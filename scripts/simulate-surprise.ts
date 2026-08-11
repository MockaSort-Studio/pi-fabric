// Replay harness for the surprise sensor: mines real pi session JSONLs,
// extracts per-turn event streams, replays them through the real
// SurpriseDetector + SurpriseTuning, and reports calibration evidence:
// fire rate vs. budget, h/d/budget trajectories, epoch gap histogram, and
// synthetic regime-shift stress runs. Read-only against the real agent dir;
// tuning persistence is redirected to a temp agent dir.
//
// Usage: npx tsx scripts/simulate-surprise.ts [--projects N=3] [--sessions N=60] [--synth]
//
// Limitations (replay fidelity):
// - steer/followUp inferred from entry position (no streaming flag in JSONL);
// - edit streamability assumed false (cadence feature is inert in replay);
// - turn = assistant message; results attach by toolCallId.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// Redirect tuning persistence BEFORE anything calls getAgentDir().
const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-surprise-sim-"));
process.env.PI_CODING_AGENT_DIR = tmpAgent;

const { SurpriseDetector } = await import("../src/core/surprise.js");
const { SurpriseTuning } = await import("../src/core/surprise-tuning.js");
const { DEFAULT_FABRIC_CONFIG } = await import("../src/config.js");

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const PROJECTS = flag("--projects", 3);
const SESSIONS = flag("--sessions", 60);
const SYNTH = args.includes("--synth");

const CONFIG = { ...DEFAULT_FABRIC_CONFIG.surprise, mode: "trace" as const };
const HOME_DIR = os.homedir();
const REAL_AGENT = path.join(HOME_DIR, ".pi", "agent");
const displayPath = (value: string): string => {
  if (value === HOME_DIR) return "~";
  return value.startsWith(`${HOME_DIR}${path.sep}`)
    ? `~${value.slice(HOME_DIR.length)}`
    : value;
};

interface SessionTool { name: string; args: unknown; isError: boolean }
interface UserEvent { beforeTurn: number; steer: boolean }
interface Extracted {
  cwd: string;
  startedMs: number;
  endedMs: number;
  turns: SessionTool[][];
  users: UserEvent[];
  // Gold labels for "a human should intervene", derived from what humans
  // actually did: mid-run steers, and follow-ups that directly respond to an
  // errored turn (human-forced recovery).
  interventions: number[];
}



const extract = async (file: string): Promise<Extracted | undefined> => {
  const turns: SessionTool[][] = [];
  const users: UserEvent[] = [];
  let cwd = "";
  let startedMs = 0;
  let endedMs = 0;
  let pending: { calls: { id: string; name: string; args: unknown }[]; results: Map<string, boolean> } | undefined;
  const closePending = (): void => {
    if (!pending) return;
    turns.push(
      pending.calls.map((c) => ({ name: c.name, args: c.args, isError: pending?.results.get(c.id) ?? false })),
    );
    pending = undefined;
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length > 2_000_000) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.timestamp) {
      const ms = Date.parse(entry.timestamp);
      if (!startedMs) startedMs = ms;
      endedMs = ms;
    }
    if (entry.type === "session") { cwd = entry.cwd ?? ""; continue; }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "user") {
      users.push({ beforeTurn: pending ? turns.length : Math.max(turns.length - (turns.length ? 0 : 0), 0), steer: !!pending });
      continue;
    }
    if (msg.role === "toolResult") {
      if (pending) pending.results.set(String(msg.toolCallId), !!msg.isError);
      continue;
    }
    if (msg.role === "assistant") {
      closePending();
      const calls = (Array.isArray(msg.content) ? msg.content : [])
        .filter((c: any) => c.type === "toolCall")
        .map((c: any) => ({ id: String(c.id), name: String(c.name), args: c.arguments }));
      pending = { calls, results: new Map() };
    }
  }
  closePending();
  if (!cwd || turns.length === 0) return undefined;
  const interventions: number[] = [];
  for (const u of users) {
    if (u.steer) { interventions.push(u.beforeTurn); continue; }
    const prev = turns[u.beforeTurn - 1];
    if (prev?.some((t) => t.isError)) interventions.push(u.beforeTurn);
  }
  return { cwd, startedMs, endedMs, turns, users, interventions };
};

const main = async (): Promise<void> => {
  const rootDir = path.join(REAL_AGENT, "sessions");
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !n.startsWith("--private-"));
  const ranked = dirs
    .map((n) => {
      const files = fs.readdirSync(path.join(rootDir, n)).filter((f) => f.endsWith(".jsonl")).sort();
      return { n, files, newest: files[files.length - 1] ?? "" };
    })
    .filter((e) => e.files.length > 0)
    .sort((a, b) => b.newest.localeCompare(a.newest))
    .slice(0, PROJECTS);

  const allGapHours: number[] = [];
  const lines: string[] = [];
  const log = (s: string): void => { lines.push(s); };

  for (const proj of ranked) {
    const take = proj.files.slice(-SESSIONS);
    const sessions: Extracted[] = [];
    for (const f of take) {
      const e = await extract(path.join(rootDir, proj.n, f));
      if (e && !e.cwd.startsWith("/private") && !e.cwd.startsWith(os.tmpdir())) sessions.push(e);
    }
    sessions.sort((a, b) => a.startedMs - b.startedMs);
    if (sessions.length === 0) continue;
    const cwd = sessions[0].cwd;
    for (let i = 1; i < sessions.length; i++) {
      allGapHours.push((sessions[i].startedMs - sessions[i - 1].endedMs) / 3_600_000);
    }

    const detector = new SurpriseDetector();
    const tuning = new SurpriseTuning();
    let totalTurns = 0;
    let fires = 0;
    let earlyFires = 0;
    let earlyTurns = 0;
    const sValues: number[] = [];
    const fireNotes: string[] = [];
    let confirmed = 0, ignored = 0;
    // Alignment ledger: which fires led an intervention, which interventions
    // got a led fire, and by how many turns. Near-perfect means the advisor
    // spends tokens only where a human correction was coming anyway.
    const LEAD_WINDOW = 6;
    let interventionsTotal = 0;
    let firesMatched = 0;
    let interventionsMatched = 0;
    let leadSum = 0;
    let earlyFireCount = 0; let earlyFireAligned = 0;
    let lateFireCount = 0; let lateFireAligned = 0;
    const sessionFireTurns: number[] = [];
    for (const sess of sessions) {
      detector.reset();
      tuning.configure(cwd, CONFIG);
      tuning.reset();
      const fireNotesAtStart = fireNotes.length;
      const fireTurnsAtStart = sessionFireTurns.length;
      for (let t = 0; t < sess.turns.length; t++) {
        for (const u of sess.users.filter((u) => u.beforeTurn === t)) {
          detector.observeInput(u.steer);
          tuning.noteHumanActivity();
        }
        for (const tool of sess.turns[t]) {
          detector.observeToolStart(tool.name, tool.args);
          detector.observeToolEnd(tool.isError);
        }
        const p = tuning.parameters(CONFIG);
        const v = detector.endTurn(t, { ...CONFIG, ...p });
        const res = tuning.resolveOutcomes(t, () => ({ subscribed: 0, delivered: 0 }));
        confirmed += res.filter((r) => r.outcome === "confirmed").length;
        ignored += res.filter((r) => r.outcome === "ignored").length;
        if (v.fire) {
          fires++;
          tuning.registerFire(t, CONFIG.cooldown);
          fireNotes.push(`    fire t=${t} S=${v.cusum.toFixed(1)} reasons=${(v.reasons.join("; ") || "none").slice(0, 110)}`);
          sessionFireTurns.push(t);
          if (t < 10) earlyFires++;
        }
        if (t < 10) earlyTurns++;
        tuning.observeTurn(v.score, v.fire);
        sValues.push(v.score);
        totalTurns++;
      }
      const sessionFires = fireNotes.length - fireNotesAtStart > 0
        ? sessionFireTurns.slice(fireTurnsAtStart)
        : [];
      interventionsTotal += sess.interventions.length;
      for (const f of sessionFires) {
        const lead = sess.interventions.find((i) => i >= f && i - f <= LEAD_WINDOW);
        if (lead !== undefined) { firesMatched++; leadSum += lead - f; }
        if (f < 10) { earlyFireCount++; if (lead !== undefined) earlyFireAligned++; }
        else { lateFireCount++; if (lead !== undefined) lateFireAligned++; }
      }
      for (const i of sess.interventions) {
        if (sessionFires.some((f) => f <= i && i - f <= LEAD_WINDOW)) interventionsMatched++;
      }
    }
    const st = tuning.state();
    sValues.sort((a, b) => a - b);
    const q = (p: number): number => sValues[Math.min(sValues.length - 1, Math.floor(p * sValues.length))] ?? 0;
    const spanDays = ((sessions[sessions.length - 1].startedMs - sessions[0].startedMs) / 86_400_000).toFixed(0);
    log(`\n## ${displayPath(cwd)} — ${sessions.length} sessions / ${spanDays}d / ${totalTurns} turns`);
    log(`  fires=${fires} rate=${(1000 * fires / Math.max(totalTurns, 1)).toFixed(1)}/1000 turns (budget target: ${CONFIG.budget}/100)`);
    log(`  early-turn fires (t<10): ${earlyFires}/${fires} over ${earlyTurns} early turns (cold-start check)`);
    log(`  S dist: p50=${q(0.5).toFixed(2)} p90=${q(0.9).toFixed(2)} p99=${q(0.99).toFixed(2)} max=${q(1).toFixed(2)}`);
    log(`  learned end-state: h=${st?.h.toFixed(2)} d=${st?.d.toFixed(2)} budget=${st?.budget.toFixed(2)} turns=${st?.turns} sessions=${st?.sessions}`);
    log(`  outcomes: confirmed=${confirmed} ignored=${ignored} abstained=${Math.max(0, fires - confirmed - ignored)}`);
    const pct = (n: number, dn: number): string => (dn === 0 ? "—" : `${((100 * n) / dn).toFixed(0)}%`);
    log(`  alignment: interventions=${interventionsTotal} precision=${pct(firesMatched, fires)} (${firesMatched}/${fires}) recall=${pct(interventionsMatched, interventionsTotal)} mean-lead=${firesMatched ? (leadSum / firesMatched).toFixed(1) : "—"} turns (window ${LEAD_WINDOW}t)`);
    log(`  split: early(t<10) aligned=${pct(earlyFireAligned, earlyFireCount)} (${earlyFireAligned}/${earlyFireCount}) · late aligned=${pct(lateFireAligned, lateFireCount)} (${lateFireAligned}/${lateFireCount})`);
    for (const note of fireNotes.slice(0, 12)) log(note);
    if (fireNotes.length > 12) log(`    … ${fireNotes.length - 12} more fires`);
  }

  const buckets: Record<string, number> = { "<1h": 0, "1-6h": 0, "6-36h": 0, "36h-3d": 0, "3-7d": 0, ">7d": 0 };
  for (const g of allGapHours) {
    if (g < 1) buckets["<1h"]++;
    else if (g < 6) buckets["1-6h"]++;
    else if (g < 36) buckets["6-36h"]++;
    else if (g < 72) buckets["36h-3d"]++;
    else if (g < 168) buckets["3-7d"]++;
    else buckets[">7d"]++;
  }
  log(`\n## Inter-session gaps (per project, ${allGapHours.length} gaps)`);
  for (const [k, v] of Object.entries(buckets)) log(`  ${k.padEnd(8)} ${"█".repeat(Math.min(60, v))} ${v}`);

  if (SYNTH) {
    log(`\n## Synthetic regime-shift runs`);
    let seed = 42;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (const scenario of ["clean→stuck burst→clean", "clean-only control", "chronic noise"] as const) {
      const detector = new SurpriseDetector();
      const tuning = new SurpriseTuning();
      tuning.configure("/synth", CONFIG);
      tuning.reset();
      let fires = 0;
      const T = 400;
      for (let t = 0; t < T; t++) {
        const inStuck = scenario === "clean→stuck burst→clean" && t >= 200 && t < 206;
        const noisy = scenario === "chronic noise";
        const nTools = noisy ? Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
        for (let i = 0; i < nTools; i++) {
          detector.observeToolStart("bash", { command: `cmd-${i}-${t}` });
          detector.observeToolEnd(false);
        }
        if (inStuck) {
          detector.observeToolStart("bash", { command: "make build" });
          detector.observeToolEnd(true);
          detector.observeToolStart("bash", { command: "npm test" });
          detector.observeToolEnd(true);
          detector.observeToolStart("edit", { path: "/src/x.ts" });
          detector.observeToolEnd(false);
        } else if (rnd() < (noisy ? 0.35 : 0.02)) {
          detector.observeToolStart("bash", { command: "npm test" });
          detector.observeToolEnd(true);
        }
        if (inStuck && t % 2 === 0) { detector.observeInput(true); tuning.noteHumanActivity(); }
        const p = tuning.parameters(CONFIG);
        const v = detector.endTurn(t, { ...CONFIG, ...p });
        const res = tuning.resolveOutcomes(t, () => ({ subscribed: 0, delivered: 0 }));
        void res;
        if (v.fire) { fires++; tuning.registerFire(t, CONFIG.cooldown); }
        tuning.observeTurn(v.score, v.fire);
      }
      const st = tuning.state();
      log(`  ${scenario}: T=${T} fires=${fires} h=${st?.h.toFixed(2)} d=${st?.d.toFixed(2)} budget=${st?.budget.toFixed(2)}`);
    }
  }

  fs.rmSync(tmpAgent, { recursive: true, force: true });
  console.log(lines.join("\n"));
};

await main();
