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

Let $\theta$ be the configured `threshold` (default 0.9) and $B = 1.0$ the weak
match band. Each turn, each unburned source with $s \geq \theta$ falls into one of
two bands:

| Band | Condition | Behavior |
|---|---|---|
| Strong | $s \geq \theta + B$ | **Ignites instantly.** Multi-term overlap is strong evidence; delay would hurt real use. |
| Weak | $\theta \leq s < \theta + B$ | Must accumulate **warmth** until it exceeds the ignition point $\theta_i$. |

Warmth is an exponential moving average over *evaluated turns* (advisory-eligible
prompts), with retention $\alpha = 0.5$ (half-life one turn):

$$
W_k = \alpha\, W_{k-1} + (1 - \alpha)\, s_k, \qquad s_k =
\begin{cases} s \geq \theta & \text{weak-band score this turn} \\ 0 & \text{otherwise} \end{cases}
$$

Weak ignition fires when $W_k \geq \theta_i$ (the ignition point; by default
$\theta_i = \theta$). Interpretation: sustained exposure asymptotes W to $s$:
$W_k \to s\,(1 - \alpha^k)$. A one-off vocabulary collision spikes once and cools
before crossing. Dropping the topic mid-decay halves W per turn; returning to it
re-warms from the residue rather than restarting.

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
\theta_i = \theta \cdot (1 + 0.25\, n), \qquad 0 \leq n \leq 4
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

## Summary of knobs

| Knob | Where | Effect |
|---|---|---|
| `capture.advisory.mode` | config | enabled / hidden / disabled |
| `capture.advisory.threshold` | config | base ignition $\theta$ |
| `capture.advisory.maxPerSession` | config | session fire cap |
| `capture.advisory.budget` | config | token ceiling for the advisory text (chars/4, 128–8192, same range as [pi-fovea](https://github.com/monotykamary/pi-fovea)'s `sync.budget`) |

Internal constants (not user-facing): $B = 1.0$ (weak band), retention
$\alpha = 0.5$, smoke step $0.25\theta$ per streak, streak cap 4.
