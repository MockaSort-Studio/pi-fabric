// Provider-argument normalization mirroring the pi core tool guest proxy
// (__normalizePiArgs in runtime/quickjs-runtime.ts). The pi proxy repairs
// near-miss argument spellings before host validation because a strict
// rejection costs a zero-work model round trip; the same applies to Fabric
// provider actions. Every guest call (memory.*, state.*, schema.*, compact.*,
// mesh.*, agents.*) reaches the action registry's prepare stage, where a
// provider's prepareArguments hook canonicalizes alias spellings, coerces
// numeric strings, and strips nullish known optionals. Unknown keys pass
// through untouched and fail the registry's additionalProperties:false
// validation exactly as before, with the error path naming the offending
// property.
//
// Alias discipline (same as the pi maps): a repair only applies when the
// canonical key is absent, the canonical key always wins on conflict, and
// every alias preserves intent exactly — spelling synonyms and mechanical
// casing/plurality variants only, never semantic guesses. Unit-ambiguous
// spellings (a bare `timeout` for a `timeoutMs` field) are not aliases; they
// fail validation with an actionable message instead. Keep each provider's
// table in sync with the argument bag types in runtime/guest-types.ts, which
// declare the same spillover spellings so the type-checker's excess-property
// diagnostic (2353) passes over repairable calls.

export interface ArgNormalizationSpec {
  /** Near-miss key spellings mapped to their canonical key. */
  aliases?: Record<string, string>;
  /** String-valued spellings remapped before validation, e.g. scope "cwd" → "project". */
  values?: Record<string, Record<string, string>>;
  /** Scalar numeric fields that accept numeric strings ("20" → 20). */
  numerics?: readonly string[];
  /** Numeric array fields whose numeric-string elements coerce element-wise. */
  numericArrays?: readonly string[];
  /** Declared keys whose null/undefined values are dropped before validation. */
  knownKeys?: readonly string[];
}

const numericString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));

export const normalizeActionArgs = (
  args: Record<string, unknown>,
  spec: ArgNormalizationSpec,
): Record<string, unknown> => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  let out = args;
  const edit = (): void => {
    if (out === args) out = { ...args };
  };
  const aliases = spec.aliases;
  if (aliases) {
    for (const alias in aliases) {
      if (!(alias in out)) continue;
      edit();
      const canonical = aliases[alias]!;
      if (!(canonical in out)) out[canonical] = out[alias];
      delete out[alias];
    }
  }
  const values = spec.values;
  if (values) {
    for (const key in values) {
      const current = out[key];
      if (typeof current !== "string") continue;
      const mapped = values[key]![current];
      if (mapped === undefined) continue;
      edit();
      out[key] = mapped;
    }
  }
  for (const key of spec.numerics ?? []) {
    if (!numericString(out[key])) continue;
    edit();
    out[key] = Number(out[key]);
  }
  for (const key of spec.numericArrays ?? []) {
    const items = out[key];
    if (!Array.isArray(items) || !items.some(numericString)) continue;
    edit();
    out[key] = items.map((item) => (numericString(item) ? Number(item) : item));
  }
  for (const key of spec.knownKeys ?? []) {
    if (!(key in out)) continue;
    if (out[key] !== null && out[key] !== undefined) continue;
    edit();
    delete out[key];
  }
  return out;
};

// Declared property names of a descriptor inputSchema, for knownKeys plumbing.
const schemaPropertyKeys = (
  inputSchema: Record<string, unknown>,
): string[] => {
  const properties = (inputSchema as { properties?: Record<string, unknown> }).properties;
  return properties ? Object.keys(properties) : [];
};

/** Registry-ready prepareArguments built from a descriptor lookup plus a table. */
export const actionArgNormalizer = (
  descriptors: () => Array<{ name: string; inputSchema: Record<string, unknown> }>,
  table: Record<string, ArgNormalizationSpec>,
) =>
(actionName: string, args: Record<string, unknown>): Record<string, unknown> => {
  const descriptor = descriptors().find((item) => item.name === actionName);
  const spec: ArgNormalizationSpec = {
    ...(table[actionName] ?? {}),
    knownKeys: descriptor ? schemaPropertyKeys(descriptor.inputSchema) : [],
  };
  return normalizeActionArgs(args, spec);
};
