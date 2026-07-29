import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FabricPrewalkMode, FabricResultFormat } from "../config.js";
import {
  NESTED_TOOL_CALL_ID_PREFIX,
  type FabricCallAudit,
} from "../core/action-registry.js";
import type { FabricExecutionResult } from "../execution-service.js";
import type {
  FabricInvocationActivityUpdate,
  FabricInvocationContext,
} from "../protocol.js";
import { snapshotHandoffSession } from "../agents/handoff.js";
import type {
  AgentSessionSeed,
  AgentToolResultMessage,
} from "../agents/types.js";
import type { PrewalkController } from "./controller.js";

const PREWALK_CONTINUE_PROMPT = [
  "Continue the existing task in this same session under the new executor model.",
  "Do not stop merely because the model changed or because the first mutation succeeded.",
  "Finish the remaining implementation, check matching call sites for consistency, and run the relevant verification before reporting completion.",
].join(" ");

export const PREWALK_ARMED_MESSAGE_TYPE = "pi-fabric-prewalk-armed";

// Advisory arm-time framing, delivered as a hidden nextTurn custom message:
// LLM-visible, TUI-hidden, and never fired as an `input` event, so it cannot
// be captured as the next prewalk task and never triggers a turn by itself.
export const prewalkArmedPrompt = (mode: FabricPrewalkMode, model: string): string =>
  [
    `Prewalk armed → ${model} (${mode}): the first successful pi.edit / pi.write / schema.commit inside fabric_exec hands off to the executor automatically; ${
      mode === "trajectory"
        ? "your turn ends there and the executor continues the work."
        : `this session switches to ${model} and keeps working.`
    }`,
    "Reads never fire it; for multi-step work, restate the remaining steps before your first edit.",
  ].join("\n");

const customMessageText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
};

// Pileup guard: only skip when an identical armed prompt already persists in
// the branch, so re-arming with a different mode/model still announces itself.
export const hasPrewalkArmedPrompt = (
  entries: ReadonlyArray<unknown>,
  content: string,
): boolean =>
  entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as { type?: unknown; customType?: unknown; content?: unknown };
    return (
      candidate.type === "custom_message" &&
      candidate.customType === PREWALK_ARMED_MESSAGE_TYPE &&
      customMessageText(candidate.content) === content
    );
  });

export interface BoundaryHandoffRunner {
  executeHandoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    sessionSeed: AgentSessionSeed,
  ): Promise<Record<string, unknown>>;
}

export interface PendingFabricHandoff {
  kind: "explicit" | "prewalk-in-place" | "prewalk-trajectory";
  args: Record<string, unknown>;
  audit: FabricCallAudit;
  resultFormat: FabricResultFormat;
  triggerRef?: string;
}

// Appended to the replaced boundary tool result so the framing persists with
// what Main keeps seeing, anchoring every later turn. Advisory only: prewalk
// cannot gate the next claim on a plan, and bash edits stay invisible to it.
const TRAJECTORY_REARM_DIRECTIVE = [
  "Prewalk handoff completed — the executor's result above is final; don't redo it.",
  "Prewalk re-armed: on the next request, restate remaining steps (skip if trivial), then make changes via pi.edit / pi.write in fabric_exec to hand off again.",
  "Re-check only what the executor left incomplete.",
].join("\n");

export const withTrajectoryRearmDirective = (
  text: string,
  pending: PendingFabricHandoff,
  handoff: Record<string, unknown>,
  controller: PrewalkController,
  sessionId: string,
): string =>
  pending.kind === "prewalk-trajectory" &&
  handoff.completed === true &&
  controller.isArmed(sessionId)
    ? `${text}\n\n${TRAJECTORY_REARM_DIRECTIVE}`
    : text;

export const claimFabricHandoff = (
  controller: PrewalkController,
  execution: FabricExecutionResult,
  sessionId: string,
  resultFormat: FabricResultFormat,
): PendingFabricHandoff | undefined => {
  if (execution.handoffRequest) {
    controller.completeTask();
    let audit: FabricCallAudit | undefined;
    for (let index = execution.audits.length - 1; index >= 0; index--) {
      const candidate = execution.audits[index];
      if (candidate?.ref === "agents.handoff") {
        audit = candidate;
        break;
      }
    }
    if (!audit) {
      throw new Error("Deferred agents.handoff request has no matching Fabric audit");
    }
    return {
      kind: "explicit",
      args: execution.handoffRequest,
      audit,
      resultFormat,
    };
  }

  const claim = controller.claim(execution.audits, sessionId);
  if (!claim) return undefined;
  const inPlace = claim.arm.mode === "in-place";
  const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}prewalk_${randomUUID()}`;
  const args = {
    model: claim.arm.model,
    name: inPlace ? "In-place Prewalk" : "Prewalk trajectory executor",
    ...(claim.arm.task ? { task: claim.arm.task } : {}),
  };
  const audit: FabricCallAudit = {
    ref: inPlace ? "fabric.prewalk" : "agents.handoff",
    nestedToolCallId,
    startedAt: Date.now(),
    tool: inPlace ? "prewalk" : "handoff",
    provider: inPlace ? "fabric" : "agents",
    args,
  };
  execution.audits.push(audit);
  return {
    kind: inPlace ? "prewalk-in-place" : "prewalk-trajectory",
    args,
    audit,
    resultFormat,
    triggerRef: claim.mutation.ref,
  };
};

const modelForKey = (key: string, context: ExtensionContext) => {
  const separator = key.indexOf("/");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error("Prewalk requires a provider/model executor target");
  }
  const model = context.modelRegistry.find(
    key.slice(0, separator),
    key.slice(separator + 1),
  );
  if (!model) throw new Error(`Prewalk model is unavailable: ${key}`);
  return model;
};

const runInPlacePrewalk = async (
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  context: ExtensionContext,
): Promise<Record<string, unknown>> => {
  const modelKey = String(pending.args.model ?? "");
  context.ui.setStatus("fabric-prewalk", `switching Main → ${modelKey}`);
  const model = modelForKey(modelKey, context);
  const switched = await extension.setModel(model);
  if (!switched) {
    throw new Error(`No authentication configured for prewalk model: ${modelKey}`);
  }
  context.ui.notify(
    `Prewalk continuing Main in place with ${modelKey}. Pi will retain this model after the task.`,
    "info",
  );
  extension.sendMessage(
    {
      customType: "pi-fabric-prewalk-continue",
      content: PREWALK_CONTINUE_PROMPT,
      display: false,
      details: {
        mode: "in-place",
        model: modelKey,
        trigger: pending.triggerRef,
      },
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
  context.ui.setStatus("fabric-prewalk", `continuing Main → ${modelKey}`);
  return {
    prewalk: true,
    mode: "in-place",
    continued: true,
    status: "continued",
    model: modelKey,
    trigger: { ref: pending.triggerRef },
  };
};

export const runFabricHandoffAtBoundary = async (
  controller: PrewalkController,
  runner: BoundaryHandoffRunner,
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  outerToolResult: AgentToolResultMessage,
  context: ExtensionContext,
  activity?: (update: FabricInvocationActivityUpdate) => void,
): Promise<Record<string, unknown>> => {
  const model = String(pending.args.model ?? "");
  const inPlace = pending.kind === "prewalk-in-place";
  context.ui.setStatus(
    "fabric-prewalk",
    inPlace ? `switching Main → ${model}` : `handing off trajectory → ${model}`,
  );
  try {
    if (inPlace) {
      const result = await runInPlacePrewalk(extension, pending, context);
      pending.audit.success = true;
      pending.audit.result = result;
      pending.audit.endedAt = Date.now();
      activity?.({ type: "progress", message: `Main continuing in place with ${model}` });
      return result;
    }

    const seed = snapshotHandoffSession(
      context.sessionManager,
      context.model,
      outerToolResult,
      outerToolResult.toolCallId,
    );
    const invocation: FabricInvocationContext = {
      cwd: context.cwd,
      signal: context.signal,
      parentToolCallId: outerToolResult.toolCallId,
      nestedToolCallId: pending.audit.nestedToolCallId,
      extensionContext: context,
      update(message) {
        context.ui.setStatus("fabric-prewalk", message);
        activity?.({ type: "progress", message });
      },
      ...(activity ? { activity } : {}),
      attachPreview(preview) {
        pending.audit.preview = preview;
      },
    };
    const result = await runner.executeHandoff(pending.args, invocation, seed);
    const completed = result.completed === true;
    pending.audit.success = completed;
    pending.audit.result = result;
    pending.audit.endedAt = Date.now();
    context.ui.setStatus(
      "fabric-prewalk",
      completed ? "trajectory executor implemented" : `trajectory ${String(result.status ?? "failed")}`,
    );
    return {
      ...(pending.kind === "prewalk-trajectory"
        ? { prewalk: true, mode: "trajectory", trigger: { ref: pending.triggerRef } }
        : {}),
      ...result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pending.audit.success = false;
    pending.audit.error = message;
    pending.audit.endedAt = Date.now();
    context.ui.setStatus("fabric-prewalk", inPlace ? "in-place continuation failed" : "trajectory handoff failed");
    return {
      ...(pending.kind.startsWith("prewalk-")
        ? {
            prewalk: true,
            mode: inPlace ? "in-place" : "trajectory",
            trigger: { ref: pending.triggerRef },
          }
        : {}),
      handedOff: false,
      continued: false,
      completed: false,
      status: "failed",
      error: message,
    };
  } finally {
    const status = controller.completeTask();
    if (status.state === "armed") {
      context.ui.setStatus("fabric-prewalk", `armed → ${status.model}`);
    }
  }
};
