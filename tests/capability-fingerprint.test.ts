import { describe, expect, it } from "vitest";
import type { FabricActionDescriptor } from "../src/protocol.js";
import {
  buildCapabilityIndex,
  capabilitySourceLabel,
  type CapabilitySourceFingerprint,
  tokenizeCapabilityText,
  truncateAdvisoryDescription,
} from "../src/core/capability-fingerprint.js";

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

describe("tokenizeCapabilityText", () => {
  it("splits camelCase, snake_case, and punctuation-separated identifiers", () => {
    expect(tokenizeCapabilityText("openaiWebSearch_v2.run-now/the thing")).toEqual([
      "openai",
      "web",
      "search",
      "v2",
      "run",
      "now",
      "thing",
    ]);
  });

  it("drops stopwords and single-character tokens", () => {
    expect(tokenizeCapabilityText("a run with the B tool")).toEqual(["run", "tool"]);
  });
});

describe("buildCapabilityIndex", () => {
  it("groups descriptors by source namespace and counts tools", () => {
    const index = buildCapabilityIndex([
      descriptor("one_tool", "first tool of alpha", "extension:alpha"),
      descriptor("two_tool", "second tool of alpha", "extension:alpha"),
      descriptor("beta_tool", "only tool of beta", "extension:beta"),
    ]);
    expect(index.sourceCount).toBe(2);
    const alpha: CapabilitySourceFingerprint | undefined = index.sources.find(
      (source) => source.namespace === "extension:alpha",
    );
    expect(alpha?.toolCount).toBe(2);
    expect(alpha?.label).toBe("alpha");
  });

  it("scores rare terms above shared terms in idf", () => {
    const index = buildCapabilityIndex([
      descriptor("a", "alpha unicorn shared", "extension:a"),
      descriptor("b", "beta unicorn shared", "extension:b"),
      descriptor("c", "gamma shared", "extension:c"),
    ]);
    expect(index.idf("unicorn")).toBeGreaterThan(index.idf("shared"));
    expect(index.idf("missing")).toBe(0);
  });

  it("handles an empty descriptor list", () => {
    const index = buildCapabilityIndex([]);
    expect(index.sourceCount).toBe(0);
    expect(index.idf("anything")).toBe(0);
  });
});

describe("capabilitySourceLabel", () => {
  it("strips the extension prefix and tolerates missing namespaces", () => {
    expect(capabilitySourceLabel("extension:pi-fovea")).toBe("pi-fovea");
    expect(capabilitySourceLabel("mcp:server")).toBe("mcp:server");
    expect(capabilitySourceLabel(undefined)).toBe("unscoped");
  });
});

describe("truncateAdvisoryDescription", () => {
  it("keeps the first sentence when it fits", () => {
    const text =
      "Search the web using Synthetic's zero-data-retention API. Returns a long detail dump that far exceeds the advisory budget per ref.";
    expect(truncateAdvisoryDescription(text)).toBe(
      "Search the web using Synthetic's zero-data-retention API.",
    );
  });

  it("strips capture provenance suffixes", () => {
    expect(truncateAdvisoryDescription("Focus the code graph. (captured from pi-fovea)")).toBe(
      "Focus the code graph.",
    );
  });

  it("truncates long sentence-less text with an ellipsis within budget", () => {
    const text = "x".repeat(200);
    const truncated = truncateAdvisoryDescription(text);
    expect(truncated.length).toBeLessThanOrEqual(64);
    expect(truncated.endsWith("…")).toBe(true);
  });
});
