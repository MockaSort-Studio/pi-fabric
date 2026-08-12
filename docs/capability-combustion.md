# Capability combustion: the math behind fabric's advisory hints

This document walks through the advisory model: term scoring, ignition bands,
the warmth accumulator that gates weak evidence, the ash record, organic
poisoning when the model finds a capability on its own, and the furnace
feedback that raises the ignition point after ignored hints. The
implementation lives in `src/core/capability-advisory.ts`.

## A finite reservoir per capability

[pi-fovea](https://github.com/monotykamary/pi-fovea) is a sensor. It watches the repo
continuously, so it filters frame-rate noise out of a high-throughput signal.
Its heat dynamics stop bad steers from cascading.

The capability advisory faces the opposite regime. Emission is bounded
(`maxPerSession`, default 3 per session), and every hint spends a namespace
for the rest of the session. Each capability is a single battery cell of
information value, and it only drains. A false fire spends information the
model never gets back. One invariant drives the whole design: fire a hint only
when the available evidence says it will be used.

## Scoring: 1/df term weighting

Captured tools are fingerprinted by source namespace. Each source's corpus is
its identity surface: tool names plus the leading sentence of each
description. Instructional tails ("Use this when…", "HOW TO USE: …") are
excluded by construction — they describe how to choose the tool, not what the
capability is, and their meta-vocabulary ("understand", "how") collides with
ordinary interrogative prompts ("help me understand the mathematics behind
docs/heat-diffusion.md" used to ignite fal.ai on "understand" + "docs"). A
prompt scores against each unburned source as the sum of per-word evidence:

$$
s(p, j) = \sum_{w \in W(p)} \max_{t \in R(w) \cap T(j)} \frac{1}{\mathrm{df}(t)}, \qquad \mathrm{df}(t) = \Bigl|\{ j : t \in T(j) \}\Bigr|
$$

where $W(p)$ is the prompt's written words and $R(w)$ the readings of one
word — its camelCase atoms plus the word itself, both held to the corpus
token rules. One written word therefore contributes exactly one unit of
evidence: the rarity of its rarest matched reading. Casing is just spelling:
every casing of a word has the same reading set, so a camelCase brand word
("GitHub" vs "github" vs "GITHUB") can never earn more quanta than any other
spelling of itself.

The weight is plain $1/\mathrm{df}$, with no logarithm. The catalog is too
small for classic idf: with four sources, $\ln(4/2) < 1$, so a rare term would
score below a common one and matches would starve. Weight $1/\mathrm{df}$
keeps "two distinctive words about equal to one source" true at any catalog
size.

Pre-ignition filters:

- **Skill-envelope strip.** Pi expands loaded skills into the prompt as XML
  (`<available_skills>…</available_skills>`, `<skill>…</skill>`). That is
  ambient context rather than user intent, and its vocabulary would poison the
  fingerprint. The matcher removes those regions before tokenization. An
  unclosed trailing tag counts as stripped too.
- **Path-context discount.** A prompt term that occurs only inside a path,
  URL, or filename span (`docs/heat-diffusion.md`, `worker.ts`) denotes a
  local artifact rather than capability intent, so its matched quantum is
  halved (q/2). A lone such word lands below the default threshold entirely,
  and two of them sum to a single weak-band quantum instead of an instant
  strong fire. Filename spans are recognized through a code/doc extension
  allowlist so brand domains in prose (`fal.ai`) keep full weight; a term
  that also appears as free prose elsewhere in the prompt keeps full weight
  too.
- **At least two matched written words.** A lone distinctive word such as
  "project" or "recent" is a vocabulary coincidence, not intent. The gate
  and the scorer share one unit — the written word — so casing can inflate
  neither the count nor the score. One exception: a word whose rarest
  reading is found in exactly one source (df = 1) already weighs a full
  score quantum, the smallest unit of unambiguous evidence the scorer can
  express, so a single source-unique word earns the weak band on its own,
  with sustained warmth doing the transience filtering. A second exception,
  fire-once ignition across a script boundary, is the last entry here.
- **Script-boundary ignition.** When a prompt's non-latin letters
  outnumber its latin written words, the prose itself is not latin — Chinese,
  Japanese, Korean, Cyrillic, Arabic, Hebrew, Thai — and the collision the
  two-term gate prices into single latin words cannot occur there: reaching
  across the script boundary to type a brand name is deliberate. A lone
  source-unique word inside such prose ignites on the first turn instead of
  warming for up to $k_{\text{ignite}}$ turns (4 at the defaults for a
  band-floor signal, $s = 1$ at $\theta = 0.9$). Its score is unchanged, so
  the fire still reads in the weak "might match" register, and ash, smoke,
  and the session cap all apply as usual.
- **Latin-only tokenization.** Matching keeps latin alphanumerics of two or
  more characters; non-latin scripts atomize to nothing, so a non-latin
  prompt matches through the latin brand words it contains — the gap that
  script-boundary ignition closes.
- **Stopword filtering** during tokenization (see `capability-fingerprint.ts`).

## Ignition bands and warmth

### Two primitives generate everything

The dynamics hold several constants: band width, retention, smoke step, streak
cap, session cap. Every one of them projects from two primitives plus the
user-facing $\theta$:

1. **The score quantum $q = 1$.** Under $1/\mathrm{df}$ scoring, a written
   word whose rarest matched reading lives in exactly one source weighs
   $1/1 = 1$. That is the smallest unit of unambiguous evidence the scorer
   can express. The weak band is one quantum wide, $B = q = 1$, so a weak
   match gains instant ignition as soon as one more source-unique word
   appears.
2. **The memory scale $\tau = 2$ turns.** Every temporal behavior below is the
   same exponential integrator with retention $1 - 1/\tau$. The table shows
   how the remaining constants come out:

| Constant | Value | Projection |
|---|---|---|
| warmth retention $\alpha$ | 0.5 | $1 - 1/\tau$ |
| cool half-life | 1 turn | $\ln \tfrac{1}{2}\,/\,\ln(1 - 1/\tau)$ |
| weak band $B$ | 1.0 | $q = 1$ |
| smoke step | $0.25\theta$ | $\theta/\tau^2$ |
| smoke streak cap | 4 | $\tau^2$ |
| max furnace raise | $\theta$ | $(\theta/\tau^2)\cdot\tau^2$, equal to $\theta$ for every $\tau$ |
| default session cap | 3 | $2\tau - 1$ |

Two rows justify the lift. The furnace's total authority comes out at exactly
$\theta$ no matter which value $\tau$ takes, so more patience slows the
response and leaves the ceiling in place. The split between $\tau$ and
$\tau^2$ has a statistical reading. Warmth estimates a mean, and O($\tau$)
turns of signal suffice for that. Smoke estimates a usage bias whose variance
falls like $1/n$; a convergent estimate of bias wants the squared budget
before the thermostat hardens against a namespace.

Let $\theta$ be the configured `threshold` (default 0.9) and $B = q = 1$ the
weak-band width. Each turn, every unburned source with $s \geq \theta$ falls
into one of two bands:

| Band | Condition | Behavior |
|---|---|---|
| Strong | $s \geq \theta + B$ | **Ignites at once.** Multi-term overlap is strong evidence, and any delay would hurt real use. |
| Weak | $\theta \leq s < \theta + B$ | Must accumulate **warmth** until it passes the ignition point $\theta_i$. |

Warmth convolves the per-turn score signal with the unit-mass exponential
kernel $K_\tau(j) = \tfrac{1}{\tau}\bigl(1 - \tfrac{1}{\tau}\bigr)^j$ over
evaluated turns, meaning prompts the advisory processed. That is a first-order
low-pass filter with $\alpha = 1 - 1/\tau = 0.5$ at the default, a half-life
of one turn:

$$
W_k = (1-\alpha)\, s_k + \alpha\, W_{k-1} = (K_\tau * s)_k, \qquad s_k =
\begin{cases} s \geq \theta & \text{weak-band score this turn} \\ 0 & \text{otherwise} \end{cases}
$$

Weak ignition fires when $W_k \geq \theta_i$, with $\theta_i = \theta$ by
default. Sustained exposure pushes W towards s: $W_k \to s\,(1 - \alpha^k)$.
The crossing time for a held weak signal works out to
$k_{\text{ignite}} = \big\lceil \ln(1 - \theta_i/s)\,/\,\ln(1 - 1/\tau) \big\rceil$.
With $\tau = 2$ and $\theta = 0.9$ the formula gives 4 turns for a signal at
the band floor ($s = 1.0$), 2 turns for the upper band ($s \geq 1.25$), and 0
for a strong match. A single vocabulary coincidence spikes once and cools
before it crosses. Dropping the topic mid-decay halves W each turn, and
picking the topic back up continues from the residue.

$\tau$ slides between two behaviors. At $\tau \to 1$ the scheme is memoryless
and warmth just re-reads the last score. A large $\tau$ refuses anything
transient. The kernel's mean spans $\tau$ turns, so $\tau = 2$ reads as: trust
a mean taken over roughly the last two turns.

With the default fixture terms, "query the results table please" scores
$s = 1.333$ (weak band). The EWMA crosses $0.9$ only on the second tidy
prompt, and a cool-off while the user edits code delays the fire the way the
design intends.

## Ash: session-scoped suppression, with the transcript as the ledger

Fired namespaces burn. The burn record lives in the session transcript and in
no other file:

- `fired`: the hint itself is the record. Every advisory goes out as a
  `pi-fabric-capability` custom-message entry whose `details` list the shown
  namespaces.
- `organic`: the model invoked a captured tool from that namespace before any
  hint. The tool call is already a transcript entry, and the capability has
  been introduced. The advisor marks the namespace burned so a later hint
  cannot spend a turn on it (organic-discovery poisoning).

Nothing stores the ash separately. On `session_start` and on each branch
switch (`session_tree`) the advisor replays the current branch's entries
(`ctx.sessionManager.getBranch()`) and rebuilds both kinds of burn. The
provenance (`origin`) reflects which kind of evidence matched. The wall clock
(`at`) comes from the entry's own timestamp:

```json
{ "namespace": "extension:pi-websearch", "origin": "fired", "at": "2026-08-10T16:00:00.000Z" }
{ "namespace": "extension:pi-fovea",    "origin": "organic", "at": "2026-08-10T16:12:11.000Z" }
```

The replay runs up to the branch's current leaf, so the ash set follows the
history exactly. A fork sees the burns that happened before the fork point. A
`/tree` rewind re-exposes capabilities whose only burns sat in the abandoned
part of the tree. A fresh session starts with an empty urn, on the grounds
that the one who learned from the hint arrives with a fresh context anyway.

Inside one session a burn stays burned, without expiry or release. `reset()`
clears the transient state (warmth, smoke streak, per-session cap) and leaves
ash alone.

## Furnace feedback

Combustion quality regulates the furnace. At each `turn_end` the advisor
checks the pending fires: did any matched namespace see a captured-tool call
before the turn closed? A fire that produced no tool call counts as smoke, and
a streak of smoke lifts the weak-band ignition point:

$$
\theta_i = \theta \cdot \bigl(1 + n / \tau^2\bigr), \qquad 0 \leq n \leq \tau^2
$$

The streak $n$ caps at 4, so the ignition point stays at or below $2\theta$.
The first hint the model follows clears the streak, and the furnace responds
fast again. Smoke feedback applies to the weak band alone. Strong matches
ignite at once, since the thermostat's skepticism has no standing when the
evidence is unambiguous.

Smoke stays session-local as well. A new session starts from a fresh
transcript, and with it a fresh furnace reading.

## Per-session cap

At most `maxPerSession` hints fire per session, whatever the model does
(default 3). The cap guards against prompt storms inside one session, and ash
guards against repeat hints.

## Summary

| Knob | Where | Effect |
|---|---|---|
| `capture.advisory.mode` | config | enabled / hidden / disabled |
| `capture.advisory.threshold` | config | base ignition $\theta$ |
| `capture.advisory.maxPerSession` | config | session fire cap |
| `capture.advisory.budget` | config | token ceiling for the advisory text (chars/4, 128–8192, same range as [pi-fovea](https://github.com/monotykamary/pi-fovea)'s `sync.budget`) |

Everything else derives from the primitives $q = 1$ and $\tau = 2$: retention
$\alpha = 1 - 1/\tau$, weak band $B = q$, smoke step $\theta/\tau^2$, streak
cap $\tau^2$, and the default session cap $2\tau - 1$. Getting $\tau$ wrong
costs some responsiveness. The furnace ceiling stays at $\theta$ either way.
