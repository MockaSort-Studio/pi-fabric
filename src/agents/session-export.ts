import os from "node:os";
import path from "node:path";
import type { FabricAgentConfig } from "../config.js";

/**
 * Host-side resolution for the usage export store written by spawned workers
 * (see worker/session-export.ts). The layout mirrors pi-format session stores
 * understood by tokscale and ccusage:
 *
 *   <root>/sessions/<encoded-cwd>/<timestamp>_<runId>.jsonl
 *
 * with root resolved as:
 *
 *   PI_FABRIC_AGENT_DIR env  >  agents.sessionExportDir  >  ~/.pi-fabric/agent
 *
 * tokscale scans the analogous `~/.senpi/agent/sessions` tree for senpi, and
 * ccusage accepts named pi-format stores via its `pi.stores` config; both
 * therefore ingest this store unmodified.
 */

export const SESSION_EXPORT_ENV = "PI_FABRIC_AGENT_DIR";

const expandHome = (value: string): string =>
  value === "~"
    ? os.homedir()
    : value.startsWith("~/") || value.startsWith(`~${path.win32.sep}`)
      ? path.join(os.homedir(), value.slice(2))
      : value;

/**
 * Pi's exact cwd → session-subdir encoding (badlogic/pi-mono
 * getDefaultSessionDirPath): `/Users/dev/project` becomes `--Users-dev-project--`.
 * Both trackers only require the directory to sit under the scanned tree; using
 * pi's encoding keeps fabric sessions visually consistent with native ones.
 */
export const encodeSessionExportCwd = (cwd: string): string =>
  `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Root of the export store, or undefined when `agents.sessionExport` is off. */
export const resolveSessionExportDir = (config: FabricAgentConfig): string | undefined => {
  if (!config.sessionExport) return undefined;
  const raw =
    process.env[SESSION_EXPORT_ENV]?.trim() ||
    config.sessionExportDir.trim() ||
    path.join(os.homedir(), ".pi-fabric", "agent");
  return expandHome(raw);
};

/** Final JSONL path for one run: `<root>/sessions/<encoded-cwd>/<ts>_<runId>.jsonl`. */
export const sessionExportFileFor = (
  root: string,
  cwd: string,
  runId: string,
  at: Date,
): string => {
  const fileTimestamp = at.toISOString().replace(/[:.]/g, "-");
  return path.join(
    root,
    "sessions",
    encodeSessionExportCwd(cwd),
    `${fileTimestamp}_${runId}.jsonl`,
  );
};
