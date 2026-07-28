import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolResultMessage } from "../src/agents/types.js";
import type { FabricExecutionResult } from "../src/execution-service.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import {
  claimFabricHandoff,
  runFabricHandoffAtBoundary,
} from "../src/prewalk/handoff.js";

const execution = (): FabricExecutionResult => ({
  success: true,
  value: "complete outer result",
  logs: [],
  audits: [
    {
      ref: "pi.read",
      nestedToolCallId: "read",
      startedAt: 1,
      endedAt: 2,
      success: true,
      args: { path: "src/a.ts" },
      result: "source",
    },
    {
      ref: "pi.edit",
      nestedToolCallId: "edit-one",
      startedAt: 3,
      endedAt: 4,
      success: true,
      args: { path: "src/a.ts" },
      result: { ok: true },
    },
    {
      ref: "pi.write",
      nestedToolCallId: "edit-two",
      startedAt: 5,
      endedAt: 6,
      success: true,
      args: { path: "src/b.ts" },
      result: { ok: true },
    },
  ],
  phases: [],
  trace: {
    kind: "pi-fabric.execution",
    version: 1,
    outcome: "succeeded",
    counts: {
      droppedValues: 0,
      truncatedValues: 0,
      redactedValues: 0,
      droppedOperations: 0,
    },
    operations: [],
    phases: [],
  },
  elapsedMs: 1,
});

const outerResult = (): AgentToolResultMessage => ({
  role: "toolResult",
  toolCallId: "outer",
  toolName: "fabric_exec",
  content: [{ type: "text", text: "complete outer result" }],
  details: { success: true },
  isError: false,
  timestamp: 10,
});

const context = () => {
  const source = SessionManager.inMemory();
  source.appendMessage({ role: "user", content: "Implement everything", timestamp: 1 });
  source.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "outer",
      name: "fabric_exec",
      arguments: { code: "await pi.edit(...); return 'complete outer result';" },
    }],
    api: "anthropic",
    provider: "anthropic",
    model: "frontier",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  const target = { provider: "anthropic", id: "executor" };
  const setStatus = vi.fn();
  return {
    value: {
      cwd: process.cwd(),
      signal: undefined,
      model: { provider: "anthropic", id: "frontier" },
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === target.provider && id === target.id ? target : undefined,
      },
      sessionManager: source,
      ui: { setStatus, notify: vi.fn() },
    } as unknown as ExtensionContext,
    setStatus,
    target,
  };
};

const extension = () => {
  const setModel = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn();
  return {
    value: { setModel, sendMessage } as unknown as ExtensionAPI,
    setModel,
    sendMessage,
  };
};

const unusedRunner = () => ({ executeHandoff: vi.fn() });

describe("outer-boundary Prewalk", () => {
  it("switches Main in place and queues a hidden follow-up by default", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const run = execution();
    const pending = claimFabricHandoff(controller, run, "session-1", "json");

    expect(run.audits.map((audit) => audit.ref)).toEqual([
      "pi.read",
      "pi.edit",
      "pi.write",
      "fabric.prewalk",
    ]);
    expect(pending).toMatchObject({
      kind: "prewalk-in-place",
      args: { model: "anthropic/executor", task: "Implement the guard" },
      triggerRef: "pi.edit",
    });

    const ctx = context();
    const ext = extension();
    const runner = unusedRunner();
    const activity = vi.fn();
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
      activity,
    );

    expect(runner.executeHandoff).not.toHaveBeenCalled();
    expect(ext.setModel).toHaveBeenCalledWith(ctx.target);
    expect(ctx.value.ui.notify).toHaveBeenCalledWith(
      "Prewalk continuing Main in place with anthropic/executor. Pi will retain this model after the task.",
      "info",
    );
    expect(ext.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-fabric-prewalk-continue",
        display: false,
        content: expect.stringContaining("Continue the existing task"),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(result).toMatchObject({
      prewalk: true,
      mode: "in-place",
      continued: true,
      status: "continued",
      trigger: { ref: "pi.edit" },
    });
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: "progress" }));
    expect(controller.status()).toEqual({ state: "idle" });
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "continuing Main → anthropic/executor",
    );
  });

  it("keeps trajectory handoff opt-in and exposes child activity", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending).toMatchObject({
      kind: "prewalk-trajectory",
      audit: { ref: "agents.handoff" },
    });

    const ctx = context();
    const ext = extension();
    let transferredSeed: unknown;
    const runner = {
      executeHandoff: vi.fn(async (_args, invocation, seed) => {
        transferredSeed = seed;
        invocation.activity?.({
          type: "entity",
          id: "child-1",
          kind: "agent",
          name: "Prewalk trajectory executor",
        });
        invocation.update("Agent Prewalk trajectory executor: running · edit");
        invocation.attachPreview?.({ kind: "fabric-agent-tools" });
        return {
          handedOff: true,
          completed: true,
          status: "completed",
          implementation: "implemented",
          agent: { id: "child-1" },
        };
      }),
    };
    const activity = vi.fn();
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
      activity,
    );

    expect(ext.setModel).not.toHaveBeenCalled();
    expect(runner.executeHandoff).toHaveBeenCalledWith(
      {
        model: "anthropic/executor",
        name: "Prewalk trajectory executor",
        task: "Implement the guard",
      },
      expect.objectContaining({ parentToolCallId: "outer", activity: expect.any(Function) }),
      expect.any(Object),
    );
    expect(transferredSeed).toMatchObject({
      sourceBranch: [
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant" } },
      ],
      outerToolResult: { toolCallId: "outer", toolName: "fabric_exec" },
    });
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: "entity", id: "child-1" }));
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: "progress" }));
    expect(result).toMatchObject({
      prewalk: true,
      mode: "trajectory",
      handedOff: true,
      completed: true,
      implementation: "implemented",
    });
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "trajectory executor implemented",
    );
  });

  it("re-arms after an in-place continuation when configured", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      extension().value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(controller.status()).toMatchObject({
      state: "armed",
      mode: "in-place",
      model: "anthropic/executor",
      alwaysRearm: true,
    });
    expect(controller.status()).not.toHaveProperty("task");
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "armed → anthropic/executor",
    );
  });

  it("gives an explicit deferred trajectory request precedence", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/automatic", sessionId: "session-1" });
    const run = execution();
    run.audits.push({
      ref: "agents.handoff",
      nestedToolCallId: "explicit",
      startedAt: 7,
      endedAt: 8,
      success: true,
      args: { model: "anthropic/explicit" },
      result: { status: "deferred" },
    });
    run.handoffRequest = { model: "anthropic/explicit", task: "Use explicit executor" };

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toMatchObject({
      kind: "explicit",
      args: { model: "anthropic/explicit", task: "Use explicit executor" },
    });
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("does not claim when the complete execution had no mutation", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    const run = execution();
    run.audits = run.audits.slice(0, 1);

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });
});
