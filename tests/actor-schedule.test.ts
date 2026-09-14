import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { ActorManager } from "../src/actors/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";

const roots: string[] = [];
const managers: ActorManager[] = [];
const agents: AgentManager[] = [];
const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduled tick");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

const setup = (owns = () => true) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-schedule-"));
  roots.push(root);
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 20);
  const agentManager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: path.join(root, "runs"),
  });
  agents.push(agentManager);
  const identity: MeshIdentity = { id: "session:schedule", name: "main", kind: "main", sessionId: "schedule" };
  const actorManager = new ActorManager("schedule", identity, mesh,
    { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 }, agentManager, () => {},
    { actorRoot: path.join(root, "actors"), persistent: true, canManageActor: owns });
  managers.push(actorManager);
  return { actorManager, mesh, root };
};

const ticks = (mesh: MeshStore, topic: string) =>
  mesh.tail(0, 200).events.filter(event => event.topic === topic && event.kind === "fabric.actor.schedule");

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  await Promise.all(agents.splice(0).map(manager => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable actor schedules", () => {
  it("persists and publishes a subscribed topic tick", async () => {
    const { actorManager, mesh, root } = setup();
    const actor = await actorManager.create({ name: "ticker", instructions: "Observe ticks.", residency: "durable", topics: ["crew.tick"], schedule: { topic: "crew.tick", everyMs: 1_000 } });
    expect(actor.schedule).toMatchObject({ topic: "crew.tick", everyMs: 1_000, sequence: 0 });
    const registry = fs.readFileSync(path.join(root, "actors", "actors.json"), "utf8");
    expect(registry).toContain('"schedule"');
    await waitFor(() => ticks(mesh, "crew.tick").length === 1);
    expect(ticks(mesh, "crew.tick")[0]?.data).toMatchObject({ actorId: actor.id, sequence: 1 });
  });

  it("restores a persisted schedule after manager restart", async () => {
    const { actorManager, mesh, root } = setup();
    const actor = await actorManager.create({ name: "restored ticker", instructions: "Observe.", topics: ["crew.restart"], schedule: { topic: "crew.restart", everyMs: 1_000 } });
    await actorManager.close();
    const identity: MeshIdentity = { id: "session:schedule", name: "main", kind: "main", sessionId: "schedule" };
    const restored = new ActorManager("schedule", identity, mesh, { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 }, agents.at(-1)!, () => {}, { actorRoot: path.join(root, "actors"), persistent: true });
    managers.push(restored);
    expect(restored.status(actor.id).schedule).toMatchObject({ topic: "crew.restart", everyMs: 1_000 });
    await waitFor(() => ticks(mesh, "crew.restart").length === 1);
  });

  it("rejects unsafe or unsubscribed schedules", async () => {
    const { actorManager } = setup();
    await expect(actorManager.create({ name: "wrong-topic", instructions: "Observe.", topics: ["crew.work"], schedule: { topic: "crew.tick", everyMs: 1_000 } })).rejects.toThrow(/subscribed topics/);
    await expect(actorManager.create({ name: "too-fast", instructions: "Observe.", topics: ["crew.tick"], schedule: { topic: "crew.tick", everyMs: 999 } })).rejects.toThrow(/1000/);
  });

  it("does not publish when ownership is lost or after removal", async () => {
    let owns = true;
    const { actorManager, mesh } = setup(() => owns);
    const actor = await actorManager.create({ name: "owned ticker", instructions: "Observe.", topics: ["crew.tick"], schedule: { topic: "crew.tick", everyMs: 1_000 } });
    owns = false;
    await new Promise(resolve => setTimeout(resolve, 1_150));
    expect(ticks(mesh, "crew.tick")).toHaveLength(0);
    owns = true;
    await actorManager.remove(actor.id);
    await new Promise(resolve => setTimeout(resolve, 1_150));
    expect(ticks(mesh, "crew.tick")).toHaveLength(0);
  });
});
