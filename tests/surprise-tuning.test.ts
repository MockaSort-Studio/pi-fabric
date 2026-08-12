import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FabricSurpriseConfig } from "../src/config.js";
import { SurpriseTuning } from "../src/core/surprise-tuning.js";
import { encodeCwdDir } from "../src/memory/discovery.js";

const config = (
  overrides: Partial<FabricSurpriseConfig> = {},
): FabricSurpriseConfig => ({
  mode: "notify",
  learn: true,
  budget: 1,
  window: 16,
  drift: 0.3,
  threshold: 2,
  cooldown: 3,
  maxPerSession: 5,
  ...overrides,
});

const withAgentDir = (run: (agentDir: string) => void): void => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-surprise-tuning-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  try {
    run(process.env.PI_CODING_AGENT_DIR);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe("SurpriseTuning", () => {
  it("starts from config priors on first sighting of a project", () => {
    withAgentDir(() => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config({ threshold: 3, drift: 0.5, budget: 2 }));
      expect(tuning.parameters(config())).toEqual({ threshold: 3, drift: 0.5 });
      expect(tuning.state()?.budget).toBe(2);
      expect(tuning.state()?.sessions).toBe(1);
    });
  });

  it("tracks the budget: a fire lifts h, quiet turns let it sink back to it", () => {
    withAgentDir(() => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config());
      tuning.observeTurn(0, true);
      // 2 + 0.25·(1 − 0.01)
      expect(tuning.state()?.h).toBeCloseTo(2.2475, 6);
      for (let i = 0; i < 99; i++) tuning.observeTurn(0, false);
      // 100 quiet turns at budget 1/100 sink h back to ~2.
      expect(tuning.state()?.h).toBeCloseTo(2.0, 2);
    });
  });

  it("adapted h never escapes its band even under a fire storm or silence", () => {
    withAgentDir(() => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config());
      for (let i = 0; i < 200; i++) tuning.observeTurn(0, true);
      expect(tuning.state()?.h).toBe(16);
      for (let i = 0; i < 50_000; i++) tuning.observeTurn(0, false);
      expect(tuning.state()?.h).toBe(1);
    });
  });

  it("tracks d as a score quantile, bounded within its band", () => {
    withAgentDir(() => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config());
      // Constant score s: d climbs until P(s'>d) → target, i.e. hovers at s.
      for (let i = 0; i < 120; i++) tuning.observeTurn(1, false);
      const d = tuning.state()?.d ?? 0;
      expect(d).toBeGreaterThan(0.9);
      expect(d).toBeLessThan(1.2);
      // Pure silence drives it to the floor; pure noise to the cap.
      for (let i = 0; i < 2_000; i++) tuning.observeTurn(0, false);
      expect(tuning.state()?.d).toBe(0.1);
      for (let i = 0; i < 2_000; i++) tuning.observeTurn(9, false);
      expect(tuning.state()?.d).toBe(2);
    });
  });

  it("abstains when no advisor or human supplies outcome evidence", () => {
    withAgentDir(() => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config());
      tuning.registerFire(5, 3);
      const resolutions = tuning.resolveOutcomes(9);
      expect(resolutions).toEqual([]);
      expect(tuning.state()?.budget).toBe(1);
    });
  });

  it("confirms alarms an advisor found material or a human reacted to", () => {
    withAgentDir(() => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config());
      tuning.registerFire(5, 3);
      tuning.noteAdvisorDecision(5, "message");
      const confirmed = tuning.resolveOutcomes(9);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]?.outcome).toBe("confirmed");
      expect(tuning.state()?.budget).toBeCloseTo(1.25, 6);

      // Human engagement counts equally.
      const second = new SurpriseTuning();
      second.configure("/repo/two", config({ budget: 2 }));
      second.registerFire(1, 2);
      second.noteHumanActivity();
      expect(second.resolveOutcomes(5)[0]?.outcome).toBe("confirmed");
      expect(second.state()?.budget).toBeCloseTo(2.5, 6);
    });
  });

  it("uses an advisor directive as selectivity evidence instead of delivery", () => {
    withAgentDir(() => {
      const silent = new SurpriseTuning();
      silent.configure("/repo/silent", config());
      silent.registerFire(5, 3);
      silent.noteAdvisorDecision(5, "silent");
      expect(silent.resolveOutcomes(9)[0]?.outcome).toBe("ignored");
      expect(silent.state()?.budget).toBeCloseTo(0.8, 6);

      const spoke = new SurpriseTuning();
      spoke.configure("/repo/spoke", config());
      spoke.registerFire(5, 3);
      spoke.noteAdvisorDecision(5, "message");
      expect(spoke.resolveOutcomes(9)[0]?.outcome).toBe("confirmed");
      expect(spoke.state()?.budget).toBeCloseTo(1.25, 6);
    });
  });

  it("discounts alarms nobody acted on, within the budget band", () => {
    withAgentDir(() => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config());
      tuning.noteHumanActivity(); // human present, then goes quiet
      tuning.registerFire(5, 3);
      const resolutions = tuning.resolveOutcomes(9);
      expect(resolutions[0]?.outcome).toBe("ignored");
      expect(tuning.state()?.budget).toBeCloseTo(0.8, 6);

      const stormy = new SurpriseTuning();
      stormy.configure("/repo/three", config());
      for (let i = 0; i < 30; i++) {
        stormy.noteHumanActivity();
        stormy.registerFire(i * 10, 3);
        stormy.resolveOutcomes(i * 10 + 9);
      }
      expect(stormy.state()?.budget).toBe(0.2);
      const stormyUp = new SurpriseTuning();
      stormyUp.configure("/repo/four", config({ budget: 4 }));
      for (let i = 0; i < 30; i++) {
        stormyUp.registerFire(i * 10, 3);
        stormyUp.noteAdvisorDecision(i * 10, "message");
        stormyUp.resolveOutcomes(i * 10 + 9);
      }
      expect(stormyUp.state()?.budget).toBe(5);
    });
  });

  it("waits out the window before resolving a fire", () => {
    withAgentDir(() => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config());
      tuning.registerFire(5, 3);
      tuning.noteAdvisorDecision(5, "message");
      expect(tuning.resolveOutcomes(8)).toEqual([]);
      expect(tuning.resolveOutcomes(9)).toHaveLength(1);
    });
  });

  it("persists learned state per project and survives corrupted files", () => {
    withAgentDir((agentDir) => {
      const tuning = new SurpriseTuning();
      tuning.configure("/repo/one", config());
      tuning.observeTurn(0, true);
      tuning.save();

      const reloaded = new SurpriseTuning();
      reloaded.configure("/repo/one", config());
      expect(reloaded.state()?.h).toBeCloseTo(2.2475, 6);
      expect(reloaded.state()?.sessions).toBe(2);

      const other = new SurpriseTuning();
      other.configure("/repo/other", config());
      expect(other.state()?.h).toBe(2);

      fs.writeFileSync(
        path.join(agentDir, "fabric-surprise", encodeCwdDir("/repo/one"), "tuning.json"),
        "{not json",
      );
      const recovered = new SurpriseTuning();
      recovered.configure("/repo/one", config());
      expect(recovered.state()?.h).toBe(2);
    });
  });

  it("pins h/d to config and adapts nothing when learn is false", () => {
    withAgentDir(() => {
      const pinned = new SurpriseTuning();
      pinned.configure("/repo/one", config({ learn: false, threshold: 7, drift: 1 }));
      pinned.observeTurn(5, true);
      expect(pinned.parameters(config({ learn: false, threshold: 7, drift: 1 }))).toEqual({
        threshold: 7,
        drift: 1,
      });
      expect(pinned.state()).toBeUndefined();
    });
  });
});
