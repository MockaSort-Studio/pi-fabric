#!/usr/bin/env node
// Guard for issue #13: the /fabric dashboard lazy-loads dist/ui/dashboard.js and
// dist/ui/model-picker.js via native dynamic import(). Under a managed install
// (pi install npm:pi-fabric) Pi intentionally omits the host package
// "@earendil-works/pi-coding-agent" from fabric's node_modules, so any real
// import of it in the lazily-loaded transitive closure fails at runtime.
//
// This script walks the static import/export closure of the lazy entry points
// in dist/ and fails if any file imports the host package. Note that
// verbatimModuleSyntax turns "import { type X }" into a runtime
// "import {} from ...", which is why this operates on dist, not src.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
const LAZY_ENTRIES = ["ui/dashboard.js", "ui/model-picker.js"];

const importRe = /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;

function localImports(file) {
  const source = readFileSync(file, "utf8");
  const out = [];
  for (const match of source.matchAll(importRe)) {
    const specifier = match[1];
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      out.push(resolve(dirname(file), specifier));
    }
  }
  return out;
}

const visited = new Set();
const stack = LAZY_ENTRIES.map((entry) => join(dist, entry));
while (stack.length > 0) {
  const file = stack.pop();
  if (!file || visited.has(file)) continue;
  visited.add(file);
  for (const dep of localImports(file)) {
    if (existsSync(dep)) stack.push(dep);
  }
}

const offenders = [];
for (const file of visited) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importRe)) {
    if (match[1] === HOST_PACKAGE || match[1].startsWith(HOST_PACKAGE + "/")) {
      offenders.push(file);
      break;
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "Lazy dashboard graph must not import " + HOST_PACKAGE + " (#13). Offenders:\n  " +
      offenders.map((f) => f.replace(dist + "/", "")).join("\n  "),
  );
  process.exit(1);
}
console.log(`lazy dashboard graph is host-package-free (${visited.size} files checked)`);
