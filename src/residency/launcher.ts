#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const child = spawn(config.piBinary, [
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
    // RPC ends on stdin EOF, so the launcher deliberately keeps this pipe open.
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, PI_FABRIC_RESIDENT_CONFIG: configPath },
  });
  let seenOwner = false;
  let stderr = "";
  const ownerPath = path.join(path.dirname(configPath), "owner.json");
  const ownerPoll = setInterval(() => { seenOwner ||= fs.existsSync(ownerPath); }, 50);
  ownerPoll.unref();
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
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
