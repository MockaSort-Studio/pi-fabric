import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piFabric from "../src/index.js";

// The settings command handler calls state.ensure(), which lazily creates the
// heavyweight runtime (mesh, lifecycle, residency workers). Replace it with a
// stub so the handler can run in a unit test.
vi.mock("../src/fabric-runtime-state.js", () => ({
  FabricRuntimeState: class {
    initialized = true;
    widgetDismissedAt = 0;
    async initialize(): Promise<void> {}
    async shutdown(): Promise<void> {}
    registerExternal(): void {}
    mcpSlice(): never[] {
      return [];
    }
  },
}));

// Replace the settings modal with the real apply path: a successful save calls
// onConfigApplied, which is the display-mode switch that re-renders the
// transcript through refreshToolDisplay.
vi.mock("../src/ui/settings.js", () => ({
  openFabricSettings: vi.fn(async (
    _context: ExtensionContext,
    deps: { onConfigApplied?: () => void },
  ) => {
    deps.onConfigApplied?.();
  }),
}));

type ExtensionHandler = (event: unknown, context: unknown) => unknown;

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("Fabric tool display lifecycle", () => {
  it("drops abandoned-branch invalidators when session_tree rebuilds the transcript", async () => {
    const handlers = new Map<string, ExtensionHandler[]>();
    const registeredTools: unknown[] = [];
    let commandHandler:
      | ((argumentsText: string, context: ExtensionContext) => Promise<void>)
      | undefined;

    const pi = {
      events: {
        emit: vi.fn(),
        on: vi.fn(() => () => {}),
      },
      getActiveTools: vi.fn(() => []),
      getAllTools: vi.fn(() => []),
      on: vi.fn((event: string, handler: ExtensionHandler) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      }),
      registerCommand: vi.fn((_name: string, definition: { handler: typeof commandHandler }) => {
        commandHandler = definition.handler;
      }),
      registerTool: vi.fn((tool: unknown) => {
        registeredTools.push(tool);
      }),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;

    await piFabric(pi);

    const fabricTool = registeredTools.find(
      (tool) => (tool as { name?: string }).name === "fabric_exec",
    ) as {
      renderCall?: (
        params: unknown,
        theme: Theme,
        context: Record<string, unknown>,
      ) => { render: (width: number) => string[] };
    };
    expect(fabricTool).toBeDefined();
    expect(fabricTool.renderCall).toBeTypeOf("function");

    const renderCard = (toolCallId: string, invalidate: () => void): void => {
      const params = { code: "await pi.read('/tmp/leaf');" };
      fabricTool.renderCall!(params, plainTheme, {
        args: params,
        toolCallId,
        invalidate,
        lastComponent: undefined,
        state: {},
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: true,
        isError: false,
      } as never);
    };

    // The abandoned branch renders its card and registers an invalidator.
    const abandonedInvalidate = vi.fn();
    renderCard("abandoned-branch-call", abandonedInvalidate);

    // Pi emits session_tree before it clears and rebuilds the transcript.
    for (const handler of handlers.get("session_tree") ?? []) {
      await handler(undefined, {});
    }

    // The rebuilt active branch renders its card and registers again.
    const activeInvalidate = vi.fn();
    renderCard("active-branch-call", activeInvalidate);

    // A display-mode switch re-renders registered cards through the real
    // settings apply path (openFabricSettings -> onConfigApplied ->
    // refreshToolDisplay -> controller.refresh()).
    const context = {
      mode: "code",
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      hasUI: false,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: { getBranch: () => [], getSessionId: () => "test-session" },
    } as unknown as ExtensionContext;
    await commandHandler!("settings", context);

    expect(abandonedInvalidate).not.toHaveBeenCalled();
    expect(activeInvalidate).toHaveBeenCalledOnce();

    // Abandoned invalidators stay dropped for the rest of the session: a
    // second switch still refreshes only the active card.
    await commandHandler!("settings", context);
    expect(abandonedInvalidate).not.toHaveBeenCalled();
    expect(activeInvalidate).toHaveBeenCalledTimes(2);
  });
});
