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
// Score quantum: the weight of a source-unique term (df = 1 → 1/df = 1) — the
// smallest unit of unambiguous evidence the 1/df scorer can express. The weak
// band is exactly one quantum wide: strong = weak + one quantum of certainty.
const SCORE_QUANTUM = 1;
const WEAK_MATCH_BAND = SCORE_QUANTUM;
const MAX_ADVISORY_SOURCES = 2;
const MAX_NAMES_PER_SOURCE = 2;
const MAX_ADVISORY_NAMES = 3;
const BASE_HEADER = "[Fabric capability hint]";
const WEAK_HEADER = "[Fabric capability hint · possible match]";

// Combustion dynamics. The advisory is a finite battery: every fire spends a
// namespace permanently (ash), so ignition is gated. Two primitives determine
// everything (see docs/capability-combustion.md):
//   q   = 1 — the score quantum above.
//   τ   = 2 turns — the patience/memory scale. Warmth W is the convolution of
//   the score signal with the exponential kernel K_τ (an EWMA with retention
//   1 − 1/τ, half-life one turn at τ=2): first-order evidence averages over
//   τ turns. Smoke feedback estimates a bias, a second-order signal, so it
//   calibrates over τ² events: step θ/τ², ceiling τ² — keeping the maximum
//   furnace raise at exactly θ regardless of τ.
// Strong band ignites instantly; weak band fires when W breaches the ignition
// point, so single-turn collisions cool before they get there.
const TAU = 2;
const WARM_ALPHA = 1 - 1 / TAU; // 0.5
const SMOKE_STEP = 1 / (TAU * TAU); // 0.25
const SMOKE_MAX = TAU * TAU; // 4
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

interface SourceBlock {
  label: string;
  names: string[];
  descriptions: string[];
  leftoverNames: string[];
}

// pi-fovea icon/indent pattern: one flat ▪ bullet per shown tool with the
// fully-qualified ref, a source tag in parentheses when more than one source
// is in play, and the truncated description after an em dash on the rich
// rung. Leftover tools collapse into an indented "~ +N more in <source>"
// counter line, mirroring fovea's "~ +N more in <file>".
const renderCandidates = (blocks: SourceBlock[], withDescriptions: boolean): string[] => {
  const multiSource = blocks.length > 1;
  const lines: string[] = [];
  for (const block of blocks) {
    block.names.forEach((name, index) => {
      const ref = `${ADVISORY_REF_PREFIX}.${name}`;
      const sourceTag = multiSource ? ` (${block.label})` : "";
      const description = block.descriptions[index] ?? "";
      const tail =
        withDescriptions && description
          ? ` — ${truncateAdvisoryDescription(description)}`
          : "";
      lines.push(`▪ ${ref}${sourceTag}${tail}`);
    });
    if (block.leftoverNames.length > 0) {
      const listed = block.leftoverNames.slice(0, 3).join(", ");
      lines.push(
        `  ~ +${block.leftoverNames.length} more in ${block.label}: ${listed}${block.leftoverNames.length > 3 ? ", …" : ""}`,
      );
    }
  }
  return lines;
};

// Leanest non-trivial rung: one bullet per source, bare refs with leftovers
// inline — the actionable identity of each capability, no prose.
const renderFlat = (blocks: SourceBlock[]): string[] =>
  blocks.map((block) => {
    const refs = block.names.map((name) => `${ADVISORY_REF_PREFIX}.${name}`);
    const listed = block.leftoverNames.slice(0, 3).join(", ");
    const leftover =
      block.leftoverNames.length > 0
        ? `, ~ +${block.leftoverNames.length} more: ${listed}${block.leftoverNames.length > 3 ? ", …" : ""}`
        : "";
    return `▪ ${block.label} · ${refs.join(", ")}${leftover}`;
  });

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

  // Ash is derived from the session transcript, never stored beside it:
  // fired hints ARE their own custom messages, organic use IS the tool calls
  // that named captured tools — both are already persisted entries. Replay a
  // branch (ctx.sessionManager.getBranch()) to rebuild ash exactly up to the
  // current leaf, so forks and /tree rewinds see ashes up to that point in
  // time, and a brand-new session starts with a clean urn. Warmth, smoke, and
  // the per-session cap stay pure transients: reset() governs them.
  restoreAshFromEntries(
    entries: Iterable<unknown>,
    nameToNamespace: (toolName: string) => string | undefined,
  ): void {
    this.#ash.clear();
    for (const entryUnknown of entries) {
      const entry = entryUnknown as {
        type?: unknown;
        customType?: unknown;
        timestamp?: unknown;
        details?: unknown;
        message?: unknown;
      };
      const at =
        typeof entry.timestamp === "string" ? entry.timestamp : "";
      if (
        entry.type === "custom_message" &&
        entry.customType === CAPABILITY_ADVISORY_CUSTOM_TYPE
      ) {
        const matches = (entry.details as { matches?: unknown } | undefined)
          ?.matches;
        if (Array.isArray(matches)) {
          for (const match of matches) {
            const namespace = (match as { namespace?: unknown } | undefined)
              ?.namespace;
            if (typeof namespace === "string" && namespace.length > 0) {
              this.#burn(namespace, "fired", at);
            }
          }
        }
        continue;
      }
      if (entry.type === "message") {
        const message = entry.message as
          | { role?: unknown; content?: unknown }
          | undefined;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) {
          continue;
        }
        for (const block of message.content) {
          const { type, name } = block as { type?: unknown; name?: unknown };
          if (type !== "toolCall" || typeof name !== "string") continue;
          const namespace = nameToNamespace(name);
          if (namespace !== undefined) this.#burn(namespace, "organic", at);
        }
      }
    }
  }

  // Idempotent append: a namespace burns at most once per session history.
  #burn(namespace: string, origin: CapabilityBurn["origin"], at: string): boolean {
    if (this.#ash.has(namespace)) return false;
    this.#ash.set(namespace, {
      namespace,
      origin,
      at: at.length > 0 ? at : new Date().toISOString(),
    });
    return true;
  }

  ashRecords(): CapabilityBurn[] {
    return [...this.#ash.values()];
  }

  // Organic poisoning: the model reached this namespace without a hint, so
  // the capability's information potential is already spent. Burn it as ash
  // with origin "organic". Returns true when the ash set changed (persist it).
  observeToolUse(namespace: string): boolean {
    if (this.#pendingFire.has(namespace)) this.#hitsThisTurn.add(namespace);
    return this.#burn(namespace, "organic", new Date().toISOString());
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

    // Structured like fovea's sync advisories: a compact headline naming
    // the matched sources, flat ▪-bulletish candidate rows, a Next: action
    // pointing at the top ref, and a Steer: directive.
    const headerSources = included.map((match) => match.label).join(", ");
    const headerTools = included.reduce((sum, match) => sum + match.names.length, 0);
    const headerLine = `${header} ${headerSources} · ${headerTools} tool${headerTools === 1 ? "" : "s"} matched your prompt.`;
    const blocks: SourceBlock[] = [];
    let shown = 0;
    for (const match of included) {
      const cappedNames: string[] = [];
      const cappedDescriptions: string[] = [];
      for (let index = 0; index < match.names.length; index++) {
        const name = match.names[index];
        if (
          name !== undefined &&
          cappedNames.length < MAX_NAMES_PER_SOURCE &&
          shown < MAX_ADVISORY_NAMES
        ) {
          cappedNames.push(name);
          cappedDescriptions.push(match.descriptions[index] ?? "");
          shown++;
        }
      }
      match.omitted = match.names.length - cappedNames.length;
      const leftoverNames = match.names.slice(cappedNames.length);
      match.names = cappedNames;
      match.descriptions = cappedDescriptions;
      blocks.push({
        label: match.label,
        names: cappedNames,
        descriptions: cappedDescriptions,
        leftoverNames,
      });
    }

    const topName = blocks[0]?.names[0];
    const nextLine =
      topName === undefined
        ? ""
        : `Next: tools.describe({ref: "${ADVISORY_REF_PREFIX}.${topName}"}) for its schema, then ${ADVISORY_REF_PREFIX}.${topName}({…}) inside fabric_exec.`;

    // Budget squeeze (fovea pattern): walk the ladder until a rung fits —
    // bullets with descriptions → bullets, names only → one bullet per
    // source (dropping Next: alongside the collapse) → header + steer as the
    // floor. Details keep the full (pre-squeeze) picture regardless.
    const rungs: string[][] = [
      [...renderCandidates(blocks, true), ...(nextLine ? [nextLine] : [])],
      [...renderCandidates(blocks, false), ...(nextLine ? [nextLine] : [])],
      renderFlat(blocks),
    ];
    let content = "";
    for (const rung of rungs) {
      const candidate = [headerLine, ...rung, STEER_LINE].join("\n");
      if (estimateTokens(candidate) <= config.budget) {
        content = candidate;
        break;
      }
    }
    if (!content) {
      // Pathological budget: header + steer only, refs survive in details.
      content = `${headerLine}\n${STEER_LINE}`;
    }

    for (const match of included) {
      this.#burn(match.namespace, "fired", new Date().toISOString());
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
