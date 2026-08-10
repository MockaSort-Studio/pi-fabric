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

// Fires at most once per source namespace per session — an advisory repeated
// for an already-mentioned capability turns into noise the model learns to
// ignore. Fire-set and per-session cap live in extension state, so compaction
// cannot resurrect a spent advisory and a new session earns fresh hints.
export class CapabilityAdvisor {
  #index: CapabilityIndex = buildCapabilityIndex([]);
  #firedNamespaces = new Set<string>();
  #firedTotal = 0;

  refresh(descriptors: FabricActionDescriptor[]): void {
    this.#index = buildCapabilityIndex(descriptors);
  }

  reset(): void {
    this.#firedNamespaces.clear();
    this.#firedTotal = 0;
  }

  // Machine-global persistence: hydrate with previously fired namespaces at
  // session start so already-hinted capabilities stay quiet across restarts.
  // The per-session advisory cap stays session-local — only the namespace
  // fire-set is durable.
  hydrate(firedNamespaces: Iterable<string>): void {
    this.#firedNamespaces = new Set(firedNamespaces);
  }

  firedNamespaces(): string[] {
    return [...this.#firedNamespaces];
  }

  evaluate(
    prompt: string,
    config: FabricCapabilityAdvisoryConfig,
  ): CapabilityAdvisoryResult | undefined {
    if (config.mode === "disabled") return undefined;
    if (this.#firedTotal >= config.maxPerSession) return undefined;
    const promptTerms = [...new Set(tokenizeCapabilityText(stripSkillRegions(prompt)))];
    if (promptTerms.length === 0 || this.#index.sourceCount === 0) return undefined;

    const matches: CapabilityAdvisoryMatch[] = [];
    for (const source of this.#index.sources) {
      if (this.#firedNamespaces.has(source.namespace)) continue;
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

    for (const match of included) this.#firedNamespaces.add(match.namespace);
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
