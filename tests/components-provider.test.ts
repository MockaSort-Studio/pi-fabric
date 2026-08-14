import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricComponentCatalog } from "../src/components/catalog.js";
import { FabricComponentLoader } from "../src/components/loader.js";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { ComponentsProvider } from "../src/providers/components-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "components-provider-test",
  nestedToolCallId: "components-provider-test",
  extensionContext: {} as ExtensionContext,
  update() {},
};

describe("ComponentsProvider", () => {
  it("exposes list, status, graph, and rollback-capable reload actions", async () => {
    const registry = new ActionRegistry();
    const catalog = new FabricComponentCatalog();
    const supervisor = new FabricComponentSupervisor(registry, {
      invocationContext: () => context,
    });
    const loader = new FabricComponentLoader(catalog, supervisor);
    const provider = new ComponentsProvider(loader);
    catalog.register({ name: "service", activate() {} });
    await loader.reconcile([{ id: "service", component: "service" }]);

    expect((await provider.list({}, context)).map((action) => action.name)).toEqual([
      "list",
      "status",
      "graph",
      "reload",
    ]);
    expect(await provider.invoke("status", { id: "service" }, context)).toMatchObject({
      id: "service",
      state: "active",
      revision: 1,
    });
    expect(await provider.invoke("graph", {}, context)).toMatchObject({
      components: [expect.objectContaining({ id: "service" })],
      edges: [],
      cycles: [],
    });
    expect(await provider.invoke("reload", { id: "service" }, context)).toMatchObject({
      components: [expect.objectContaining({ id: "service", revision: 2 })],
    });
    expect(await provider.invoke("list", {}, context)).toMatchObject({
      definitions: [expect.objectContaining({ name: "service", revision: 1 })],
      components: [expect.objectContaining({ id: "service", state: "active" })],
    });

    await loader.close();
    await registry.close();
  });
});
