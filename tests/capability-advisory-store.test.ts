import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("capability advisory state store", () => {
  it("round-trips fired namespaces", () => {
    const filePath = path.join(temporaryDirectory(), "nested", "capability-advisories.json");
    saveCapabilityAdvisoryState(["extension:pi-web", "extension:pi-fovea"], filePath);
    expect(loadCapabilityAdvisoryState(filePath)).toEqual([
      "extension:pi-web",
      "extension:pi-fovea",
    ]);
  });

  it("returns an empty set for missing state", () => {
    expect(loadCapabilityAdvisoryState(path.join(temporaryDirectory(), "absent.json"))).toEqual([]);
  });

  it("returns an empty set for corrupt or wrong-format state", () => {
    const filePath = path.join(temporaryDirectory(), "capability-advisories.json");
    fs.writeFileSync(filePath, "{ not json", "utf8");
    expect(loadCapabilityAdvisoryState(filePath)).toEqual([]);
    fs.writeFileSync(filePath, JSON.stringify({ format: 2, fired: ["extension:x"] }), "utf8");
    expect(loadCapabilityAdvisoryState(filePath)).toEqual([]);
  });

  it("accumulates across saves without losing prior namespaces", () => {
    const filePath = path.join(temporaryDirectory(), "capability-advisories.json");
    saveCapabilityAdvisoryState(["extension:pi-web"], filePath);
    saveCapabilityAdvisoryState([...loadCapabilityAdvisoryState(filePath), "extension:pi-fovea"], filePath);
    expect(loadCapabilityAdvisoryState(filePath)).toEqual([
      "extension:pi-web",
      "extension:pi-fovea",
    ]);
  });
});