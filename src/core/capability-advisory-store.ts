import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ADVISORY_STATE_FILENAME = "capability-advisories.json";

import type { CapabilityBurn } from "./capability-advisory.js";

// Format 2 stores the ash record (origin + burn time); format 1 files carried
// a bare namespace list and migrate in as origin "fired" with no timestamp.
interface CapabilityAdvisoryFile {
  format: 2;
  burned: CapabilityBurn[];
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

export const loadCapabilityAdvisoryState = (filePath?: string): CapabilityBurn[] => {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath ?? defaultStatePath(), "utf8")) as {
      format?: number;
      burned?: unknown;
      fired?: unknown;
    };
    if (raw.format === 2 && Array.isArray(raw.burned)) {
      return raw.burned.filter(
        (entry): entry is CapabilityBurn =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as CapabilityBurn).namespace === "string" &&
          ((entry as CapabilityBurn).origin === "fired" ||
            (entry as CapabilityBurn).origin === "organic"),
      );
    }
    if (raw.format === 1 && Array.isArray(raw.fired)) {
      return raw.fired
        .filter((entry): entry is string => typeof entry === "string")
        .map((namespace) => ({ namespace, origin: "fired" as const }));
    }
    return [];
  } catch {
    // Missing or corrupt state means nothing has burned yet.
    return [];
  }
};

export const saveCapabilityAdvisoryState = (
  burned: Iterable<CapabilityBurn>,
  filePath?: string,
): void => {
  const document: CapabilityAdvisoryFile = { format: 2, burned: [...burned] };
  atomicWriteJson(filePath ?? defaultStatePath(), document);
};
