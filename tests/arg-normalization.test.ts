import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, afterEach } from "vitest";
import {
  actionArgNormalizer,
  normalizeActionArgs,
  type ArgNormalizationSpec,
} from "../src/providers/arg-normalization.js";
import { MEMORY_ARG_NORMALIZATION, MemoryProvider } from "../src/providers/memory-provider.js";
import { STATE_ARG_NORMALIZATION } from "../src/providers/state-provider.js";
import { SCHEMA_ARG_NORMALIZATION } from "../src/providers/schema-provider.js";
import { COMPACT_ARG_NORMALIZATION } from "../src/providers/compact-provider.js";
import { MESH_ARG_NORMALIZATION } from "../src/providers/mesh-provider.js";
import { AGENTS_ARG_NORMALIZATION } from "../src/providers/agents-provider.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import type {
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";
import type { FabricMemoryConfig } from "../src/config.js";
import { encodeCwdDir } from "../src/memory/discovery.js";
import {
  sessionHeader,
  userMessage,
  writeSessionFile,
  type FixtureEntry,
} from "./fixtures/memory.js";

const tmpRoots: string[] = [];
const makeTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-argnorm-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("normalizeActionArgs", () => {
  it("repairs alias spellings and drops the alias key", () => {
    expect(
      normalizeActionArgs({ id: "s1", extra: true }, { aliases: { id: "session" } }),
    ).toEqual({ session: "s1", extra: true });
  });

  it("keeps the canonical key on conflict and still drops the alias", () => {
    expect(
      normalizeActionArgs(
        { id: "alias", session: "canonical" },
        { aliases: { id: "session" } },
      ),
    ).toEqual({ session: "canonical" });
  });

  it("remaps value spellings", () => {
    expect(
      normalizeActionArgs({ scope: "cwd" }, { values: { scope: { cwd: "project" } } }),
    ).toEqual({ scope: "project" });
  });

  it("coerces numeric strings and leaves non-numeric strings untouched", () => {
    expect(
      normalizeActionArgs(
        { limit: "10", scope: "abc" },
        { numerics: ["limit", "scope"] },
      ),
    ).toEqual({ limit: 10, scope: "abc" });
  });

  it("coerces numeric-string array elements element-wise", () => {
    expect(
      normalizeActionArgs({ indices: ["2", 4, "x"] }, { numericArrays: ["indices"] }),
    ).toEqual({ indices: [2, 4, "x"] });
  });

  it("strips nullish values for declared keys only", () => {
    const out = normalizeActionArgs(
      { limit: null, bogus: undefined } as unknown as Record<string, unknown>,
      { knownKeys: ["limit"] },
    );
    expect(Object.keys(out)).toEqual(["bogus"]);
  });

  it("leaves unknown keys untouched for the validation stage", () => {
    expect(
      normalizeActionArgs({ before: 8, session: "s" }, { aliases: { id: "session" } }),
    ).toEqual({ before: 8, session: "s" });
  });

  it("never mutates the caller's object", () => {
    const args: Record<string, unknown> = { id: "s1", limit: "5" };
    normalizeActionArgs(args, { aliases: { id: "session" }, numerics: ["limit"] });
    expect(args).toEqual({ id: "s1", limit: "5" });
  });

  it("passes non-object arguments through unchanged", () => {
    expect(normalizeActionArgs("bare" as unknown as Record<string, unknown>, {})).toBe("bare");
  });
});

describe("actionArgNormalizer", () => {
  it("fills knownKeys from the descriptor schema properties", () => {
    const normalize = actionArgNormalizer(
      () => [
        {
          name: "pick",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number" } },
          },
        },
      ],
      { pick: { aliases: { max: "limit" }, numerics: ["limit"] } },
    );
    const out = normalize(
      "pick",
      { max: "3", query: null } as unknown as Record<string, unknown>,
    );
    expect(out.limit).toBe(3);
    // Undeclared keys are retained so the validation stage owns their failure.
    expect("query" in out).toBe(true);
    const stripped = normalize("pick", { limit: null });
    expect("limit" in stripped).toBe(false);
  });
});

const specOf = (table: Record<string, ArgNormalizationSpec>, action: string): ArgNormalizationSpec => {
  const spec = table[action];
  if (!spec) throw new Error(`missing normalization spec for ${action}`);
  return spec;
};

describe("provider normalization tables", () => {
  it("memory.sessions repairs scope spellings and max with numeric coercion", () => {
    expect(
      normalizeActionArgs({ scope: "cwd", max: "3" }, specOf(MEMORY_ARG_NORMALIZATION, "sessions")),
    ).toEqual({ scope: "project", limit: 3 });
  });

  it("memory.expand repairs session/id spellings; window guesses pass through to validation", () => {
    expect(
      normalizeActionArgs(
        { id: "75292bd6", indices: ["1", "2"], before: 8 },
        specOf(MEMORY_ARG_NORMALIZATION, "expand"),
      ),
    ).toEqual({ session: "75292bd6", indices: [1, 2], before: 8 });
  });

  it("memory.recall repairs query and page size spellings", () => {
    expect(
      normalizeActionArgs(
        { q: "auth", limit: "5", entry_range: { first: 0, last: 3 } },
        specOf(MEMORY_ARG_NORMALIZATION, "recall"),
      ),
    ).toEqual({ query: "auth", pageSize: 5, entryRange: { first: 0, last: 3 } });
  });

  it("state repairs summary/label spellings and numeric strings", () => {
    expect(
      normalizeActionArgs({ command: "make test" }, specOf(STATE_ARG_NORMALIZATION, "goal")),
    ).toEqual({ check: "make test" });
    expect(
      normalizeActionArgs(
        { label: ["init"], timeoutMs: "5000" },
        specOf(STATE_ARG_NORMALIZATION, "verify"),
      ),
    ).toEqual({ labels: ["init"], timeoutMs: 5000 });
    expect(
      normalizeActionArgs({ name: "init", max: "3" }, specOf(STATE_ARG_NORMALIZATION, "history")),
    ).toEqual({ label: "init", limit: 3 });
  });

  it("schema repairs hypothesis id spellings", () => {
    for (const action of ["verify", "commit", "abort"]) {
      expect(
        normalizeActionArgs({ id: "h1" }, specOf(SCHEMA_ARG_NORMALIZATION, action)),
      ).toEqual({ hypothesisId: "h1" });
    }
    expect(
      normalizeActionArgs(
        { description: "d", complexity_reduction: true },
        specOf(SCHEMA_ARG_NORMALIZATION, "hypothesize"),
      ),
    ).toEqual({ summary: "d", complexityReduction: true });
  });

  it("compact repairs instruction spellings", () => {
    expect(
      normalizeActionArgs(
        { instruction: "summarize", requested_by: "me" },
        specOf(COMPACT_ARG_NORMALIZATION, "request"),
      ),
    ).toEqual({ instructions: "summarize", requestedBy: "me" });
  });

  it("mesh repairs publish text and CAS version spellings", () => {
    expect(
      normalizeActionArgs({ message: "hi" }, specOf(MESH_ARG_NORMALIZATION, "publish")),
    ).toEqual({ text: "hi" });
    expect(
      normalizeActionArgs({ key: "k", version: "3" }, specOf(MESH_ARG_NORMALIZATION, "put")),
    ).toEqual({ key: "k", ifVersion: 3 });
    expect(
      normalizeActionArgs({ max: "7", include_stale: true }, specOf(MESH_ARG_NORMALIZATION, "members")),
    ).toEqual({ limit: 7, includeStale: true });
  });

  it("agents repair task, timeout, and id spellings", () => {
    expect(
      normalizeActionArgs(
        { prompt: "do it", timeout_ms: "5000" },
        specOf(AGENTS_ARG_NORMALIZATION, "run"),
      ),
    ).toEqual({ task: "do it", timeoutMs: 5000 });
    expect(
      normalizeActionArgs({ agent_id: "a1" }, specOf(AGENTS_ARG_NORMALIZATION, "wait")),
    ).toEqual({ id: "a1" });
    expect(
      normalizeActionArgs(
        { agentId: "a1", delete_branch: true },
        specOf(AGENTS_ARG_NORMALIZATION, "cleanup"),
      ),
    ).toEqual({ id: "a1", deleteBranch: true });
  });
});

describe("ActionRegistry prepare before validate", () => {
  const probeProvider = (): FabricProvider => ({
    name: "probe",
    description: "Probe normalization stages",
    async list() {
      return [
        {
          name: "pick",
          description: "Pick a session",
          inputSchema: {
            type: "object",
            properties: { session: { type: "string" } },
            required: ["session"],
            additionalProperties: false,
          },
          risk: "read",
        },
      ];
    },
    async describe(name, invocation) {
      return (await this.list({}, invocation)).find((item) => item.name === name);
    },
    prepareArguments(_actionName, args) {
      return normalizeActionArgs(args, { aliases: { id: "session" } });
    },
    async invoke(_name, args) {
      return args;
    },
  });

  const registryContext = () => ({
    cwd: process.cwd(),
    signal: undefined,
    parentToolCallId: "parent",
    nestedToolCallId: "nested",
    extensionContext: {} as ExtensionContext,
    update() {},
    approve: async () => {},
    audits: [],
    maxResultChars: 10_000,
  });

  it("prepares alias spellings before validation and invocation", async () => {
    const registry = new ActionRegistry();
    registry.register(probeProvider());
    const result = await registry.invoke("probe.pick", { id: "s1" }, registryContext());
    expect(result).toEqual({ session: "s1" });
  });

  it("names the offending property path for unrepairable keys", async () => {
    const registry = new ActionRegistry();
    registry.register(probeProvider());
    await expect(
      registry.invoke("probe.pick", { session: "s1", before: 8 }, registryContext()),
    ).rejects.toThrow(/probe\.pick[\s\S]*\/before/);
  });

  it("still enforces required canonical keys after repair", async () => {
    const registry = new ActionRegistry();
    registry.register(probeProvider());
    await expect(registry.invoke("probe.pick", {}, registryContext())).rejects.toThrow(/required/);
  });
});

describe("memory.sessions limit", () => {
  const cwd = "/home/user/normalize-proj";
  let agentDir: string;
  let indexDir: string;

  const makeMemoryConfig = (dir: string): FabricMemoryConfig => ({
    enabled: true,
    indexDir: dir,
    maxSessions: 500,
    maxEntryChars: 2_000,
    indexThinking: false,
    indexToolOutput: true,
  });

  const msg = (
    id: string,
    parentId: string | null,
    seconds: number,
    message: Record<string, unknown>,
  ): FixtureEntry => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date(1_700_000_000_000 + seconds * 1_000).toISOString(),
    message,
  });

  const setup = () => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
    const dir = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    (["a", "b", "c"] as const).forEach((id, offset) => {
      writeSessionFile(dir, `${offset + 1}_${id}.jsonl`, [
        sessionHeader(id, cwd),
        msg(`e${offset}`, null, offset, userMessage(`session ${id} notes`)),
      ]);
    });
  };

  const invocationContext = (): FabricInvocationContext => ({
    cwd,
    signal: undefined,
    parentToolCallId: "test",
    nestedToolCallId: "nested",
    extensionContext: {} as ExtensionContext,
    update() {},
  });

  it("prepareArguments repairs scope and max spellings for sessions", () => {
    setup();
    const provider = new MemoryProvider({
      agentDir,
      cwd,
      config: makeMemoryConfig(indexDir),
      sessionId: "a",
    });
    expect(
      provider.prepareArguments("sessions", { scope: "cwd", max: "2" }),
    ).toEqual({ scope: "project", limit: 2 });
  });

  it("invoke honors limit and defaults to every session in scope", async () => {
    setup();
    const provider = new MemoryProvider({
      agentDir,
      cwd,
      config: makeMemoryConfig(indexDir),
      sessionId: "a",
    });
    const all = (await provider.invoke(
      "sessions",
      { scope: "project" },
      invocationContext(),
    )) as { sessions?: unknown[] };
    expect(all.sessions).toHaveLength(3);
    const limited = (await provider.invoke(
      "sessions",
      { scope: "project", limit: 2 },
      invocationContext(),
    )) as { sessions?: unknown[] };
    expect(limited.sessions).toHaveLength(2);
  });
});
