# Components, effects, and committed capabilities

Pi Fabric adds a component plane that turns the provider registry into a supervised, reconfigurable harness. A **provider** exposes actions. A **component** declares the exact actions it requires, and it may mount providers of its own. Each component owns an effect scope that Fabric can unwind. An **actor** may commit the same kind of exact capability view before each model run. The [component calculus](component-calculus.md) records the formal correspondence, the laws the runtime enforces, the author obligations, and the documented implementation boundary.

## Architectural fit

The core square shows this flow:

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

The square commutes when every consumer sees one complete provider generation, old or new, and never a half-mounted set. Provider bindings carry versions. A stale lease identifies one specific versioned binding identity. A retiring generation stays callable for views that already committed to it, and it closes only after its owner, its dependent views, and its in-flight calls release it. Transition epochs stop a late-settling activation from resurrecting after retirement.

These parts add the missing control plane above `ActionRegistry`. The existing data, state, actor, and execution planes stay in place:

- `ActionRegistry` routes capabilities and enforces policy.
- `FabricComponentSupervisor` owns lifecycle and effect scopes.
- `FabricComponentLoader` reconciles declarative entries and catalog revisions transactionally.
- `components.*` exposes lifecycle diagnostics and reload control.
- An actor can declare `requires` and receives a closed-world view with a portable descriptor digest for every run.

## Registering a component

Registration is versioned. Like an external provider, a component may arrive through an eager event or answer a discovery handshake:

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

Registering a definition name again with `overwrite: true` marks the HMR boundary. Fabric restarts every configured instance of that definition through the rollback-capable replacement path. If candidate activation fails and its cleanup succeeds, Fabric restores the prior definition. Fabric quarantines the instance whenever that cleanup fails. The status makes no claim that rollback succeeded.

## Declarative instances

Declare instances at the root of `fabric.json`:

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

A definition may arrive after the configuration that references it. The unresolved instance stays `waiting` and lists `component:<name>` in `missing`. Component discovery activates the instance later. `/fabric reload` reconciles changed entries. When a later activation fails during a multi-entry reconciliation, Fabric rolls back the additions and replacements from that pass. Two live component records may never declare the same provider name. Fabric rejects the insertion or replacement before it disturbs either fiber.

## Exact requirements and committed views

`requires` accepts `provider.action` strings or `{ ref, optional: true }`. Fabric resolves each present action to:

- the exact provider binding ID and generation.
- the action descriptor hash, which covers the input/output schema, the risk, and the effect metadata.
- a runtime-local digest that changes when the provider is replaced.
- a portable semantic digest that child actor runtimes can check.

The view is closed-world. A call outside the view fails even when the live registry gains that action later. Fabric also rejects a call when the descriptor of a pinned action changes in place. A missing optional ref lets activation proceed. That ref stays absent from the view, so calls to it fail.

When a dependency disappears, or when its generation or descriptor target changes, the supervisor retires the providers and unloads the dependent components first. It then unwinds effects in LIFO order, releases the old view, and reconciles against the new target.

## Effects and guarantees

Every activation runs inside a `FabricEffectScope`:

- `context.effect(setup, labelOrOptions)` records one or more disposers that the setup returns or yields.
- `context.defer(disposer, labelOrOptions)` records a disposer that already exists.
- the options may declare `label`, `kind`, `resources`, and `ordering` for lifetime-independence checks.
- `context.defer()` describes an effect that already happened, so a rejected emission registration stays recorded long enough for rollback to invoke its disposer.
- `context.acquire(ref, args)` requires `effect.kind: "scoped"`, and it records the provider's single-shot disposer automatically.
- Fabric treats the value returned by `activate()` as an effect result too.
- a setup failure rolls back the effects already installed.
- a target change diverts generators at yield boundaries, after an asynchronous step lands and before its stale continuation resumes.
- on unload, Fabric requests `context.signal` cancellation before it awaits the in-flight transition. Cleanup and state publication still wait for that transition to settle.
- disposal is asynchronous, runs in LIFO order, and is idempotent.
- Fabric aggregates cleanup failures and moves the component into the `quarantined` state.

`guarantee: "managed"` puts every effect registered through this API under Fabric's management. `guarantee: "revertible"` adds restrictions the runtime can enforce. Every provided service implements `close()`, and all scoped actions go through `context.acquire()`. Ordinary calls may carry only `none` or `transactional` effects. Each installed lifetime footprint must stay pairwise independent from the other installed component effects under the declared resource relation. Fabric rejects emissions, whether component code invokes them as actions or registers them directly. Ambient side effects that component code performs behind Fabric's back sit outside both guarantees. Component extensions run as trusted host code.

Action descriptors carry effect metadata:

```ts
effect: {
  kind: "none" | "scoped" | "transactional" | "emission",
  resources: ["optional:resource-identity"],
  ordering: "commutative" | "ordered" | "unknown"
}
```

When a descriptor omits this metadata, Fabric normalizes it conservatively. A `read` risk becomes commutative `none`, and any other risk becomes an unknown-order `emission`. Missing resource identities normalize to `*`, the top/unknown footprint. An unknown noncommutative footprint conflicts with every effect. Shared named resources commute only when both declarations say `commutative`. On a `revertible` component, a plain string label stays conservative until the author supplies explicit resources and ordering. These declarations are author witnesses, and the runtime accepts them as claims it cannot prove.

## Parent-owned components

A component may install another supervised component as a registration effect:

```ts
const child = context.use(workerDefinition, {
  id: "worker",
  config: { queue: "reviews" },
});
```

The child receives the global ID `<parent>.<local-id>` and reports `parentId`. In every other way it behaves like any component. It resolves its own committed view and can provide services. If the child fails, the parent and siblings keep running. `context.use()` is a synchronous registration operation available only while `activate()` runs. Child activation begins after the parent transition finishes, so parent activation must never wait for child readiness. When the parent unloads, Fabric retires the descendants and their dependents before it runs the parent's own inverse. Calling `child.stop()` is identity-safe and idempotent. Parent cleanup still completes eventually, even after the child record is gone. Ownership by itself grants no capabilities. A component receives capabilities only through its own `requires` list. Each parent may own at most 256 live children, and one supervisor may host at most 1,024 fibers.

Never call or await supervisor or loader lifecycle operations from component activation or teardown closures. Such a call would wait on the transition that is running the closure. Fabric rejects the call to prevent a queue deadlock. When a component asks to stop itself, Fabric folds that request into the current retirement transition. Use `context.use()` for child registration, and run unrelated orchestration outside lifecycle callbacks.

## Actor commitments

A persistent actor accepts the same exact requirement syntax:

```ts
await agents.create({
  name: "release-watcher",
  instructions: "Watch releases and report actionable changes.",
  events: ["turn_end"],
  requires: ["mcp.github.latest_release", { ref: "memory.recall", optional: true }],
});
```

Before each run, the host acquires a committed view and retains it. It sends the resolved refs and the portable semantic digest to the Pi child. The child resolves the refs on its own. It rejects a digest mismatch, and it pins every `fabric_exec` call to that closed-world view. Actor status and run metadata record the requirements and the digest. When a requirement is unavailable at run time, that mailbox activation stays queued and the actor reports `missingCapabilities`. Provider or catalog changes retry the activation. The retry never widens authority silently. Non-Pi runners still receive host-side commitment checks. Only recursive Pi actors have a Fabric guest surface that enforces the commitment inside the child.

## Diagnostics

```ts
const all = await components.list();
const one = await components.status({ id: "project-issues" });
const graph = await components.graph();
await components.reload({ id: "project-issues" });
```

The dashboard renders components in a separate topology group. It draws exact requirement-to-provision edges and cycle paths, and it keeps component lifecycle separate from participant ownership. Managed components expose bounded effect evidence, and their status stays free of strict conflict warnings. Fabric reserves `effectConflicts` for fibers that opted into the `revertible` guarantee. When mesh lifecycle delivery is enabled, Fabric also publishes each changed state as an attributed `component.state` event with bounded identity and state metadata. That delivery stays observational and never drives local correctness.

The states are `waiting`, `loading`, `active`, `unloading`, `failed`, `quarantined`, and `disposed`. A status response includes parent ownership, missing and optional requirements, provisions, up to 256 effect-evidence records, strict non-independence diagnostics, revision, target digest, activation error, and cleanup failures. The graph reports requirement-to-provider dependency edges, parent ownership edges, and dependency cycles. A programmatic supervisor may force-remove a quarantined record with `stop(id, { force: true })`. Force removal deletes the registry record. It makes no claim that leaked ambient state was recovered.
