#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { observeResidentOwner } from "./launcher-owner.js";

// Same pattern as worker.ts: on Windows, `pi` resolves to a node_modules/.bin
// .cmd shim that a raw spawn cannot execute, and a .js pi entry must run under
// a real runtime. The launcher itself is always started through a resolved
// generic runtime, so process.execPath is node or bun here.
const NODE_SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);
const spawnPi = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof crossSpawn>[2],
): ReturnType<typeof crossSpawn> =>
  NODE_SCRIPT_EXTENSIONS.has(path.extname(command).toLowerCase())
    ? crossSpawn(process.execPath, [command, ...args], options)
    : crossSpawn(command, [...args], options);

const parseConfigPath = (argv: readonly string[]): string => {
  const index = argv.indexOf("--config");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("Missing resident launcher argument: --config");
  return path.resolve(value);
};

const readConfig = (configPath: string): { cwd: string; piBinary: string } => {
  const value: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Fabric resident host config");
  }
  const config = value as { cwd?: unknown; piBinary?: unknown };
  if (typeof config.cwd !== "string" || typeof config.piBinary !== "string") {
    throw new Error("Fabric resident host config is incomplete");
  }
  return { cwd: config.cwd, piBinary: config.piBinary };
};

const liveOwnerPid = (ownerPath: string): number | undefined => {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number") return undefined;
    process.kill(owner.pid, 0);
    return owner.pid;
  } catch {
    return undefined;
  }
};

const writeFailure = (configPath: string, error: unknown): void => {
  try {
    const message = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(path.join(path.dirname(configPath), "error.json"), JSON.stringify({
      error: message,
      occurredAt: Date.now(),
    }, null, 2));
  } catch {
    // Startup diagnostics are best-effort.
  }
};

const configPath = parseConfigPath(process.argv);
try {
  const config = readConfig(configPath);
  const entry = fileURLToPath(new URL("./pi-entry.js", import.meta.url));
  // Pi loads extension peers through its virtual module runtime; raw Node cannot.
  const child = spawnPi(config.piBinary, [
    "--mode", "rpc",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension", entry,
  ], {
    cwd: config.cwd,
    detached: false,
    // RPC ends on stdin EOF. Keep it open only while this child owns residency.
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, PI_FABRIC_RESIDENT_CONFIG: configPath },
  });
  let seenOwner = false;
  let claimedOwner = false;
  let closingInput = false;
  let stderr = "";
  const ownerPath = path.join(path.dirname(configPath), "owner.json");
  // The resident host may start slowly or fail silently; keep the child stderr
  // and the latest ownership observation on disk so a client-side startup
  // timeout can surface the real cause instead of a bare deadline error.
  const childLogPath = path.join(path.dirname(configPath), "child-stderr.log");
  try { fs.rmSync(childLogPath, { force: true }); } catch { /* best effort */ }
  const ownerPoll = setInterval(() => {
    const observation = observeResidentOwner(liveOwnerPid(ownerPath), child.pid, claimedOwner);
    claimedOwner = observation.claimed;
    seenOwner ||= observation.observedOwner;
    if (observation.closeInput && !closingInput) {
      closingInput = true;
      child.stdin?.end();
    }
  }, 50);
  ownerPoll.unref();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
    try { fs.writeFileSync(childLogPath, stderr); } catch { /* best effort */ }
  });
  child.on("error", (error) => writeFailure(configPath, error));
  child.on("exit", (code, signal) => {
    clearInterval(ownerPoll);
    if (!seenOwner) writeFailure(configPath, stderr.trim() || `Pi resident host exited (${signal ?? code ?? "unknown"})`);
    process.exitCode = code ?? 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => child.kill(signal));
  }
} catch (error) {
  writeFailure(configPath, error);
  process.exitCode = 1;
}
