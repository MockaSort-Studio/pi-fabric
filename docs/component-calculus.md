# Component calculus and runtime laws

This document records the mathematical contract of Pi Fabric's component plane. It is an implementation guide, not a claim that JavaScript can prove arbitrary program equivalence. The ordinary `fabric_exec` path remains outside this plane unless a committed capability view or supervised component is explicitly used.

The design follows the effect/coeffect calculus described in DeepSeek's dynamic-composition paper. Pi Fabric retains explicit provider/action refs and host policy rather than copying Cordis's proxy context API.

## Runtime correspondence

For a runtime context Γ, a component instance is represented by the operational tuple

```text
⟨d, p, e, π, σ, τ, θ, ω⟩
```

| Symbol | Pi Fabric realization |
|---|---|
| `d` | exact `requires` refs |
| `p` | disjoint declared provider names in `provides` |
| `e` | `activate()` and its yielded/returned inverses |
| `π` | optional `parentId` created by `context.use()` |
| `σ` | staged provider bindings owned by the instance |
| `τ` | monotone retirement plus a transition epoch |
| `θ` | `waiting`, `loading`, `active`, `unloading`, `failed`, `quarantined`, or `disposed` |
| `ω` | retained committed capability view |

Provider binding IDs are fresh atoms. A committed view pins the binding generation and descriptor hash, not merely a provider name. This prevents an ABA replacement from appearing unchanged.

## The resolution square

Activation has two observable paths that must agree:

```text
component definition ── activate under ω ──▶ owned effects
        │                                      │
        │ resolve d                            │ commit p
        ▼                                      ▼
live provider state ─── target(d, Γ) ─────▶ active fiber
```

The lower and upper paths commute only when the target at the final iteration boundary is still `ω`. Otherwise activation diverts, applies the accumulated inverse, and retries against the new target. `tests/component-laws.test.ts` checks that inserting a provider before its consumer or after the consumer reaches `waiting` has the same terminal observation.

## Witnessed effects

A tracked effect contributes a forward transformation `f` and an author-supplied inverse `g`:

```text
Γ ──f──▶ Γ′
│        │
└──id◀──g
```

The runtime enforces the structural part of this triangle:

- each landed iterator step contributes at most one callable inverse;
- inverses run once in LIFO order;
- setup failure and target diversion recover all landed steps;
- iterator `return()` runs on diversion so generator `finally` blocks settle;
- cleanup failure produces `quarantined`, never a false claim of recovery.

The runtime cannot prove `g(f(Γ)) ≃ Γ`. Correctness of the inverse and the chosen observational equivalence `≃` remain author obligations. Ambient mutations performed outside `context.effect`, `context.defer`, `context.acquire`, `context.call`, `context.provide`, or `context.use` are outside the witnessed system.

## Iteration, diversion, and inertia

An effect generator exposes a delimited continuation at every yield:

```text
loading(ω, g₀)
  ├─ step lands with inverse h, target = ω  → loading(ω, g₀ ∘ h)
  ├─ step lands with inverse h, target ≠ ω  → unloading(ω, g₀ ∘ h)
  ├─ iterator finishes, target = ω          → active(ω, g)
  └─ iterator raises                         → unloading(ω, g, error)
```

A launched asynchronous step is inertial: Fabric lets it land and records its inverse before inspecting the target again. It does not resume the stale continuation. Diversion is retryable and lands in `waiting`; an author error lands in `failed` and is not retried against the same target.

Retirement and replacement increment a transition epoch. A stale transition may clean up its own local scope, but it cannot publish providers or write a later lifecycle state. This prevents a late activation from resurrecting after `stop`, replacement, provider retirement, or shutdown.

## Withdrawal and committed views

A provider leaves the live target before its inverse runs:

```text
active provider
  → retire bindings
  → unload consumers whose ω names those binding IDs
  → run provider owner's inverses
  → release owner bindings
```

Consumer teardown retains its old `ω`, so it can still call the retiring provider. The binding closes only after owner retention, committed views, scoped acquisitions, and in-flight calls all release it.

The owner component's ambient supporting state must remain valid until its provider's `close()` runs. The registry can retain a provider object across external actor views, but it cannot infer hidden closure dependencies.

## Provision disjointness

Within the shared provider realm, two installed fibers may not declare the same provider name. The supervisor rejects the second insertion or replacement before disturbing either component. Staged bindings reserve their provider names, so an external registration cannot slip between staging and commit without an explicit overwrite. If an external orchestrator retires an active provision, the owner fiber leaves and reconciles instead of remaining falsely active.

This is stronger than relying on last-writer-wins registry replacement. It preserves a unique provider for every declared key and makes dependency edges unambiguous. Multiple implementations belong behind an explicit broker provider rather than ambiguous core resolution.

## Parent-owned fibers

`context.use(definition, options)` installs a child fiber as a tracked registration effect. The child is a normal supervised component with its own requirements, effects, failures, and committed view.

```text
parent scope ──use──▶ child fiber ──use──▶ grandchild fiber
     │                    │
     └──── inverse ───────┴── retires descendants first
```

Parent ownership does not imply dependency injection. Requirement edges still determine provider/consumer withdrawal. Ownership ensures descendants are retired and removed before the parent's own inverse runs. A child activation failure remains local: healthy siblings and the parent continue. Registration occurs during parent activation, but the serial lifecycle activates the child only after the parent transition finishes; awaiting child readiness from the parent transition is therefore outside the calculus and rejected lifecycle re-entry is used instead of deadlock.

## Independence

For effects `a` and `b`, safe reordering requires more than concurrent-call non-overlap. Their forwards, inverses, and mixed forward/inverse compositions must commute under `≃`.

Pi Fabric uses a conservative, declared approximation:

```ts
effect: {
  resources: ["workspace:project"],
  ordering: "commutative" | "ordered" | "unknown"
}
```

Disjoint explicit resources are treated as independent. Shared resources are independent only when both effects declare `commutative`. Missing resources normalize to `*`, which is the top/unknown footprint rather than a literal resource name. An unknown noncommutative effect conflicts with every effect; an unknown commutative effect conflicts with peers that contain any noncommutative effect. Therefore a legacy string-label registration on a `revertible` component is deliberately conservative until it supplies explicit resources and ordering. A `revertible` component rejects a conflicting lifetime effect before installation where possible and rechecks before commit. Managed components retain bounded evidence without claiming or warning on the stronger theorem.

The `commutative` label is a witness supplied by the provider or component author; Fabric does not prove it. Component status exposes at most 256 effect-evidence records and strict conflicts so the claim remains inspectable. A revertible component refuses a 257th record rather than silently weakening its check. A failure caused by a peer footprint commits that peer environment into its blocked target, so removal of the conflicting component automatically retries the fiber. Shutdown uses reverse activation order, the conservative inverse order when no dependency edge gives a stronger constraint.

## System boundary

The effect kind records where an operation sits relative to the recoverable system:

- `none`: no tracked mutation;
- `scoped`: acquisition with an explicit disposer;
- `transactional`: provider or author claims recovery under its stated equivalence;
- `emission`: output crossed the boundary and cannot be recovered by the component scope.

A `revertible` component may use `none`, `scoped`, and `transactional` effects. It rejects emissions whether they arrive through a provider action or a custom effect registration. This does not turn `transactional` into a proof: its compensation or rollback semantics remain a provider obligation.

Output withholding, compensation frameworks, and coarser application-specific equivalences are deliberately not implicit. They require an explicit protocol because silently buffering arbitrary host output would alter existing Pi Fabric behavior and model-visible timing.

## Enforced invariants

The runtime and tests enforce:

1. unique component identity and disjoint provisions;
2. closed-world, retained committed views;
3. staged provider publication only after stable activation;
4. LIFO, single-fire partial recovery;
5. asynchronous inertia with yield-boundary diversion;
6. transition epochs preventing stale lifecycle writes;
7. dependent-before-provider withdrawal;
8. descendant-before-parent removal;
9. per-fiber failure isolation;
10. quarantine on unverifiable cleanup;
11. conservative lifetime-effect independence for `revertible` components;
12. reverse-activation shutdown order;
13. forced removal of a quarantined registry record without pretending leaked ambient state was recovered.

The ordinary uncommitted action path is pinned separately by `tests/default-path-compatibility.test.ts`, including derived effect metadata and capability hash bytes.

## Liveness and performance boundary

The progress argument assumes every launched transition eventually settles, either normally or after cooperative `context.signal` cancellation, and that provider targets eventually quiesce. Fabric signals cancellation before awaiting inertia, rejects lifecycle calls re-entered from activation or teardown, and never runs an inverse concurrently with the forward step it is meant to recover. Repeated target diversions use an exponential delay capped at 100 ms, preventing a flapping provider from turning the serial reconcile loop into a CPU spin. Fabric does not detach an uncooperative infinite host promise and then pretend cleanup was sound.

The ordinary ARC-sensitive execution path does not perform component target checks, footprint summaries, or async-context tracking. Async lifecycle context is dynamically imported on the first actual component transition. Component evidence is bounded, conflict checks use linear footprint summaries, and one dashboard list pass projects each component and pair once. A supervisor admits at most 1,024 fibers and each parent at most 256 live children, keeping the remaining pairwise graph projection finite. Provider staged-name reservations use a direct index rather than scanning bindings.

## Deliberate frontier

The current calculus stays in one shared provider realm. Isolation realms, interception metadata, structural service versioning, output commit, compensation, module-cache HMR, and guest component sandboxing are separate architectural layers, not missing premises of the implemented single-realm lifecycle calculus.

They should be introduced only when their use case supplies the needed equivalence and policy semantics. In particular:

- use explicit broker components for multiplexing rather than ambiguous provider selection;
- prefer process or QuickJS replacement boundaries over Node-internal ESM cache mutation;
- keep explicit `call` and `acquire` APIs for auditability;
- never infer commutativity from successful examples;
- do not describe trusted host components as sandboxed.

This stop line preserves a small UX: authors declare requirements, provisions, effect footprints, and ownership; the dashboard shows the resulting evidence; the runtime enforces only laws it can observe.
