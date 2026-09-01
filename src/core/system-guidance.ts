export const fabricExecutionKernelGuidance = (fullCodeMode: boolean): string =>
  fullCodeMode
    ? "Pi Fabric full code mode: `fabric_exec` is the only way to call Pi core tools — use them as `pi.*` inside `code`."
    : "Pi Fabric is in orchestration-only mode. Pi core and registered extension tools stay on their native direct execution path; inside fabric_exec, `pi.*` and `extensions.*` are unavailable.";

export const defaultFabricExecutionGuidance = (fullCodeMode: boolean): string =>
  fullCodeMode
    ? "Examples and returns: `pi.read('/x')`, `pi.grep('TODO','src')` / `pi.grep({pattern:'TODO', path:'src', ignoreCase:true, context:2})`, `pi.find({pattern:'*.ts', path:'src', limit:20})`, and `pi.ls('src')` return strings; `pi.bash({cmd:'ls'})`, `pi.edit({path:'/x', old:'a', new:'b'})`, and `pi.write({path:'/y', text:'z'})` return `{ok, output, details}` (read `.output`); failed core calls reject, including `bash` on an ordinary nonzero exit; pass `settle: true` to `pi.bash` to get `{ ok: false, exitCode, output, error }` instead. Timeout, cancellation, approval, and security failures still reject.\n`tools` is discovery + generic calls only (`providers`/`catalog`/`list`/`search`/`describe`/`call`/`models`). Call known MCP tools as `mcp.<sanitized_server>.<sanitized_tool>(args)`, captured tools as `extensions.<tool>(args)`, and stable providers as `memory.*`, `state.*`, `schema.*`, or `compact.*`. Use `tools.call({ref,args})` for computed refs. `pi` is the core tools; `π.<key>` reads named `strings` (not a tool)."
    : "Call known actions through `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, `state.*`, `schema.*`, `components.*`, `compact.*`, `agents.*`, or `mesh.*`; use `tools.catalog`/`search`/`describe`/`list` for discovery and `tools.call({ref,args})` for computed refs. Other surfaces are opt-in via user-loaded skills.";

// Shape of CapturedToolCatalog entries this renderer needs (kept structural to avoid a runtime dependency on the capture layer from a guidance module).
export interface ExtensionRosterToolSource {
  name: string;
  sourceInfo?: { source?: string; path?: string };
}

// In full code mode the model sees only fabric_exec in its tool list, so
// registered extension tools are invisible unless named up front (#69). The
// roster stays names-only: descriptions and schemas are on demand through the
// tools.list/search/describe discovery surface, so the standing prompt cost is
// a bare name index. Core overrides are excluded: they surface as pi.* via
// coreOverridePromptGuidance.
export const extensionToolRosterGuidance = (
  tools: ReadonlyArray<ExtensionRosterToolSource>,
  coreToolNames: ReadonlySet<string>,
): string | undefined => {
  const extensionTools = tools.filter((tool) => !coreToolNames.has(tool.name));
  if (extensionTools.length === 0) return undefined;
  const namespaceLabel = (tool: ExtensionRosterToolSource): string => {
    const source = tool.sourceInfo?.source?.trim();
    if (source) return source;
    const parts = (tool.sourceInfo?.path ?? "").split(/[\\/]/).filter(Boolean);
    const base = parts.at(-1)?.trim() ?? "";
    // Entry files like index.js name the package directory, not the source.
    if (/^index\./i.test(base)) return parts.at(-2)?.trim() || base;
    return base || "extensions";
  };
  const groups = new Map<string, string[]>();
  for (const tool of [...extensionTools].sort((left, right) => left.name.localeCompare(right.name))) {
    const label = namespaceLabel(tool);
    const names = groups.get(label);
    if (names) names.push(tool.name);
    else groups.set(label, [tool.name]);
  }
  return [
    "Registered extension tools are callable inside fabric_exec as `extensions.<name>(args)`; run `tools.list` for full descriptions and schemas before re-implementing an effect with pi.bash.",
    ...[...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, names]) => "- " + label + ": " + names.join(", ")),
  ].join("\n");
};

export const fabricSchemaGuidance = (mode: "off" | "audit" | "enforce"): string | undefined => {
  if (mode === "enforce") {
    return "Schema enforce mode is fixed for this session. Reads remain available, but protected-workspace changes must use schema.hypothesize → schema.verify → schema.commit in the same fabric_exec invocation. Direct pi.edit/write/bash, agents, state/mesh writes, compaction requests, MCP, extensions, and external providers are blocked by the host gate.";
  }
  if (mode === "audit") {
    return "Schema audit mode reports actions that enforce mode would block, but preserves their current behavior.";
  }
  return undefined;
};
