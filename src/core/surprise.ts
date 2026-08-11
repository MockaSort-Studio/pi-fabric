import type { FabricSurpriseConfig } from "../config.js";

// Turn-level surprise sensor (math: docs/surprise.md). Behavioral features
// accumulate between turn boundaries; each is normalized against its own
// recent history by a bias-corrected EWMA (one-sided z, winsorized), weighted
// into per-turn nonconformity s_t, and integrated by a CUSUM accumulator
// S_t = max(0, S_{t-1} + s_t − d). Firing at S_t ≥ h, absorbing S on fire,
// cooling down, and capping per session reuse the same deficit-accumulator
// idiom as capability combustion and fovea's sync ledger.

type SurpriseFeatureName = "errors" | "retries" | "steers" | "revisits" | "gap";

export type SurpriseFeatureVector = Record<SurpriseFeatureName, number>;

export interface SurpriseVerdict {
  turn: number;
  features: SurpriseFeatureVector;
  z: SurpriseFeatureVector;
  score: number;
  cusum: number;
  threshold: number;
  drift: number;
  fire: boolean;
  firedTotal: number;
  cooldownLeft: number;
  reasons: string[];
}

// Feature weights are quanta of observer-worthiness per z unit. Only a rare
// error turn (1.0) or a mid-stream human steer (1.25) can cross h = 2 on one
// turn at the z cap; retries need a ≥ 4-deep repeat loop; revisits and gap
// can only accumulate — sustained drift, never a single blip, rings the sensor.
const FEATURE_WEIGHTS: SurpriseFeatureVector = {
  errors: 1,
  retries: 0.5,
  steers: 1.25,
  revisits: 0.4,
  gap: 0.2,
};
const FEATURE_NAMES = Object.keys(FEATURE_WEIGHTS) as SurpriseFeatureName[];

const Z_CAP = 4;
// Count features sit on zero-variance baselines; the floor keeps one rare
// event loud (z = 4 at the elbow) instead of dividing by ~0, while making
// events at their baseline rate score z ≈ 0 regardless of spread shape.
const Z_FLOOR = 0.25;
const MAX_REASONS = 2;
const ARG_FINGERPRINT_CHARS = 4_096;

interface EwmaStat {
  n: number;
  mean: number;
  variance: number;
}

const zeroFeatures = (): SurpriseFeatureVector => ({
  errors: 0,
  retries: 0,
  steers: 0,
  revisits: 0,
  gap: 0,
});

const zeroStats = (): Record<SurpriseFeatureName, EwmaStat> => ({
  errors: { n: 0, mean: 0, variance: 0 },
  retries: { n: 0, mean: 0, variance: 0 },
  steers: { n: 0, mean: 0, variance: 0 },
  revisits: { n: 0, mean: 0, variance: 0 },
  gap: { n: 0, mean: 0, variance: 0 },
});

// One-sided z against the bias-corrected EWMA baseline computed BEFORE the
// current observation joins it. With no history at all (n = 0) there is no
// basis for judgment, so the feature abstains; the very first turn of any
// session is silent by construction.
const ewmaZ = (stat: EwmaStat, x: number, alpha: number): number => {
  if (stat.n === 0) return 0;
  const correction = 1 - (1 - alpha) ** stat.n;
  const mean = correction > 0 ? stat.mean / correction : 0;
  const spread = Math.sqrt(Math.max(correction > 0 ? stat.variance / correction : 0, 0)) + Z_FLOOR;
  return Math.min(Math.max((x - mean) / spread, 0), Z_CAP);
};

const ewmaUpdate = (stat: EwmaStat, x: number, alpha: number): void => {
  const previousMean = stat.mean;
  stat.n += 1;
  stat.mean = (1 - alpha) * stat.mean + alpha * x;
  stat.variance = (1 - alpha) * (stat.variance + alpha * (x - previousMean) ** 2);
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const fingerprintArgs = (args: unknown): string => {
  if (typeof args !== "object" || args === null) return "";
  try {
    return stableStringify(args).slice(0, ARG_FINGERPRINT_CHARS);
  } catch {
    return "";
  }
};

// File-targeting pi tools all take a path argument; fabric_exec code stays
// opaque on purpose (its inner pi.* calls surface as their own turns).
const extractPath = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const candidate = (args as Record<string, unknown>).path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

export class SurpriseDetector {
  #stats = zeroStats();
  #pending = zeroFeatures();
  #recentCalls = new Map<string, number>();
  #recentPaths = new Map<string, number>();
  // #currentTurn is the turn IN PROGRESS: the last closed turn index + 1, so
  // revisit bookkeeping compares whole turns rather than intra-turn touches.
  #currentTurn = 0;
  #lastInputTurn = -1;
  #cusum = 0;
  #cooldownLeft = 0;
  #firedTotal = 0;

  reset(): void {
    this.#stats = zeroStats();
    this.#pending = zeroFeatures();
    this.#recentCalls.clear();
    this.#recentPaths.clear();
    this.#currentTurn = 0;
    this.#lastInputTurn = -1;
    this.#cusum = 0;
    this.#cooldownLeft = 0;
    this.#firedTotal = 0;
  }

  // Interactive input only: programmatic (rpc/extension) input carries no
  // human signal. steer = the input arrived while the agent was streaming —
  // someone watching decided the loop needed correction mid-flight.
  observeInput(steer: boolean): void {
    this.#lastInputTurn = this.#currentTurn;
    if (steer) this.#pending.steers += 1;
  }

  observeToolStart(toolName: string, args: unknown): void {
    const fingerprint = `${toolName} ${fingerprintArgs(args)}`;
    if (this.#recentCalls.has(fingerprint)) this.#pending.retries += 1;
    this.#recentCalls.set(fingerprint, this.#currentTurn);
    const path = extractPath(args);
    if (path !== undefined) {
      const lastTouch = this.#recentPaths.get(path);
      if (lastTouch !== undefined && lastTouch < this.#currentTurn) this.#pending.revisits += 1;
      this.#recentPaths.set(path, this.#currentTurn);
    }
  }

  observeToolEnd(isError: boolean): void {
    if (isError) this.#pending.errors += 1;
  }

  endTurn(turnIndex: number, config: FabricSurpriseConfig): SurpriseVerdict {
    this.#currentTurn = turnIndex + 1;
    const gapTurns = this.#lastInputTurn < 0 ? 0 : Math.max(0, turnIndex - this.#lastInputTurn);
    // Log compression: doubling the silence doubles the signal, so long
    // autonomous runs climb slowly instead of racing the z cap.
    this.#pending.gap = Math.log2(1 + gapTurns);

    const features = { ...this.#pending };
    const alpha = 1 / config.window;
    const z = zeroFeatures();
    let score = 0;
    for (const name of FEATURE_NAMES) {
      const value = features[name];
      const zi = ewmaZ(this.#stats[name], value, alpha);
      score += FEATURE_WEIGHTS[name] * zi;
      z[name] = round2(zi);
      ewmaUpdate(this.#stats[name], value, alpha);
    }

    // Ring state only needs to reach back one baseline window.
    const pruneBefore = this.#currentTurn - config.window;
    for (const [key, turn] of this.#recentCalls) {
      if (turn < pruneBefore) this.#recentCalls.delete(key);
    }
    for (const [key, turn] of this.#recentPaths) {
      if (turn < pruneBefore) this.#recentPaths.delete(key);
    }

    let fire = false;
    if (this.#cooldownLeft > 0) {
      // Absorbed: S holds at zero while cooling, so an ember left over from
      // the firing turn cannot re-light the accumulator on the next turn.
      this.#cooldownLeft -= 1;
      this.#cusum = 0;
    } else if (this.#firedTotal < config.maxPerSession) {
      this.#cusum = Math.max(0, this.#cusum + score - config.drift);
      if (score > 0 && this.#cusum >= config.threshold) fire = true;
    }

    const contributors = FEATURE_NAMES
      .map((name) => ({ name, impact: FEATURE_WEIGHTS[name] * z[name] }))
      .filter((entry) => entry.impact > 0)
      .sort((a, b) => b.impact - a.impact)
      .slice(0, MAX_REASONS);
    const reasons = contributors.map((entry) =>
      features[entry.name] > 1 && entry.name !== "gap"
        ? `${entry.name} ×${features[entry.name]} (z ${z[entry.name].toFixed(2)})`
        : `${entry.name} (z ${z[entry.name].toFixed(2)})`,
    );

    const cusumReport = this.#cusum;
    if (fire) {
      this.#firedTotal += 1;
      this.#cooldownLeft = config.cooldown;
      this.#cusum = 0;
    }
    this.#pending = zeroFeatures();

    return {
      turn: turnIndex,
      features,
      z,
      score: round2(score),
      cusum: round2(cusumReport),
      threshold: config.threshold,
      drift: config.drift,
      fire,
      firedTotal: this.#firedTotal,
      cooldownLeft: this.#cooldownLeft,
      reasons,
    };
  }
}
