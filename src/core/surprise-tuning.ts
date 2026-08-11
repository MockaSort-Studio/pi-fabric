import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { encodeCwdDir } from "../memory/discovery.js";
import type { FabricSurpriseConfig } from "../config.js";
import { writeJsonAtomic } from "./atomic-write.js";

// Self-tuning layer for the surprise sensor (docs/surprise.md, "Self-tuning").
// Robbins-Monro quantile tracking replaces hand-retuned h/d:
//
//   h ← clamp(h + 0.25 · (1{fire} − budget/100), [1, 16])   per closed turn
//   d ← clamp(d + 0.05 · (1{s > d} − 0.3),      [0.1, 2])   per closed turn
//
// The budget itself floats on observed alarm outcomes: resolved "confirmed"
// (a fabric.surprise subscriber received the alarm, or interactive input
// arrived after it) multiplies by 1.25; "ignored" (audience present, neither
// happened) divides by 1.25, clamped to [0.2, 5] fires per 100 turns.
// Audience-free sessions — no interactive input at all, no subscriber
// anywhere — abstain: nobody was there to judge the alarm, so no outcome
// accrues. Adapted state persists per project next to the trace logs, so a
// noisy project learns a thicker skin across sessions; setting learn: false
// pins threshold/drift as exact values and stops all of this.

export interface SurpriseTuningState {
  format: 1;
  h: number;
  d: number;
  budget: number;
  turns: number;
  sessions: number;
  updatedAt: string;
}

export interface SurpriseOutcomeResolution {
  fireTurn: number;
  outcome: "confirmed" | "ignored";
  budget: number;
}

interface PendingFire {
  turn: number;
  windowTurns: number;
  firedAt: number;
  // Logical clock value at fire time: ordering against human activity is by
  // causal sequence, not wall time — two host operations inside one
  // millisecond must still order correctly.
  order: number;
}

const H_MIN = 1;
const H_MAX = 16;
const H_STEP = 0.25;
const D_MIN = 0.1;
const D_MAX = 2;
const D_STEP = 0.05;
// d converges so roughly 30% of turns exceed it: routine churn evaporates,
// only the top of the score distribution can accumulate.
const D_TARGET_EXCEED = 0.3;
const BUDGET_MIN = 0.2;
const BUDGET_MAX = 5;
const OUTCOME_FACTOR = 1.25;
const MAX_PENDING = 8;
// h/d drift microscopically every turn; persistence checkpoints fire/outcome
// moments and every so often otherwise, not every turn.
const SAVE_EVERY_TURNS = 25;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const stateFromValue = (value: unknown): SurpriseTuningState | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.format !== 1 ||
    typeof candidate.h !== "number" || !Number.isFinite(candidate.h) ||
    typeof candidate.d !== "number" || !Number.isFinite(candidate.d) ||
    typeof candidate.budget !== "number" || !Number.isFinite(candidate.budget) ||
    typeof candidate.turns !== "number" ||
    typeof candidate.sessions !== "number" ||
    typeof candidate.updatedAt !== "string"
  ) return undefined;
  return {
    format: 1,
    h: clamp(candidate.h, H_MIN, H_MAX),
    d: clamp(candidate.d, D_MIN, D_MAX),
    budget: clamp(candidate.budget, BUDGET_MIN, BUDGET_MAX),
    turns: candidate.turns,
    sessions: candidate.sessions,
    updatedAt: candidate.updatedAt,
  };
};

const freshState = (config: FabricSurpriseConfig): SurpriseTuningState => ({
  format: 1,
  h: clamp(config.threshold, H_MIN, H_MAX),
  d: clamp(config.drift, D_MIN, D_MAX),
  budget: clamp(config.budget, BUDGET_MIN, BUDGET_MAX),
  turns: 0,
  sessions: 0,
  updatedAt: new Date().toISOString(),
});

export class SurpriseTuning {
  #state: SurpriseTuningState | undefined;
  #file: string | undefined;
  #pending: PendingFire[] = [];
  #clock = 0;
  #lastHumanOrder = -1;
  #turnsSinceSave = 0;

  /**
   * Bind to the project and load (or seed, from config priors) its learned
   * state. Called once per session; session-scoped bookkeeping resets with
   * reset(), the learned state never does.
   */
  configure(cwd: string, config: FabricSurpriseConfig): void {
    if (!config.learn) {
      this.#state = undefined;
      this.#file = undefined;
      return;
    }
    this.#file = path.join(
      getAgentDir(),
      "fabric-surprise",
      encodeCwdDir(cwd),
      "tuning.json",
    );
    let loaded: SurpriseTuningState | undefined;
    try {
      loaded = stateFromValue(JSON.parse(fs.readFileSync(this.#file, "utf8")));
    } catch {
      loaded = undefined;
    }
    this.#state = loaded ?? freshState(config);
    this.#state.sessions += 1;
    this.#turnsSinceSave = SAVE_EVERY_TURNS;
    this.save();
  }

  /** Session-scoped: pending outcome windows and the human-activity marker. */
  reset(): void {
    this.#pending = [];
    this.#lastHumanOrder = -1;
  }

  /** The h/d the sensor should close this turn with. */
  parameters(config: FabricSurpriseConfig): { threshold: number; drift: number } {
    if (!config.learn || !this.#state) {
      return { threshold: config.threshold, drift: config.drift };
    }
    return { threshold: this.#state.h, drift: this.#state.d };
  }

  /** Interactive input arrived — a human is (or was recently) watching. */
  noteHumanActivity(): void {
    this.#lastHumanOrder = ++this.#clock;
  }

  /** A fire starts an outcome window of `windowTurns` (the cooldown span: by
   *  the time another fire is structurally possible, this one's fate is
   *  known). */
  registerFire(turn: number, windowTurns: number): void {
    if (!this.#state) return;
    this.#pending.push({ turn, windowTurns, firedAt: Date.now(), order: ++this.#clock });
    if (this.#pending.length > MAX_PENDING) this.#pending.shift();
  }

  /**
   * Resolve pending fires whose window has closed. `engagement(sinceMs)`
   * reports subscriber presence and deliveries for the alarm event — host
   * supplies it, so the tuner never peeks into lifecycle internals itself.
   */
  resolveOutcomes(
    turn: number,
    engagement: (sinceMs: number) => { subscribed: number; delivered: number },
  ): SurpriseOutcomeResolution[] {
    if (!this.#state) return [];
    const resolutions: SurpriseOutcomeResolution[] = [];
    const pending = this.#pending;
    this.#pending = [];
    for (const fire of pending) {
      if (turn <= fire.turn + fire.windowTurns) {
        this.#pending.push(fire);
        continue;
      }
      const heard = engagement(fire.firedAt);
      // Strictly after the fire in causal order: activity predating the
      // alarm is baseline presence, not a reaction to it.
      const humanNear = this.#lastHumanOrder > fire.order;
      if (heard.subscribed === 0 && this.#lastHumanOrder < 0) {
        // Audience-free: no human input all session, no subscriber. No
        // evidence either way — abstain (drop the pending silently).
        continue;
      }
      const confirmed = humanNear || heard.delivered > 0;
      this.#state.budget = clamp(
        confirmed ? this.#state.budget * OUTCOME_FACTOR : this.#state.budget / OUTCOME_FACTOR,
        BUDGET_MIN,
        BUDGET_MAX,
      );
      resolutions.push({
        fireTurn: fire.turn,
        outcome: confirmed ? "confirmed" : "ignored",
        budget: this.#state.budget,
      });
    }
    if (resolutions.length > 0) this.save();
    return resolutions;
  }

  /** Stochastic-approximation step for h and d, then checkpoint policy. */
  observeTurn(score: number, fire: boolean): void {
    const state = this.#state;
    if (!state) return;
    const target = state.budget / 100;
    state.h = clamp(state.h + H_STEP * ((fire ? 1 : 0) - target), H_MIN, H_MAX);
    state.d = clamp(
      state.d + D_STEP * ((score > state.d ? 1 : 0) - D_TARGET_EXCEED),
      D_MIN,
      D_MAX,
    );
    state.turns += 1;
    state.updatedAt = new Date().toISOString();
    this.#turnsSinceSave += 1;
    if (fire || this.#turnsSinceSave >= SAVE_EVERY_TURNS) this.save();
  }

  /** Persist; tuning state must never break a turn. */
  save(): void {
    if (!this.#state || !this.#file) return;
    this.#turnsSinceSave = 0;
    try {
      writeJsonAtomic(this.#file, this.#state);
    } catch {
      // Swallowed: see class comment.
    }
  }

  state(): SurpriseTuningState | undefined {
    return this.#state ? { ...this.#state } : undefined;
  }
}
