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
  it("fires on a web-search prompt and names both matching sources", () => {
    const result = advisor().evaluate("search the web for recent llm pricing news", config());
    expect(result).toBeDefined();
    expect(result?.content).toContain("extensions.synthetic_web_search");
    expect(result?.content).toContain("extensions.openai_websearch");
    // Refs rank by their own prompt-term overlap: the image tool shares the
    // source but must not lead a web-search advisory.
    expect(result?.content.indexOf("openai_websearch")).toBeLessThan(
      result?.content.indexOf("openai_image") ?? Number.POSITIVE_INFINITY,
    );
    expect(result?.content).toContain("Next: tools.describe('synthetic_web_search')");
    expect(result?.content).toContain(
      "Steer: prefer these captured tools over re-implementing the capability",
    );
    expect(result?.content).toContain("  pi-synthetic — extensions.synthetic_web_search");
    expect(result?.content).not.toContain("(captured from");
    expect(result?.content).not.toContain("possible match");
    expect(result?.display).toBe(false);
    const namespaces: CapabilityAdvisoryMatch["namespace"][] =
      result?.details.matches.map((match) => match.namespace) ?? [];
    expect(namespaces).toContain("extension:pi-synthetic");
    expect(namespaces).toContain("extension:pi-better-openai");
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
    // query (rare) + results (shared) land between threshold and the strong band.
    const result = advisor().evaluate("query the results table please", config());
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

  it("re-arms sources after a session reset", () => {
    const instance = advisor();
    expect(instance.evaluate("search the web for recent news", config())).toBeDefined();
    instance.reset();
    expect(instance.evaluate("search the web again", config())).toBeDefined();
  });

  it("does not fire with an empty index", () => {
    expect(new CapabilityAdvisor().evaluate("search the web", config())).toBeUndefined();
  });

  it("summarises large sources with a more indicator", () => {
    const result = advisor().evaluate("send a mail draft please", config());
    expect(result?.content).toContain("+1 more");
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
    // Intent typed outside the envelope still matches normally.
    const b = advisor();
    const hit = b.evaluate(`somewhere in the middle: ${'neutral words'}\nsearch the web please\n${envelope}`, config());
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

  it("stays quiet across simulated restarts when hydrated with fired state", () => {
    const first = advisor();
    expect(first.evaluate("search the web for recent news", config())).toBeDefined();
    const second = advisor();
    second.hydrate(first.firedNamespaces());
    expect(second.evaluate("search the web again", config())).toBeUndefined();
    // Unrelated capabilities still fire after hydration.
    expect(second.evaluate("focus my code graph on a symbol", config())).toBeDefined();
  });

  it("exports the custom type used for message injection", () => {
    expect(CAPABILITY_ADVISORY_CUSTOM_TYPE).toBe("pi-fabric-capability");
  });
});
