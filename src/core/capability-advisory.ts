import type { FabricCapabilityAdvisoryConfig } from "../config.js";
import type { FabricActionDescriptor } from "../protocol.js";
import {
  buildCapabilityIndex,
  tokenizeCapabilityText,
  truncateAdvisoryDescription,
  type CapabilityIndex,
} from "./capability-fingerprint.js";

export const CAPABILITY_ADVISORY_CUSTOM_TYPE = "pi-fabric-capability";
const ADVISORY_REF_PREFIX = "extensions";
const WEAK_MATCH_BAND = 1.0;
const MAX_ADVISORY_SOURCES = 2;
const MAX_NAMES_PER_SOURCE = 2;
const MAX_ADVISORY_NAMES = 3;
const BASE_HEADER = "[Fabric capability hint]";
const WEAK_HEADER = "[Fabric capability hint · possible match]";

// Combustion dynamics. The advisory is a finite battery: every fire spends a
// namespace permanently (ash), so ignition is gated. The strong band ignites
// instantly; the weak band must accumulate warmth W, an EWMA of weak-band
// scores with retention WARM_ALPHA per turn (half-life ~1 turn), until W
// breaches the ignition point — single-turn vocabulary collisions cool before
// they get there. Ignored fires are smoke: each raises future weak-band
// ignition by SMOKE_STEP × the base threshold (capped SMOKE_MAX streaks).
const WARM_ALPHA = 0.5;
const SMOKE_STEP = 0.25;
const SMOKE_MAX = 4;
const WARM_FLOOR = 1e-3;

export interface CapabilityAdvisoryMatch {
  namespace: string;
  label: string;
  score: number;
  matchedTerms: string[];
  names: string[];
  descriptions: string[];
  omitted: number;
}

export interface CapabilityAdvisoryResult {
  content: string;
  display: boolean;
  details: { matches: CapabilityAdvisoryMatch[] };
}

type CapabilityBurnOrigin = "fired" | "organic";

// Ash record: the irreversible residue of a capability's information
// potential. origin records how the potential was spent — a hint fired vs the
// model discovering the namespace on its own — and the record is append-only:
// misfires are never reclaimed (you don't unburn paper).
export interface CapabilityBurn {
  namespace: string;
  origin: CapabilityBurnOrigin;
  at?: string;
}

const STEER_LINE =
  "Steer: prefer these captured tools over re-implementing the capability; skip if irrelevant.";

// pi's prompt expansion wraps loaded skills in an XML envelope
// (<available_skills><skill>…</skill></available_skills>; an invoked skill
// lands as <skill>…<name>…<location>…). That content is ambient context, not
// user intent — letting it through poisons the fingerprint with the skill's
// own vocabulary (e.g. a websearch skill alone fires the web-search hint).
const SKILL_REGION =
  /<available_skills\b[^>]*>[\s\S]*?(?:<\/available_skills\s*>|$)|<skill\b[^>]*>[\s\S]*?(?:<\/skill\s*>|$)/g;

const stripSkillRegions = (prompt: string): string => prompt.replace(SKILL_REGION, " ");

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const formatRef = (name: string, description: string): string =>
  `${ADVISORY_REF_PREFIX}.${name} (${truncateAdvisoryDescription(description)})`;

export class CapabilityAdvisor {
  #index: CapabilityIndex = buildCapabilityIndex([]);
  #ash = new Map<string, CapabilityBurn>();
  #warmth = new Map<string, number>();
  #pendingFire = new Set<string>();
  #hitsThisTurn = new Set<string>();
  #smokeStreak = 0;
  #firedTotal = 0;

  refresh(descriptors: FabricActionDescriptor[]): void {
    this.#index = buildCapabilityIndex(descriptors);
  }

  reset(): void {
    this.#warmth.clear();
    this.#pendingFire.clear();
    this.#hitsThisTurn.clear();
    this.#smokeStreak = 0;
    this.#firedTotal = 0;
  }

  // Machine-global persistence: hydrate with prior ash at session start so
  // already-spent capabilities stay quiet across restarts. Warmth, smoke, and
  // the per-session cap stay session-local — transients govern ignition, only
  // the ash is durable.
  hydrate(records: Iterable<CapabilityBurn>): void {
    this.#ash = new Map([...records].map((record) => [record.namespace, record]));
  }

  ashRecords(): CapabilityBurn[] {
    return [...this.#ash.values()];
  }

  // Organic poisoning: the model reached this namespace without a hint, so
  // the capability's information potential is already spent. Burn it as ash
  // with origin "organic". Returns true when the ash set changed (persist it).
  observeToolUse(namespace: string): boolean {
    if (this.#pendingFire.has(namespace)) this.#hitsThisTurn.add(namespace);
    if (this.#ash.has(namespace)) return false;
    this.#ash.set(namespace, {
      namespace,
      origin: "organic",
      at: new Date().toISOString(),
    });
    return true;
  }

  // Furnace feedback, evaluated once per turn (turn_end event). A fire whose
  // namespaces saw no tool use is smoke; a used fire is clean combustion and
  // clears the streak. Smoke raises the weak-band ignition point.
  endTurn(): void {
    if (this.#pendingFire.size > 0) {
      const combusted = [...this.#pendingFire].some((namespace) => this.#hitsThisTurn.has(namespace));
      this.#smokeStreak = combusted ? 0 : Math.min(this.#smokeStreak + 1, SMOKE_MAX);
      this.#pendingFire.clear();
    }
    this.#hitsThisTurn.clear();
  }

  evaluate(
    prompt: string,
    config: FabricCapabilityAdvisoryConfig,
  ): CapabilityAdvisoryResult | undefined {
    if (config.mode === "disabled") return undefined;
    if (this.#firedTotal >= config.maxPerSession) return undefined;

    // Warmth retention α·W applies every evaluated turn, matched or not.
    for (const [namespace, current] of this.#warmth) {
      const decayed = current * WARM_ALPHA;
      if (decayed < WARM_FLOOR) this.#warmth.delete(namespace);
      else this.#warmth.set(namespace, decayed);
    }
    // Smoke raises the weak-band ignition point: the furnace demands more
    // sustained evidence after a streak of ignored fires.
    const ignitionPoint = config.threshold * (1 + SMOKE_STEP * this.#smokeStreak);

    const promptTerms = [...new Set(tokenizeCapabilityText(stripSkillRegions(prompt)))];
    if (promptTerms.length === 0 || this.#index.sourceCount === 0) return undefined;

    const matches: CapabilityAdvisoryMatch[] = [];
    for (const source of this.#index.sources) {
      if (this.#ash.has(source.namespace)) continue;
      // Score with 1/df term weights, not raw idf: idf magnitude collapses on
      // small captured catalogs (ln(4/2) < 1), silently starving matches below
      // the threshold, while 1/df keeps "two distinctive terms ≈ one source"
      // meaningful at any catalog size.
      const matchedTerms: string[] = [];
      let score = 0;
      for (const term of promptTerms) {
        if (!source.tf.has(term)) continue;
        matchedTerms.push(term);
        const frequency = this.#index.docFrequency(term);
        if (frequency > 0) score += 1 / frequency;
      }
      // Require at least two shared terms: a lone distinctive word ("project",
      // "recent") is vocabulary collision, not intent, and single-term fires
      // are the fastest route to banner blindness.
      if (matchedTerms.length < 2 || score < config.threshold) continue;

      const strong = score >= config.threshold + WEAK_MATCH_BAND;
      if (!strong) {
        // Weak band: accumulate warmth this turn, ignite only at saturation.
        const warmth = (this.#warmth.get(source.namespace) ?? 0) + (1 - WARM_ALPHA) * score;
        this.#warmth.set(source.namespace, warmth);
        if (warmth < ignitionPoint) continue;
      }

      // Rank this source's tools by their own prompt-term overlap so the most
      // relevant refs lead (e.g. openai_websearch before openai_image on a
      // web-search prompt) instead of inherited catalog order.
      const order = source.names.map((_, index) => index).sort((a, b) => {
        const scoreAt = (index: number): number => {
          let toolScore = 0;
          const terms = source.toolTerms[index];
          if (!terms) return 0;
          for (const term of promptTerms) {
            if (!terms.has(term)) continue;
            const frequency = this.#index.docFrequency(term);
            if (frequency > 0) toolScore += 1 / frequency;
          }
          return toolScore;
        };
        return scoreAt(b) - scoreAt(a) || a - b;
      });
      matches.push({
        namespace: source.namespace,
        label: source.label,
        score,
        matchedTerms: matchedTerms.sort(
          (a, b) => this.#index.docFrequency(a) - this.#index.docFrequency(b),
        ),
        names: order.map((index) => source.names[index] ?? "").filter((name) => name !== ""),
        descriptions: order.map((index) => source.descriptions[index] ?? ""),
        omitted: 0,
      });
    }
    if (matches.length === 0) return undefined;
    matches.sort(
      (a, b) => b.score - a.score || a.namespace.localeCompare(b.namespace),
    );
    const included = matches.slice(0, MAX_ADVISORY_SOURCES);
    const header =
      included[0] !== undefined && included[0].score >= config.threshold + WEAK_MATCH_BAND
        ? BASE_HEADER
        : WEAK_HEADER;

    // Structured like fovea's sync advisories: headline, grouped candidate
    // lines, a Next: action pointing at the top ref, and a Steer: directive.
    const lines: string[] = [`${header} prompt terms matched captured tools.`, "Candidates:"];
    let shown = 0;
    for (const match of included) {
      const total = match.names.length;
      const refs: string[] = [];
      const cappedNames: string[] = [];
      const cappedDescriptions: string[] = [];
      for (let index = 0; index < total; index++) {
        const name = match.names[index];
        if (
          name !== undefined &&
          cappedNames.length < MAX_NAMES_PER_SOURCE &&
          shown < MAX_ADVISORY_NAMES
        ) {
          refs.push(formatRef(name, match.descriptions[index] ?? ""));
          cappedNames.push(name);
          cappedDescriptions.push(match.descriptions[index] ?? "");
          shown++;
        }
      }
      match.omitted = total - cappedNames.length;
      match.names = cappedNames;
      match.descriptions = cappedDescriptions;
      lines.push(
        `  ${match.label} — ${refs.join(", ")}${match.omitted > 0 ? `, +${match.omitted} more` : ""}`,
      );
    }

    const topName = included[0]?.names[0];
    let nextLine = "";
    if (topName !== undefined) {
      nextLine = `Next: tools.describe('${topName}') for its schema, then ${ADVISORY_REF_PREFIX}.${topName}({…}) inside fabric_exec.`;
    }

    // Budget squeeze (fovea pattern): drop trailing candidate lines first,
    // then bare-name refs, then the Next: line, always keeping the header and
    // steer. Details keep the full (pre-squeeze) picture regardless.
    const sourceCount = lines.length - 2; // headline + "Candidates:" at index 0-1
    let content = "";
    for (let drop = 0; drop <= sourceCount + 1; drop++) {
      const kept = lines.slice(0, 2 + Math.max(0, sourceCount - drop));
      const descriptionFree = drop > sourceCount;
      const rendered = descriptionFree
        ? [
            ...kept.slice(0, 2),
            ...included.map(
              (match) =>
                `  ${match.label} — ${match.names
                  .map((name) => `${ADVISORY_REF_PREFIX}.${name}`)
                  .join(", ")}`,
            ),
          ]
        : kept;
      const parts = [...rendered];
      if (!descriptionFree && nextLine) parts.push(nextLine);
      parts.push(STEER_LINE);
      const candidate = parts.join("\n");
      if (estimateTokens(candidate) <= config.budget) {
        content = candidate;
        break;
      }
    }
    if (!content) {
      // Pathological budget: header + steer only, refs survive in details.
      content = `${lines[0] ?? BASE_HEADER}\n${STEER_LINE}`;
    }

    for (const match of included) {
      this.#ash.set(match.namespace, {
        namespace: match.namespace,
        origin: "fired",
        at: new Date().toISOString(),
      });
      this.#warmth.delete(match.namespace);
      this.#pendingFire.add(match.namespace);
    }
    this.#firedTotal += 1;
    return {
      content,
      display: config.mode === "enabled",
      details: { matches: roundScores(included) },
    };
  }
}

const roundScores = (matches: CapabilityAdvisoryMatch[]): CapabilityAdvisoryMatch[] =>
  matches.map((match) => ({ ...match, score: Math.round(match.score * 100) / 100 }));
