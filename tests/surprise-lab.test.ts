import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STRONG_INTERVENTIONS,
  buildLabRows,
  evaluateSession,
  extractLabSession,
  fitDeterministicRandomForest,
  fitEmpiricalTail,
  interventionTurns,
  loadLabCorpus,
  splitCorpusChronologically,
  type LabSession,
  type TrainingExample,
} from "../scripts/surprise-lab.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-surprise-lab-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const entry = (timestamp: string, value: Record<string, unknown>): string =>
  JSON.stringify({ timestamp, ...value });

const fixtureLines = (offsetMs = 0): string[] => {
  const at = (seconds: number): string => new Date(1_700_000_000_000 + offsetMs + seconds * 1_000).toISOString();
  return [
    entry(at(0), { type: "session", cwd: "/workspace/project" }),
    entry(at(1), { type: "message", message: { role: "user", content: "start", timestamp: 1_700_000_001_000 + offsetMs } }),
    entry(at(3), {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        timestamp: 1_700_000_001_500 + offsetMs,
        usage: { input: 100, output: 20, reasoning: 4 },
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "test failing target" } }],
      },
    }),
    entry(at(8), {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        isError: true,
        content: [{ type: "text", text: "deterministic failure" }],
        timestamp: 1_700_000_008_000 + offsetMs,
      },
    }),
    entry(at(9), { type: "message", message: { role: "user", content: "stop and fix it", timestamp: 1_700_000_009_000 + offsetMs } }),
    entry(at(11), {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "aborted",
        timestamp: 1_700_000_009_500 + offsetMs,
        usage: { input: 120, output: 5, reasoning: 0 },
        content: [{ type: "text", text: "stopping" }],
      },
    }),
    entry(at(12), { type: "message", message: { role: "user", content: "continue", timestamp: 1_700_000_012_000 + offsetMs } }),
    entry(at(14), {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        timestamp: 1_700_000_012_500 + offsetMs,
        usage: { input: 80, output: 10, reasoning: 0 },
        content: [{ type: "text", text: "done" }],
      },
    }),
  ];
};

const writeFixture = (file: string, offsetMs = 0): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${fixtureLines(offsetMs).join("\n")}\n`, "utf8");
};

describe("surprise experiment lab", () => {
  it("distinguishes active-run steers from ordinary follow-ups and timestamps strong labels", async () => {
    const file = path.join(temporaryDirectory(), "session.jsonl");
    writeFixture(file);

    const session = await extractLabSession(file, "project");
    expect(session).toBeDefined();
    expect(session?.users.map((user) => user.kind)).toEqual(["initial", "steer", "followUp"]);
    expect(session?.interventions.map((event) => event.kind)).toEqual(["steer", "abort", "recovery"]);
    expect(interventionTurns(session as LabSession, STRONG_INTERVENTIONS)).toEqual([1]);
    expect(session?.turns[0]?.tools[0]?.isError).toBe(true);
    expect(session?.turns[0]?.completedMs).toBe(1_700_000_008_000);

    const rows = buildLabRows(session as LabSession);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.features.errors).toBe(1);
    expect(rows[0]?.features.toolDurationLog).toBeGreaterThan(2);
    expect([...rows[0]!.lexical].some((value) => value > 0)).toBe(true);
  });

  it("requires strict causal lead and matches fires to interventions one-to-one", async () => {
    const file = path.join(temporaryDirectory(), "session.jsonl");
    writeFixture(file);
    const extracted = await extractLabSession(file, "project");
    expect(extracted).toBeDefined();
    const session = extracted as LabSession;

    const sameTurn = evaluateSession(session, [1], STRONG_INTERVENTIONS, 20);
    expect(sameTurn.matches).toBe(0);

    const duplicateFires = evaluateSession(session, [0, 0], STRONG_INTERVENTIONS, 20);
    expect(duplicateFires.matches).toBe(1);
    expect(duplicateFires.fires).toBe(2);

    const twoLabels: LabSession = {
      ...session,
      interventions: [...session.interventions, { turn: 3, kind: "steer", atMs: 1_700_000_015_000 }],
    };
    expect(evaluateSession(twoLabels, [0], STRONG_INTERVENTIONS, 20).matches).toBe(1);
  });

  it("splits every project chronologically without future leakage", () => {
    const sessions: LabSession[] = [];
    for (const project of ["a", "b"]) {
      for (let index = 0; index < 10; index++) {
        sessions.push({
          id: `${project}-${index}`,
          project,
          cwd: `/workspace/${project}`,
          startedMs: index,
          endedMs: index,
          turns: [],
          users: [],
          interventions: [],
        });
      }
    }
    const split = splitCorpusChronologically(sessions);
    expect(split.train).toHaveLength(12);
    expect(split.validation).toHaveLength(4);
    expect(split.test).toHaveLength(4);
    for (const project of ["a", "b"]) {
      const train = split.train.filter((session) => session.project === project);
      const validation = split.validation.filter((session) => session.project === project);
      const test = split.test.filter((session) => session.project === project);
      expect(Math.max(...train.map((session) => session.startedMs))).toBeLessThan(
        Math.min(...validation.map((session) => session.startedMs)),
      );
      expect(Math.max(...validation.map((session) => session.startedMs))).toBeLessThan(
        Math.min(...test.map((session) => session.startedMs)),
      );
    }
  });

  it("keeps empirical tail evidence monotone and seeded forests reproducible", async () => {
    const kernel = fitEmpiricalTail([0, 1, 2, 3, 4]);
    expect(kernel.evidence(4)).toBeGreaterThan(kernel.evidence(2));
    expect(kernel.evidence(2)).toBeGreaterThanOrEqual(kernel.evidence(0));

    const file = path.join(temporaryDirectory(), "session.jsonl");
    writeFixture(file);
    const session = await extractLabSession(file, "project") as LabSession;
    const rows = buildLabRows(session);
    const examples: TrainingExample[] = Array.from({ length: 120 }, (_, index) => ({
      project: "project",
      row: {
        ...rows[index % rows.length]!,
        features: { ...rows[index % rows.length]!.features, errors: index % 3 },
      },
      positive: index % 4 === 0,
    }));
    const first = fitDeterministicRandomForest(examples, "first", 6, 73);
    const second = fitDeterministicRandomForest(examples, "second", 6, 73);
    expect(rows.map((row) => first.score(row))).toEqual(rows.map((row) => second.score(row)));
  });

  it("excludes actively growing session files from a settled corpus", async () => {
    const agentDir = temporaryDirectory();
    const project = path.join(agentDir, "sessions", "project");
    const oldFile = path.join(project, "old.jsonl");
    const activeFile = path.join(project, "active.jsonl");
    writeFixture(oldFile);
    writeFixture(activeFile, 100_000);
    const cutoff = Date.now() - 60_000;
    fs.utimesSync(oldFile, new Date(cutoff - 60_000), new Date(cutoff - 60_000));
    fs.utimesSync(activeFile, new Date(cutoff + 30_000), new Date(cutoff + 30_000));

    const corpus = await loadLabCorpus({
      agentDir,
      projects: 1,
      sessionsPerProject: 10,
      settledBeforeMs: cutoff,
    });
    expect(corpus.map((session) => session.id)).toEqual(["old.jsonl"]);
  });
});
