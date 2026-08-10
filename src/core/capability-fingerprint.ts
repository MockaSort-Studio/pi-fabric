import type { FabricActionDescriptor } from "../protocol.js";

// English stopwords plus prose fillers common in tool descriptions that would
// otherwise dominate tf-idf fingerprints and prompt matching.
const CAPABILITY_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "of", "to", "in", "for", "on", "with", "and", "or", "as",
  "by", "at", "from", "into", "one", "this", "that", "it", "its", "their",
  "your", "you", "we", "i", "is", "are", "be", "been", "current", "existing",
  "new", "use", "used", "using", "via", "per", "each", "all", "any", "can",
  "will", "also", "not", "no", "if", "when", "then", "else", "than", "so",
  "such", "over", "under", "out", "up", "down", "off", "through", "during",
  "about", "between", "same", "many", "much", "more", "most", "other",
  "some", "only",
]);

export interface CapabilitySourceFingerprint {
  namespace: string;
  label: string;
  toolCount: number;
  names: string[];
  descriptions: string[];
  toolTerms: ReadonlySet<string>[];
  tf: Map<string, number>;
}

export interface CapabilityIndex {
  sourceCount: number;
  sources: CapabilitySourceFingerprint[];
  idf(term: string): number;
  docFrequency(term: string): number;
}

export const tokenizeCapabilityText = (text: string): string[] => {
  const matches = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .match(/[a-z][a-z0-9]{1,}/g);
  if (!matches) return [];
  return matches.filter((token) => !CAPABILITY_STOPWORDS.has(token));
};

const SOURCE_LABEL_PREFIX = "extension:";

export const capabilitySourceLabel = (namespace: string | undefined): string =>
  namespace !== undefined && namespace.startsWith(SOURCE_LABEL_PREFIX)
    ? namespace.slice(SOURCE_LABEL_PREFIX.length)
    : (namespace ?? "unscoped");

// Capability fingerprints group captured tools by source namespace: a source's
// whole corpus (tool names + descriptions) gives far stronger signal than any
// single tool, and per-source tf-idf terms end up readable as capability
// labels without requiring manifest declarations or a curated taxonomy.
export const buildCapabilityIndex = (
  descriptors: FabricActionDescriptor[],
): CapabilityIndex => {
  const grouped = new Map<string, FabricActionDescriptor[]>();
  for (const descriptor of descriptors) {
    const namespace = descriptor.namespace ?? "unscoped";
    const bucket = grouped.get(namespace);
    if (bucket) bucket.push(descriptor);
    else grouped.set(namespace, [descriptor]);
  }
  const sourceCount = grouped.size;
  const documentFrequency = new Map<string, number>();
  const sources: CapabilitySourceFingerprint[] = [];
  for (const [namespace, bucket] of grouped) {
    const tf = new Map<string, number>();
    for (const descriptor of bucket) {
      for (const token of tokenizeCapabilityText(`${descriptor.name} ${descriptor.description}`)) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
    }
    for (const token of tf.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    sources.push({
      namespace,
      label: capabilitySourceLabel(namespace),
      toolCount: bucket.length,
      names: bucket.map((descriptor) => descriptor.name),
      descriptions: bucket.map((descriptor) => descriptor.description),
      toolTerms: bucket.map(
        (descriptor) => new Set(tokenizeCapabilityText(`${descriptor.name} ${descriptor.description}`)),
      ),
      tf,
    });
  }
  const docFrequency = (term: string): number => documentFrequency.get(term) ?? 0;
  const idf = (term: string): number => {
    const frequency = documentFrequency.get(term);
    if (frequency === undefined || sourceCount === 0) return 0;
    return Math.log(sourceCount / frequency);
  };
  return { sourceCount, sources, idf, docFrequency };
};

const CAPTURED_FROM_SUFFIX = /\s*\(captured from [^)]*\)\s*$/;

// Advisory text shows one short clause per tool: the first sentence when it
// fits, otherwise a bounded slice. Provenance suffixes are stripped because
// the advisory names the source separately.
export const truncateAdvisoryDescription = (description: string, maxChars = 64): string => {
  const cleaned = description.replace(CAPTURED_FROM_SUFFIX, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  const sentence = /^(.{8,}?[.!?])(?:\s|$)/.exec(cleaned);
  if (sentence?.[1] !== undefined && sentence[1].length <= maxChars) return sentence[1];
  return `${cleaned.slice(0, maxChars - 1)}…`;
};
