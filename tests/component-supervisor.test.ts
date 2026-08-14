import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import type {
  FabricComponentDefinition,
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";

const invocationContext = (): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "test",
  extensionContext: {} as ExtensionContext,
  update() {},
});

const echoProvider = (
  name = "svc",
  value = "ok",
  close?: () => void,
): FabricProvider => ({
  name,
  description: `${name} service`,
  async list() {
    return [{
      name: "echo",
      description: "Echo a value",
      inputSchema: { type: "object", additionalProperties: false },
      risk: "read",
      effect: { kind: "none", ordering: "commutative" },
    }];
  },
  async describe(action) {
    return action === "echo" ? (await this.list({}, invocationContext()))[0] : undefined;
  },
  async invoke() {
    return value;
  },
  async close() { close?.(); },
});

const entry = (id: string, component = id) => ({ id, component });

describe("FabricComponentSupervisor", () => {
  it("waits for exact capabilities and activates against a committed view", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const states: string[] = [];
    supervisor.subscribe(() => {
      const state = supervisor.list().find((component) => component.id === "consumer")?.state;
      if (state) states.push(state);
    });
    const events: string[] = [];
    const definition: FabricComponentDefinition = {
      name: "consumer",
      requires: ["svc.echo", { ref: "missing.optional", optional: true }],
      async activate(context) {
        events.push(String(await context.call("svc.echo")));
        return () => { events.push("cleanup"); };
      },
    };

    expect(await supervisor.start(entry("consumer"), definition)).toMatchObject({
      state: "waiting",
      missing: ["svc.echo"],
      optionalMissing: ["missing.optional"],
    });
    registry.register(echoProvider());
    await supervisor.settle();

    expect(supervisor.status("consumer")).toMatchObject({
      state: "active",
      missing: [],
      optionalMissing: ["missing.optional"],
    });
    expect(supervisor.status("consumer").targetDigest).toBeTruthy();
    expect(events).toEqual(["ok"]);
    await supervisor.stop("consumer");
    expect(events).toEqual(["ok", "cleanup"]);
    expect(states).toContain("disposed");
    await registry.close();
  });

  it("keeps declaration cycles waiting and reports their exact path", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await supervisor.start(entry("alpha"), {
      name: "alpha",
      requires: ["beta.echo"],
      provides: ["alpha"],
      activate(context) { context.provide(echoProvider("alpha")); },
    });
    await supervisor.start(entry("beta"), {
      name: "beta",
      requires: ["alpha.echo"],
      provides: ["beta"],
      activate(context) { context.provide(echoProvider("beta")); },
    });

    expect(supervisor.status("alpha")).toMatchObject({
      state: "waiting",
      missing: ["beta.echo"],
    });
    expect(supervisor.status("beta")).toMatchObject({
      state: "waiting",
      missing: ["alpha.echo"],
    });
    expect(supervisor.graph().cycles).toEqual([["alpha", "beta"]]);
    await supervisor.close();
    await registry.close();
  });

  it("retires providers, unloads dependents, then releases owner effects", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    const owner: FabricComponentDefinition = {
      name: "owner",
      provides: ["svc"],
      activate(context) {
        context.provide(echoProvider("svc", "owned", () => { events.push("provider-close"); }));
        return () => { events.push("owner-cleanup"); };
      },
    };
    const dependent: FabricComponentDefinition = {
      name: "dependent",
      requires: ["svc.echo"],
      activate(context) {
        events.push("dependent-start");
        return async () => {
          events.push(`dependent-teardown:${String(await context.call("svc.echo"))}`);
          events.push("dependent-cleanup");
        };
      },
    };

    await supervisor.start(entry("owner"), owner);
    await supervisor.start(entry("dependent"), dependent);
    expect(registry.has("svc")).toBe(true);
    await supervisor.stop("owner");
    await supervisor.settle();

    expect(events).toEqual([
      "dependent-start",
      "dependent-teardown:owned",
      "dependent-cleanup",
      "owner-cleanup",
      "provider-close",
    ]);
    expect(registry.has("svc")).toBe(false);
    expect(supervisor.status("dependent")).toMatchObject({
      state: "waiting",
      missing: ["svc.echo"],
    });
    await supervisor.close();
    await registry.close();
  });

  it("settles async activation, rolls back a stale target, and retries", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activationStarted = new Promise<void>((resolve) => { started = resolve; });
    registry.register(echoProvider("svc", "first"));

    const activation = supervisor.start(entry("drift"), {
      name: "drift",
      requires: ["svc.echo"],
      async activate(context) {
        const value = String(await context.call("svc.echo"));
        events.push(`start:${value}`);
        started();
        await gate;
        return () => { events.push(`cleanup:${value}`); };
      },
    });
    await activationStarted;
    registry.register(echoProvider("svc", "second"), { overwrite: true });
    release();
    await activation;
    await supervisor.settle();

    expect(supervisor.status("drift")).toMatchObject({ state: "active" });
    expect(events).toEqual(["start:first", "cleanup:first", "start:second"]);
    await supervisor.close();
    await registry.close();
  });

  it("rolls back a failed replacement to the previous revision", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    const stable: FabricComponentDefinition = {
      name: "service",
      activate() {
        events.push("stable-start");
        return () => { events.push("stable-cleanup"); };
      },
    };
    const broken: FabricComponentDefinition = {
      name: "service",
      activate() {
        events.push("broken-start");
        throw new Error("candidate failed");
      },
    };

    await supervisor.start(entry("service"), stable);
    await expect(supervisor.replace("service", entry("service"), broken))
      .rejects.toThrow("candidate failed; previous revision restored");
    expect(supervisor.status("service")).toMatchObject({ state: "active", revision: 3 });
    expect(events).toEqual([
      "stable-start",
      "stable-cleanup",
      "broken-start",
      "stable-start",
    ]);
    await supervisor.close();
    await registry.close();
  });

  it("reconciles active components when a provider descriptor changes in place", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    let description = "version one";
    let notify = () => {};
    registry.register({
      name: "mutable",
      description: "Mutable catalog",
      async list() { return [(await this.describe("read", invocationContext()))!]; },
      async describe(name) {
        return name === "read"
          ? {
              name: "read",
              description,
              inputSchema: { type: "object", additionalProperties: false },
              risk: "read",
            }
          : undefined;
      },
      async invoke() { return description; },
      subscribeCatalog(listener) { notify = listener; return () => { notify = () => {}; }; },
    });
    await supervisor.start(entry("catalog-user"), {
      name: "catalog-user",
      requires: ["mutable.read"],
      activate() {
        events.push(`start:${description}`);
        return () => { events.push(`stop:${description}`); };
      },
    });
    const firstDigest = supervisor.status("catalog-user").targetDigest;
    description = "version two";
    notify();
    await supervisor.settle();

    expect(events).toEqual([
      "start:version one",
      "stop:version two",
      "start:version two",
    ]);
    expect(supervisor.status("catalog-user").targetDigest).not.toBe(firstDigest);
    await supervisor.close();
    await registry.close();
  });

  it("automatically disposes scoped acquisitions", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    registry.register({
      name: "lease",
      description: "Lease provider",
      async list() { return [(await this.describe("open", invocationContext()))!]; },
      async describe(name) {
        return name === "open"
          ? {
              name: "open",
              description: "Open lease",
              inputSchema: { type: "object", additionalProperties: false },
              risk: "execute",
              effect: { kind: "scoped", resources: ["lease"], ordering: "ordered" },
            }
          : undefined;
      },
      async invoke() { throw new Error("use acquire"); },
      async acquire() {
        events.push("acquire");
        return { value: "resource", dispose: () => { events.push("release"); } };
      },
    });
    await supervisor.start(entry("lease-user"), {
      name: "lease-user",
      requires: ["lease.open"],
      guarantee: "revertible",
      async activate(context) {
        events.push(String(await context.acquire("lease.open")));
        return () => { events.push("owner-cleanup"); };
      },
    });
    await supervisor.stop("lease-user");
    expect(events).toEqual(["acquire", "resource", "owner-cleanup", "release"]);
    await registry.close();
  });

  it("rejects emission effects from revertible components", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    registry.register({
      name: "emit",
      description: "Emission provider",
      async list() { return [(await this.describe("write", invocationContext()))!]; },
      async describe(name) {
        return name === "write"
          ? {
              name: "write",
              description: "Emit a write",
              inputSchema: { type: "object", additionalProperties: false },
              risk: "write",
            }
          : undefined;
      },
      async invoke() { return "written"; },
    });

    await expect(supervisor.start(entry("safe"), {
      name: "safe",
      requires: ["emit.write"],
      guarantee: "revertible",
      async activate(context) { await context.call("emit.write"); },
    })).rejects.toThrow("cannot emit non-revertible action emit.write");
    expect(supervisor.status("safe").state).toBe("failed");
    await supervisor.close();
    await registry.close();
  });

  it("quarantines activation when setup rollback cleanup also fails", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await expect(supervisor.start(entry("broken-setup"), {
      name: "broken-setup",
      async *activate() {
        yield () => { throw new Error("rollback leaked"); };
        throw new Error("activation failed");
      },
    })).rejects.toThrow("setup and rollback failed");
    expect(supervisor.status("broken-setup")).toMatchObject({
      state: "quarantined",
      cleanupErrors: ["component:activate: rollback leaked"],
    });
    await supervisor.close();
    await registry.close();
  });

  it("quarantines cleanup failures instead of claiming disposal", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await supervisor.start(entry("leaky"), {
      name: "leaky",
      activate() {
        return () => { throw new Error("cleanup leaked"); };
      },
    });

    await expect(supervisor.stop("leaky")).rejects.toThrow("cleanup failed");
    expect(supervisor.status("leaky")).toMatchObject({
      state: "quarantined",
      cleanupErrors: ["component:activate: cleanup leaked"],
    });
    await supervisor.close();
    await registry.close();
  });
});
