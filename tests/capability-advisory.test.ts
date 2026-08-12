import { describe, expect, it } from "vitest";
import type { FabricCapabilityAdvisoryConfig } from "../src/config.js";
import type { FabricActionDescriptor } from "../src/protocol.js";
import {
  CAPABILITY_ADVISORY_CUSTOM_TYPE,
  CapabilityAdvisor,
  type CapabilityAdvisoryMatch,
  type CapabilityAdvisoryResult,
} from "../src/core/capability-advisory.js";
import { toMcpAdvisoryDescriptor } from "../src/providers/mcp-provider.js";

const descriptor = (
  name: string,
  description: string,
  namespace: string,
): FabricActionDescriptor => ({
  name,
  description,
  inputSchema: {},
  risk: "read",
  namespace,
});

const FIXTURES: FabricActionDescriptor[] = [
  descriptor(
    "synthetic_web_search",
    "Search the web using Synthetic's zero-data-retention API. Returns results with titles, URLs, content snippets, and publication dates for documentation, articles, recent information, or any web content.",
    "extension:pi-synthetic",
  ),
  descriptor(
    "openai_image",
    "Generate or edit images through the standalone Codex Images API, saving into the project. Supports local reference images by default.",
    "extension:pi-better-openai",
  ),
  descriptor(
    "openai_websearch",
    "Search the live web through the ChatGPT Codex search backend using OpenAI subscription auth. Returns an answer with cited sources. (captured from pi-better-openai)",
    "extension:pi-better-openai",
  ),
  descriptor("fovea_focus", "Focus the code graph on a symbol.", "extension:pi-fovea"),
  descriptor("fovea_impact", "Blast radius of edited files.", "extension:pi-fovea"),
  descriptor("task_run", "Run and track background task runs.", "extension:pi-tasks"),
  descriptor("note_edit", "Edit and run note blocks.", "extension:pi-notes"),
  descriptor("media_render", "Render images and videos into results.", "extension:pi-media"),
  descriptor("db_query", "Query rows and results from tables.", "extension:pi-db"),
  descriptor("mail_send", "Send and draft mail messages.", "extension:pi-mail"),
  descriptor("mail_draft", "Draft mail replies.", "extension:pi-mail"),
  descriptor("mail_list", "List mail threads.", "extension:pi-mail"),
];

const config = (overrides: Partial<FabricCapabilityAdvisoryConfig> = {}): FabricCapabilityAdvisoryConfig => ({
  mode: "hidden",
  threshold: 0.9,
  maxPerSession: 3,
  budget: 512,
  ...overrides,
});

const advisor = (): CapabilityAdvisor => {
  const instance = new CapabilityAdvisor();
  instance.refresh(FIXTURES);
  return instance;
};

// Shared vocabulary (search, web → df = 2, half a quantum each) sits in the
// weak band at s = 1.0: warmth W = 0.5, 0.75, 0.875, 0.9375 crosses θ = 0.9
// on the fourth sustained exposure, igniting both web sources together.
const igniteWebSearch = (
  instance: CapabilityAdvisor,
  cfg: FabricCapabilityAdvisoryConfig = config(),
): CapabilityAdvisoryResult | undefined => {
  let result: CapabilityAdvisoryResult | undefined;
  for (let turn = 0; turn < 4; turn++) {
    result = instance.evaluate("search the web for recent llm pricing news", cfg);
  }
  return result;
};

describe("CapabilityAdvisor", () => {
  it("fires unambiguous matches instantly; shared vocabulary warms over turns", () => {
    // Identity-surface vocabulary is unambiguous: all four fovea terms are
    // unique to pi-fovea (s = 4.0 ≥ θ+1) and ignite instantly in the strong
    // register. Web-search verbs are shared across catalogs (search, web →
    // df = 2 — half a quantum each), so both web sources sit at s = 1.0 in
    // the weak band and ignite together only on the fourth sustained turn.
    const instance = advisor();
    const first = instance.evaluate("focus my code graph on a symbol", config());
    expect(first?.content).toContain("extensions.fovea_focus");
    expect(first?.content).toContain(
      'Next: tools.describe({ref: "extensions.fovea_focus"}) for its schema, then extensions.fovea_focus({…}) inside fabric_exec.',
    );
    expect(first?.content).toContain(
      "Steer: prefer these captured tools over re-implementing the capability",
    );
    expect(first?.content).toContain("pi-fovea · 2 tools matched your prompt.");
    expect(first?.content).toContain("▪ extensions.fovea_focus — Focus the code graph on a symbol.");
    expect(first?.content).not.toContain("might match");
    expect(first?.display).toBe(false);
    const strongNamespaces: CapabilityAdvisoryMatch["namespace"][] =
      first?.details.matches.map((match) => match.namespace) ?? [];
    expect(strongNamespaces).toContain("extension:pi-fovea");

    const web = () => instance.evaluate("search the web for recent llm pricing news", config());
    expect(web()).toBeUndefined();
    expect(web()).toBeUndefined();
    expect(web()).toBeUndefined();
    const fourth = web();
    expect(fourth).toBeDefined();
    // Refs rank by their own prompt-term overlap: the image tool shares the
    // source but must not lead a web-search advisory.
    expect(fourth?.content.indexOf("openai_websearch")).toBeLessThan(
      fourth?.content.indexOf("openai_image") ?? Number.POSITIVE_INFINITY,
    );
    expect(fourth?.content).toContain("extensions.openai_websearch");
    expect(fourth?.content).toContain("extensions.synthetic_web_search");
    expect(fourth?.content).toContain("might match your prompt.");
    expect(fourth?.display).toBe(false);
    const weakNamespaces: CapabilityAdvisoryMatch["namespace"][] =
      fourth?.details.matches.map((match) => match.namespace) ?? [];
    expect(weakNamespaces).toContain("extension:pi-better-openai");
    expect(weakNamespaces).toContain("extension:pi-synthetic");
  });

  it("fires on a web-search prompt even with a tiny captured catalog", () => {
    // Regression: raw idf scoring starved matches when few sources exist
    // (web+search summed below threshold with only two captured sources).
    // 1/df keeps the pair at s = 1.0 in the weak band — sustained exposure
    // ignites on the fourth turn regardless of catalog size.
    const instance = new CapabilityAdvisor();
    instance.refresh(FIXTURES.filter((entry) => entry.namespace?.includes("openai") || entry.namespace?.includes("synthetic")));
    const prompt = "search the web for recent llm pricing news";
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    const result = instance.evaluate(prompt, config());
    expect(result?.content).toContain("extensions.synthetic_web_search");
  });

  it("marks low-confidence matches as possible matches", () => {
    // query (rare) + results (shared) land between threshold and the strong
    // band, so warmth must accumulate: first exposure stays below the
    // ignition point, the second ignites in the might-match register.
    const instance = advisor();
    expect(instance.evaluate("query the results table please", config())).toBeUndefined();
    const result = instance.evaluate("query the results table please", config());
    expect(result).toBeDefined();
    expect(result?.content).toContain("might match your prompt.");
    expect(result?.content).toContain("extensions.db_query");
  });

  it("never fires twice for the same source in one session", () => {
    const instance = advisor();
    const first = igniteWebSearch(instance);
    const second = instance.evaluate("search the web once more please", config());
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("stays silent when nothing matches", () => {
    // "run" appears in two fixture sources (df=2 → contribution 0.5), so the
    // generic run/lint prompt stays well below the 0.9 fire threshold.
    expect(advisor().evaluate("refactor this local function", config())).toBeUndefined();
    expect(advisor().evaluate("run the tests and lint the project", config())).toBeUndefined();
  });

  it("honours disabled mode", () => {
    expect(
      advisor().evaluate("search the web for recent news", config({ mode: "disabled" })),
    ).toBeUndefined();
  });

  it("renders advisories in the transcript only in enabled mode", () => {
    expect(igniteWebSearch(advisor(), config({ mode: "enabled" }))?.display).toBe(true);
  });

  it("caps the number of advisories per session across distinct sources", () => {
    const instance = advisor();
    const capped = config({ maxPerSession: 2 });
    expect(igniteWebSearch(instance, capped)).toBeDefined();
    expect(instance.evaluate("focus my code graph on a symbol", capped)).toBeDefined();
    expect(instance.evaluate("send a mail draft to the team", capped)).toBeUndefined();
  });

  it("ash survives a session reset", () => {
    // reset() only clears session transients (warmth, smoke, per-session
    // cap); burnedness is durable entropy and is never wiped.
    const instance = advisor();
    expect(igniteWebSearch(instance)).toBeDefined();
    instance.reset();
    expect(instance.evaluate("search the web again", config())).toBeUndefined();
    // Unburned capabilities still ignite after a reset.
    expect(instance.evaluate("focus my code graph on a symbol", config())).toBeDefined();
  });

  it("does not fire with an empty index", () => {
    expect(new CapabilityAdvisor().evaluate("search the web", config())).toBeUndefined();
  });

  it("summarises large sources with a more indicator", () => {
    const result = advisor().evaluate("send a mail draft please", config());
    expect(result?.content).toContain("+1 more");
  });

  it("renders candidates as fovea-style icon bullets and degrades down the squeeze ladder", () => {
    // Rung 0: one ▪ bullet per shown tool with its description; leftover tools
    // named in an indented "~ +N more in <source>" counter (measured 103
    // tokens).
    const rich = advisor().evaluate("send and draft mail messages", config());
    expect(rich?.content).toContain("pi-mail · 3 tools matched your prompt.");
    expect(rich?.content).toContain("▪ extensions.mail_send — Send and draft mail messages.");
    expect(rich?.content).toContain("▪ extensions.mail_draft — Draft mail replies.");
    expect(rich?.content).toContain("  ~ +1 more in pi-mail: mail_list");

    // Rung 1: bullets survive but descriptions drop (measured 97 → 82
    // tokens, so a 90-token budget must force this rung).
    const lean = advisor().evaluate("send and draft mail messages", config({ budget: 90 }));
    expect(lean?.content).toContain("\n▪ extensions.mail_send\n");
    expect(lean?.content).not.toContain("Send and draft mail messages.");
    expect(lean?.content).toContain('Next: tools.describe({ref: "extensions.mail_send"})');

    // Rung 2: one ▪ bullet per source, names only, Next: dropped (59 tokens).
    const flat = advisor().evaluate("send and draft mail messages", config({ budget: 64 }));
    expect(flat?.content).toContain(
      "▪ pi-mail · extensions.mail_send, extensions.mail_draft, ~ +1 more: mail_list",
    );
    expect(flat?.content).not.toContain("Next:");
  });

  it("picks up new sources on refresh without clearing fired state", () => {
    const instance = advisor();
    expect(igniteWebSearch(instance)).toBeDefined();
    instance.refresh([
      ...FIXTURES,
      descriptor("tz_convert", "Convert timezone offsets precisely.", "extension:pi-time"),
    ]);
    expect(instance.evaluate("search the web again", config())).toBeUndefined();
    expect(instance.evaluate("convert timezone offsets", config())).toBeDefined();
  });

  it("ignores prompt regions wrapped in pi's skill envelope", () => {
    const a = advisor();
    // The skill envelope itself mentions web search — it must not fire a hint.
    const envelope = `<available_skills>\n<skill>\n<name>web-tools</name>\n<location>web search backend for the project</location>\n</skill>\n</available_skills>`;
    expect(a.evaluate(`please refactor the graph module\n${envelope}`, config())).toBeUndefined();
    expect(a.evaluate(envelope, config())).toBeUndefined();
    // An unclosed skill tag (truncated at end of prompt) is stripped too.
    expect(
      a.evaluate(`<skill><name>web-tools</name><description>search the web, project news</description>`, config()),
    ).toBeUndefined();
    // Intent typed outside the envelope still matches normally. "search" +
    // "web" score 1.0 (weak band); warmth W_k = 1−0.5^k crosses θ=0.9 on the
    // fourth identical prompt.
    const b = advisor();
    const outside = `somewhere in the middle: ${'neutral words'}\nsearch the web please\n${envelope}`;
    expect(b.evaluate(outside, config())).toBeUndefined();
    expect(b.evaluate(outside, config())).toBeUndefined();
    expect(b.evaluate(outside, config())).toBeUndefined();
    const hit = b.evaluate(outside, config());
    expect(hit).toBeDefined();
    expect(hit?.details.matches.some((m) => m.namespace === "extension:pi-synthetic" || m.namespace === "extension:pi-better-openai")).toBe(true);
  });

  it("squeezes content to the configured token budget", () => {
    const a = advisor();
    const tight = a.evaluate("focus search the web and mail please", config({ budget: 128, threshold: 0.1 }));
    expect(tight).toBeDefined();
    expect(Math.ceil(tight!.content.length / 4)).toBeLessThanOrEqual(128);
    // No bracket label on the headline — the floor is a plain Sources
    // sentence followed by the steer directive.
    expect(tight!.content.split("\n")[0]).toMatch(/(matched|might match) your prompt\.$/);
    expect(tight!.content).toContain("Steer:");
    // Details keep the unsqueezed picture even when the text is squeezed.
    expect(tight!.details.matches.length).toBeGreaterThan(0);
  });

  it("falls back to header + steer when even the leanest form busts the budget", () => {
    const a = advisor();
    // Minimum clamp is 128 tokens; craft a threshold=0 so everything matches
    // and budget=128 — the steer line alone is ~30 tokens, header ~10.
    const result = a.evaluate("search the web mail focus file terms", config({ budget: 128, threshold: 0 }));
    expect(result).toBeDefined();
    expect(Math.ceil(result!.content.length / 4)).toBeLessThanOrEqual(128);
  });

  const hintEntry = (namespace: string, at: string) => ({
    type: "custom_message",
    customType: CAPABILITY_ADVISORY_CUSTOM_TYPE,
    timestamp: at,
    details: { matches: [{ namespace }] },
  });

  it("replays ash from the session transcript on reload", () => {
    const first = advisor();
    const firedAdvisory = igniteWebSearch(first);
    expect(firedAdvisory).toBeDefined();
    // No side store: the fired hint persists as its own custom message entry,
    // organic use as the tool call itself. The transcript is the ash ledger.
    const transcript = [
      {
        type: "custom_message",
        customType: CAPABILITY_ADVISORY_CUSTOM_TYPE,
        timestamp: "2026-01-01T00:00:00.000Z",
        details: firedAdvisory?.details,
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "openai_image", arguments: {} }],
        },
      },
    ];
    const second = advisor();
    second.restoreAshFromEntries(transcript, (toolName) =>
      toolName === "openai_image" ? "extension:pi-better-openai" : undefined,
    );
    // Burned namespaces stay quiet, organic use is replayed, timestamps come
    // from the transcript, and unrelated capabilities still fire.
    const burned = second.ashRecords().map((record) => record.namespace).sort();
    expect(burned).toEqual(["extension:pi-better-openai", "extension:pi-synthetic"]);
    expect(
      second.ashRecords().find((record) => record.namespace === "extension:pi-synthetic")?.at,
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(second.evaluate("search the web again", config())).toBeUndefined();
    expect(second.evaluate("focus my code graph on a symbol", config())).toBeDefined();
  });

  it("replays ash only up to the replayed branch point", () => {
    const transcript = [
      hintEntry("extension:pi-synthetic", "2026-01-01T00:00:00.000Z"),
      hintEntry("extension:pi-fovea", "2026-01-01T00:05:00.000Z"),
    ];
    // A fork from the first entry sees ashes up to that point only.
    const forked = advisor();
    forked.restoreAshFromEntries(transcript.slice(0, 1), () => undefined);
    expect(forked.ashRecords().map((record) => record.namespace)).toEqual([
      "extension:pi-synthetic",
    ]);
    expect(forked.evaluate("focus my code graph on a symbol", config())).toBeDefined();
  });

  it("replaces ash on re-replay instead of accumulating", () => {
    const a = advisor();
    a.restoreAshFromEntries(
      [
        hintEntry("extension:pi-synthetic", "2026-01-01T00:00:00.000Z"),
        hintEntry("extension:pi-fovea", "2026-01-01T00:05:00.000Z"),
      ],
      () => undefined,
    );
    // A /tree rewind back before the second burn re-exposes the realm.
    a.restoreAshFromEntries([hintEntry("extension:pi-synthetic", "2026-01-01T00:00:00.000Z")], () => undefined);
    expect(a.ashRecords().map((record) => record.namespace)).toEqual([
      "extension:pi-synthetic",
    ]);
  });

  it("marks fired namespaces with origin and timestamp in the ash record", () => {
    const a = advisor();
    igniteWebSearch(a);
    const fired = a.ashRecords().filter((record) => record.namespace === "extension:pi-synthetic");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.origin).toBe("fired");
    expect(fired[0]?.at).toBeDefined();
  });

  it("poisons organically-discovered namespaces permanently", () => {
    const a = advisor();
    // Model finds synthetic_web_search on its own: the hint must never fire.
    expect(a.observeToolUse("extension:pi-synthetic")).toBe(true);
    // Duplicate observations don't churn the ash set.
    expect(a.observeToolUse("extension:pi-synthetic")).toBe(false);
    expect(a.evaluate("search the web for recent news", config())).toBeUndefined();
    const organic = a.ashRecords().find((record) => record.namespace === "extension:pi-synthetic");
    expect(organic?.origin).toBe("organic");
  });

  it("gates weak-band matches behind sustained warmth", () => {
    // Weak-band score s=1.5: warmth W_i = 1.5·(1−α) Σ_{k<i} α^k with α=0.5,
    // so W_1=0.75 < θ, W_2=1.125 ≥ θ — exactly one soft turn then ignition.
    const instance = advisor();
    expect(instance.evaluate("query the results table please", config())).toBeUndefined();
    expect(instance.evaluate("query the results table please", config())).toBeDefined();
  });

  it("cools weak warmth while the topic is dropped", () => {
    // db scores s = 1.5 (query df = 1, results df = 2): uninterrupted
    // exposure ignites on turn 2 (W: 0.75 → 1.125). Interrupting with an
    // unrelated turn halves the residual warmth (0.375), so the next
    // re-exposure lands at 1.125 only on the second contiguous turn — the
    // dropped topic ignites one turn later (turn 3). Dropped topics cool.
    const prompt = "query the results table please";
    const uninterrupted = advisor();
    expect(uninterrupted.evaluate(prompt, config())).toBeUndefined();
    expect(uninterrupted.evaluate(prompt, config())).toBeDefined();
    const dropped = advisor();
    expect(dropped.evaluate(prompt, config())).toBeUndefined();
    expect(dropped.evaluate("refactor this local function", config())).toBeUndefined();
    expect(dropped.evaluate(prompt, config())).toBeDefined();
  });

  it("raises the weak-band ignition point after ignored fires (smoke)", () => {
    const instance = advisor();
    const prompt = "query the results table please";
    // Two ignored fires stack the smoke streak to 2, raising the weak-band
    // ignition point from θ = 0.9 to 0.9·(1 + 2/τ²) = 1.35. With s = 1.5 the
    // clean trajectory ignites on turn 2 (W = 1.125 ≥ 0.9); under double
    // smoke it needs turn 4 (W: 0.75 → 1.125 → 1.3125 → 1.40625).
    igniteWebSearch(instance);
    instance.endTurn();
    instance.evaluate("focus my code graph on a symbol", config());
    instance.endTurn();
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate(prompt, config())).toBeDefined();
  });

  it("resets the smoke streak when a fired hint leads to tool use", () => {
    const instance = advisor();
    igniteWebSearch(instance);
    instance.observeToolUse("extension:pi-synthetic");
    expect(instance.evaluate("focus my code graph on a symbol", config())).toBeDefined();
    instance.observeToolUse("extension:pi-fovea");
    instance.endTurn(); // both fires combusted → streak reset
    // Ignition stays at the base 0.9: weak fire arrives on exposure two.
    expect(instance.evaluate("query the results table please", config())).toBeUndefined();
    expect(instance.evaluate("query the results table please", config())).toBeDefined();
  });

  it("cannot be gamed by camelCase: one written word is one gate word", () => {
    // "git"/"hub" live in two sources (df = 2 each), so the source-unique
    // exemption never applies: a lone "GitHub" is one written word and never
    // ignites, while the same atoms typed as two words are genuine overlap
    // (s = 1.0 weak band; warmth crosses θ = 0.9 on the fourth exposure).
    const splitCorpus = [
      descriptor("alpha_notes", "Hub notes for git archaeology.", "extension:alpha"),
      descriptor("beta_metrics", "git sums hub metrics.", "extension:beta"),
    ];
    const lone = new CapabilityAdvisor();
    lone.refresh(splitCorpus);
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(lone.evaluate("GitHub", config())).toBeUndefined();
    }
    const twoWords = new CapabilityAdvisor();
    twoWords.refresh(splitCorpus);
    expect(twoWords.evaluate("git hub", config())).toBeUndefined();
    expect(twoWords.evaluate("git hub", config())).toBeUndefined();
    expect(twoWords.evaluate("git hub", config())).toBeUndefined();
    expect(twoWords.evaluate("git hub", config())).toBeDefined();
  });

  it("admits a source-unique word into the weak band through sustained warmth", () => {
    // "project" matches only pi-better-openai (df = 1 → one full score
    // quantum, s = 1.0 ≥ θ). A lone word used to be void; now it ignites like
    // any weak match — on the fourth identical prompt, never the first.
    const instance = advisor();
    expect(instance.evaluate("the project", config())).toBeUndefined();
    expect(instance.evaluate("the project", config())).toBeUndefined();
    expect(instance.evaluate("the project", config())).toBeUndefined();
    const ignited = instance.evaluate("the project", config());
    expect(ignited?.content).toContain("might match your prompt.");
    expect(ignited?.details.matches.map((match) => match.namespace)).toContain(
      "extension:pi-better-openai",
    );
  });

  it("scores one written word as one unit of evidence in any casing", () => {
    // Issue #26: CJK characters atomize to nothing, so the brand word is the
    // only surviving latin token. Every casing of it scores and gates
    // identically — one source-unique word, one quantum (s = 1.0) — and in
    // non-latin prose the word is a deliberate reach across a script
    // boundary, so it ignites on the first turn in the weak might-match
    // register, whichever the casing.
    const catalog = [
      descriptor("github_repo", "Read GitHub repository metadata", "extension:pi-integrations"),
      descriptor("github_issue", "List GitHub issues", "extension:pi-integrations"),
    ];
    for (const prompt of ["看看 github 仓库", "看看 GitHub 仓库", "看看 GITHUB 仓库"]) {
      const instance = new CapabilityAdvisor();
      instance.refresh(catalog);
      const fire = instance.evaluate(prompt, config());
      expect(fire?.details.matches[0]?.score).toBe(1);
      expect(fire?.content).toContain("might match your prompt.");
      expect(fire?.content).toContain("extensions.github_repo");
      // Ash still applies across scripts: the second ask stays silent.
      expect(instance.evaluate(prompt, config())).toBeUndefined();
    }
    // Latin prose gives no such signal: the same lone word is ambient
    // vocabulary there and stays on the slow warmth path, igniting on the
    // fourth sustained prompt, never the first three.
    const latinProse = new CapabilityAdvisor();
    latinProse.refresh(catalog);
    expect(latinProse.evaluate("github", config())).toBeUndefined();
    expect(latinProse.evaluate("github", config())).toBeUndefined();
    expect(latinProse.evaluate("github", config())).toBeUndefined();
    expect(latinProse.evaluate("github", config())).toBeDefined();
    // Ordinary multi-word overlap still reaches the strong band at once, and
    // camelCase spelling of the brand word earns no extra evidence.
    for (const prompt of ["check github repo", "check GitHub repo"]) {
      const instance = new CapabilityAdvisor();
      instance.refresh(catalog);
      const fire = instance.evaluate(prompt, config());
      expect(fire?.details.matches[0]?.score).toBe(2);
      expect(fire?.content).toContain("matched your prompt.");
      expect(fire?.content).not.toContain("might match");
    }
  });

  const MULTI_SOURCE_CATALOG: FabricActionDescriptor[] = [
    descriptor("github_repo", "Read GitHub repository files and metadata.", "extension:github"),
    descriptor("github_issue", "List and create GitHub issues.", "extension:github"),
    descriptor("perplexity_search", "Ask an AI search engine for sourced answers.", "extension:perplexity"),
    descriptor("db_query", "Query rows and files from database tables.", "extension:db"),
    descriptor("mail_send", "Send rows of batched mail messages.", "extension:mail"),
    descriptor("browser_open", "Open a page in the headless browser.", "extension:browser"),
  ];

  it("ignites a deliberate brand word across non-latin scripts on the first turn", () => {
    // Issue #26, round 2 — non-latin prose starves the two-term gate, so the
    // exception must not overfit any one language. In every non-latin script
    // a latin brand word is a deliberate reach across the script boundary:
    // first-turn fire, weak register, one quantum of score, then ash.
    const scriptPrompts: [script: string, prompt: string][] = [
      ["Chinese", "看看 GitHub 仓库"],
      ["Japanese", "GitHub のリポジトリを見せて"],
      ["Korean", "GitHub 저장소를 열어줘"],
      ["Russian", "Открой репозиторий GitHub в браузере"],
      ["Arabic", "افتح مستودع GitHub من فضلك"],
      ["Thai", "เปิดรีโพ GitHub ให้หน่อย"],
      ["Hebrew", "תפתח את המאגר של GitHub"],
    ];
    for (const [script, prompt] of scriptPrompts) {
      const instance = new CapabilityAdvisor();
      instance.refresh(MULTI_SOURCE_CATALOG);
      const fire = instance.evaluate(prompt, config());
      expect(fire, script).toBeDefined();
      expect(fire?.details.matches, script).toHaveLength(1);
      expect(fire?.details.matches[0]?.namespace, script).toBe("extension:github");
      expect(fire?.details.matches[0]?.score, script).toBe(1);
      expect(fire?.content, script).toContain("might match your prompt.");
      expect(fire?.content, script).toContain("extensions.github_repo");
    }
  });

  it("keeps shared vocabulary on the warmth path even in non-latin prose", () => {
    // "files" and "rows" each live in two sources (df = 2 → half a quantum
    // apiece): they reach the weak band by accumulated count, and uniqueness
    // is what the script boundary certifies. Latin and non-latin prose see
    // the same slow path — silent for three turns, firing on the fourth.
    for (const prompt of ["files 和 rows 一起处理", "process the files and rows"]) {
      const instance = new CapabilityAdvisor();
      instance.refresh(MULTI_SOURCE_CATALOG);
      expect(instance.evaluate(prompt, config())).toBeUndefined();
      expect(instance.evaluate(prompt, config())).toBeUndefined();
      expect(instance.evaluate(prompt, config())).toBeUndefined();
      expect(instance.evaluate(prompt, config())).toBeDefined();
    }
    // Non-latin prose that names no latin word has nothing to match at all.
    const noLatin = new CapabilityAdvisor();
    noLatin.refresh(MULTI_SOURCE_CATALOG);
    expect(noLatin.evaluate("仓库 在哪里", config())).toBeUndefined();
  });

  it("exports the custom type used for message injection", () => {
    expect(CAPABILITY_ADVISORY_CUSTOM_TYPE).toBe("pi-fabric-capability");
  });
});

describe("CapabilityAdvisor MCP sources", () => {
  const mcpTool = {
    name: "test.echo-value",
    description: "Echo a value received from the client",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    risk: "network",
    namespace: "test",
  } satisfies FabricActionDescriptor;
  const mcpSlice = (): FabricActionDescriptor[] =>
    [mcpTool].map((entry) => toMcpAdvisoryDescriptor(entry as FabricActionDescriptor));

  it("renders mcp.* refs and burns the mcp: namespace", () => {
    const instance = new CapabilityAdvisor();
    instance.setSource("mcp", mcpSlice());
    const result = instance.evaluate("please echo a value back to me", config());
    expect(result?.content).toContain("mcp:test · 1 tool matched your prompt.");
    expect(result?.content).toContain("▪ mcp.test.echo_value");
    expect(result?.content).not.toContain("extensions.test.echo_value");
    expect(result?.content).toContain(
      'Next: tools.describe({ref: "mcp.test.echo_value"}) for its schema, then mcp.test.echo_value({…}) inside fabric_exec.',
    );
    expect(result?.details.matches[0]?.namespace).toBe("mcp:test");
    // The namespace burned, so the identical prompt stays silent.
    expect(instance.evaluate("please echo a value back to me", config())).toBeUndefined();
  });

  it("keeps slices independent across refreshes", () => {
    const instance = new CapabilityAdvisor();
    instance.setSource("captured", [
      descriptor(
        "synthetic_web_search",
        "Search the web using Synthetic's zero-data-retention API.",
        "extension:pi-synthetic",
      ),
    ]);
    instance.setSource("mcp", mcpSlice());
    instance.setSource("mcp", []);
    const web = instance.evaluate("search the web for docs", config());
    expect(web?.content).toContain("extensions.synthetic_web_search");
    expect(web?.content).not.toContain("mcp.");
    expect(instance.evaluate("please echo a value back to me", config())).toBeUndefined();
  });

  it("restores organic MCP ash from fabric_exec transcript inputs", () => {
    const instance = new CapabilityAdvisor();
    instance.setSource("mcp", mcpSlice());
    const code = "await mcp.test.echo_value({ value: 'x' })";
    instance.restoreAshFromEntries(
      [
        {
          type: "message",
          timestamp: "2024-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "fabric_exec", input: { code } }],
          },
        },
      ],
      (toolName, input) => {
        expect(toolName).toBe("fabric_exec");
        expect(input).toEqual({ code });
        return toolName === "fabric_exec" ? ["mcp:test"] : undefined;
      },
    );
    expect(instance.ashRecords().map((record) => record.namespace)).toContain("mcp:test");
    expect(instance.evaluate("please echo a value back to me", config())).toBeUndefined();
  });
});

describe("identity-surface vocabulary and prompt path context", () => {
  // Verbose multi-sentence descriptions in the style of real MCP servers
  // (fal.ai): instructional tails ("Use this when…", "IMPORTANT: …") describe
  // how to choose the tool, not what the capability IS. The index reads tool
  // names + leading sentences only, so that meta-prose cannot collide with
  // interrogative user prompts ("help me understand…").
  const VERBOSE_FAL: FabricActionDescriptor[] = [
    descriptor(
      "search_models",
      "Search fal.ai's model catalog. Use this to discover available models.\nCategories: text-to-image, image-to-video, text-to-video, text-to-speech, speech-to-text, vision, training.",
      "mcp:fal_ai",
    ),
    descriptor(
      "get_model_schema",
      "Get the full input/output schema for a specific fal.ai model.\nReturns all parameters the model accepts and what it returns.\nUse this before run_model to understand what inputs are needed.",
      "mcp:fal_ai",
    ),
    descriptor(
      "run_model",
      "Run a fal.ai model: submits to the queue and waits a short, bounded time for the result.\nIMPORTANT: If the user does NOT specify a model by id, search first.",
      "mcp:fal_ai",
    ),
    descriptor(
      "check_job",
      "Check the status of a running fal.ai job.\nUse this for long-running jobs (video generation, training, etc.) or when run_model returns status.",
      "mcp:fal_ai",
    ),
    descriptor(
      "search_docs",
      "Search the fal.ai documentation for guides, API references, code examples, and implementation details.\nUse this when you need to understand how fal.ai works, find specific API docs, or get code snippets.",
      "mcp:fal_ai",
    ),
  ];

  const verboseCatalog = (extra: FabricActionDescriptor[] = []) => {
    const instance = new CapabilityAdvisor();
    instance.refresh([...VERBOSE_FAL, ...extra]);
    return instance;
  };

  it("never ignites on a prompt about a documentation path", () => {
    // Regression: full-description indexing matched "understand" (a tail
    // prose verb in search_docs) + "docs" (df = 1 via search_docs' name) for
    // an instant strong fire that permanently burned mcp:fal_ai. Now
    // "understand" is tail prose — not indexed at all — and "docs" only
    // occurs inside the path span docs/heat-diffusion.md: half a quantum,
    // below the threshold, so no warmth even accumulates.
    const instance = verboseCatalog();
    for (let turn = 0; turn < 4; turn++) {
      expect(
        instance.evaluate(
          "Help me understand the mathematics behind docs/heat-diffusion.md",
          config(),
        ),
      ).toBeUndefined();
    }
  });

  it("stays silent on interrogative prompts about local source files", () => {
    const instance = verboseCatalog([
      descriptor("get_me", "Get the authenticated user's profile.", "mcp:github"),
    ]);
    // "me" is prose filler (get_me must not claim it); the filenames carry
    // local-artifact path context; "understand"/"works" live in fal's tails.
    expect(
      instance.evaluate("explain how the worker.ts retry logic works", config()),
    ).toBeUndefined();
    expect(instance.evaluate("help me understand src/config.ts", config())).toBeUndefined();
  });

  it("still fires strongly on the verbose source's actual identity", () => {
    const instance = verboseCatalog();
    const result = instance.evaluate("submit a fal job and check its status", config());
    expect(result?.content).toContain("mcp:fal_ai");
    expect(result?.content).toContain("matched your prompt.");
  });

  it("keeps path-adjacent intent at full strength when prose carries it", () => {
    const instance = verboseCatalog([
      descriptor("read_file", "Read a file.", "mcp:filesystem"),
      descriptor("write_file", "Write or create a file.", "mcp:filesystem"),
      descriptor("create_directory", "Create a directory.", "mcp:filesystem"),
      descriptor("list_directory", "List directory contents and sizes.", "mcp:filesystem"),
    ]);
    // "src/components" is path context and earns nothing, but create /
    // directory / write / file are full-weight prose intent: strong fire.
    const result = instance.evaluate(
      "create a directory src/components and write a file there",
      config(),
    );
    expect(result?.details.matches[0]?.namespace).toBe("mcp:filesystem");
    expect(result?.content).toContain("matched your prompt.");
  });
});
