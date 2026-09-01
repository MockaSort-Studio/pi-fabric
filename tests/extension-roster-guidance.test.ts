import { describe, expect, it } from "vitest";
import { extensionToolRosterGuidance } from "../src/core/system-guidance.js";

const entry = (name: string, sourceInfo?: { source?: string; path?: string }) => ({
  name,
  ...(sourceInfo === undefined ? {} : { sourceInfo }),
});

describe("extensionToolRosterGuidance", () => {
  it("lists tool names grouped by source namespace without descriptions", () => {
    const roster = extensionToolRosterGuidance(
      [
        entry("fovea_focus", { source: "pi-fovea" }),
        entry("fovea_dwell", { source: "pi-fovea" }),
        entry("openai_image", { source: "pi-better-openai" }),
      ],
      new Set(["read", "bash"]),
    );
    expect(roster).toContain("- pi-better-openai: openai_image");
    expect(roster).toContain("- pi-fovea: fovea_dwell, fovea_focus");
    expect(roster).toContain("tools.list");
  });

  it("falls back to path basenames, then a generic label", () => {
    const roster = extensionToolRosterGuidance(
      [
        entry("from_entry", { path: "/ext/pi-somewhere/index.js" }),
        entry("from_file", { path: "/ext/pi-other/cool.js" }),
        entry("bare"),
      ],
      new Set(),
    );
    expect(roster).toContain("- pi-somewhere: from_entry");
    expect(roster).toContain("- cool.js: from_file");
    expect(roster).toContain("- extensions: bare");
  });

  it("excludes captured core overrides and empty catalogs", () => {
    expect(extensionToolRosterGuidance([entry("read")], new Set(["read"]))).toBeUndefined();
    expect(extensionToolRosterGuidance([], new Set())).toBeUndefined();
  });
});
