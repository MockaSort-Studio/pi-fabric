# Components, effects, and committed capabilities

Pi Fabric's component plane turns the provider registry into a supervised, reconfigurable harness. A **provider** exposes actions. A **component** declares exact actions it requires, may mount providers of its own, and owns an effect scope that Fabric can unwind. An **actor** may commit the same kind of exact capability view before each model run.

## Architectural fit

The core square is:

```text
component definition ──activate──▶ owned effects + staged providers
        │                                │
        │ requires exact refs            │ commit only after activation
        ▼                                ▼
live provider catalog ──resolve──▶ committed capability view
```

Reload preserves the corresponding observable path:

```text
old component ──dispose dependents/effects──▶ retired provider generation
      │                                             │ retained until quiescent
      │ replacement succeeds                       ▼
      └────────────────────────────────────▶ new provider generation
```

The square commutes when consumers see either the complete old generation or the complete new generation—never a half-mounted provider set. Provider bindings are versioned and stale leases identify a binding, not merely a provider name. A retiring generation remains callable by already committed views and closes only after its owner, dependent views, and in-flight calls release it.

This adds the missing control plane above `ActionRegistry` without replacing Fabric's existing data, state, actor, or execution planes:

- `ActionRegistry` remains the capability router and policy boundary.
- `FabricComponentSupervisor` owns lifecycle and effect scopes.
- `FabricComponentLoader` reconciles declarative entries and catalog revisions transactionally.
- `components.*` exposes lifecycle diagnostics and reload control.
- actors can declare `requires` and receive a closed-world view with a portable descriptor digest for every run.

## Registering a component

Component registration is versioned and supports both an eager event and a discovery handshake, like external providers:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_COMPONENT_DISCOVER_EVENT,
  FABRIC_COMPONENT_REGISTER_EVENT,
  type FabricComponentDefinition,
  type FabricComponentDiscovery,
} from "pi-fabric/protocol";

export default function extension(pi: ExtensionAPI) {
  const component: FabricComponentDefinition<{ prefix?: string }> = {
    name: "issue-observer",
    description: "Maintains an issue observation service",
    requires: ["github.subscription", { ref: "memory.recall", optional: true }],
    provides: ["issues"],
    guarantee: "revertible",
    async activate(context, config) {
      const client = await context.acquire<Client>("github.subscription", {
        query: `${config.prefix ?? ""} is:open`,
      });

      context.provide({
        name: "issues",
        description: "Current issue observations",
        async list() { return descriptors; },
        async describe(name) { return descriptors.find((item) => item.name === name); },
        async invoke(name, args) { return client.call(name, args); },
        async close() { await client.close(); },
      });

      return () => stopObserver();
    },
  };

  pi.events.emit(FABRIC_COMPONENT_REGISTER_EVENT, {
    version: 1,
    component,
    overwrite: true,
  });

  pi.events.on(FABRIC_COMPONENT_DISCOVER_EVENT, (discovery: FabricComponentDiscovery) => {
    discovery.register(component, { overwrite: true });
  });
}
```

Re-registering the same definition name with `overwrite: true` is the HMR boundary. Every configured instance using that definition is restarted through the rollback-capable replacement path. If candidate activation fails and its cleanup succeeds, Fabric restores the prior definition. If cleanup itself fails, Fabric quarantines the instance instead of claiming rollback succeeded.

## Declarative instances

Configure instances at the root of `fabric.json`:

```json
{
  "components": [
    {
      "id": "project-issues",
      "component": "issue-observer",
      "config": { "prefix": "repo:owner/project" }
    },
    {
      "id": "optional-observer",
      "component": "another-definition",
      "disabled": true
    }
  ]
}
```

Definitions may arrive after configuration. An unresolved instance remains `waiting` with `component:<name>` in `missing`; component discovery activates it later. `/fabric reload` reconciles changed entries. A multi-entry reconciliation rolls back additions and replacements if a later activation fails.

## Exact requirements and committed views

`requires` accepts `provider.action` strings or `{ ref, optional: true }`. Fabric resolves each present action to:

- the exact provider binding ID and generation;
- the action descriptor hash, including input/output schema, risk, and effect metadata;
- a runtime-local digest that changes on provider replacement;
- a portable semantic digest that can be checked by child actor runtimes.

A view is closed-world: calls outside it fail even if the live registry later gains that action. Calls also fail if a pinned action's descriptor changes in place. Optional missing refs do not block activation but are absent from the view, so they cannot be called.

If a dependency disappears or its generation/descriptor target changes, the supervisor retires providers, unloads dependent components first, unwinds effects in LIFO order, releases the old view, and reconciles against the new target.

## Effects and guarantees

Every activation runs inside a `FabricEffectScope`:

- `context.effect(setup, label)` records one or more returned/yielded disposers;
- `context.defer(disposer, label)` records an existing disposer;
- `context.acquire(ref, args)` requires `effect.kind: "scoped"` and automatically records the provider's single-shot disposer;
- the value returned by `activate()` is itself treated as an effect result;
- setup failure rolls back effects already installed;
- disposal is asynchronous LIFO and idempotent;
- cleanup failures are aggregated and put the component in `quarantined` state.

`guarantee: "managed"` means Fabric manages effects registered through this API. `guarantee: "revertible"` adds enforceable restrictions: provided services must implement `close()`, scoped actions must use `context.acquire()`, and ordinary calls may only be `none` or `transactional` effects. Emission actions are rejected. Neither guarantee can undo ambient side effects that component code performs behind Fabric's back; component extensions are trusted host code.

Action descriptors carry effect metadata:

```ts
effect: {
  kind: "none" | "scoped" | "transactional" | "emission",
  resources: ["optional:resource-identity"],
  ordering: "commutative" | "ordered" | "unknown"
}
```

Descriptors that omit it are normalized conservatively: `read` risk becomes commutative `none`; other risks become unknown-order `emission`.

## Actor commitments

Persistent actors accept the same exact requirement syntax:

```ts
await agents.create({
  name: "release-watcher",
  instructions: "Watch releases and report actionable changes.",
  events: ["turn_end"],
  requires: ["mcp.github.latest_release", { ref: "memory.recall", optional: true }],
});
```

Before each run, the host acquires and retains a committed view. It sends the resolved refs and portable semantic digest to the Pi child. The child independently resolves the refs, rejects a digest mismatch, and pins every `fabric_exec` call to that closed-world view. Requirements and the digest are recorded in actor status and run metadata. A requirement unavailable at run time keeps that mailbox activation queued and reports `missingCapabilities`; provider/catalog changes retry it without silently widening authority. Non-Pi runners still receive host-side commitment checks, but only recursive Pi actors have a Fabric guest surface to enforce inside the child.

## Diagnostics

```ts
const all = await components.list();
const one = await components.status({ id: "project-issues" });
const graph = await components.graph();
await components.reload({ id: "project-issues" });
```

The dashboard renders components in a separate topology group, with exact requirement-to-provision edges and cycle paths; component lifecycle is not conflated with participant ownership. When mesh lifecycle delivery is enabled, each changed state is also published as an attributed `component.state` event with bounded identity/state metadata; delivery is observational and never drives local correctness.

States are `waiting`, `loading`, `active`, `unloading`, `failed`, `quarantined`, and `disposed`. Status includes missing/optional requirements, provisions, revision, target digest, activation error, and cleanup failures. The graph reports requirement-to-provider-component edges and dependency cycles.
