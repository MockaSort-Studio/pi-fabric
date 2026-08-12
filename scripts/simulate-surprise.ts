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
import type { LabSession } from "./surprise-lab.js";

// Redirect tuning persistence BEFORE anything calls getAgentDir().
const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-surprise-sim-"));
process.env.PI_CODING_AGENT_DIR = tmpAgent;

const { SurpriseDetector } = await import("../src/core/surprise.js");
const { SurpriseTuning } = await import("../src/core/surprise-tuning.js");
const { DEFAULT_FABRIC_CONFIG } = await import("../src/config.js");
const { evaluateSession, extractLabSession } = await import("./surprise-lab.js");

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

type Extracted = LabSession;

const extract = async (file: string): Promise<Extracted | undefined> =>
  extractLabSession(file);

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
    const firstSession = sessions[0];
    if (!firstSession) continue;
    const cwd = firstSession.cwd;
    for (let i = 1; i < sessions.length; i++) {
      const current = sessions[i];
      const previous = sessions[i - 1];
      if (current && previous) {
        allGapHours.push((current.startedMs - previous.endedMs) / 3_600_000);
      }
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
    const LEAD_WINDOW = 20;
    let interventionsTotal = 0;
    let firesMatched = 0;
    let interventionsMatched = 0;
    let leadSum = 0;
    let earlyFireCount = 0;
    let lateFireCount = 0;
    const sessionFireTurns: number[] = [];
    for (const sess of sessions) {
      detector.reset();
      tuning.configure(cwd, CONFIG);
      tuning.reset();
      const fireNotesAtStart = fireNotes.length;
      const fireTurnsAtStart = sessionFireTurns.length;
      for (let t = 0; t < sess.turns.length; t++) {
        for (const u of sess.users.filter((u) => u.beforeTurn === t)) {
          detector.observeInput(u.kind === "steer");
          tuning.noteHumanActivity();
        }
        const turn = sess.turns[t];
        if (!turn) continue;
        for (const tool of turn.tools) {
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
      const evaluation = evaluateSession(
        sess,
        sessionFires,
        ["steer", "abort"],
        LEAD_WINDOW,
      );
      interventionsTotal += evaluation.labels;
      firesMatched += evaluation.matches;
      interventionsMatched += evaluation.matches;
      leadSum += evaluation.leadSum;
      for (const fire of sessionFires) {
        if (fire < 10) earlyFireCount += 1;
        else lateFireCount += 1;
      }
    }
    const st = tuning.state();
    sValues.sort((a, b) => a - b);
    const q = (p: number): number => sValues[Math.min(sValues.length - 1, Math.floor(p * sValues.length))] ?? 0;
    const lastSession = sessions.at(-1) ?? firstSession;
    const spanDays = ((lastSession.startedMs - firstSession.startedMs) / 86_400_000).toFixed(0);
    log(`\n## ${displayPath(cwd)} — ${sessions.length} sessions / ${spanDays}d / ${totalTurns} turns`);
    log(`  fires=${fires} rate=${(1000 * fires / Math.max(totalTurns, 1)).toFixed(1)}/1000 turns (budget target: ${CONFIG.budget}/100)`);
    log(`  early-turn fires (t<10): ${earlyFires}/${fires} over ${earlyTurns} early turns (cold-start check)`);
    log(`  S dist: p50=${q(0.5).toFixed(2)} p90=${q(0.9).toFixed(2)} p99=${q(0.99).toFixed(2)} max=${q(1).toFixed(2)}`);
    log(`  learned end-state: h=${st?.h.toFixed(2)} d=${st?.d.toFixed(2)} budget=${st?.budget.toFixed(2)} turns=${st?.turns} sessions=${st?.sessions}`);
    log(`  outcomes: confirmed=${confirmed} ignored=${ignored} abstained=${Math.max(0, fires - confirmed - ignored)}`);
    const pct = (n: number, dn: number): string => (dn === 0 ? "—" : `${((100 * n) / dn).toFixed(0)}%`);
    log(`  alignment: interventions=${interventionsTotal} precision=${pct(firesMatched, fires)} (${firesMatched}/${fires}) recall=${pct(interventionsMatched, interventionsTotal)} mean-lead=${firesMatched ? (leadSum / firesMatched).toFixed(1) : "—"} turns (window ${LEAD_WINDOW}t)`);
    log(`  split: early(t<10) fires=${earlyFireCount} · late fires=${lateFireCount}`);
    for (const note of fireNotes.slice(0, 12)) log(note);
    if (fireNotes.length > 12) log(`    … ${fireNotes.length - 12} more fires`);
  }

  const buckets: Record<string, number> = { "<1h": 0, "1-6h": 0, "6-36h": 0, "36h-3d": 0, "3-7d": 0, ">7d": 0 };
  const increment = (key: keyof typeof buckets): void => {
    buckets[key] = (buckets[key] ?? 0) + 1;
  };
  for (const g of allGapHours) {
    if (g < 1) increment("<1h");
    else if (g < 6) increment("1-6h");
    else if (g < 36) increment("6-36h");
    else if (g < 72) increment("36h-3d");
    else if (g < 168) increment("3-7d");
    else increment(">7d");
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
