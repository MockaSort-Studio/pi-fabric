import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import { registerFabricCommand } from "../src/commands/fabric.js";
import {
  PREWALK_ARMED_MESSAGE_TYPE,
  prewalkArmedPrompt,
} from "../src/prewalk/handoff.js";
import type { FabricState } from "../src/fabric-state.js";
import type { FabricUiController } from "../src/ui/controller.js";

describe("/fabric command", () => {
  it("opens the dashboard when invoked without arguments", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(
        (
          _name: string,
          definition: {
            handler: (argumentsText: string, context: ExtensionContext) => Promise<void>;
          },
        ) => {
          handler = definition.handler;
        },
      ),
    } as unknown as ExtensionAPI;
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
    } as unknown as FabricState;
    const fabricUi = {
      openDashboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FabricUiController;
    const context = {} as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    expect(handler).toBeDefined();

    await handler!("", context);

    expect(state.ensure).toHaveBeenCalledWith(context);
    expect(fabricUi.openDashboard).toHaveBeenCalledWith(context);
  });

  it("keeps the /fabric ui dashboard alias", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const state = { ensure: vi.fn().mockResolvedValue(undefined) } as unknown as FabricState;
    const fabricUi = { openDashboard: vi.fn().mockResolvedValue(undefined) } as unknown as FabricUiController;
    const context = {} as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    await handler!("ui", context);

    expect(fabricUi.openDashboard).toHaveBeenCalledWith(context);
  });

  it("arms prewalk with the configured executor and submits an inline task", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendUserMessage = vi.fn();
    const sendMessage = vi.fn();
    const pi = {
      sendUserMessage,
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "in-place", model: "anthropic/executor" },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    await handler!("prewalk Implement the token guard", context);

    expect(arm).toHaveBeenCalledWith({
      model: "anthropic/executor",
      mode: "in-place",
      sessionId: "session-1",
      task: "Implement the token guard",
    });
    expect(sendUserMessage).toHaveBeenCalledWith("Implement the token guard");
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("in-place", "anthropic/executor"),
        display: false,
        details: { mode: "in-place", model: "anthropic/executor" },
      },
      { deliverAs: "nextTurn" },
    );
    // Advisory framing lands in the queue before the task submission.
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("uses the model picker when prewalk has no configured executor", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const pi = {
      sendUserMessage: vi.fn(),
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const select = vi.fn().mockResolvedValue("openai/executor");
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "in-place" },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      hasUI: true,
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai", id: "executor" },
          { provider: "anthropic", id: "other" },
        ],
      },
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { select, setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    await handler!("prewalk", context);

    expect(select).toHaveBeenCalledWith("Prewalk executor model", [
      "anthropic/other",
      "openai/executor",
    ]);
    expect(arm).toHaveBeenCalledWith({
      model: "openai/executor",
      mode: "in-place",
      sessionId: "session-1",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("in-place", "openai/executor"),
        display: false,
      }),
      { deliverAs: "nextTurn" },
    );
  });

  it("skips the armed prompt when the identical one already persists", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const pi = {
      sendUserMessage: vi.fn(),
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "trajectory", model: "anthropic/executor" },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      sessionManager: {
        getSessionId: () => "session-1",
        getBranch: () => [
          {
            type: "custom_message",
            customType: PREWALK_ARMED_MESSAGE_TYPE,
            content: prewalkArmedPrompt("trajectory", "anthropic/executor"),
          },
        ],
      },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    await handler!("prewalk", context);

    expect(arm).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("persists display changes by scope and refreshes the current transcript", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { DEFAULT_FABRIC_CONFIG, loadFabricConfig } = await import("../src/config.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-display-command-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
      let completions: ((prefix: string) => Array<{ value: string }> | null) | undefined;
      const pi = {
        registerCommand: vi.fn((_name: string, definition: {
          handler: typeof handler;
          getArgumentCompletions: typeof completions;
        }) => {
          handler = definition.handler;
          completions = definition.getArgumentCompletions;
        }),
      } as unknown as ExtensionAPI;
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const state = {
        initialized: true,
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(
          config,
          loadFabricConfig({ cwd, agentDir, projectTrusted: true }),
        )),
      } as unknown as FabricState;
      const refreshToolDisplay = vi.fn();
      const notify = vi.fn();
      const context = {
        cwd,
        isProjectTrusted: () => true,
        ui: { notify },
      } as unknown as ExtensionContext;

      registerFabricCommand(pi, {
        state,
        fabricUi: {} as FabricUiController,
        capturedTools: {} as CapturedToolCatalog,
        applyFabricMode: vi.fn(),
        suspendToolCapture: vi.fn(),
        autoArmPrewalk: vi.fn(async () => {}),
        refreshToolDisplay,
      });

      expect(completions!("dis")?.map((item) => item.value)).toEqual(["display"]);
      expect(completions!("display c")?.map((item) => item.value)).toEqual(["compact"]);
      expect(completions!("display compact ")?.map((item) => item.value)).toEqual([
        "--global",
        "--project",
      ]);
      expect(completions!("display compact --")?.map((item) => item.value)).toEqual([
        "--global",
        "--project",
      ]);

      await handler!("display compact", context);
      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8")))
        .toMatchObject({ ui: { toolDisplay: "compact" } });
      expect(config.ui.toolDisplay).toBe("compact");
      expect(state.reloadConfig).toHaveBeenCalledWith(context);
      expect(refreshToolDisplay).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenLastCalledWith("Fabric tool display: compact (project)", "info");

      await handler!("display full --global", context);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({ ui: { toolDisplay: "full" } });
      expect(refreshToolDisplay).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenLastCalledWith("Fabric tool display: full (global)", "info");

      const untrustedCwd = path.join(root, "untrusted");
      fs.mkdirSync(untrustedCwd, { recursive: true });
      const untrustedContext = {
        ...context,
        cwd: untrustedCwd,
        isProjectTrusted: () => false,
      } as unknown as ExtensionContext;
      await handler!("display compact", untrustedContext);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({ ui: { toolDisplay: "compact" } });
      expect(fs.existsSync(path.join(untrustedCwd, ".pi", "fabric.json"))).toBe(false);
      expect(refreshToolDisplay).toHaveBeenCalledTimes(3);
      expect(notify).toHaveBeenLastCalledWith("Fabric tool display: compact (global)", "info");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid display values, conflicting flags, and unavailable project scope", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const state = {
      initialized: true,
      ensure: vi.fn().mockResolvedValue(undefined),
      config: { ui: { toolDisplay: "full" } },
      reloadConfig: vi.fn(),
    } as unknown as FabricState;
    const refreshToolDisplay = vi.fn();
    const notify = vi.fn();
    const context = {
      cwd: process.cwd(),
      isProjectTrusted: () => false,
      ui: { notify },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
      refreshToolDisplay,
    });

    await handler!("display brief", context);
    expect(notify).toHaveBeenLastCalledWith(
      "Usage: /fabric display <full|compact> [--global|--project]",
      "warning",
    );
    await handler!("display compact --global --project", context);
    expect(notify).toHaveBeenLastCalledWith("Choose either --global or --project.", "warning");
    await handler!("display compact --project", context);
    expect(notify).toHaveBeenLastCalledWith(
      "Project scope is unavailable for an untrusted project.",
      "error",
    );
    expect(state.reloadConfig).not.toHaveBeenCalled();
    expect(refreshToolDisplay).not.toHaveBeenCalled();
  });

});
