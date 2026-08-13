import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { FabricState } from "../src/fabric-state.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import { FabricToolDisplayController } from "../src/ui/tool-display.js";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const semanticTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;

const stateFor = (toolDisplay: "full" | "compact") => ({
  initialized: true,
  config: {
    ui: { showAgentToolPreview: true, toolDisplay },
  },
}) as unknown as FabricState;

const toolFor = (
  state: FabricState,
  display?: FabricToolDisplayController,
) => createFabricExecTool(
  state,
  defaultCodePreviewSettings(),
  new Map(),
  (tool) => tool,
  display,
);

const renderContext = (
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  args,
  toolCallId: "fabric-call-1",
  invalidate: vi.fn(),
  lastComponent: undefined,
  state: {},
  cwd: process.cwd(),
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: true,
  isError: false,
  ...overrides,
});

const renderCall = (
  tool: ReturnType<typeof toolFor>,
  args: Record<string, unknown>,
  expanded = false,
  theme: Theme = plainTheme,
) => tool.renderCall!(args as never, theme, renderContext(args, { expanded }) as never).render(120).join("\n");

const renderResult = (
  tool: ReturnType<typeof toolFor>,
  args: Record<string, unknown>,
  details: Record<string, unknown>,
  output: string,
  options: { expanded?: boolean; partial?: boolean; theme?: Theme; context?: Record<string, unknown>; width?: number } = {},
) => tool.renderResult!(
  { content: output ? [{ type: "text", text: output }] : [], details } as never,
  { expanded: options.expanded ?? false, isPartial: options.partial ?? false },
  options.theme ?? plainTheme,
  renderContext(args, { expanded: options.expanded ?? false, isPartial: options.partial ?? false, ...options.context }) as never,
).render(options.width ?? 120).join("\n");

describe("registered fabric_exec compact transcript rendering", () => {
  it("keeps full rendering intact while compact rendering elevates declared intent without source", () => {
    const args = {
      code: "const implementationSecret = await discover();\nreturn implementationSecret;",
      display: { name: "Apply migration", description: "Persist the verified setting" },
    };

    const full = renderCall(toolFor(stateFor("full")), args, true);
    const compact = renderCall(toolFor(stateFor("compact")), args, true);
    const fallback = renderCall(toolFor(stateFor("compact")), { code: args.code });

    expect(full).toContain("fabric");
    expect(full).toContain("TypeScript · 2 lines");
    expect(full).toContain("implementationSecret");
    expect(compact).toContain("Apply migration");
    expect(compact).toContain("Persist the verified setting");
    expect(compact).not.toContain("fabric");
    expect(compact).not.toContain("TypeScript");
    expect(compact).not.toContain("implementationSecret");
    expect(fallback).toContain("Tool");
  });

  it("summarizes compact outcomes while retaining nested failures and bounded return visibility", () => {
    const tool = toolFor(stateFor("compact"));
    const args = { code: "await Promise.all([]);" };
    const failed = renderResult(
      tool,
      args,
      {
        success: false,
        error: "Fabric execution failed",
        audits: [
          { ref: "pi.read", provider: "pi", tool: "read", args: { path: "src/config.ts" }, success: true, result: "export const value = true;" },
          { ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "pnpm test" }, success: false, error: "tests failed" },
        ],
        phases: [],
      },
      "outer failure details",
    );
    const done = renderResult(tool, args, { success: true, audits: [], phases: [] }, "quiet outer return");
    const expandedDone = renderResult(
      tool,
      args,
      { success: true, audits: [], phases: [] },
      "quiet outer return",
      { expanded: true },
    );

    expect(failed).toContain("Tools");
    expect(failed).toContain("2 calls");
    expect(failed).toContain("1 failed");
    expect(failed).toContain("read src/config.ts");
    expect(failed).toContain("tests failed");
    expect(failed).toContain("outer failure details");
    expect(done).toContain("Done");
    expect(done).not.toContain("quiet outer return");
    expect(expandedDone).toContain("quiet outer return");
  });

  it("dims compact bash commands and folds dynamic JSON without exposing strings", () => {
    const tool = toolFor(stateFor("compact"));
    const args = { code: "await Promise.all([]);", strings: { outer: "outer-secret" } };
    const payload = `prefix-${"x".repeat(320)}-dynamic-tail`;
    const details = {
      success: true,
      audits: [
        {
          ref: "pi.bash",
          provider: "pi",
          tool: "bash",
          args: { command: "echo alpha\necho beta" },
          result: { output: "bash result" },
          success: true,
        },
        {
          ref: "mcp.remote.call",
          provider: "mcp",
          tool: "remote.call",
          args: { strings: "hidden-string-payload", query: "needle", payload },
          success: true,
        },
      ],
      phases: [],
    };

    const collapsed = renderResult(tool, args, details, "", { theme: semanticTheme });
    const expanded = renderResult(tool, args, details, "", { expanded: true, theme: semanticTheme, width: 640 });

    expect(collapsed).toContain("<toolTitle><bold>bash</bold></toolTitle>");
    expect(collapsed).toContain("<dim>$</dim>");
    expect(collapsed).toContain("<dim>echo alpha</dim>");
    expect(collapsed).not.toContain("hidden-string-payload");
    expect(collapsed).not.toContain("outer-secret");
    expect(collapsed).toContain('"query":"needle"');
    expect(collapsed).toContain("to expand");
    expect(expanded).toContain("dynamic-tail");
    expect(expanded).not.toContain("hidden-string-payload");
    const narrow = renderResult(tool, args, details, "", {
      expanded: true,
      theme: semanticTheme,
      width: 48,
    });
    expect(narrow).toContain("dynamic-tail");
    expect(narrow.split("\n").length).toBeGreaterThan(expanded.split("\n").length);
  });

  it("renders compact JSON for live dynamic multicalls without strings", () => {
    const rendered = renderResult(
      toolFor(stateFor("compact")),
      { code: "await Promise.all([]);" },
      {
        audits: [
          {
            ref: "pi.read",
            provider: "pi",
            tool: "read",
            args: { path: "src/example.ts" },
            success: true,
          },
          {
            ref: "extensions.remote",
            provider: "extensions",
            tool: "remote",
            args: { strings: "hidden-live-string", query: "needle", payload: "x".repeat(400) },
          },
        ],
        phases: [],
      },
      "",
      { partial: true },
    );

    expect(rendered).toContain('"query":"needle"');
    expect(rendered).toContain("to expand");
    expect(rendered).not.toContain("hidden-live-string");
  });

  it("keeps live single dynamic arguments compact and string-safe", () => {
    const payload = `live-${"x".repeat(400)}-tail`;
    const details = {
      audits: [
        {
          ref: "extensions.remote",
          provider: "extensions",
          tool: "remote",
          args: { strings: "hidden-single-string", payload },
        },
      ],
      phases: [],
    };
    const collapsed = renderResult(
      toolFor(stateFor("compact")),
      { code: "await extensions.remote({});" },
      details,
      "",
      { partial: true },
    );
    const expanded = renderResult(
      toolFor(stateFor("compact")),
      { code: "await extensions.remote({});" },
      details,
      "",
      { partial: true, expanded: true, width: 640 },
    );

    expect(collapsed).toContain('"payload":"live-');
    expect(collapsed).toContain("to expand");
    expect(collapsed).not.toContain("hidden-single-string");
    expect(expanded).toContain("live-");
    expect(expanded).toContain("-tail");
    expect(expanded).not.toContain("hidden-single-string");
  });

  it("keeps cached MCP headlines out of compact dynamic details", () => {
    const args = { code: "await mcp.remote.lookup({});" };
    const liveDetails = {
      audits: [
        {
          ref: "mcp.remote.lookup",
          provider: "mcp",
          tool: "lookup",
          args: { strings: "hidden-mcp-string" },
        },
      ],
      phases: [],
    };
    const completedDetails = {
      success: true,
      audits: [
        {
          ref: "mcp.remote.lookup",
          provider: "mcp",
          tool: "lookup",
          args: {},
          success: true,
        },
      ],
      phases: [],
    };
    const renderCompleted = (mode: "full" | "compact") => {
      const state = stateFor(mode);
      const rendererState = {};
      const tool = toolFor(state);
      renderResult(tool, args, liveDetails, "", { partial: true, context: { state: rendererState } });
      return renderResult(tool, args, completedDetails, "", { context: { state: rendererState } });
    };

    const full = renderCompleted("full");
    const compact = renderCompleted("compact");

    expect(full).toContain("hidden-mcp-string");
    expect(compact).toContain("lookup");
    expect(compact).not.toContain("hidden-mcp-string");
  });

  it("renders compact JSON for Fabric-provider calls", () => {
    const rendered = renderResult(
      toolFor(stateFor("compact")),
      { code: "await fabric.workflow.parallel([]);" },
      {
        success: true,
        audits: [
          {
            ref: "fabric.workflow.parallel",
            provider: "fabric",
            tool: "workflow.parallel",
            args: { itemCount: 2, strings: "hidden-fabric-string" },
            success: true,
          },
        ],
        phases: [],
      },
      "",
    );

    expect(rendered).toContain('"itemCount":2');
    expect(rendered).not.toContain("hidden-fabric-string");
  });

  it("adds an expansion affordance when collapsed dynamic JSON is width-clipped", () => {
    const payload = `narrow-${"x".repeat(180)}-tail`;
    const details = {
      success: true,
      audits: [
        {
          ref: "extensions.remote",
          provider: "extensions",
          tool: "remote",
          args: { payload },
          success: true,
        },
      ],
      phases: [],
    };
    const args = { code: "await extensions.remote({});" };
    const wide = renderResult(toolFor(stateFor("compact")), args, details, "", { width: 640 });
    const narrow = renderResult(toolFor(stateFor("compact")), args, details, "", { width: 48 });
    const liveNarrow = renderResult(toolFor(stateFor("compact")), args, details, "", {
      partial: true,
      width: 48,
    });

    expect(wide).toContain("-tail");
    for (const rendered of [narrow, liveNarrow]) {
      expect(rendered).toContain("detail hidden");
      expect(rendered).toContain("to expand");
      expect(rendered).not.toContain("-tail");
    }
  });

  it("keeps failed dynamic arguments auditable in completed compact results", () => {
    const rendered = renderResult(
      toolFor(stateFor("compact")),
      { code: "await extensions.remote({});" },
      {
        success: false,
        audits: [
          {
            ref: "extensions.remote",
            provider: "extensions",
            tool: "remote",
            args: { strings: "hidden-completed-failure-string", query: "needle" },
            success: false,
            error: "remote request failed",
          },
        ],
        phases: [],
      },
      "outer failure",
    );

    expect(rendered).toContain('"query":"needle"');
    expect(rendered).toContain("remote request failed");
    expect(rendered).not.toContain("hidden-completed-failure-string");
  });

  it("retains failed live dynamic details in compact mode", () => {
    const rendered = renderResult(
      toolFor(stateFor("compact")),
      { code: "await extensions.remote({});" },
      {
        audits: [
          {
            ref: "extensions.remote",
            provider: "extensions",
            tool: "remote",
            args: { strings: "hidden-live-failure-string", query: "needle" },
            success: false,
            error: "remote request failed",
          },
        ],
        phases: [],
      },
      "",
      { partial: true },
    );

    expect(rendered).toContain("remote request failed");
    expect(rendered).not.toContain("hidden-live-failure-string");
  });

  it("renders persisted dynamic trace arguments in compact expanded detail", () => {
    const payload = `persisted-${"x".repeat(320)}-tail`;
    const rendered = renderResult(
      toolFor(stateFor("compact")),
      { code: "await mcp.remote.call({ query: 'needle' });" },
      {
        success: true,
        trace: {
          kind: "pi-fabric.execution",
          version: 1,
          outcome: "succeeded",
          phases: [],
          counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
          operations: [
            {
              type: "call",
              sequence: 0,
              ref: "mcp.remote.call",
              provider: "mcp",
              action: "remote.call",
              args: { query: "needle", payload },
              outcome: "succeeded",
            },
          ],
        },
      },
      "",
      { expanded: true, width: 640 },
    );

    expect(rendered).toContain("persisted-");
    expect(rendered).toContain("-tail");
  });

  it("keeps full dynamic string headlines while compact rendering suppresses them", () => {
    const args = { code: "await tools.call({ ref: 'extensions.secret', args: {} });" };
    const details = {
      success: true,
      audits: [
        {
          ref: "extensions.secret",
          provider: "extensions",
          tool: "secret",
          args: { strings: "hidden-string-payload" },
          success: true,
        },
      ],
      phases: [],
    };

    const full = renderResult(toolFor(stateFor("full")), args, details, "");
    const compact = renderResult(toolFor(stateFor("compact")), args, details, "");

    expect(full).toContain("hidden-string-payload");
    expect(compact).not.toContain("hidden-string-payload");
    expect(compact).not.toContain("cached-secret-headline");
  });

  it("does not use dynamic strings as compact title fallbacks", () => {
    const rendered = renderResult(
      toolFor(stateFor("compact")),
      { code: "await tools.call({ ref: 'extensions.secret', args: {} });" },
      {
        success: true,
        audits: [
          {
            ref: "extensions.secret",
            provider: "extensions",
            tool: "secret",
            args: { strings: "hidden-string-payload" },
            previewHeadline: "cached-secret-headline",
            success: true,
          },
        ],
        phases: [],
      },
      "",
    );

    expect(rendered).toContain("secret");
    expect(rendered).not.toContain("hidden-string-payload");
  });

  it("retains compact phases, read hints, and formatted expanded returns", () => {
    const tool = toolFor(stateFor("compact"));
    const args = { code: "await pi.read({ path: 'src/example.ts' });" };
    const details = {
      success: true,
      phases: ["Inspect", "Verify"],
      outputFormat: "json",
      outputFormatStartLine: 0,
      outputFormatLines: 1,
      audits: [
        {
          ref: "pi.read",
          provider: "pi",
          tool: "read",
          args: { path: "src/example.ts" },
          result: "first\nsecond\nthird",
          success: true,
        },
      ],
    };

    const collapsed = renderResult(tool, args, details, "first", { theme: semanticTheme });
    const expanded = renderResult(tool, args, details, '{"value":true}', {
      expanded: true,
      theme: semanticTheme,
    });

    expect(collapsed).toContain("2 phases");
    expect(collapsed).toContain("◆ Inspect");
    expect(collapsed).toContain("→ 1 of 3 lines to model");
    expect(expanded).toContain("↩ return");
    expect(expanded).toContain('{"value":true}');
  });

  it("keeps outer strings hidden while retaining the specialized write preview", () => {
    const args = {
      code: 'await pi.write({ path: "README.md", content: π.content });',
      strings: { content: "# Visible write preview", secret: "never-show-this" },
      display: { name: "Update README" },
    };
    const tool = toolFor(stateFor("compact"));
    const preview = tool.renderCall!(
      args as never,
      plainTheme,
      renderContext(args, { executionStarted: false }) as never,
    ).render(120).join("\n");

    expect(preview).toContain("Update README");
    expect(preview).toContain("README.md");
    expect(preview).toContain("Visible write preview");
    expect(preview).not.toContain("never-show-this");
    expect(preview).not.toContain("await pi.write");
  });

  it("retains collapsed single-bash outcomes and multi-call write previews", () => {
    const tool = toolFor(stateFor("compact"));
    const args = { code: "await Promise.all([]);" };
    const bash = renderResult(
      tool,
      args,
      {
        success: true,
        audits: [
          {
            ref: "pi.bash",
            provider: "pi",
            tool: "bash",
            args: { command: "echo first\necho second" },
            result: { output: "bash outcome" },
            success: true,
          },
        ],
        phases: [],
      },
      "",
      { theme: semanticTheme },
    );
    const write = renderResult(
      tool,
      args,
      {
        success: true,
        audits: [
          {
            ref: "pi.read",
            provider: "pi",
            tool: "read",
            args: { path: "src/example.ts" },
            result: "export const source = true;",
            success: true,
          },
          {
            ref: "pi.write",
            provider: "pi",
            tool: "write",
            args: { path: "src/output.ts", content: "export const preview = true;" },
            result: { output: "wrote" },
            success: true,
          },
        ],
        phases: [],
      },
      "",
      { theme: semanticTheme },
    );

    expect(bash).toContain("<dim>echo first</dim>");
    expect(bash).toContain("<dim>echo second</dim>");
    expect(bash).toContain("bash outcome");
    expect(write).toContain("src/output.ts");
    expect(write).toContain("preview = true");
  });

  it("keeps specialized core details stable except for dimmed compact bash commands", () => {
    const args = { code: "await Promise.all([]);" };
    const details = {
      success: true,
      audits: [
        {
          ref: "pi.bash",
          provider: "pi",
          tool: "bash",
          args: { command: "echo first\necho second" },
          result: { output: "bash outcome" },
          success: true,
        },
        {
          ref: "pi.grep",
          provider: "pi",
          tool: "grep",
          args: { pattern: "needle", path: "src", literal: true },
          result: { output: "src/example.ts:1: needle" },
          success: true,
        },
      ],
      phases: [],
    };

    const full = renderResult(toolFor(stateFor("full")), args, details, "", {
      expanded: true,
      theme: semanticTheme,
    });
    const compact = renderResult(toolFor(stateFor("compact")), args, details, "", {
      expanded: true,
      theme: semanticTheme,
    });

    expect(full).toContain("<accent>echo first</accent>");
    expect(compact).toContain("<dim>echo first</dim>");
    expect(compact).toContain("<dim>echo second</dim>");
    expect(full).toContain("<accent>/needle/</accent>");
    expect(compact).toContain("<accent>/needle/</accent>");
    expect(full).toContain("<accent>src/example.ts</accent>");
    expect(compact).toContain("<accent>src/example.ts</accent>");
    expect(full).toContain("<toolOutput>needle</toolOutput>");
    expect(compact).toContain("<toolOutput>needle</toolOutput>");
    expect(full).toContain("bash outcome");
    expect(compact).toContain("bash outcome");
  });

  it("keeps agent bash previews quiet in compact mode without hiding their outcome", () => {
    const args = { code: "await agents.wait({ id: 'child' });" };
    const details = {
      success: true,
      audits: [
        {
          ref: "agents.wait",
          provider: "agents",
          tool: "wait",
          args: { id: "child" },
          success: true,
          preview: {
            kind: "fabric-agent-tools",
            id: "child",
            name: "researcher",
            status: "completed",
            owner: "agent",
            tools: [
              {
                id: "child-bash",
                kind: "tool",
                label: "bash",
                toolName: "bash",
                status: "completed",
                args: { command: "echo parent\necho child" },
                result: { output: "child outcome" },
              },
            ],
          },
        },
      ],
      phases: [],
    };

    const full = renderResult(toolFor(stateFor("full")), args, details, "", {
      expanded: true,
      theme: semanticTheme,
    });
    const compact = renderResult(toolFor(stateFor("compact")), args, details, "", {
      expanded: true,
      theme: semanticTheme,
    });

    expect(full).toContain("<accent>echo child</accent>");
    expect(compact).toContain("<dim>echo child</dim>");
    expect(compact).toContain("child outcome");
  });

  it("invalidates completed cards so their current display preference redraws immediately", () => {
    const state = stateFor("full");
    const display = new FabricToolDisplayController();
    const tool = toolFor(state, display);
    const args = { code: "const currentPresentation = true;" };
    const context = renderContext(args);
    const resultContext = renderContext(args);
    const result = {
      content: [] as Array<{ type: "text"; text: string }>,
      details: { success: true, audits: [], phases: [] },
    };

    const full = tool.renderCall!(args as never, plainTheme, context as never).render(120).join("\n");
    const fullResult = tool.renderResult!(
      result as never,
      { expanded: false, isPartial: false },
      plainTheme,
      resultContext as never,
    ).render(120).join("\n");
    (state.config.ui as { toolDisplay: "full" | "compact" }).toolDisplay = "compact";
    display.refresh();
    const compact = tool.renderCall!(args as never, plainTheme, context as never).render(120).join("\n");
    const compactResult = tool.renderResult!(
      result as never,
      { expanded: false, isPartial: false },
      plainTheme,
      resultContext as never,
    ).render(120).join("\n");

    expect(full).toContain("currentPresentation");
    expect(fullResult).toContain("Fabric");
    expect(context.invalidate).toHaveBeenCalledOnce();
    expect(resultContext.invalidate).toHaveBeenCalledOnce();
    expect(compact).not.toContain("currentPresentation");
    expect(compactResult).toContain("Done");
  });
});
