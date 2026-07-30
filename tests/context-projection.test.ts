import { describe, expect, it } from "vitest";
import { projectCompletedFabricCallArguments } from "../src/context-projection.js";

const assistant = (id: string, code: string) => ({
  role: "assistant",
  content: [{
    type: "toolCall",
    id,
    name: "fabric_exec",
    arguments: {
      code,
      strings: { payload: "large payload".repeat(100) },
      display: { name: `Call ${id}`, description: "Inspect and verify" },
    },
  }],
});

const result = (id: string, ref: string, args: Record<string, unknown>) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "fabric_exec",
  content: [{ type: "text", text: "result evidence" }],
  details: {
    trace: {
      operations: [{ ref, args, outcome: "succeeded" }],
    },
  },
});

describe("Fabric context projection", () => {
  it("projects old completed call arguments while retaining the two newest calls", () => {
    const messages = [
      assistant("call-1", "const source = await pi.read('/tmp/source.ts'); return source;".repeat(20)),
      result("call-1", "pi.read", { path: "src/source.ts", offset: 20, limit: 80 }),
      assistant("call-2", "const hits = await pi.grep('target', 'src'); return hits;".repeat(20)),
      result("call-2", "pi.grep", { path: "src", pattern: "target" }),
      assistant("call-3", "const test = await pi.bash({cmd:'npm test'}); return test.output;".repeat(20)),
      result("call-3", "pi.bash", { command: "npm test" }),
    ];
    const original = structuredClone(messages);

    const projected = projectCompletedFabricCallArguments(messages, 2);

    expect(projected).toBeDefined();
    const firstArgs = (projected![0]!.content[0] as { arguments: Record<string, unknown> }).arguments;
    expect(firstArgs.code).toContain("completed fabric_exec: pi.read");
    expect(firstArgs.code).toContain('path="src/source.ts"');
    expect(firstArgs).not.toHaveProperty("strings");
    expect(firstArgs.display).toEqual({ name: "Call call-1", description: "Inspect and verify" });
    expect(projected![2]).toEqual(messages[2]);
    expect(projected![4]).toEqual(messages[4]);
    expect(messages).toEqual(original);
  });

  it("projects successful calls immediately without projecting repairable failures", () => {
    const successful = [
      assistant("success", "return await pi.read('src/large.ts');".repeat(40)),
      result("success", "pi.read", { path: "src/large.ts" }),
    ];
    expect(projectCompletedFabricCallArguments(successful)).toBeDefined();

    const failedResult = { ...result("failure", "pi.read", { path: "src/large.ts" }), isError: true };
    const failed = [
      assistant("failure", "return await pi.read('src/large.ts');".repeat(40)),
      failedResult,
    ];
    expect(projectCompletedFabricCallArguments(failed)).toBeUndefined();
  });

  it("leaves incomplete and already-compact calls unchanged", () => {
    const incomplete = [assistant("pending", "return await pi.read('x');")];
    expect(projectCompletedFabricCallArguments(incomplete)).toBeUndefined();

    const tinyAssistant = (id: string) => ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "fabric_exec", arguments: { code: "return 1;" } }],
    });
    const compact = [
      tinyAssistant("old"),
      result("old", "pi.read", { path: "x" }),
      tinyAssistant("new-1"),
      result("new-1", "pi.read", { path: "y" }),
      tinyAssistant("new-2"),
      result("new-2", "pi.read", { path: "z" }),
    ];
    expect(projectCompletedFabricCallArguments(compact)).toBeUndefined();
  });
});
