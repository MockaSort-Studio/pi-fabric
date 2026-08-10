import { describe, expect, it } from "vitest";
import type { FabricCapabilityAdvisoryConfig } from "../src/config.js";
import type { FabricActionDescriptor } from "../src/protocol.js";
import {
  CAPABILITY_ADVISORY_CUSTOM_TYPE,
  CapabilityAdvisor,
  type CapabilityAdvisoryMatch,
} from "../src/core/capability-advisory.js";

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
    "Generate or edit images through the standalone Codex Images API. Supports local reference images and saves to the project by default.",
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

describe("CapabilityAdvisor", () => {
  it("fires unambiguous matches instantly; weak-band sources need sustained exposure", () => {
    // synthetic scores strong (search/web/recent → 2.0 ≥ θ+1), openai is
    // weak (search/web → 1.0): only the strong source ignites on the first
    // prompt, the weak one burns in after sustained exposure (asymptote 1.0
    // crosses θ=0.9 on the fourth identical prompt).
    const instance = advisor();
    const first = instance.evaluate("search the web for recent llm pricing news", config());
    expect(first?.content).toContain("extensions.synthetic_web_search");
    expect(first?.content).not.toContain("extensions.openai_websearch");
    expect(instance.evaluate("search the web for recent llm pricing news", config())).toBeUndefined();
    expect(instance.evaluate("search the web for recent llm pricing news", config())).toBeUndefined();
    const fourth = instance.evaluate("search the web for recent llm pricing news", config());
    expect(fourth).toBeDefined();
    // Refs rank by their own prompt-term overlap: the image tool shares the
    // source but must not lead a web-search advisory.
    expect(fourth?.content.indexOf("openai_websearch")).toBeLessThan(
      fourth?.content.indexOf("openai_image") ?? Number.POSITIVE_INFINITY,
    );
    expect(fourth?.content).toContain("extensions.openai_websearch");
    expect(fourth?.content).toContain("possible match");
    expect(fourth?.display).toBe(false);
    // The strong first fire names the synthetic headline and action line.
    expect(first?.content).toContain("Next: tools.describe('synthetic_web_search')");
    expect(first?.content).toContain(
      "Steer: prefer these captured tools over re-implementing the capability",
    );
    expect(first?.content).toContain("  pi-synthetic\n");
    expect(first?.content).toContain(
      "└─ extensions.synthetic_web_search — Search the web using Synthetic's zero-data-retention API.",
    );
    expect(first?.content).not.toContain("(captured from");
    expect(first?.content).not.toContain("possible match");
    expect(first?.display).toBe(false);
    const strongNamespaces: CapabilityAdvisoryMatch["namespace"][] =
      first?.details.matches.map((match) => match.namespace) ?? [];
    expect(strongNamespaces).toContain("extension:pi-synthetic");
    const weakNamespaces: CapabilityAdvisoryMatch["namespace"][] =
      fourth?.details.matches.map((match) => match.namespace) ?? [];
    expect(weakNamespaces).toContain("extension:pi-better-openai");
  });

  it("fires on a web-search prompt even with a tiny captured catalog", () => {
    // Regression: raw idf scoring starved matches when few sources exist
    // (web+search summed below threshold with only two captured sources).
    const instance = new CapabilityAdvisor();
    instance.refresh(FIXTURES.filter((entry) => entry.namespace?.includes("openai") || entry.namespace?.includes("synthetic")));
    const result = instance.evaluate("search the web for recent llm pricing news", config());
    expect(result?.content).toContain("extensions.synthetic_web_search");
  });

  it("marks low-confidence matches as possible matches", () => {
    // query (rare) + results (shared) land between threshold and the strong
    // band, so warmth must accumulate: first exposure stays below the
    // ignition point, the second ignites as a "possible match".
    const instance = advisor();
    expect(instance.evaluate("query the results table please", config())).toBeUndefined();
    const result = instance.evaluate("query the results table please", config());
    expect(result).toBeDefined();
    expect(result?.content).toContain("possible match");
    expect(result?.content).toContain("extensions.db_query");
  });

  it("never fires twice for the same source in one session", () => {
    const instance = advisor();
    const first = instance.evaluate("search the web for recent llm pricing news", config());
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
    expect(
      advisor().evaluate("search the web for recent news", config({ mode: "enabled" }))?.display,
    ).toBe(true);
  });

  it("caps the number of advisories per session across distinct sources", () => {
    const instance = advisor();
    const capped = config({ maxPerSession: 2 });
    expect(instance.evaluate("search the web for recent news", capped)).toBeDefined();
    expect(instance.evaluate("focus my code graph on a symbol", capped)).toBeDefined();
    expect(instance.evaluate("send a mail draft to the team", capped)).toBeUndefined();
  });

  it("ash survives a session reset", () => {
    // reset() only clears session transients (warmth, smoke, per-session
    // cap); burnedness is durable entropy and is never wiped.
    const instance = advisor();
    expect(instance.evaluate("search the web for recent news", config())).toBeDefined();
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

  it("renders candidates as an indented tree and degrades down the squeeze ladder", () => {
    // Rung 0: tree with one description row per shown tool; leftover tools
    // named in a "+N more" leaf that closes the source block.
    const rich = advisor().evaluate("send and draft mail messages", config());
    expect(rich?.content).toContain("  pi-mail\n");
    expect(rich?.content).toContain("    ├─ extensions.mail_send — Send and draft mail messages.");
    expect(rich?.content).toContain("    ├─ extensions.mail_draft — Draft mail replies.");
    expect(rich?.content).toContain("    └─ +1 more: mail_list");

    // Rung 1: tree shape survives but descriptions drop (measured 104 → 90
    // tokens, so a 100-token budget must force this rung).
    const lean = advisor().evaluate("send and draft mail messages", config({ budget: 100 }));
    expect(lean?.content).toContain("    ├─ extensions.mail_send\n");
    expect(lean?.content).not.toContain("Send and draft mail messages.");
    expect(lean?.content).toContain("Next: tools.describe('mail_send')");

    // Rung 2: flat per-source line, names only, Next: dropped (61 tokens).
    const flat = advisor().evaluate("send and draft mail messages", config({ budget: 64 }));
    expect(flat?.content).toContain(
      "  pi-mail — extensions.mail_send, extensions.mail_draft, +1 more: mail_list",
    );
    expect(flat?.content).not.toContain("Next:");
  });

  it("picks up new sources on refresh without clearing fired state", () => {
    const instance = advisor();
    expect(instance.evaluate("search the web for recent news", config())).toBeDefined();
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
    expect(tight!.content.startsWith("[Fabric capability hint")).toBe(true);
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

  it("stays quiet across simulated restarts when hydrated with ash", () => {
    const first = advisor();
    expect(first.evaluate("search the web for recent news", config())).toBeDefined();
    const second = advisor();
    second.hydrate(first.ashRecords());
    expect(second.evaluate("search the web again", config())).toBeUndefined();
    // Unrelated capabilities still fire after hydration.
    expect(second.ashRecords()).toEqual(first.ashRecords());
    // Unrelated capabilities still fire after hydration.
    expect(second.evaluate("focus my code graph on a symbol", config())).toBeDefined();
  });

  it("marks fired namespaces with origin and timestamp in the ash record", () => {
    const a = advisor();
    a.evaluate("search the web for recent news", config());
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
    // s=1.333 weak band. T1 accumulates W=0.667 (silent). The unrelated
    // focus prompt fires (strong) and halves residual warmth to 0.333, then
    // decays again to 0.167 before the first re-exposure: 0.167+0.667=0.833
    // stays under θ=0.9; only the second clean re-exposure ignites
    // (0.417+0.667=1.083). Continuous repeated prompting would have fired
    // one turn earlier — dropped topics cool.
    const instance = advisor();
    const prompt = "query the results table please";
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate("focus my code graph on a symbol", config())).toBeDefined();
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate(prompt, config())).toBeDefined();
  });

  it("raises the weak-band ignition point after an ignored fire (smoke)", () => {
    const instance = advisor();
    const prompt = "query the results table please";
    // Strong band fires instantly; no tool use this turn → smoke streak 1,
    // ignition rises from 0.9 to 0.9·1.25=1.125. With s=1.333 the clean
    // trajectory ignites on turn 2 (W=1.0); under smoke it needs turn 3
    // (W: 0.667 → 1.0 → 1.167, where the final evaluates fire).
    expect(instance.evaluate("search the web for recent news", config())).toBeDefined();
    instance.endTurn();
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate(prompt, config())).toBeUndefined();
    expect(instance.evaluate(prompt, config())).toBeDefined();
  });

  it("resets the smoke streak when a fired hint leads to tool use", () => {
    const instance = advisor();
    expect(instance.evaluate("search the web for recent news", config())).toBeDefined();
    instance.observeToolUse("extension:pi-synthetic");
    expect(instance.evaluate("focus my code graph on a symbol", config())).toBeDefined();
    instance.observeToolUse("extension:pi-fovea");
    instance.endTurn(); // both fires combusted → streak reset
    // Ignition stays at the base 0.9: weak fire arrives on exposure two.
    expect(instance.evaluate("query the results table please", config())).toBeUndefined();
    expect(instance.evaluate("query the results table please", config())).toBeDefined();
  });

  it("exports the custom type used for message injection", () => {
    expect(CAPABILITY_ADVISORY_CUSTOM_TYPE).toBe("pi-fabric-capability");
  });
});
