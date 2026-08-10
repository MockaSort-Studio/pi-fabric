import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ADVISORY_STATE_FILENAME = "capability-advisories.json";

interface CapabilityAdvisoryFile {
  format: 1;
  fired: string[];
}

const defaultStatePath = (): string =>
  // Sits beside the global actor registry: fired capability hints belong to
  // the user's machine-global agent dir so once-fired advisories stay quiet
  // across session restarts in every project.
  path.join(getAgentDir(), "fabric", ADVISORY_STATE_FILENAME);

const atomicWriteJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
};

export const loadCapabilityAdvisoryState = (filePath?: string): string[] => {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath ?? defaultStatePath(), "utf8")) as Partial<CapabilityAdvisoryFile>;
    if (raw.format !== 1 || !Array.isArray(raw.fired)) return [];
    return raw.fired.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Missing or corrupt state means nothing has fired yet.
    return [];
  }
};

export const saveCapabilityAdvisoryState = (
  fired: Iterable<string>,
  filePath?: string,
): void => {
  const document: CapabilityAdvisoryFile = { format: 1, fired: [...fired] };
  atomicWriteJson(filePath ?? defaultStatePath(), document);
};
