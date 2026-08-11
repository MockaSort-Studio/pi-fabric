import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FabricSurpriseConfig } from "../src/config.js";
import { SurpriseDetector } from "../src/core/surprise.js";
import { SurpriseTrace } from "../src/core/surprise-trace.js";

const config = (
  overrides: Partial<FabricSurpriseConfig> = {},
): FabricSurpriseConfig => ({
  mode: "trace",
  learn: true,
  budget: 1,
  window: 16,
  drift: 0.3,
  threshold: 2,
  cooldown: 3,
  maxPerSession: 5,
  ...overrides,
});

const cleanTurn = (s: SurpriseDetector, turn: number) => s.endTurn(turn, config());

const errorTurn = (s: SurpriseDetector, turn: number, count = 1, cfg = config()) => {
  for (let i = 0; i < count; i++) {
    s.observeToolStart("bash", { command: `fail-${turn}-${i}` });
    s.observeToolEnd(true);
  }
  return s.endTurn(turn, cfg);
};

describe("SurpriseDetector", () => {
  it("stays silent through a quiet session: zero evidence decays to nothing", () => {
    const s = new SurpriseDetector();
    for (let turn = 0; turn < 24; turn++) {
      const verdict = cleanTurn(s, turn);
      expect(verdict.fire).toBe(false);
      expect(verdict.score).toBe(0);
    }
  });

  it("abstains on the very first turn: no baseline means no judgment", () => {
    const s = new SurpriseDetector();
    const verdict = errorTurn(s, 0, 4);
    expect(verdict.fire).toBe(false);
    expect(verdict.score).toBe(0);
  });

  it("rings once on a rare error burst, absorbs, and adapts to repeats", () => {
    const s = new SurpriseDetector();
    cleanTurn(s, 0);

    const burst = errorTurn(s, 1);
    expect(burst.fire).toBe(true);
    expect(burst.cusum).toBeGreaterThanOrEqual(2);
    expect(burst.firedTotal).toBe(1);
    expect(burst.cooldownLeft).toBe(3);
    expect(burst.reasons[0]).toContain("errors");

    // Absorbed while cooling: S holds at zero.
    for (const turn of [2, 3, 4]) {
      const verdict = cleanTurn(s, turn);
      expect(verdict.fire).toBe(false);
      expect(verdict.cusum).toBe(0);
    }
    cleanTurn(s, 5);

    // Five turns later the same single error no longer clears h: the EWMA
    // baseline absorbed the first burst, so the repeat reads as less strange.
    const repeat = errorTurn(s, 6);
    expect(repeat.fire).toBe(false);
    expect(s.endTurn(7, config()).firedTotal).toBe(1);
  });

  it("learns a steady background error rate and stops firing", () => {
    const s = new SurpriseDetector();
    const cfg = config({ cooldown: 1, maxPerSession: 50 });
    const verdicts = [];
    for (let turn = 0; turn < 48; turn++) {
      s.observeToolStart("bash", { command: `probe-${turn}` });
      s.observeToolEnd(true);
      verdicts.push(s.endTurn(turn, cfg));
    }
    const fires = verdicts.filter((verdict) => verdict.fire).length;
    expect(fires).toBeLessThanOrEqual(2);
    expect(verdicts.slice(-12).every((verdict) => !verdict.fire)).toBe(true);
  });

  it("lets a transient retry loop pass but rings a deepening one", () => {
    const s = new SurpriseDetector();
    cleanTurn(s, 0);
    const attempt = (depth: number) => {
      for (let i = 0; i < depth; i++) {
        s.observeToolStart("read", { path: "/src/stuck.ts" });
      }
    };
    attempt(4);
    const transient = s.endTurn(1, config());
    // 3 retries at the z cap weigh 0.5·4 = 2.0, but the drift allowance d
    // takes 0.3 first: one turn of looping stays below h.
    expect(transient.fire).toBe(false);
    expect(transient.cusum).toBeGreaterThan(0);

    // The sensor normalizes away constant wrongness (z falls as the EWMA
    // catches it), so sustained struggle must ESCALATE to ring: a deeper loop.
    attempt(6);
    const persistent = s.endTurn(2, config());
    expect(persistent.fire).toBe(true);
    // The retouched path also rings as a revisit on its first cross-turn
    // sighting; the retry loop stays among the named contributors.
    expect(persistent.reasons.some((reason) => reason.includes("retries"))).toBe(true);
  });

  it("treats a mid-stream human steer as first-class evidence", () => {
    const s = new SurpriseDetector();
    cleanTurn(s, 0);
    s.observeInput(true);
    const verdict = s.endTurn(1, config());
    expect(verdict.fire).toBe(true);
    expect(verdict.reasons[0]).toContain("steers");
  });

  it("keeps intra-turn file churn out of revisits and revisiting sub-threshold", () => {
    const s = new SurpriseDetector();
    // First touches: warm-up turn, no revisits by construction. The content
    // differs per turn so the same-path retouch reads as a revisit only —
    // identical (tool, args) fingerprints would ALSO count as retries.
    for (const path of ["/a.ts", "/b.ts", "/c.ts"]) {
      s.observeToolStart("edit", { path, content: "v0" });
    }
    expect(s.endTurn(0, config()).features.revisits).toBe(0);

    // Chronic oscillation across whole turns: real revisits, but at these
    // weights their ceiling stays under h — oscillation only adds to a case.
    for (const path of ["/a.ts", "/b.ts", "/c.ts"]) {
      s.observeToolStart("edit", { path, content: "v1" });
    }
    const verdict = s.endTurn(1, config());
    expect(verdict.features.revisits).toBe(3);
    expect(verdict.features.retries).toBe(0);
    expect(verdict.fire).toBe(false);
  });

  it("cannot be rung by autopilot silence alone within the drift allowance", () => {
    const s = new SurpriseDetector();
    s.observeInput(false);
    cleanTurn(s, 0);
    for (let turn = 1; turn <= 8; turn++) {
      expect(cleanTurn(s, turn).fire).toBe(false);
    }
  });

  it("respects the per-session cap", () => {
    const s = new SurpriseDetector();
    const cfg = config({ threshold: 1, cooldown: 1, maxPerSession: 2 });
    cleanTurn(s, 0);
    // Escalating storms, since an adapted baseline re-absorbs identical ones.
    expect(errorTurn(s, 1, 1, cfg).fire).toBe(true);
    cleanTurn(s, 2);
    expect(errorTurn(s, 3, 3, cfg).fire).toBe(true);
    cleanTurn(s, 4);
    expect(errorTurn(s, 5, 5, cfg).fire).toBe(false);
    expect(errorTurn(s, 5, 5, cfg).firedTotal).toBe(2);
  });

  it("reset() returns to a cold baseline", () => {
    const s = new SurpriseDetector();
    cleanTurn(s, 0);
    expect(errorTurn(s, 1).fire).toBe(true);
    s.reset();
    // Cold again: one observation carries no surprise basis.
    expect(errorTurn(s, 0).fire).toBe(false);
    expect(cleanTurn(s, 1).firedTotal).toBe(0);
  });
});

describe("SurpriseTrace", () => {
  it("writes one JSONL verdict per closed turn under the agent dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-surprise-trace-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    try {
      const detector = new SurpriseDetector();
      detector.endTurn(0, config()); // warm the baseline
      const verdict = errorTurn(detector, 1);
      const trace = new SurpriseTrace();
      trace.configure(process.cwd(), "trace-session");
      const file = trace.file();
      expect(file).toContain("fabric-surprise");
      if (!file) throw new Error("trace file not configured");
      trace.append(verdict, "trace");
      const rows = fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0].mode).toBe("trace");
      expect(rows[0].fire).toBe(true);
      expect(rows[0].turn).toBe(1);
      expect(typeof rows[0].cusum).toBe("number");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
