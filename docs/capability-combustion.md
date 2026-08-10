# Capability combustion — the math behind fabric's advisory hints

This document walks the advisory model: the tf-idf scoring under the matches, the
ignition bands, the warmth accumulation that gates weak evidence, the ash record
that makes fires permanent, organic poisoning when the model self-discovers a
capability, and the furnace feedback that raises ignition after ignored fires.
Implementation references point at `src/core/capability-advisory.ts`.

## Why a battery, not a sensor

[pi-fovea](https://github.com/monotykamary/pi-fovea) is a *sensor*: it watches the repo continuously and must filter
frame-rate noise from a high-throughput signal (every edit is an event). Its heat
dynamics exist to stop bad steers from cascading.

pi-fabric's capability advisory faces the opposite regime. Emission is tightly
bounded (`maxPerSession`, default 3 per session), and — since fire-once state
persists — every hint burns a capability's namespace *permanently*. The advisory
is a battery: it holds a finite reservoir of information value, one spot per
capability, that only depletes. The cost of a false fire isn't noise; it's
potential-information irrecoverably spent. So the system is engineered around one
invariant: **never waste a burn.**

## Scoring: 1/df term weighting

Captured tools are fingerprinted by source namespace (the plugin they belong to):
each source's corpus is its tools' names plus descriptions. A prompt scores
against each unburned source as the sum of matched-term weights:

$$
s(p, j) = \sum_{t \in T(p) \cap T(j)} \frac{1}{\mathrm{df}(t)}, \qquad \mathrm{df}(t) = \bigl|\{ j : t \in T(j) \bigr\|
$$

The weight is *plain* $1/\mathrm{df}$, not $\ln(N/\mathrm{df})$ tf-idf. Classic idf
collapses on tiny captured catalogs: with four sources, $\ln(4/2) < 1$, so rare
terms score less than common ones below the threshold and matches starve
silently. $1/\mathrm{df}$ keeps "two distinctive terms ≈ one source" meaningful at
any catalog size.

Pre-ignition filters:

- **Skill-envelope strip.** Pi expands loaded skills into the prompt as XML
  (`<available_skills>…</available_skills>`, `<skill>…</skill>`). That's ambient
  context, not intent; letting it through poisons the fingerprint with the
  skill's own vocabulary. Regions are removed before tokenization (unclosed
  trailing tags count as stripped too).
- **≥2 matched terms.** A lone distinctive word ("project", "recent") is
  vocabulary collision, not intent.
- **Stopword filtering** at tokenization (see `capability-fingerprint.ts`).

## Ignition bands and warmth

### Two primitives generate everything

The dynamics look parameter-heavy — band width, retention, smoke step, streak
cap, session cap — but they all project from **two primitives**, plus the
user-facing $\theta$:

1. **The score quantum $q = 1$.** Under $1/\mathrm{df}$ scoring a *source-unique*
   term weighs exactly $1/1 = 1$: the smallest unit of unambiguous evidence the
   scorer can express. The weak band is exactly one quantum wide, $B = q = 1$ —
   strong = weak + one quantum of certainty. A weak match that gains even a
   single truly-unique term crosses into instant ignition.
2. **The memory scale $\tau = 2$ turns.** Every temporal behavior below is one
   exponential integrator with retention $1 - 1/\tau$. All other constants
   derive from it:

| Constant | Value | Projection |
|---|---|---|
| warmth retention $\alpha$ | 0.5 | $1 - 1/\tau$ |
| cool half-life | 1 turn | $\ln \tfrac{1}{2}\,/\,\ln(1 - 1/\tau)$ |
| weak band $B$ | 1.0 | $q = 1$ |
| smoke step | $0.25\theta$ | $\theta/\tau^2$ |
| smoke streak cap | 4 | $\tau^2$ |
| max furnace raise | $\theta$ | $(\theta/\tau^2)\cdot\tau^2$ — $\tau$-invariant |
| default session cap | 3 | $2\tau - 1$ |

The second-to-last row is the point of the lift: total furnace authority is
bounded at exactly $\theta$ *no matter what $\tau$ is* — patience changes how
quickly the furnace responds, never how hot it may run. And the $\tau$ vs
$\tau^2$ split has a statistical reading: **first-order signals average over
$\tau$ samples; second-order feedback calibrates over $\tau^2$.** Warmth tracks
a mean ("is the user on this topic") and O($\tau$) turns suffice; smoke
estimates a bias ("do this namespace's hints get used") whose variance
converges like $1/n$, so the thermostat needs the squared budget.

Let $\theta$ be the configured `threshold` (default 0.9) and $B = q = 1$ the weak
match band. Each turn, each unburned source with $s \geq \theta$ falls into one of
two bands:

| Band | Condition | Behavior |
|---|---|---|
| Strong | $s \geq \theta + B$ | **Ignites instantly.** Multi-term overlap is strong evidence; delay would hurt real use. |
| Weak | $\theta \leq s < \theta + B$ | Must accumulate **warmth** until it exceeds the ignition point $\theta_i$. |

Warmth convolves the per-turn score signal with the unit-mass exponential
kernel $K_\tau(j) = \tfrac{1}{\tau}\bigl(1 - \tfrac{1}{\tau}\bigr)^j$ over
*evaluated turns* (advisory-eligible prompts) — a first-order low-pass filter,
$\alpha = 1 - 1/\tau = 0.5$ at the default (half-life one turn):

$$
W_k = (1-\alpha)\, s_k + \alpha\, W_{k-1} = (K_\tau * s)_k, \qquad s_k =
\begin{cases} s \geq \theta & \text{weak-band score this turn} \\ 0 & \text{otherwise} \end{cases}
$$

Weak ignition fires when $W_k \geq \theta_i$ (the ignition point; by default
$\theta_i = \theta$). Interpretation: sustained exposure asymptotes W to $s$:
$W_k \to s\,(1 - \alpha^k)$, so a sustained weak signal crossing time is
$k_{\text{ignite}} = \big\lceil \ln(1 - \theta_i/s)\,/\,\ln(1 - 1/\tau) \big\rceil$.
At $\tau = 2$, $\theta = 0.9$: the floor of the band ($s = 1.0$) needs 4 turns,
the upper band ($s \geq 1.25$) needs 2, and the strong band needs 0 — one
formula, three regimes. A one-off vocabulary collision spikes once and cools
before crossing. Dropping the topic mid-decay halves W per turn; returning to
it re-warms from the residue rather than restarting.

τ interpolates between regimes: $\tau \to 1$ is memoryless (no gating, warmth
just re-reads the last score); large $\tau$ never ignites on anything transient.
The mean of $K_\tau$ spans $\tau$ turns, so $\tau = 2$ says: trust a mean taken
over roughly the last two turns.

With the default fixture terms, "query the results table please" scores
$s = 1.333$ (weak band): the EWMA crosses $0.9$ only on the second tidy prompt,
and cool-off while the user edits code delays the fire as intended.

## Ash: permanent suppression with provenance

Fired namespaces are burned. The record (ash) is append-only and machine-global,
persisted at `<agent-dir>/fabric/capability-advisories.json`:

```json
{ "format": 2, "burned": [
    { "namespace": "extension:pi-websearch", "origin": "fired", "at": "2026-08-10T16:00:00.000Z" },
    { "namespace": "extension:pi-fovea",    "origin": "organic" } ] }
```

Provenance is in `origin`:

- `fired` — a hint was emitted for this capability.
- `organic` — the model invoked a captured tool from that namespace *without a
  hint*. The capability's information potential is already spent; a hint would
  be redundant, so we burn it preemptively. This is organic-discovery poisoning:
  the same one-way door as a fire, entered from the other side.

You don't unburn paper. Ash is never reclaimed: no expires, no release path, no
defrost knob. `reset()` clears things that are inherently session-local (warmth,
smoke streak, per-session cap) but never ash; `hydrate()` loads it on session
start.

## Furnace feedback

Combustion quality regulates the furnace. Each turn (at `turn_end`) the advisor
checks pending fires: did any matched namespace see a captured-tool invocation
before the turn closed? A fire that the model ignored is smoke; a streak of
smoke raises the weak-band ignition point:

$$
\theta_i = \theta \cdot \bigl(1 + \tfrac{n}{\tau^2}\bigr), \qquad 0 \leq n \leq \tau^2 \quad (\tau = 2: \\ \text{step } 0.25\theta,\ \text{cap } 4)
$$

where $n$ is the consecutive no-use streak (capped at 4, so ignition never
exceeds $2\theta$). Any fire whose hint led to a tool call clears the streak to
zero — clean combustion keeps the furnace responsive. Smoke feedback only raises
the *weak-band* ignition bar; strong matches still ignite instantly, because if
the evidence is that unambiguous the furnace's skepticism isn't invited.

Transient feedback lives session-locally too: smoke is lifted by the first clean
burn, and unlike ash it doesn't persist across sessions (organic poisoning
covers the durable learning).

## Per-session cap

$\leq$ `maxPerSession` fires per session regardless of model behavior (default
3). Unchanged from the pre-combustion design; the cap guards against prompt
storms in a single session, ash guards against repetition across sessions.

## Summary

| Knob | Where | Effect |
|---|---|---|
| `capture.advisory.mode` | config | enabled / hidden / disabled |
| `capture.advisory.threshold` | config | base ignition $\theta$ |
| `capture.advisory.maxPerSession` | config | session fire cap |
| `capture.advisory.budget` | config | token ceiling for the advisory text (chars/4, 128–8192, same range as [pi-fovea](https://github.com/monotykamary/pi-fovea)'s `sync.budget`) |

Internal constants (not user-facing): the two primitives $q = 1$ (score
quantum) and $\tau = 2$ (memory scale); every manifest constant projects from
them — retention $\alpha = 1 - 1/\tau$, weak band $B = q$, smoke step
$\theta/\tau^2$, streak cap $\tau^2$, default `maxPerSession` $= 2\tau - 1$.
Mispredicting $\tau$ costs responsiveness, never authority: the maximum furnace
raise stays at $\theta$ for any $\tau$.
