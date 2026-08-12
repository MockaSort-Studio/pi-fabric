import { describe, expect, it } from "vitest";
import {
  SWE_CHAT_LABEL_CONFIDENCE,
  buildSweChatSessions,
  splitSweChatByRepository,
  sweChatRepositorySplit,
  sweChatResultIsError,
  type SweChatRow,
} from "../scripts/swe-chat-lab.js";
import { buildLabRows } from "../scripts/surprise-lab.js";

const row = (
  turn_number: number,
  turn_type: string,
  overrides: Partial<SweChatRow> = {},
): SweChatRow => ({
  session_id: "session-1",
  repo_id: "owner/repo",
  agent: "Claude Code",
  turn_number,
  turn_type,
  content: "",
  timestamp_ms: 1_700_000_000_000 + turn_number * 1_000,
  input_tokens: 0,
  output_tokens: 0,
  tool_name: null,
  tool_call_id: null,
  file_path: null,
  command: null,
  pattern: null,
  tool_input_json: null,
  category: null,
  bash_category: null,
  queue_op_subtype: null,
  prompt_pushback: null,
  ...overrides,
});

describe("SWE-chat causal adapter", () => {
  it("places weak pushback labels after all preceding tool features", () => {
    const sessions = buildSweChatSessions([
      row(0, "user_prompt", { content: "fix it" }),
      row(1, "tool_use", {
        tool_name: "Edit",
        tool_call_id: "edit-1",
        file_path: "/workspace/a.ts",
        tool_input_json: JSON.stringify({ file_path: "/workspace/a.ts", old_string: "a", new_string: "b" }),
        category: "Action",
      }),
      row(2, "tool_result", { tool_name: "Edit", tool_call_id: "edit-1", content: "updated" }),
      row(3, "tool_use", {
        tool_name: "Bash",
        tool_call_id: "test-1",
        command: "pnpm test",
        tool_input_json: JSON.stringify({ command: "pnpm test" }),
        category: "Action",
        bash_category: "test/build",
      }),
      row(4, "tool_result", { tool_name: "Bash", tool_call_id: "test-1", content: "FAILED one test" }),
      row(5, "assistant_response", { content: "done", input_tokens: 100, output_tokens: 20 }),
      row(6, "user_prompt", { content: "that is still broken", prompt_pushback: "failure_report" }),
    ]);

    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.source).toContain("SALT-NLP/SWE-chat@");
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]?.tools[0]?.name).toBe("Edit");
    expect(session.turns[1]?.tools[0]?.isError).toBe(true);
    expect(session.users.map((user) => ({ beforeTurn: user.beforeTurn, kind: user.kind }))).toEqual([
      { beforeTurn: 0, kind: "initial" },
      { beforeTurn: 2, kind: "followUp" },
    ]);
    expect(session.interventions).toEqual([{
      turn: 2,
      kind: "failureReport",
      atMs: 1_700_000_006_000,
      provenance: "weak",
      confidence: SWE_CHAT_LABEL_CONFIDENCE,
    }]);
    const rows = buildLabRows(session);
    expect(rows[0]?.features.revisits).toBe(0);
    expect(rows[1]?.features.errors).toBe(1);
    expect(rows[1]?.features.inputTokensLog).toBeGreaterThan(6);
    expect(rows[0]?.features.actionWithoutResearch).toBeGreaterThan(0);
    expect(rows[1]?.features.verificationBurst).toBeGreaterThan(0);
    expect(rows[1]?.features.failedVerificationDebt).toBeGreaterThan(0);
  });

  it("deduplicates observed busy-run input and excludes subagent notifications", () => {
    const sessions = buildSweChatSessions([
      row(0, "tool_use", { tool_name: "Read", tool_call_id: "read-1", file_path: "/workspace/a.ts" }),
      row(1, "tool_result", { tool_name: "Read", tool_call_id: "read-1", content: "source" }),
      row(2, "queue_operation", { queue_op_subtype: "user_prompt_enqueued", content: "stop and check the test" }),
      row(3, "queue_operation", { queue_op_subtype: "user_prompt_enqueued", content: "stop and check the test" }),
      row(4, "queue_operation", {
        queue_op_subtype: "user_prompt_enqueued",
        content: "<agent-notification>completed</agent-notification>",
      }),
      row(5, "assistant_response", { content: "continuing" }),
    ]);

    expect(sessions[0]?.users.map((user) => user.kind)).toEqual([]);
    expect(sessions[0]?.interventions).toEqual([{
      turn: 1,
      kind: "steer",
      atMs: 1_700_000_002_000,
      provenance: "observed",
      confidence: 1,
    }]);
  });

  it("normalizes alternate file-path keys for revisit features", () => {
    const session = buildSweChatSessions([
      row(0, "tool_use", {
        tool_name: "read_file",
        tool_call_id: "read-1",
        file_path: "/workspace/a.ts",
        tool_input_json: JSON.stringify({ file_path: "/workspace/a.ts" }),
      }),
      row(1, "tool_result", { tool_call_id: "read-1", content: "source" }),
      row(2, "tool_use", {
        tool_name: "edit_file",
        tool_call_id: "edit-1",
        file_path: "/workspace/a.ts",
        tool_input_json: JSON.stringify({ file_path: "/workspace/a.ts" }),
      }),
      row(3, "tool_result", { tool_call_id: "edit-1", content: "updated" }),
    ])[0]!;
    expect(buildLabRows(session)[1]?.features.revisits).toBe(1);
  });

  it("uses repository-disjoint deterministic splits", () => {
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      ...buildSweChatSessions([
        row(0, "tool_use", {
          session_id: `session-${index}`,
          repo_id: `owner/repo-${index % 10}`,
          tool_name: "Read",
          tool_call_id: `read-${index}`,
        }),
        row(1, "tool_result", {
          session_id: `session-${index}`,
          repo_id: `owner/repo-${index % 10}`,
          tool_call_id: `read-${index}`,
          content: "ok",
        }),
      ])[0]!,
    }));
    const first = splitSweChatByRepository(sessions, 73);
    const second = splitSweChatByRepository(sessions, 73);
    expect(first).toEqual(second);
    const projects = [first.train, first.validation, first.test].map(
      (part) => new Set(part.map((session) => session.project)),
    );
    expect([...projects[0]!].some((project) => projects[1]!.has(project) || projects[2]!.has(project))).toBe(false);
    expect([...projects[1]!].some((project) => projects[2]!.has(project))).toBe(false);
    for (const session of sessions) {
      expect(first[sweChatRepositorySplit(session.project, 73)]).toContain(session);
    }
  });

  it("uses conservative tool-result error heuristics", () => {
    expect(sweChatResultIsError("FAILED 3 tests with exit code 1")).toBe(true);
    expect(sweChatResultIsError("Traceback: exception raised")).toBe(true);
    expect(sweChatResultIsError("0 errors, all tests passed")).toBe(false);
    expect(sweChatResultIsError("The file was updated successfully")).toBe(false);
  });
});
