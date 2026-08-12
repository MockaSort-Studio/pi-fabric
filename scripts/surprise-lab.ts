import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { SurpriseDetector } from "../src/core/surprise.js";

export type InterventionKind =
  | "steer"
  | "abort"
  | "terminalError"
  | "recovery"
  | "correction"
  | "rejection"
  | "failureReport";
export type InterventionProvenance = "observed" | "weak" | "heuristic";
export type UserKind = "initial" | "followUp" | "steer";

export const LEXICAL_BUCKETS = 128;
const MAX_HASHED_TOKENS = 512;

const tokenHash = (token: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % LEXICAL_BUCKETS;
};

export const hashValueInto = (target: Uint16Array, value: unknown): void => {
  let tokens = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (tokens >= MAX_HASHED_TOKENS || depth > 5) return;
    if (typeof entry === "string") {
      for (const match of entry.toLowerCase().matchAll(/[a-z0-9_./:-]{2,40}/g)) {
        const token = match[0];
        if (!token) continue;
        const bucket = tokenHash(token);
        target[bucket] = Math.min(65_535, (target[bucket] ?? 0) + 1);
        tokens += 1;
        if (tokens >= MAX_HASHED_TOKENS) break;
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const value of entry) visit(value, depth + 1);
      return;
    }
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : undefined;
    if (!record) return;
    for (const [key, nested] of Object.entries(record)) {
      visit(key, depth + 1);
      visit(nested, depth + 1);
    }
  };
  visit(value, 0);
};

export interface LabTool {
  id: string;
  name: string;
  args: unknown;
  isError: boolean;
  completedMs: number;
}

export interface LabTurn {
  tools: LabTool[];
  stopReason: string;
  startedMs: number;
  messageEndedMs: number;
  completedMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  textChars: number;
  thinkingChars: number;
  lexical: Uint16Array;
}

export interface LabUserEvent {
  beforeTurn: number;
  kind: UserKind;
  atMs: number;
}

export interface LabIntervention {
  turn: number;
  kind: InterventionKind;
  atMs: number;
  provenance?: InterventionProvenance;
  confidence?: number;
}

export interface LabSession {
  id: string;
  project: string;
  cwd: string;
  source?: string;
  agent?: string;
  startedMs: number;
  endedMs: number;
  turns: LabTurn[];
  users: LabUserEvent[];
  interventions: LabIntervention[];
}

export const STRONG_INTERVENTIONS: readonly InterventionKind[] = ["steer", "abort"];
export const SOFT_INTERVENTIONS: readonly InterventionKind[] = [
  "correction",
  "rejection",
  "failureReport",
];
export const HUMAN_INTERVENTIONS: readonly InterventionKind[] = [
  "steer",
  ...SOFT_INTERVENTIONS,
];
export const EXPANDED_INTERVENTIONS: readonly InterventionKind[] = [
  "steer",
  "abort",
  "terminalError",
  "recovery",
];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

const timestampMs = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const contentBlocks = (message: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(message.content)
    ? message.content.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined)
    : [];

const finiteNumber = (record: Record<string, unknown> | undefined, key: string): number => {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const blockChars = (blocks: readonly Record<string, unknown>[], type: string): number =>
  blocks
    .filter((block) => block.type === type)
    .reduce((sum, block) => {
      const value = type === "thinking" ? block.thinking : block.text;
      return sum + (typeof value === "string" ? value.length : 0);
    }, 0);

export const extractLabSession = async (
  file: string,
  project = path.basename(path.dirname(file)),
): Promise<LabSession | undefined> => {
  const turns: LabTurn[] = [];
  const users: LabUserEvent[] = [];
  const interventions: LabIntervention[] = [];
  const callsById = new Map<string, { tool: LabTool; turn: LabTurn }>();
  let cwd = "";
  let startedMs = 0;
  let endedMs = 0;
  let agentActive = false;
  let seenUser = false;
  let terminalTrouble = false;

  const stream = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (line.length > 2_000_000) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    if (!entry) continue;
    const at = timestampMs(entry.timestamp);
    if (at > 0) {
      if (startedMs === 0) startedMs = at;
      endedMs = at;
    }
    if (entry.type === "session") {
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message || typeof message.role !== "string") continue;

    if (message.role === "user") {
      const beforeTurn = turns.length;
      const userAt = timestampMs(message.timestamp) || at;
      let kind: UserKind;
      if (!seenUser) kind = "initial";
      else if (agentActive) kind = "steer";
      else kind = "followUp";
      users.push({ beforeTurn, kind, atMs: userAt });
      if (kind === "steer") interventions.push({ turn: beforeTurn, kind: "steer", atMs: userAt });
      if (kind === "followUp" && terminalTrouble) {
        interventions.push({ turn: beforeTurn, kind: "recovery", atMs: userAt });
      }
      seenUser = true;
      agentActive = true;
      terminalTrouble = false;
      continue;
    }

    if (message.role === "assistant") {
      const blocks = contentBlocks(message);
      const messageStart = timestampMs(message.timestamp) || at;
      const messageEnd = at || messageStart;
      const tools = blocks
        .filter((block) => block.type === "toolCall")
        .map((block): LabTool => ({
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          args: block.arguments,
          isError: false,
          completedMs: messageEnd,
        }));
      const usage = asRecord(message.usage);
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : "unknown";
      const turn = turns.length;
      const lexical = new Uint16Array(LEXICAL_BUCKETS);
      for (const tool of tools) {
        hashValueInto(lexical, tool.name);
        hashValueInto(lexical, tool.args);
      }
      for (const block of blocks) {
        if (block.type === "text" || block.type === "thinking") hashValueInto(lexical, block);
      }
      const turnRecord: LabTurn = {
        tools,
        stopReason,
        startedMs: messageStart,
        messageEndedMs: messageEnd,
        completedMs: messageEnd,
        inputTokens: finiteNumber(usage, "input"),
        outputTokens: finiteNumber(usage, "output"),
        reasoningTokens: finiteNumber(usage, "reasoning"),
        textChars: blockChars(blocks, "text"),
        thinkingChars: blockChars(blocks, "thinking"),
        lexical,
      };
      turns.push(turnRecord);
      for (const tool of tools) callsById.set(tool.id, { tool, turn: turnRecord });
      if (stopReason === "aborted") interventions.push({ turn, kind: "abort", atMs: messageEnd });
      if (stopReason === "error") interventions.push({ turn, kind: "terminalError", atMs: messageEnd });
      if (stopReason !== "toolUse") {
        const recentTrouble = turns
          .slice(Math.max(0, turns.length - 3), turns.length - 1)
          .some((candidate) => candidate.tools.some((tool) => tool.isError));
        terminalTrouble = stopReason === "aborted" || stopReason === "error" || recentTrouble;
        agentActive = false;
      }
      continue;
    }

    if (message.role === "toolResult") {
      const id = String(message.toolCallId ?? "");
      const call = callsById.get(id);
      if (call) {
        call.tool.isError = message.isError === true;
        call.tool.completedMs = Math.max(call.tool.completedMs, at);
        call.turn.completedMs = Math.max(call.turn.completedMs, at);
        hashValueInto(call.turn.lexical, message.content);
      }
    }
  }

  if (!cwd || turns.length === 0) return undefined;
  return {
    id: path.basename(file),
    project,
    cwd,
    startedMs,
    endedMs,
    turns,
    users,
    interventions,
  };
};

export interface LoadCorpusOptions {
  agentDir?: string;
  projects: number;
  sessionsPerProject: number;
  minimumSessions?: number;
  settledBeforeMs?: number;
}

export const loadLabCorpus = async (options: LoadCorpusOptions): Promise<LabSession[]> => {
  const root = path.join(options.agentDir ?? path.join(os.homedir(), ".pi", "agent"), "sessions");
  const ranked = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("--private-"))
    .map((entry) => {
      const directory = path.join(root, entry.name);
      const files = fs.readdirSync(directory)
        .filter((file) => file.endsWith(".jsonl"))
        .filter((file) => options.settledBeforeMs === undefined ||
          fs.statSync(path.join(directory, file)).mtimeMs <= options.settledBeforeMs)
        .sort();
      return { project: entry.name, files, newest: files.at(-1) ?? "" };
    })
    .filter((entry) => entry.files.length >= (options.minimumSessions ?? 1))
    .sort((left, right) => right.newest.localeCompare(left.newest))
    .slice(0, options.projects);

  const sessions: LabSession[] = [];
  for (const entry of ranked) {
    for (const file of entry.files.slice(-options.sessionsPerProject)) {
      const extracted = await extractLabSession(path.join(root, entry.project, file), entry.project);
      if (!extracted) continue;
      if (extracted.cwd.startsWith("/private") || extracted.cwd.startsWith(os.tmpdir())) continue;
      sessions.push(extracted);
    }
  }
  return sessions.sort((left, right) => left.startedMs - right.startedMs);
};

export interface CorpusSplit {
  train: LabSession[];
  validation: LabSession[];
  test: LabSession[];
}

export const splitCorpusChronologically = (
  sessions: readonly LabSession[],
  minimumProjectSessions = 10,
): CorpusSplit => {
  const projects = new Map<string, LabSession[]>();
  for (const session of sessions) {
    const group = projects.get(session.project) ?? [];
    group.push(session);
    projects.set(session.project, group);
  }
  const split: CorpusSplit = { train: [], validation: [], test: [] };
  for (const group of projects.values()) {
    group.sort((left, right) => left.startedMs - right.startedMs);
    if (group.length < minimumProjectSessions) continue;
    const trainEnd = Math.max(1, Math.floor(group.length * 0.6));
    const validationEnd = Math.max(trainEnd + 1, Math.floor(group.length * 0.8));
    split.train.push(...group.slice(0, trainEnd));
    split.validation.push(...group.slice(trainEnd, validationEnd));
    split.test.push(...group.slice(validationEnd));
  }
  return split;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const fingerprint = (tool: LabTool): string =>
  `${tool.name} ${stableStringify(tool.args).slice(0, 4_096)}`;

const toolPath = (tool: LabTool): string | undefined => {
  const args = asRecord(tool.args);
  for (const key of ["path", "file_path", "notebook_path", "filename"] as const) {
    const value = args?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

const entropyDeficit = (values: readonly string[]): number => {
  if (values.length < 3) return 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / values.length;
    entropy -= probability * Math.log2(probability);
  }
  return Math.max(0, 1 - entropy / Math.log2(values.length));
};

export const LAB_FEATURE_NAMES = [
  "errors",
  "retries",
  "revisits",
  "errorMomentum",
  "retryMomentum",
  "revisitMomentum",
  "callConcentration",
  "toolConcentration",
  "runLength",
  "inputGap",
  "elapsedLog",
  "toolBurst",
  "failureStreak",
  "responseDurationLog",
  "toolDurationLog",
  "inputTokensLog",
  "outputTokensLog",
  "reasoningRatio",
  "textLog",
  "thinkingLog",
  "researchBurst",
  "actionBurst",
  "verificationBurst",
  "actionWithoutResearch",
  "verificationDebt",
  "failedVerificationDebt",
  "actionResearchImbalance",
  "terminalMomentum",
  "interventionMomentum",
] as const;

export type LabFeatureName = typeof LAB_FEATURE_NAMES[number];
export type LabFeatureVector = Record<LabFeatureName, number>;

export interface LabRow {
  turn: number;
  features: LabFeatureVector;
  lexical: Float32Array;
  steerNow: boolean;
  abortNow: boolean;
  anyInputNow: boolean;
}

export const buildLabRows = (session: LabSession, historyWindow = 16): LabRow[] => {
  const inputs = new Map<number, LabUserEvent[]>();
  for (const user of session.users) {
    const events = inputs.get(user.beforeTurn) ?? [];
    events.push(user);
    inputs.set(user.beforeTurn, events);
  }
  const aborts = new Set(
    session.interventions.filter((entry) => entry.kind === "abort").map((entry) => entry.turn),
  );
  const recentCalls = new Map<string, number>();
  const recentPaths = new Map<string, number>();
  const concentrationWindow: { turn: number; name: string; call: string }[] = [];
  let errorMomentum = 0;
  let retryMomentum = 0;
  let revisitMomentum = 0;
  let runLength = 0;
  let inputGap = 0;
  let failureStreak = 0;
  let researchMomentum = 0;
  let actionMomentum = 0;
  let turnsSinceResearch = 0;
  let turnsSinceVerification = 0;
  let failedVerificationDebt = 0;
  let terminalMomentum = 0;
  let interventionMomentum = 0;
  const lexicalMomentum = new Float32Array(LEXICAL_BUCKETS);

  return session.turns.map((turn, turnIndex): LabRow => {
    const boundaryInputs = inputs.get(turnIndex) ?? [];
    const anyInputNow = boundaryInputs.length > 0;
    const startsRun = boundaryInputs.some((entry) => entry.kind !== "steer");
    const steerNow = boundaryInputs.some((entry) => entry.kind === "steer");
    if (startsRun) lexicalMomentum.fill(0);
    for (let bucket = 0; bucket < LEXICAL_BUCKETS; bucket++) {
      lexicalMomentum[bucket] = 0.65 * (lexicalMomentum[bucket] ?? 0) + Math.log1p(turn.lexical[bucket] ?? 0);
    }
    runLength = startsRun ? 1 : runLength + 1;
    const currentInputGap = anyInputNow ? 0 : inputGap + 1;
    inputGap = currentInputGap;

    let retries = 0;
    let revisits = 0;
    for (const tool of turn.tools) {
      const call = fingerprint(tool);
      const previousCall = recentCalls.get(call);
      if (previousCall !== undefined && turnIndex - previousCall <= historyWindow) retries += 1;
      recentCalls.set(call, turnIndex);
      const targetPath = toolPath(tool);
      if (targetPath) {
        const previousPath = recentPaths.get(targetPath);
        if (previousPath !== undefined && previousPath < turnIndex && turnIndex - previousPath <= historyWindow) {
          revisits += 1;
        }
        recentPaths.set(targetPath, turnIndex);
      }
      concentrationWindow.push({ turn: turnIndex, name: tool.name, call });
    }
    while ((concentrationWindow[0]?.turn ?? Number.POSITIVE_INFINITY) < turnIndex - 3) {
      concentrationWindow.shift();
    }
    const toolRecords = turn.tools.map((tool) => asRecord(tool.args));
    const researchBurst = turn.tools.filter((tool, index) => {
      const category = toolRecords[index]?.category;
      return category === "Research" || /^(?:read|grep|glob|search|list)/i.test(tool.name);
    }).length;
    const actionBurst = turn.tools.filter((tool, index) => {
      const category = toolRecords[index]?.category;
      return category === "Action" || /(?:edit|write|bash|command|shell)/i.test(tool.name);
    }).length;
    const verificationBurst = turn.tools.filter((tool, index) => {
      const bashCategory = toolRecords[index]?.bash_category;
      const command = toolRecords[index]?.command;
      return bashCategory === "test/build" ||
        (typeof command === "string" && /(?:^|\s)(?:test|check|lint|build|typecheck|pytest|cargo test|go test)(?:\s|$)/i.test(command));
    }).length;
    const verificationFailed = turn.tools.some((tool, index) => {
      const bashCategory = toolRecords[index]?.bash_category;
      return bashCategory === "test/build" && tool.isError;
    });
    researchMomentum = researchBurst + 0.7 * researchMomentum;
    actionMomentum = actionBurst + 0.7 * actionMomentum;
    turnsSinceResearch = researchBurst > 0 ? 0 : turnsSinceResearch + 1;
    turnsSinceVerification = verificationBurst > 0 ? 0 : turnsSinceVerification + 1;
    if (verificationBurst > 0) failedVerificationDebt = verificationFailed ? 1 : 0;
    else if (actionBurst > 0 && failedVerificationDebt > 0) failedVerificationDebt += 1;
    const errors = turn.tools.filter((tool) => tool.isError).length;
    errorMomentum = errors + 0.65 * errorMomentum;
    retryMomentum = retries + 0.65 * retryMomentum;
    revisitMomentum = revisits + 0.65 * revisitMomentum;
    failureStreak = errors > 0 ? failureStreak + 1 : 0;
    const previousAt = session.turns[turnIndex - 1]?.completedMs ?? turn.completedMs;
    const elapsedSeconds = anyInputNow
      ? 0
      : Math.min(3_600, Math.max(0, (turn.completedMs - previousAt) / 1_000));
    const responseSeconds = Math.min(3_600, Math.max(0, (turn.messageEndedMs - turn.startedMs) / 1_000));
    const toolSeconds = Math.min(3_600, Math.max(0, (turn.completedMs - turn.messageEndedMs) / 1_000));
    const terminalValue = turn.stopReason === "error"
      ? 2
      : turn.stopReason === "aborted" ? 1.5 : turn.stopReason === "length" ? 1 : 0;
    terminalMomentum = terminalValue + 0.7 * terminalMomentum;
    const priorInterventionMomentum = 0.8 * interventionMomentum;
    const abortNow = aborts.has(turnIndex);
    const row: LabRow = {
      turn: turnIndex,
      features: {
        errors,
        retries,
        revisits,
        errorMomentum,
        retryMomentum,
        revisitMomentum,
        callConcentration: entropyDeficit(concentrationWindow.map((entry) => entry.call)),
        toolConcentration: entropyDeficit(concentrationWindow.map((entry) => entry.name)),
        runLength,
        inputGap,
        elapsedLog: Math.log2(1 + elapsedSeconds),
        toolBurst: Math.log2(1 + turn.tools.length),
        failureStreak,
        responseDurationLog: Math.log2(1 + responseSeconds),
        toolDurationLog: Math.log2(1 + toolSeconds),
        inputTokensLog: Math.log2(1 + turn.inputTokens),
        outputTokensLog: Math.log2(1 + turn.outputTokens),
        reasoningRatio: turn.reasoningTokens / Math.max(1, turn.outputTokens + turn.reasoningTokens),
        textLog: Math.log2(1 + turn.textChars),
        thinkingLog: Math.log2(1 + turn.thinkingChars),
        researchBurst: Math.log2(1 + researchBurst),
        actionBurst: Math.log2(1 + actionBurst),
        verificationBurst: Math.log2(1 + verificationBurst),
        actionWithoutResearch: actionBurst > 0 ? Math.log2(1 + turnsSinceResearch) : 0,
        verificationDebt: actionBurst > 0 ? Math.log2(1 + turnsSinceVerification) : 0,
        failedVerificationDebt: Math.log2(1 + failedVerificationDebt),
        actionResearchImbalance: Math.max(0, Math.log2(1 + actionMomentum) - Math.log2(1 + researchMomentum)),
        terminalMomentum,
        interventionMomentum: priorInterventionMomentum,
      },
      lexical: new Float32Array(lexicalMomentum),
      steerNow,
      abortNow,
      anyInputNow,
    };
    interventionMomentum = priorInterventionMomentum + (steerNow || abortNow ? 1 : 0);
    return row;
  });
};

export const productionScores = (session: LabSession, window = 16): number[] => {
  const detector = new SurpriseDetector();
  const users = new Map<number, LabUserEvent[]>();
  for (const user of session.users) {
    const events = users.get(user.beforeTurn) ?? [];
    events.push(user);
    users.set(user.beforeTurn, events);
  }
  const config = {
    ...DEFAULT_FABRIC_CONFIG.surprise,
    mode: "trace" as const,
    learn: false,
    window,
    drift: 0,
    threshold: Number.MAX_SAFE_INTEGER,
    cooldown: 0,
    maxPerSession: Number.MAX_SAFE_INTEGER,
  };
  return session.turns.map((turn, turnIndex) => {
    for (const user of users.get(turnIndex) ?? []) detector.observeInput(user.kind === "steer");
    for (const tool of turn.tools) {
      detector.observeToolStart(tool.name, tool.args);
      detector.observeToolEnd(tool.isError);
    }
    return detector.endTurn(turnIndex, config).score;
  });
};

export const interventionTurns = (
  session: LabSession,
  kinds: readonly InterventionKind[] = STRONG_INTERVENTIONS,
  mergeDistance = 1,
): number[] => {
  const accepted = new Set(kinds);
  const turns = [...new Set(
    session.interventions.filter((entry) => accepted.has(entry.kind)).map((entry) => entry.turn),
  )].sort((left, right) => left - right);
  const clustered: number[] = [];
  for (const turn of turns) {
    const previous = clustered.at(-1);
    if (previous === undefined || turn - previous > mergeDistance) clustered.push(turn);
  }
  return clustered;
};

export interface TrainingExample {
  project: string;
  row: LabRow;
  positive: boolean;
  targetLead?: number;
}

export const trainingExamples = (
  sessions: readonly LabSession[],
  rows: ReadonlyMap<string, readonly LabRow[]>,
  kinds: readonly InterventionKind[],
  leadWindow: number,
): TrainingExample[] => {
  const examples: TrainingExample[] = [];
  for (const session of sessions) {
    const leads = new Map<number, number>();
    for (const intervention of interventionTurns(session, kinds)) {
      for (let lead = 1; lead <= leadWindow; lead++) {
        const turn = intervention - lead;
        if (turn >= 0) leads.set(turn, Math.min(leads.get(turn) ?? Number.POSITIVE_INFINITY, lead));
      }
    }
    for (const row of rows.get(session.id) ?? []) {
      const targetLead = leads.get(row.turn);
      examples.push({
        project: session.project,
        row,
        positive: targetLead !== undefined,
        ...(targetLead === undefined ? {} : { targetLead }),
      });
    }
  }
  return examples;
};

const FEATURE_THRESHOLDS: Record<LabFeatureName, readonly number[]> = {
  errors: [0, 1, 2],
  retries: [0, 1, 2, 4],
  revisits: [0, 1, 2, 4],
  errorMomentum: [0, 0.5, 1.5, 3],
  retryMomentum: [0, 0.5, 1.5, 3, 6],
  revisitMomentum: [0, 0.5, 1.5, 3, 6],
  callConcentration: [0, 0.25, 0.6, 0.85],
  toolConcentration: [0, 0.25, 0.6, 0.85],
  runLength: [4, 8, 16, 32, 64],
  inputGap: [2, 5, 10, 20, 40],
  elapsedLog: [1, 3, 5, 7, 9],
  toolBurst: [0, 1, 1.6, 2.3, 3.2],
  failureStreak: [0, 1, 2],
  responseDurationLog: [0, 1, 2, 3, 4, 5, 6, 8],
  toolDurationLog: [0, 1, 2, 3, 4, 5, 6, 8],
  inputTokensLog: [10, 12, 14, 16, 18, 20],
  outputTokensLog: [4, 6, 8, 10, 12],
  reasoningRatio: [0, 0.1, 0.3, 0.6, 0.9],
  textLog: [0, 5, 8, 11, 14],
  thinkingLog: [0, 5, 8, 11, 14],
  researchBurst: [0, 1, 2, 3],
  actionBurst: [0, 1, 2, 3],
  verificationBurst: [0, 1, 2],
  actionWithoutResearch: [0, 1, 2, 3, 4, 5],
  verificationDebt: [0, 1, 2, 3, 4, 5],
  failedVerificationDebt: [0, 1, 2, 3, 4],
  actionResearchImbalance: [0, 0.5, 1, 2, 3],
  terminalMomentum: [0, 0.5, 1, 2, 3],
  interventionMomentum: [0, 0.25, 0.5, 1, 2],
};

const featureBin = (name: LabFeatureName, value: number): number => {
  const thresholds = FEATURE_THRESHOLDS[name];
  let bin = 0;
  while (bin < thresholds.length && value > (thresholds[bin] ?? Number.POSITIVE_INFINITY)) bin += 1;
  return bin;
};

export interface RiskModel {
  name: string;
  score(row: LabRow): number;
  describe(): string[];
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const fitNaiveBayes = (examples: readonly TrainingExample[]): RiskModel => {
  const positive = examples.filter((example) => example.positive).length;
  const negative = examples.length - positive;
  const counts = new Map<LabFeatureName, { positive: number[]; negative: number[] }>();
  for (const name of LAB_FEATURE_NAMES) {
    const size = FEATURE_THRESHOLDS[name].length + 1;
    counts.set(name, { positive: Array(size).fill(0), negative: Array(size).fill(0) });
  }
  for (const example of examples) {
    for (const name of LAB_FEATURE_NAMES) {
      const target = counts.get(name);
      if (!target) continue;
      const bucket = example.positive ? target.positive : target.negative;
      const bin = featureBin(name, example.row.features[name]);
      bucket[bin] = (bucket[bin] ?? 0) + 1;
    }
  }
  const contribution = (name: LabFeatureName, bin: number): number => {
    const target = counts.get(name);
    if (!target) return 0;
    const bins = target.positive.length;
    const givenPositive = ((target.positive[bin] ?? 0) + 1) / (positive + bins);
    const givenNegative = ((target.negative[bin] ?? 0) + 1) / (negative + bins);
    return clamp(Math.log(givenPositive / givenNegative), -2, 2) * 0.25;
  };
  const prior = Math.log((positive + 1) / (negative + 1));
  return {
    name: "naive-bayes-hazard",
    score: (row) => prior + LAB_FEATURE_NAMES.reduce(
      (score, name) => score + contribution(name, featureBin(name, row.features[name])),
      0,
    ),
    describe: () => LAB_FEATURE_NAMES.flatMap((name) => {
      const target = counts.get(name);
      if (!target) return [];
      return target.positive.map((_, bin) => ({ name, bin, value: contribution(name, bin) }));
    })
      .filter((entry) => entry.value > 0.05)
      .sort((left, right) => right.value - left.value)
      .slice(0, 12)
      .map((entry) => `${entry.name}[bin ${entry.bin}] log-evidence=${entry.value.toFixed(2)}`),
  };
};

export const fitHashedNaiveBayes = (
  examples: readonly TrainingExample[],
  name = "hashed-lexical-hazard",
): RiskModel => {
  const positive = examples.filter((example) => example.positive).length;
  const negative = examples.length - positive;
  const positivePresent = new Uint32Array(LEXICAL_BUCKETS);
  const negativePresent = new Uint32Array(LEXICAL_BUCKETS);
  for (const example of examples) {
    for (let bucket = 0; bucket < LEXICAL_BUCKETS; bucket++) {
      if ((example.row.lexical[bucket] ?? 0) <= 0.05) continue;
      const target = example.positive ? positivePresent : negativePresent;
      target[bucket] = (target[bucket] ?? 0) + 1;
    }
  }
  const presentEvidence = new Float64Array(LEXICAL_BUCKETS);
  const absentEvidence = new Float64Array(LEXICAL_BUCKETS);
  for (let bucket = 0; bucket < LEXICAL_BUCKETS; bucket++) {
    const givenPositive = ((positivePresent[bucket] ?? 0) + 1) / (positive + 2);
    const givenNegative = ((negativePresent[bucket] ?? 0) + 1) / (negative + 2);
    presentEvidence[bucket] = clamp(Math.log(givenPositive / givenNegative), -1.5, 1.5) * 0.2;
    absentEvidence[bucket] = clamp(
      Math.log((1 - givenPositive) / Math.max(1e-9, 1 - givenNegative)),
      -1.5,
      1.5,
    ) * 0.2;
  }
  const prior = Math.log((positive + 1) / (negative + 1));
  return {
    name,
    score: (row) => {
      let score = prior;
      for (let bucket = 0; bucket < LEXICAL_BUCKETS; bucket++) {
        score += (row.lexical[bucket] ?? 0) > 0.05
          ? presentEvidence[bucket] ?? 0
          : absentEvidence[bucket] ?? 0;
      }
      return score;
    },
    describe: () => [...presentEvidence]
      .map((evidence, bucket) => ({ bucket, evidence }))
      .filter((entry) => entry.evidence > 0.03)
      .sort((left, right) => right.evidence - left.evidence)
      .slice(0, 12)
      .map((entry) => `hash bucket ${entry.bucket}: +${entry.evidence.toFixed(2)} log-evidence`),
  };
};

interface Stump {
  feature: LabFeatureName;
  threshold: number;
  evidence: number;
  positives: number;
}

export const fitStumpForest = (examples: readonly TrainingExample[], maximumStumps = 12): RiskModel => {
  const positive = examples.filter((example) => example.positive).length;
  const negative = examples.length - positive;
  const candidates: Stump[] = [];
  for (const feature of LAB_FEATURE_NAMES) {
    const rawThresholds = FEATURE_THRESHOLDS[feature];
    const thresholds = [...new Set([
      ...(rawThresholds[0] === 0 ? [0.5] : []),
      ...rawThresholds.filter((value) => value > 0),
    ])];
    for (const threshold of thresholds) {
      let positiveHits = 0;
      let negativeHits = 0;
      for (const example of examples) {
        if (example.row.features[feature] < threshold) continue;
        if (example.positive) positiveHits += 1;
        else negativeHits += 1;
      }
      const positiveRate = (positiveHits + 1) / (positive + 2);
      const negativeRate = (negativeHits + 1) / (negative + 2);
      const evidence = Math.log(positiveRate / negativeRate);
      if (positiveHits >= 3 && evidence > 0.05) {
        candidates.push({ feature, threshold, evidence, positives: positiveHits });
      }
    }
  }
  const selected: Stump[] = [];
  const perFeature = new Map<LabFeatureName, number>();
  for (const stump of candidates.sort(
    (left, right) => right.evidence * Math.log1p(right.positives) - left.evidence * Math.log1p(left.positives),
  )) {
    if ((perFeature.get(stump.feature) ?? 0) >= 2) continue;
    selected.push(stump);
    perFeature.set(stump.feature, (perFeature.get(stump.feature) ?? 0) + 1);
    if (selected.length >= maximumStumps) break;
  }
  return {
    name: "deterministic-stump-forest",
    score: (row) => selected.reduce(
      (score, stump) => score + (row.features[stump.feature] >= stump.threshold ? stump.evidence : 0),
      0,
    ),
    describe: () => selected.map(
      (stump) => `${stump.feature} >= ${stump.threshold}: +${stump.evidence.toFixed(2)} (${stump.positives} positive windows)`,
    ),
  };
};

interface ConjunctionRule {
  left: Stump;
  right: Stump;
  evidence: number;
  positives: number;
  precision: number;
}

const stumpMatches = (row: LabRow, stump: Stump): boolean =>
  row.features[stump.feature] >= stump.threshold;

export const fitConjunctionForest = (
  examples: readonly TrainingExample[],
  name = "deterministic-conjunction-forest",
  maximumRules = 16,
): RiskModel => {
  const positive = examples.filter((example) => example.positive).length;
  const negative = examples.length - positive;
  const primitives: Stump[] = [];
  for (const feature of LAB_FEATURE_NAMES) {
    const rawThresholds = FEATURE_THRESHOLDS[feature];
    const thresholds = [...new Set([
      ...(rawThresholds[0] === 0 ? [0.5] : []),
      ...rawThresholds.filter((value) => value > 0),
    ])];
    for (const threshold of thresholds) {
      let positiveHits = 0;
      let negativeHits = 0;
      for (const example of examples) {
        if (example.row.features[feature] < threshold) continue;
        if (example.positive) positiveHits += 1;
        else negativeHits += 1;
      }
      const positiveRate = (positiveHits + 1) / (positive + 2);
      const negativeRate = (negativeHits + 1) / (negative + 2);
      const evidence = Math.log(positiveRate / negativeRate);
      if (positiveHits >= 4 && evidence > 0.05) {
        primitives.push({ feature, threshold, evidence, positives: positiveHits });
      }
    }
  }
  const shortlist = primitives
    .sort((left, right) =>
      right.evidence * Math.log1p(right.positives) - left.evidence * Math.log1p(left.positives),
    )
    .slice(0, 36);
  const candidates: ConjunctionRule[] = [];
  for (let leftIndex = 0; leftIndex < shortlist.length; leftIndex++) {
    const left = shortlist[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < shortlist.length; rightIndex++) {
      const right = shortlist[rightIndex];
      if (!right || left.feature === right.feature) continue;
      let positiveHits = 0;
      let negativeHits = 0;
      for (const example of examples) {
        if (!stumpMatches(example.row, left) || !stumpMatches(example.row, right)) continue;
        if (example.positive) positiveHits += 1;
        else negativeHits += 1;
      }
      const positiveRate = (positiveHits + 1) / (positive + 2);
      const negativeRate = (negativeHits + 1) / (negative + 2);
      const evidence = Math.log(positiveRate / negativeRate);
      const precision = (positiveHits + 1) / (positiveHits + negativeHits + 2);
      if (positiveHits >= 5 && evidence > 0.25) {
        candidates.push({ left, right, evidence, positives: positiveHits, precision });
      }
    }
  }
  const selected = candidates
    .sort((left, right) =>
      right.evidence * right.precision * Math.log1p(right.positives) -
      left.evidence * left.precision * Math.log1p(left.positives),
    )
    .slice(0, maximumRules);
  return {
    name,
    score: (row) => {
      const evidence = selected
        .filter((rule) => stumpMatches(row, rule.left) && stumpMatches(row, rule.right))
        .map((rule) => rule.evidence)
        .sort((left, right) => right - left);
      const strongest = evidence[0] ?? 0;
      return strongest + 0.2 * evidence.slice(1).reduce((sum, value) => sum + value, 0);
    },
    describe: () => selected.map((rule) =>
      `${rule.left.feature} >= ${rule.left.threshold} AND ${rule.right.feature} >= ${rule.right.threshold}: +${rule.evidence.toFixed(2)} P=${(100 * rule.precision).toFixed(0)}% n+=${rule.positives}`,
    ),
  };
};

interface DecisionNode {
  probability: number;
  feature: LabFeatureName | null;
  threshold: number;
  left?: DecisionNode;
  right?: DecisionNode;
}

const gini = (positive: number, total: number): number => {
  if (total === 0) return 0;
  const probability = positive / total;
  return 2 * probability * (1 - probability);
};

export const fitDeterministicRandomForest = (
  examples: readonly TrainingExample[],
  name = "seeded-random-forest",
  treeCount = 16,
  seed = 42,
  maximumDepth = 6,
): RiskModel => {
  const positives = examples.filter((example) => example.positive);
  const negatives = examples.filter((example) => !example.positive);
  let randomState = seed >>> 0;
  const random = (): number => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 2 ** 32;
  };
  const randomEntry = (entries: readonly TrainingExample[]): TrainingExample | undefined =>
    entries[Math.floor(random() * entries.length)];
  const featureUses = new Map<LabFeatureName, number>();

  const build = (entries: readonly TrainingExample[], depth: number): DecisionNode => {
    const positive = entries.filter((entry) => entry.positive).length;
    const probability = (positive + 1) / (entries.length + 2);
    const leaf: DecisionNode = { probability, feature: null, threshold: 0 };
    if (depth >= maximumDepth || entries.length < 40 || positive < 3 || entries.length - positive < 3) return leaf;

    const featurePool = [...LAB_FEATURE_NAMES];
    for (let index = featurePool.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1));
      const value = featurePool[index];
      const swapped = featurePool[swap];
      if (value === undefined || swapped === undefined) continue;
      featurePool[index] = swapped;
      featurePool[swap] = value;
    }
    const features = featurePool.slice(0, Math.max(5, Math.ceil(Math.sqrt(featurePool.length))));
    const parentImpurity = gini(positive, entries.length);
    let best: { feature: LabFeatureName; threshold: number; gain: number } | undefined;
    for (const feature of features) {
      const rawThresholds = FEATURE_THRESHOLDS[feature];
      const thresholds = [...new Set([
        ...(rawThresholds[0] === 0 ? [0.5] : []),
        ...rawThresholds.filter((value) => value > 0),
      ])];
      for (const threshold of thresholds) {
        let leftTotal = 0;
        let leftPositive = 0;
        let rightTotal = 0;
        let rightPositive = 0;
        for (const entry of entries) {
          if (entry.row.features[feature] < threshold) {
            leftTotal += 1;
            if (entry.positive) leftPositive += 1;
          } else {
            rightTotal += 1;
            if (entry.positive) rightPositive += 1;
          }
        }
        if (leftTotal < 20 || rightTotal < 20) continue;
        const childImpurity =
          leftTotal / entries.length * gini(leftPositive, leftTotal) +
          rightTotal / entries.length * gini(rightPositive, rightTotal);
        const gain = parentImpurity - childImpurity;
        if (!best || gain > best.gain) best = { feature, threshold, gain };
      }
    }
    if (!best || best.gain < 0.002) return leaf;
    const left = entries.filter((entry) => entry.row.features[best.feature] < best.threshold);
    const right = entries.filter((entry) => entry.row.features[best.feature] >= best.threshold);
    featureUses.set(best.feature, (featureUses.get(best.feature) ?? 0) + 1);
    return {
      probability,
      feature: best.feature,
      threshold: best.threshold,
      left: build(left, depth + 1),
      right: build(right, depth + 1),
    };
  };

  const trees: DecisionNode[] = [];
  const samplePerClass = Math.min(4_000, positives.length, negatives.length);
  for (let tree = 0; tree < treeCount; tree++) {
    const sample: TrainingExample[] = [];
    for (let index = 0; index < samplePerClass; index++) {
      const positive = randomEntry(positives);
      const negative = randomEntry(negatives);
      if (positive) sample.push(positive);
      if (negative) sample.push(negative);
    }
    trees.push(build(sample, 0));
  }

  const treeScore = (row: LabRow, root: DecisionNode): number => {
    let node = root;
    while (node.feature && node.left && node.right) {
      node = row.features[node.feature] < node.threshold ? node.left : node.right;
    }
    return node.probability;
  };
  return {
    name,
    score: (row) => trees.reduce((sum, tree) => sum + treeScore(row, tree), 0) / Math.max(1, trees.length),
    describe: () => [...featureUses]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([feature, uses]) => `${feature}: ${uses} tree splits`),
  };
};

export interface TailKernel {
  evidence(score: number): number;
}

const lowerBound = (values: readonly number[], target: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

export const fitEmpiricalTail = (scores: readonly number[]): TailKernel => {
  const sorted = scores.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    evidence: (score) => {
      if (sorted.length === 0) return 0;
      const index = lowerBound(sorted, score);
      const tailProbability = (sorted.length - index + 1) / (sorted.length + 1);
      return Math.min(12, -Math.log(tailProbability));
    },
  };
};

export interface ScoredSession {
  session: LabSession;
  rows: readonly LabRow[];
  scores: readonly number[];
}

export interface AlarmConfig {
  leak: number;
  drift: number;
  threshold: number;
  cooldown: number;
  refractory: number;
  maxPerSession: number;
}

export const simulateAlarms = (
  scored: ScoredSession,
  kernel: TailKernel,
  config: AlarmConfig,
): number[] => {
  const fires: number[] = [];
  let accumulator = 0;
  let cooldown = 0;
  let refractory = 0;
  for (let index = 0; index < scored.rows.length; index++) {
    const row = scored.rows[index];
    if (!row) continue;
    if (row.steerNow) refractory = Math.max(refractory, config.refractory + 1);
    if (cooldown > 0) {
      cooldown -= 1;
      accumulator = 0;
    } else if (refractory > 0) {
      refractory -= 1;
      accumulator = 0;
    } else if (fires.length < config.maxPerSession) {
      const evidence = kernel.evidence(scored.scores[index] ?? 0);
      accumulator = Math.max(0, config.leak * accumulator + evidence - config.drift);
      if (accumulator >= config.threshold) {
        fires.push(row.turn);
        cooldown = config.cooldown;
        accumulator = 0;
      }
    }
    if (row.abortNow) refractory = Math.max(refractory, config.refractory);
  }
  return fires;
};

export interface SessionEvaluation {
  project: string;
  turns: number;
  fires: number;
  labels: number;
  matches: number;
  leadSum: number;
}

export const evaluateSession = (
  session: LabSession,
  fires: readonly number[],
  kinds: readonly InterventionKind[],
  leadWindow: number,
): SessionEvaluation => {
  const labels = interventionTurns(session, kinds);
  const unmatched = new Set(fires.map((_, index) => index));
  let matches = 0;
  let leadSum = 0;
  for (const label of labels) {
    let selected = -1;
    for (let index = fires.length - 1; index >= 0; index--) {
      if (!unmatched.has(index)) continue;
      const fire = fires[index];
      if (fire === undefined) continue;
      const lead = label - fire;
      if (lead >= 1 && lead <= leadWindow) {
        selected = index;
        break;
      }
    }
    if (selected >= 0) {
      unmatched.delete(selected);
      matches += 1;
      leadSum += label - (fires[selected] ?? label);
    }
  }
  return {
    project: session.project,
    turns: session.turns.length,
    fires: fires.length,
    labels: labels.length,
    matches,
    leadSum,
  };
};

export interface AggregateMetrics {
  turns: number;
  fires: number;
  labels: number;
  matches: number;
  precision: number;
  recall: number;
  meanLead: number;
  ratePerThousand: number;
}

export const aggregateMetrics = (evaluations: readonly SessionEvaluation[]): AggregateMetrics => {
  const counts = evaluations.reduce(
    (total, entry) => ({
      turns: total.turns + entry.turns,
      fires: total.fires + entry.fires,
      labels: total.labels + entry.labels,
      matches: total.matches + entry.matches,
      leadSum: total.leadSum + entry.leadSum,
    }),
    { turns: 0, fires: 0, labels: 0, matches: 0, leadSum: 0 },
  );
  return {
    ...counts,
    precision: counts.fires > 0 ? counts.matches / counts.fires : 0,
    recall: counts.labels > 0 ? counts.matches / counts.labels : 0,
    meanLead: counts.matches > 0 ? counts.leadSum / counts.matches : 0,
    ratePerThousand: counts.turns > 0 ? 1_000 * counts.fires / counts.turns : 0,
  };
};

export const metricsByProject = (
  evaluations: readonly SessionEvaluation[],
): Map<string, AggregateMetrics> => {
  const groups = new Map<string, SessionEvaluation[]>();
  for (const evaluation of evaluations) {
    const group = groups.get(evaluation.project) ?? [];
    group.push(evaluation);
    groups.set(evaluation.project, group);
  }
  return new Map([...groups].map(([project, group]) => [project, aggregateMetrics(group)]));
};

export interface BootstrapInterval {
  precision: [number, number];
  recall: [number, number];
  ratePerThousand: [number, number];
}

const percentile = (values: number[], probability: number): number => {
  values.sort((left, right) => left - right);
  return values[Math.min(values.length - 1, Math.floor(probability * values.length))] ?? 0;
};

export const bootstrapMetrics = (
  evaluations: readonly SessionEvaluation[],
  samples = 500,
  seed = 42,
): BootstrapInterval => {
  if (evaluations.length === 0) {
    return { precision: [0, 0], recall: [0, 0], ratePerThousand: [0, 0] };
  }
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const precision: number[] = [];
  const recall: number[] = [];
  const rate: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const selected: SessionEvaluation[] = [];
    for (let index = 0; index < evaluations.length; index++) {
      const evaluation = evaluations[Math.floor(random() * evaluations.length)];
      if (evaluation) selected.push(evaluation);
    }
    const metrics = aggregateMetrics(selected);
    precision.push(metrics.precision);
    recall.push(metrics.recall);
    rate.push(metrics.ratePerThousand);
  }
  return {
    precision: [percentile(precision, 0.025), percentile(precision, 0.975)],
    recall: [percentile(recall, 0.025), percentile(recall, 0.975)],
    ratePerThousand: [percentile(rate, 0.025), percentile(rate, 0.975)],
  };
};
