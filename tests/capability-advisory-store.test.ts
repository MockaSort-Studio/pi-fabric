import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityBurn } from "../src/core/capability-advisory.js";
import {
  loadCapabilityAdvisoryState,
  saveCapabilityAdvisoryState,
} from "../src/core/capability-advisory-store.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-advisory-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("capability advisory ash store", () => {
  it("round-trips burn records with origin and timestamp", () => {
    const filePath = path.join(temporaryDirectory(), "nested", "capability-advisories.json");
    const records: CapabilityBurn[] = [
      { namespace: "extension:pi-web", origin: "fired", at: "2026-08-10T16:00:00.000Z" },
      { namespace: "extension:pi-fovea", origin: "organic" },
    ];
    saveCapabilityAdvisoryState(records, filePath);
    expect(loadCapabilityAdvisoryState(filePath)).toEqual(records);
  });

  it("migrates format-1 string arrays to fired origin", () => {
    const filePath = path.join(temporaryDirectory(), "capability-advisories.json");
    fs.writeFileSync(filePath, JSON.stringify({ format: 1, fired: ["extension:pi-web", 42] }), "utf8");
    expect(loadCapabilityAdvisoryState(filePath)).toEqual([
      { namespace: "extension:pi-web", origin: "fired" },
    ]);
  });

  it("returns an empty set for missing state", () => {
    expect(loadCapabilityAdvisoryState(path.join(temporaryDirectory(), "absent.json"))).toEqual([]);
  });

  it("returns an empty set for corrupt or wrong-format state", () => {
    const filePath = path.join(temporaryDirectory(), "capability-advisories.json");
    fs.writeFileSync(filePath, "{ not json", "utf8");
    expect(loadCapabilityAdvisoryState(filePath)).toEqual([]);
    fs.writeFileSync(filePath, JSON.stringify({ format: 3, burned: [] }), "utf8");
    expect(loadCapabilityAdvisoryState(filePath)).toEqual([]);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ format: 2, burned: [{ namespace: "extension:x", origin: "never" }] }),
      "utf8",
    );
    expect(loadCapabilityAdvisoryState(filePath)).toEqual([]);
  });

  it("accumulates across saves without losing prior namespaces", () => {
    const filePath = path.join(temporaryDirectory(), "capability-advisories.json");
    const first: CapabilityBurn[] = [{ namespace: "extension:pi-web", origin: "fired" }];
    saveCapabilityAdvisoryState(first, filePath);
    const second: CapabilityBurn[] = [
      ...loadCapabilityAdvisoryState(filePath),
      { namespace: "extension:pi-fovea", origin: "organic" },
    ];
    saveCapabilityAdvisoryState(second, filePath);
    expect(loadCapabilityAdvisoryState(filePath)).toEqual(second);
  });
});