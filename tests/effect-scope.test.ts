import { describe, expect, it, vi } from "vitest";
import { FabricEffectScope } from "../src/components/effect-scope.js";

describe("FabricEffectScope", () => {
  it("disposes effects once in reverse registration order", async () => {
    const scope = new FabricEffectScope();
    const calls: string[] = [];
    const first = await scope.effect(() => () => { calls.push("first"); }, "first");
    await scope.effect(function* () {
      yield () => { calls.push("second-a"); };
      yield () => { calls.push("second-b"); };
    }, "second");

    expect(await scope.dispose()).toEqual({ status: "disposed", failures: [] });
    expect(calls).toEqual(["second-b", "second-a", "first"]);
    await first();
    await scope.dispose();
    expect(calls).toEqual(["second-b", "second-a", "first"]);
  });

  it("collects multiple disposers resolved by async setup", async () => {
    const scope = new FabricEffectScope();
    const calls: string[] = [];
    await scope.effect(async () => [
      () => { calls.push("first"); },
      () => { calls.push("second"); },
    ]);
    await scope.dispose();
    expect(calls).toEqual(["second", "first"]);
  });

  it("orders an effect's returned cleanup after nested registrations", async () => {
    const scope = new FabricEffectScope();
    const calls: string[] = [];
    await scope.effect(async () => {
      scope.defer(() => { calls.push("resource"); }, "resource");
      return () => { calls.push("owner"); };
    }, "owner");

    await scope.dispose();
    expect(calls).toEqual(["owner", "resource"]);
  });

  it("rolls back collected cleanup when setup fails", async () => {
    const scope = new FabricEffectScope();
    const cleanup = vi.fn();
    await expect(scope.effect(async function* () {
      yield cleanup;
      throw new Error("setup failed");
    }, "broken")).rejects.toThrow("setup failed");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await scope.dispose()).toEqual({ status: "disposed", failures: [] });
  });

  it("reports cleanup failure encountered while rolling back setup", async () => {
    const scope = new FabricEffectScope();
    await expect(scope.effect(async function* () {
      yield () => { throw new Error("rollback leaked"); };
      throw new Error("setup failed");
    }, "broken-setup")).rejects.toThrow("setup and rollback failed");

    expect(await scope.dispose()).toEqual({
      status: "quarantined",
      failures: [{ label: "broken-setup", error: "rollback leaked" }],
    });
  });

  it("awaits in-flight setup when disposal starts reentrantly", async () => {
    const scope = new FabricEffectScope();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const setup = scope.effect(async () => {
      await gate;
      return () => { calls.push("cleanup"); };
    }, "async");
    const disposal = scope.dispose();
    release();
    await setup;
    expect(await disposal).toEqual({ status: "disposed", failures: [] });
    expect(calls).toEqual(["cleanup"]);
  });

  it("continues cleanup and reports quarantine after disposer failures", async () => {
    const scope = new FabricEffectScope();
    const later = vi.fn();
    scope.defer(later, "later");
    scope.defer(() => { throw new Error("cannot release"); }, "broken");

    expect(await scope.dispose()).toEqual({
      status: "quarantined",
      failures: [{ label: "broken", error: "cannot release" }],
    });
    expect(later).toHaveBeenCalledOnce();
    expect(() => scope.defer(() => {})).toThrow(/disposing Fabric scope/);
  });
});
