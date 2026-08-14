# Component calculus and runtime laws

Pi Fabric's component plane follows this mathematical contract. JavaScript cannot prove arbitrary program equivalence. The ordinary `fabric_exec` path enters the plane only when code uses a committed capability view or a supervised component.

DeepSeek's dynamic-composition paper describes the effect/coeffect calculus used here. Pi Fabric keeps explicit provider/action refs and host policy. Cordis's proxy context API stays outside this implementation.

## Runtime correspondence

For a runtime context Γ, this operational tuple represents a component instance:

```text
⟨d, p, e, π, σ, τ, θ, ω⟩
```

| Symbol | Pi Fabric realization |
|---|---|
| `d` | the exact refs from `requires` |
| `p` | the disjoint provider names declared in `provides` |
| `e` | `activate()` with its yielded and returned inverses |
| `π` | the optional `parentId` that `context.use()` creates |
| `σ` | the staged provider bindings that the instance owns |
| `τ` | monotone retirement plus a transition epoch |
| `θ` | one of `waiting`, `loading`, `active`, `unloading`, `failed`, `quarantined`, or `disposed` |
| `ω` | the retained committed capability view |

Provider binding IDs are fresh atoms. A committed view pins the binding generation and the descriptor hash. Two bindings that share one provider name still count as distinct atoms, so an ABA replacement always produces a new pin.

## The resolution square

Activation exposes two observable paths that must agree:

```text
component definition ── activate under ω ──▶ owned effects
        │                                      │
        │ resolve d                            │ commit p
        ▼                                      ▼
live provider state ─── target(d, Γ) ─────▶ active fiber
```

The two paths commute only when the target at the final iteration boundary is still `ω`. When the target differs, activation diverts, applies the accumulated inverse, and retries against the new target. `tests/component-laws.test.ts` checks both insertion orders. The two orders place the provider before its consumer exists, or after the consumer reaches `waiting`. Both orders produce the same terminal observation.

## Witnessed effects

A tracked effect contributes a forward transformation `f` and an inverse `g` that the author supplies:

```text
Γ ──f──▶ Γ′
│        │
└──id◀──g
```

The runtime enforces the structural part of this triangle:

- each landed iterator step contributes at most one callable inverse.
- inverses run once in LIFO order.
- setup failure and target diversion recover every landed step.
- on diversion the iterator's `return()` runs, so generator `finally` blocks can settle.
- a cleanup failure produces the `quarantined` state, never a false claim of recovery.

The runtime cannot prove that `g(f(Γ)) ≃ Γ`. The author must guarantee that the inverse is correct, and the author chooses the observational equivalence `≃`. Mutations performed outside `context.effect`, `context.defer`, `context.acquire`, `context.call`, `context.provide`, or `context.use` are ambient and sit outside the witnessed system.

## Iteration, diversion, and inertia

An effect generator exposes a delimited continuation at every yield:

```text
loading(ω, g₀)
  ├─ step lands with inverse h, target = ω  → loading(ω, g₀ ∘ h)
  ├─ step lands with inverse h, target ≠ ω  → unloading(ω, g₀ ∘ h)
  ├─ iterator finishes, target = ω          → active(ω, g)
  └─ iterator raises                         → unloading(ω, g, error)
```

A launched asynchronous step is inertial. Fabric lets the step land and records its inverse before it inspects the target again. The stale continuation never resumes. A diversion is retryable and lands in `waiting`. An author error lands in `failed`, and Fabric does not retry it against the same target.

Retirement and replacement each increment a transition epoch. A stale transition may clean up its own local scope. It may not publish providers or write a later lifecycle state. The epoch rule stops a late activation from resurrecting after `stop`, replacement, provider retirement, or shutdown.

## Withdrawal and committed views

A provider leaves the live target before its inverse runs:

```text
active provider
  → retire bindings
  → unload consumers whose ω names those binding IDs
  → run provider owner's inverses
  → release owner bindings
```

Consumer teardown retains the old `ω`, so the consumer can still call the retiring provider. The binding closes only after the owner retention, the committed views, the scoped acquisitions, and the in-flight calls all release it.

The owner component must keep its ambient supporting state valid until the provider's `close()` runs. The registry can retain a provider object across external actor views. It cannot infer hidden closure dependencies.

## Provision disjointness

Inside the shared provider realm, two installed fibers may never declare the same provider name. The supervisor rejects the second insertion or replacement before it disturbs either component. Staged bindings reserve their provider names. An external registration can slip between staging and commit only through an explicit overwrite. When an external orchestrator retires an active provision, the owner fiber drops out of the active state and reconciles.

This rule is stronger than last-writer-wins registry replacement. Every declared key keeps a unique provider, and dependency edges stay unambiguous. Put multiple implementations behind an explicit broker provider, and keep ambiguous selection out of core resolution.

## Parent-owned fibers

`context.use(definition, options)` installs a child fiber as a tracked registration effect. The child behaves as a normal supervised component with its own requirements, effects, failures, and committed view.

```text
parent scope ──use──▶ child fiber ──use──▶ grandchild fiber
     │                    │
     └──── inverse ───────┴── retires descendants first
```

Parent ownership implies no dependency injection. Requirement edges still determine provider and consumer withdrawal. Ownership ensures that descendants retire and are removed before the parent's own inverse runs. A child activation failure stays local, and healthy siblings and the parent keep running. The parent registers the child during its own activation. The serial lifecycle activates the child only after the parent transition finishes. Awaiting child readiness from inside the parent transition falls outside the calculus. Fabric rejects that lifecycle re-entry so the queue cannot deadlock.

## Independence

Take two effects `a` and `b`. Safe reordering needs more than non-overlapping concurrent calls. The forwards of both effects, their inverses, and every mixed forward/inverse composition must commute under `≃`.

Pi Fabric uses a conservative, declared approximation:

```ts
effect: {
  resources: ["workspace:project"],
  ordering: "commutative" | "ordered" | "unknown"
}
```

Fabric treats disjoint explicit resources as independent. Shared resources count as independent only when both effects declare `commutative`. Missing resources normalize to `*`, the top/unknown footprint. The `*` marks unknown scope. No resource identity is literally named `*`. An unknown noncommutative effect conflicts with every effect. An unknown commutative effect conflicts with any peer that contains a noncommutative effect. A legacy string-label registration on a `revertible` component stays conservative until the author supplies explicit resources and ordering. A `revertible` component rejects a conflicting lifetime effect before installation where it can, and it checks again before commit. Managed components retain bounded evidence and leave the stronger theorem outside their claims and warnings.

The author of the provider or component supplies the `commutative` label as a witness. Fabric does not prove the claim. Component status exposes at most 256 effect-evidence records along with the strict conflicts, so the claim stays inspectable. A revertible component refuses a 257th record, because one more would silently weaken the check. A failure caused by a peer footprint commits that peer environment into the blocked target. Removing the conflicting component then retries the fiber automatically. Shutdown runs in reverse activation order, which is the conservative inverse order when no dependency edge gives a stronger constraint.

## System boundary

The effect kind records where an operation stands relative to the recoverable system:

- `none`: the operation performs no tracked mutation.
- `scoped`: an acquisition that carries an explicit disposer.
- `transactional`: the provider or author claims recovery under its stated equivalence.
- `emission`: output crossed the boundary, and the component scope cannot recover it.

A `revertible` component may use `none`, `scoped`, and `transactional` effects. It rejects emissions, whether they arrive through a provider action or through a custom effect registration. The `transactional` kind stays a claim. Its compensation or rollback semantics remain a provider obligation.

Output withholding, compensation frameworks, and coarser application-specific equivalences stay explicit opt-ins. Each one needs its own protocol. Silent buffering of arbitrary host output would alter existing Pi Fabric behavior and model-visible timing.

## Enforced invariants

The runtime and the tests enforce these invariants:

1. component identity stays unique, and provisions stay disjoint.
2. committed views stay closed-world, and the caller retains them.
3. staged providers publish only after stable activation.
4. partial recovery runs LIFO and fires once.
5. asynchronous steps keep inertia, and diversion happens at yield boundaries.
6. transition epochs block stale lifecycle writes.
7. dependents withdraw before their provider.
8. the supervisor removes descendants before their parent.
9. failure stays isolated per fiber.
10. unverifiable cleanup leads to quarantine.
11. lifetime-effect independence checks stay conservative for `revertible` components.
12. shutdown follows reverse activation order.
13. force-removal of a quarantined registry record makes no claim that leaked ambient state was recovered.

`tests/default-path-compatibility.test.ts` pins the ordinary uncommitted action path separately. The pin covers derived effect metadata and capability hash bytes.

## Liveness and performance boundary

The progress argument assumes two facts: every launched transition eventually settles, either normally or after cooperative `context.signal` cancellation, and provider targets eventually quiesce. Fabric signals cancellation before it awaits inertia. It rejects lifecycle calls that re-enter from activation or teardown. An inverse never runs concurrently with the forward step it recovers. Repeated target diversions apply an exponential delay capped at 100 ms. The cap keeps a flapping provider from turning the serial reconcile loop into a CPU spin. Fabric never detaches an uncooperative infinite host promise and then claims the cleanup was sound.

The ordinary ARC-sensitive execution path skips component target checks, footprint summaries, and async-context tracking. Fabric dynamically imports the async lifecycle context on the first component transition. Component evidence stays bounded. Conflict checks use linear footprint summaries. One dashboard list pass projects each component and each pair once. A supervisor admits at most 1,024 fibers, and each parent admits at most 256 live children. These limits keep the remaining pairwise graph projection finite. Provider staged-name reservations use a direct index. The index avoids scanning bindings.

## Implementation boundary

The current calculus stays inside one shared provider realm. Isolation realms, interception metadata, structural service versioning, output commit, compensation, module-cache HMR, and guest component sandboxing form separate architectural layers. The implemented single-realm lifecycle calculus does not depend on any of them as premises.

Introduce a layer only when its use case supplies the needed equivalence and policy semantics. Apply these rules to each candidate layer:

- multiplex through explicit broker components, and keep ambiguous provider selection out.
- favor process or QuickJS replacement boundaries over Node-internal ESM cache mutation.
- keep the `call` and `acquire` APIs explicit for auditability.
- never infer commutativity from successful examples.
- describe trusted host components as trusted host code, because the word sandboxed overstates the boundary.
