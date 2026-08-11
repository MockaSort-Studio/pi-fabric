import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { encodeCwdDir } from "../memory/discovery.js";
import type { FabricSurpriseMode } from "../config.js";
import type { SurpriseVerdict } from "./surprise.js";

// Per-turn trace for the surprise sensor. One JSONL line per closed turn
// under the pi agent dir, keyed by project cwd and session id — the same
// placement convention as pi's own session storage. Tracing is advisory: a
// trace write failure must never fail a turn.
export class SurpriseTrace {
  #file: string | undefined;

  configure(cwd: string, sessionId: string): void {
    this.#file = path.join(
      getAgentDir(),
      "fabric-surprise",
      encodeCwdDir(cwd),
      `${sessionId}.jsonl`,
    );
  }

  reset(): void {
    this.#file = undefined;
  }

  file(): string | undefined {
    return this.#file;
  }

  // Raw record sink for non-verdict rows (tuning outcome resolutions):
  // same file, same one-JSON-line-per-event shape.
  note(record: Record<string, unknown>): void {
    if (this.#file === undefined) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.appendFileSync(
        this.#file,
        `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
      );
    } catch {
      // Deliberately swallowed: see class comment.
    }
  }

  append(verdict: SurpriseVerdict, mode: FabricSurpriseMode): void {
    if (this.#file === undefined) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.appendFileSync(
        this.#file,
        `${JSON.stringify({ at: new Date().toISOString(), mode, ...verdict })}\n`,
      );
    } catch {
      // Deliberately swallowed: see class comment.
    }
  }
}
