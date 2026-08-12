import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  LEXICAL_BUCKETS,
  hashValueInto,
  type LabIntervention,
  type LabSession,
  type LabUserEvent,
  type LabTool,
  type LabTurn,
} from "./surprise-lab.js";

export const SWE_CHAT_DATASET = "SALT-NLP/SWE-chat";
export const SWE_CHAT_REVISION = "f66cca95b14caaa4177f7ed5eaa424608dadcffa";
export const SWE_CHAT_LICENSE = "ODC-BY-1.0";
export const SWE_CHAT_LABEL_CONFIDENCE = 0.79;
export const SWE_CHAT_TRAIN_BEFORE_MS = Date.parse("2026-03-07T10:49:43.704Z");
export const SWE_CHAT_VALIDATION_BEFORE_MS = Date.parse("2026-03-22T17:19:05.523Z");

export interface SweChatPaths {
  conversations: string;
  sessions: string;
}

export interface SweChatLoadOptions {
  conversations: string;
  sessions: string;
  repositoryLimit?: number;
  sessionLimit?: number;
  agent?: string;
  split?: SweChatSplitName;
  splitMode?: "chronological" | "repository";
  seed?: number;
  duckdb?: string;
}

export type SweChatSplitName = "train" | "validation" | "test";

export interface SweChatSplit {
  train: LabSession[];
  validation: LabSession[];
  test: LabSession[];
}

export interface SweChatRow {
  session_id: string;
  repo_id: string;
  agent: string | null;
  turn_number: number;
  turn_type: string;
  content: string | null;
  timestamp_ms: number;
  input_tokens: number;
  output_tokens: number;
  tool_name: string | null;
  tool_call_id: string | null;
  file_path: string | null;
  command: string | null;
  pattern: string | null;
  tool_input_json: string | null;
  category: string | null;
  bash_category: string | null;
  queue_op_subtype: string | null;
  prompt_pushback: string | null;
}

interface SessionBuilder {
  id: string;
  project: string;
  agent: string;
  turns: LabTurn[];
  current: LabTurn | undefined;
  lastToolTurn: LabTurn | undefined;
  calls: Map<string, { tool: LabTool; turn: LabTurn }>;
  pendingCalls: Set<string>;
  users: LabUserEvent[];
  interventions: LabIntervention[];
  seenQueued: Set<string>;
  startedMs: number;
  endedMs: number;
}

const quoteSql = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const numeric = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string => typeof value === "string" ? value : "";

export const defaultSweChatPaths = (root = process.cwd()): SweChatPaths => {
  const cache = path.join(root, "node_modules", ".cache", "pi-fabric-datasets", "swe-chat");
  return {
    conversations: path.join(cache, "conversations.parquet"),
    sessions: path.join(cache, "sessions.parquet"),
  };
};

export const requireSweChatPaths = (paths: SweChatPaths): void => {
  for (const [name, file] of Object.entries(paths)) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing SWE-chat ${name} table at ${file}. Run pnpm run surprise:swe-chat:download first.`);
    }
  }
};

const repositoryBucket = (repository: string, seed: number): number => {
  const firstNibble = createHash("sha256").update(`${repository}:${seed}`).digest("hex")[0];
  return Number.parseInt(firstNibble ?? "0", 16);
};

export const sweChatRepositorySplit = (repository: string, seed = 42): SweChatSplitName => {
  const bucket = repositoryBucket(repository, seed);
  if (bucket < 10) return "train";
  if (bucket < 13) return "validation";
  return "test";
};

export const splitSweChatByRepository = (
  sessions: readonly LabSession[],
  seed = 42,
): SweChatSplit => {
  const split: SweChatSplit = { train: [], validation: [], test: [] };
  for (const session of sessions) split[sweChatRepositorySplit(session.project, seed)].push(session);
  for (const values of [split.train, split.validation, split.test]) {
    values.sort((left, right) => left.startedMs - right.startedMs || left.id.localeCompare(right.id));
  }
  return split;
};

const parseJson = (value: string | null): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const sweChatResultIsError = (content: string): boolean => {
  const lower = content.toLowerCase();
  if (/\b(?:0 errors?|0 failures?|passed|all tests pass|exit code 0|success(?:ful(?:ly)?)?|no issues)\b/.test(lower)) {
    return false;
  }
  return /(?:\b(?:error|failed|failure|exception|traceback|fatal|panic)\b|exit code [1-9]|command failed|not found)/.test(lower);
};

const newTurn = (atMs: number): LabTurn => ({
  tools: [],
  stopReason: "toolUse",
  startedMs: atMs,
  messageEndedMs: atMs,
  completedMs: atMs,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  textChars: 0,
  thinkingChars: 0,
  lexical: new Uint16Array(LEXICAL_BUCKETS),
});

const builderFor = (row: SweChatRow): SessionBuilder => ({
  id: row.session_id,
  project: row.repo_id,
  agent: row.agent ?? "unknown",
  turns: [],
  current: undefined,
  lastToolTurn: undefined,
  calls: new Map(),
  pendingCalls: new Set(),
  users: [],
  interventions: [],
  seenQueued: new Set(),
  startedMs: row.timestamp_ms,
  endedMs: row.timestamp_ms,
});

const ensureCurrent = (builder: SessionBuilder, atMs: number): LabTurn => {
  if (!builder.current) builder.current = newTurn(atMs);
  builder.current.startedMs = Math.min(builder.current.startedMs || atMs, atMs);
  builder.current.completedMs = Math.max(builder.current.completedMs, atMs);
  return builder.current;
};

const closeTurn = (
  builder: SessionBuilder,
  atMs: number,
  stopReason: string,
  content = "",
): void => {
  const turn = ensureCurrent(builder, atMs);
  if (stopReason === "stop" && turn.tools.length === 0 && content.length === 0) return;
  turn.stopReason = stopReason;
  turn.messageEndedMs = Math.max(turn.messageEndedMs, atMs);
  turn.completedMs = Math.max(turn.completedMs, atMs);
  turn.textChars += content.length;
  hashValueInto(turn.lexical, content);
  builder.turns.push(turn);
  builder.current = undefined;
  builder.lastToolTurn = stopReason === "toolUse" ? turn : undefined;
  builder.pendingCalls.clear();
};

const interventionKind = (label: string): LabIntervention["kind"] | undefined => {
  if (label === "correction") return "correction";
  if (label === "rejection") return "rejection";
  if (label === "failure_report") return "failureReport";
  return undefined;
};

const addSoftIntervention = (builder: SessionBuilder, row: SweChatRow): void => {
  const kind = interventionKind(row.prompt_pushback ?? "");
  if (!kind || builder.turns.length === 0) return;
  builder.interventions.push({
    turn: builder.turns.length,
    kind,
    atMs: row.timestamp_ms,
    provenance: "weak",
    confidence: SWE_CHAT_LABEL_CONFIDENCE,
  });
};

const addObservedBusyInput = (builder: SessionBuilder, row: SweChatRow): void => {
  if (row.queue_op_subtype !== "user_prompt_enqueued") return;
  const content = text(row.content).trim();
  if (!content || content.includes("<agent-notification>") || content.includes("<task-notification>")) return;
  const key = content.toLowerCase().replace(/\s+/g, " ");
  if (builder.seenQueued.has(key)) return;
  builder.seenQueued.add(key);
  const turn = builder.turns.length;
  if (turn === 0) return;
  builder.interventions.push({
    turn,
    kind: "steer",
    atMs: row.timestamp_ms,
    provenance: "observed",
    confidence: 1,
  });
};

const acceptRow = (builder: SessionBuilder, row: SweChatRow): void => {
  builder.startedMs = Math.min(builder.startedMs || row.timestamp_ms, row.timestamp_ms);
  builder.endedMs = Math.max(builder.endedMs, row.timestamp_ms);
  if (row.turn_type === "user_prompt") {
    addSoftIntervention(builder, row);
    builder.users.push({
      beforeTurn: builder.turns.length,
      kind: builder.turns.length === 0 ? "initial" : "followUp",
      atMs: row.timestamp_ms,
    });
    builder.lastToolTurn = undefined;
    return;
  }
  if (row.turn_type === "queue_operation") {
    addObservedBusyInput(builder, row);
    builder.lastToolTurn = undefined;
    return;
  }
  if (row.turn_type === "tool_use") {
    const turn = ensureCurrent(builder, row.timestamp_ms);
    const supplied = parseJson(row.tool_input_json);
    const args = {
      ...supplied,
      ...(row.file_path ? { file_path: row.file_path } : {}),
      ...(row.command ? { command: row.command } : {}),
      ...(row.pattern ? { pattern: row.pattern } : {}),
      ...(row.category ? { category: row.category } : {}),
      ...(row.bash_category ? { bash_category: row.bash_category } : {}),
    };
    const tool: LabTool = {
      id: row.tool_call_id ?? `${row.session_id}:${row.turn_number}`,
      name: row.tool_name ?? "unknown",
      args,
      isError: false,
      completedMs: row.timestamp_ms,
    };
    turn.tools.push(tool);
    hashValueInto(turn.lexical, tool.name);
    hashValueInto(turn.lexical, args);
    builder.calls.set(tool.id, { tool, turn });
    builder.pendingCalls.add(tool.id);
    return;
  }
  if (row.turn_type === "tool_result") {
    const result = text(row.content);
    const call = row.tool_call_id ? builder.calls.get(row.tool_call_id) : undefined;
    if (call) {
      call.tool.isError = sweChatResultIsError(result);
      call.tool.completedMs = Math.max(call.tool.completedMs, row.timestamp_ms);
      call.turn.completedMs = Math.max(call.turn.completedMs, row.timestamp_ms);
      hashValueInto(call.turn.lexical, result);
      builder.pendingCalls.delete(call.tool.id);
      if (builder.pendingCalls.size === 0 && builder.current === call.turn) {
        closeTurn(builder, row.timestamp_ms, "toolUse");
      }
    }
    return;
  }
  if (row.turn_type === "assistant_thinking") {
    const turn = ensureCurrent(builder, row.timestamp_ms);
    const content = text(row.content);
    turn.thinkingChars += content.length;
    hashValueInto(turn.lexical, content);
    return;
  }
  if (row.turn_type === "assistant_response") {
    const content = text(row.content);
    const target = builder.current ?? builder.lastToolTurn;
    if (target) {
      target.inputTokens += numeric(row.input_tokens);
      target.outputTokens += numeric(row.output_tokens);
      target.messageEndedMs = Math.max(target.messageEndedMs, row.timestamp_ms);
      target.completedMs = Math.max(target.completedMs, row.timestamp_ms);
      if (content.length > 0) {
        target.textChars += content.length;
        hashValueInto(target.lexical, content);
      }
      if (builder.lastToolTurn === target) {
        target.stopReason = "stop";
        builder.lastToolTurn = undefined;
      }
    } else if (content.length > 0) {
      const turn = ensureCurrent(builder, row.timestamp_ms);
      turn.inputTokens += numeric(row.input_tokens);
      turn.outputTokens += numeric(row.output_tokens);
      closeTurn(builder, row.timestamp_ms, "stop", content);
    }
  }
};

const finish = (builder: SessionBuilder): LabSession | undefined => {
  if (builder.current && (builder.current.tools.length > 0 || builder.current.textChars > 0 || builder.current.thinkingChars > 0)) {
    builder.current.stopReason = "unknown";
    builder.turns.push(builder.current);
  }
  if (builder.turns.length === 0) return undefined;
  const maximumTurn = builder.turns.length;
  const interventions = builder.interventions
    .filter((entry) => entry.turn > 0 && entry.turn <= maximumTurn)
    .sort((left, right) => left.turn - right.turn || left.atMs - right.atMs);
  return {
    id: `swe-chat:${builder.id}`,
    project: builder.project,
    cwd: `/swe-chat/${builder.project}`,
    source: `${SWE_CHAT_DATASET}@${SWE_CHAT_REVISION}`,
    agent: builder.agent,
    startedMs: builder.startedMs,
    endedMs: builder.endedMs,
    turns: builder.turns,
    users: builder.users,
    interventions,
  };
};

export const buildSweChatSessions = (rows: readonly SweChatRow[]): LabSession[] => {
  const sessions: LabSession[] = [];
  let builder: SessionBuilder | undefined;
  const ordered = [...rows].sort((left, right) =>
    left.session_id.localeCompare(right.session_id) || left.turn_number - right.turn_number
  );
  for (const row of ordered) {
    if (!builder || builder.id !== row.session_id) {
      if (builder) {
        const session = finish(builder);
        if (session) sessions.push(session);
      }
      builder = builderFor(row);
    }
    acceptRow(builder, row);
  }
  if (builder) {
    const session = finish(builder);
    if (session) sessions.push(session);
  }
  return sessions.sort((left, right) => left.startedMs - right.startedMs || left.id.localeCompare(right.id));
};

const repositoryFilter = (options: SweChatLoadOptions): string => {
  if (options.splitMode !== "repository" || !options.split) return "";
  const seed = options.seed ?? 42;
  const nibble = `strpos('0123456789abcdef', substr(sha256(repo_id || ':' || ${quoteSql(String(seed))}), 1, 1)) - 1`;
  return `WHERE CASE WHEN ${nibble} < 10 THEN 'train' WHEN ${nibble} < 13 THEN 'validation' ELSE 'test' END = ${quoteSql(options.split)}`;
};

const chronologicalFilter = (options: SweChatLoadOptions, timestamp = "started_at"): string => {
  if ((options.splitMode ?? "chronological") !== "chronological" || !options.split) return "";
  const train = SWE_CHAT_TRAIN_BEFORE_MS;
  const validation = SWE_CHAT_VALIDATION_BEFORE_MS;
  if (options.split === "train") return `AND epoch_ms(${timestamp}) < ${train}`;
  if (options.split === "validation") return `AND epoch_ms(${timestamp}) >= ${train} AND epoch_ms(${timestamp}) < ${validation}`;
  return `AND epoch_ms(${timestamp}) >= ${validation}`;
};

const selectedRepositories = (options: SweChatLoadOptions): string => {
  const conversations = quoteSql(path.resolve(options.conversations));
  const splitClause = repositoryFilter(options);
  const agentClause = options.agent ? `AND agent = ${quoteSql(options.agent)}` : "";
  const limit = Math.max(1, Math.floor(options.repositoryLimit ?? Number.MAX_SAFE_INTEGER));
  return `SELECT repo_id FROM (SELECT repo_id, agent, session_id FROM read_parquet(${conversations}) WHERE repo_id IS NOT NULL ${agentClause}) candidates ${splitClause} GROUP BY repo_id ORDER BY count(DISTINCT session_id) DESC, repo_id LIMIT ${limit}`;
};

const extractionSql = (options: SweChatLoadOptions): string => {
  const conversations = quoteSql(path.resolve(options.conversations));
  const sessions = quoteSql(path.resolve(options.sessions));
  const repositories = selectedRepositories(options);
  const agentClause = options.agent ? `AND c.agent = ${quoteSql(options.agent)}` : "";
  const sessionLimit = Math.max(1, Math.floor(options.sessionLimit ?? Number.MAX_SAFE_INTEGER));
  return `
COPY (
  SELECT base64(encode(cast(to_json(event) AS VARCHAR))) AS payload
  FROM (
  WITH selected_repositories AS (${repositories}),
  selected_sessions AS (
    SELECT c.session_id, min(c.timestamp) AS started_at
    FROM read_parquet(${conversations}) c
    JOIN selected_repositories r USING (repo_id)
    JOIN read_parquet(${sessions}) s USING (session_id)
    WHERE c.timestamp IS NOT NULL ${agentClause}
    GROUP BY c.session_id
    HAVING true ${chronologicalFilter(options, "min(c.timestamp)")}
    ORDER BY started_at, c.session_id
    LIMIT ${sessionLimit}
  )
  SELECT
    c.session_id,
    c.repo_id,
    c.agent,
    c.turn_number,
    c.turn_type,
    c.content,
    epoch_ms(c.timestamp)::BIGINT AS timestamp_ms,
    coalesce(c.input_tokens, 0)::BIGINT AS input_tokens,
    coalesce(c.output_tokens, 0)::BIGINT AS output_tokens,
    c.tool_name,
    c.tool_call_id,
    c.file_path,
    c.command,
    c.pattern,
    c.tool_input_json,
    c.category,
    c.bash_category,
    c.queue_op_subtype,
    c.prompt_pushback
  FROM read_parquet(${conversations}) c
  JOIN selected_sessions selected USING (session_id)
  WHERE c.timestamp IS NOT NULL
    AND (
      c.turn_type IN ('user_prompt', 'assistant_response', 'assistant_thinking', 'tool_use', 'tool_result')
      OR c.queue_op_subtype = 'user_prompt_enqueued'
    )
  ORDER BY c.session_id, c.turn_number
  ) event
) TO '/dev/stdout' (FORMAT CSV, HEADER false, QUOTE '', ESCAPE '');
`;
};

export const loadSweChatCorpus = async (options: SweChatLoadOptions): Promise<LabSession[]> => {
  requireSweChatPaths({ conversations: options.conversations, sessions: options.sessions });
  const process = spawn(options.duckdb ?? "duckdb", ["-init", "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.end(extractionSql(options));
  let stderr = "";
  process.stderr.setEncoding("utf8");
  process.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const sessions: LabSession[] = [];
  let builder: SessionBuilder | undefined;
  const lines = readline.createInterface({ input: process.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const encoded = Buffer.from(line, "base64").toString("utf8");
    const row = JSON.parse(encoded) as SweChatRow;
    if (!builder || builder.id !== row.session_id) {
      if (builder) {
        const session = finish(builder);
        if (session) sessions.push(session);
      }
      builder = builderFor(row);
    }
    acceptRow(builder, row);
  }
  if (builder) {
    const session = finish(builder);
    if (session) sessions.push(session);
  }
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    process.once("error", reject);
    process.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`DuckDB SWE-chat extraction failed (${exitCode}): ${stderr.trim()}`);
  return sessions.sort((left, right) => left.startedMs - right.startedMs || left.id.localeCompare(right.id));
};
