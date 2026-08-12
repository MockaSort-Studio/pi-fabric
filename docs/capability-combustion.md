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

That $s(p,j)$ is **raw namespace overlap**. It can prove that scatter exists,
but it never owns phrased ignition. For each tool identity surface $u$ in
source $j$, the scorer computes the same sum against $T(u)$ and admits only a
surface containing a local pair $L(p,u)$:

$$
s_\phi(p,j)=\max_{u \in U(j):L(p,u)} s(p,u), \qquad
\hat{s}(p,j)=
\begin{cases}
s_\phi(p,j) & s_\phi(p,j) \geq \theta \\
\min(s(p,j),q) & \text{otherwise.}
\end{cases}
$$

$\hat{s}$ is the effective score used for ignition, ranking, and advisory
details. This binds a phrase and its mass to one surface: adding unrelated
tools can raise raw $s$ without changing $s_\phi$, and raw scatter remains
bounded by $q$ at every catalog width. The lone-brand and script-boundary
lanes retain their one-word score as explicit exceptions described below.

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
  neither the count nor the score. A word whose rarest reading is found in
  exactly one source (df = 1) still weighs a full score quantum, the
  smallest unit of unambiguous evidence the scorer can express — but one
  quantum from one word is no longer enough anywhere: interrogative filler
  ("what", "project") is source-unique in small catalogs too, and used to
  warm a namespace to ignition inside four question-shaped prompts. Lone
  written words are starved outright: no fire, no warmth. Two narrow
  exceptions: a lone word that names its own source keeps the weak trickle
  (a deliberate brand reach — the word must appear as a ≥3-letter token of
  the label's terminal namespace segment, so "ai"/"pi" stay starved), and
  fire-once ignition across a script boundary, the last entry here.
- **Phrased evidence (locality + surface mass).** A match is *phrased* when
  two of its matched written words stand within a $2\tau$ window of each
  other in the prompt's survivor stream (4 at the defaults) AND co-occur on
  one tool surface — the sequential-dependence clause of Metzler & Croft's
  Markov random field retrieval model. Certification and arithmetic are the
  same operation: each surface is scored independently and the strongest
  threshold-clearing local surface supplies $s_\phi$. A local pair can never
  launder words from the source's other tools into its score. Words matched
  far apart, across different tools, or on surfaces whose own mass stays
  below $\theta$ are *scatter*: vocabulary collision, not phrasing. Scatter
  never ignites instantly and trickles at one quantum per turn,
  $\tilde{s}=\min(s,q)$, whatever raw mass or catalog breadth produced it.
  It needs four sustained turns to cross $\theta_i$, and its asymptote
  $W_\infty=q$ falls under $\theta(1+1/\tau^2)$ after one smoke.
- **Script-boundary ignition.** When a prompt's non-latin letters
  outnumber its latin written words, the prose itself is not latin — Chinese,
  Japanese, Korean, Cyrillic, Arabic, Hebrew, Thai — and the collision the
  two-term gate prices into single latin words cannot occur there: reaching
  across the script boundary to type a brand name is deliberate. A lone
  source-unique word inside such prose ignites on the first turn instead of
  warming for up to $k_{\text{ignite}}$ turns (4 at the defaults for a
  band-floor signal, $s = 1$ at $\theta = 0.9$) — but only after the word
  certifies itself. Crossing the boundary proves deliberateness, not intent:
  a teaching question about the host software ("model とは何ですか") types a
  latin word the same deliberate way a brand does. The certification rule is
  corpus-internal: the word must either *name* its source (a $\geq 3$-letter
  token of the label's terminal namespace segment) or *saturate* it — live
  on at least $1 - 1/\tau$ of the source's tool identity surfaces, at most
  one omission per $\tau$ cycle. Brand words pass by definition ("fovea" in
  every pi-fovea tool, "github" in both pi-integrations tools). Glue
  vocabulary fails: "model" covers 5/11 fal surfaces, under the half the
  rule demands. Saturation is corpus-relative by construction — in a
  namespace whose every tool name contains a word, that word is the
  namespace's topic, and the rule says so. Its score is unchanged, so the
  fire still reads in the weak "might match" register, and ash, smoke, and
  the session cap all apply as usual.
- **Habituation: session-level Zipf damping.** Catalog rarity is static;
  how the user talks is not. A per-session ledger partitions each written
  word's appearances into *episodes*: consecutive-turn repetition is one
  episode, a return after a $\tau^2$-turn pause completes one and starts
  another, and $\tau^3$ turns of absence relapses the word to fresh. Every
  completed episode multiplies rarity by $1/(1+e)$ — effective weight
  $1/[\mathrm{df}(t)(1+e_w)]$ — so words that drift through ambient
  commentary sink below $\theta$ after a few episodes. Episode keys are
  casing-invariant: `Ledger`, `ledger`, and `LEDGER` are one vocabulary item,
  not three ways around the ledger. Sustained presence is mathematically
  exempt (gap $1 < \tau^2$ never damps), because it is the weak band's own
  ignition signature; brand terms never accrue episodes either — typing a
  source's name is a claim, not vocabulary.
- **Echo stripping.** Everything the advisory renders enters an
  emitted-words ledger derived from the current branch's custom messages.
  Words we uttered never re-enter the evidence stream, so the self-echo class
  is zero: quoting, parroting, or pasting the advisory back cannot score, and
  a namespace whose vocabulary leaked into another source through our own
  header line cannot be burned by our noise. Replay makes the rule exact in
  both directions: process reload reconstructs prior echoes, while a branch
  rewind drops words emitted only in the abandoned future.
- **Latin-only tokenization.** Matching keeps latin alphanumerics of two or
  more characters; non-latin scripts atomize to nothing, so a non-latin
  prompt matches through the latin brand words it contains — the gap that
  script-boundary ignition closes.
- **Stopword filtering** during tokenization (see `capability-fingerprint.ts`),
  including the interrogative family (what/how/why/where/which/who). Question
  words frame every request and carry no capability intent of their own — and
  in the worst case they collide with identity prose ("…based on what you want
  to create") to manufacture false evidence out of a user's grammar.

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
   appears and phrases with it (the locality gate above still applies).
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
| phrase window | 4 survivors | $2\tau$ |
| scatter feed | $\min(s, q)$ per turn | trickle cap $q$ |
| topic share | 1/2 of identity surfaces | $1 - 1/\tau$ |
| feedback attribution window | 2 turns | $\tau$ |
| episode gap | 4 turns | $\tau^2$ |
| relapse gap | 8 turns | $\tau^3$ |
| habituation discount | $1/(1+e)$ after $e$ episodes | per-word episodes |

Two rows justify the lift. The furnace's total authority comes out at exactly
$\theta$ no matter which value $\tau$ takes, so more patience slows the
response and leaves the ceiling in place. The split between $\tau$ and
$\tau^2$ has a statistical reading. Warmth estimates a mean, and O($\tau$)
turns of signal suffice for that. Smoke estimates a usage bias whose variance
falls like $1/n$; a convergent estimate of bias wants the squared budget
before the thermostat hardens against a namespace.

Let $\theta$ be the configured `threshold` (default 0.9) and $B=q=1$ the
weak-band width. Each turn, every unburned source with raw $s\geq\theta$ falls
into one of two bands using effective score $\hat{s}$:

| Band | Condition | Behavior |
|---|---|---|
| Strong | $s_\phi \geq \theta+B$ | **Ignites at once.** One tool surface carries the entire strong claim. Scatter elsewhere in the namespace contributes zero strong mass. |
| Weak | $\theta\leq s_\phi<\theta+B$, or raw scatter $s\geq\theta$ | Must accumulate **warmth** until it passes $\theta_i$. A phrased surface feeds $s_\phi$; scatter feeds $\min(s,q)$. Lone words feed nothing (brand reach and the script boundary excepted). |

The headline register reports **how the fire ignited, not how big raw overlap
was**: "matched your prompt" only when one surface clears the strong bar
$s_\phi\geq\theta+B$ this turn; every warmth arrival — trickle, brand reach,
script boundary — reads "might match your prompt". The register carries the
fire's confidence, and `details.matches[].score` carries the effective
$\hat{s}$ rather than breadth-inflated namespace mass.

Warmth convolves the per-turn score signal with the unit-mass exponential
kernel $K_\tau(j) = \tfrac{1}{\tau}\bigl(1 - \tfrac{1}{\tau}\bigr)^j$ over
evaluated turns, meaning prompts the advisory processed. That is a first-order
low-pass filter with $\alpha = 1 - 1/\tau = 0.5$ at the default, a half-life
of one turn:

$$
W_k = (1-\alpha)\, \tilde{s}_k + \alpha\, W_{k-1} = (K_\tau * \tilde{s})_k, \qquad \tilde{s}_k =
\begin{cases} s_\phi & s_\phi \geq \theta \text{ (one local surface)} \\ \min(s, q) & s \geq \theta \text{ (scatter)} \\ 0 & \text{otherwise.} \end{cases}
$$

Phrased evidence feeds one surface's score; scatter trickles at one quantum per turn.
The trickle's asymptote is $W_\infty = q = 1$: it crosses $\theta = 0.9$
after four sustained turns, and once smoke lifts the ignition point to
$\theta(1 + 1/\tau^2) = 1.125$ it can never cross again.

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

## Transcript-derived ledger: ash, echoes, and cap

Fired namespaces burn. Durable advisory state lives in the session transcript,
never in a side file:

- `fired`: the hint itself is the record. Every advisory goes out as a
  `pi-fabric-capability` custom-message entry. Its `details` list the burned
  namespaces, its `content` reconstructs emitted-word echo suppression, and
  the entry itself spends exactly one unit of session fire budget.
- `organic`: the model invoked a captured tool from that namespace before any
  hint. The tool call is already a transcript entry, and the capability has
  been introduced. The advisor marks the namespace burned so a later hint
  cannot spend a turn on it (organic-discovery poisoning).

On `session_start` and every branch switch (`session_tree`), the advisor replays
`ctx.sessionManager.getBranch()` and **replaces** ash, echoes, and fire count
with the state at that exact leaf. Process reload cannot reopen self-echo or
replenish the cap; branch rewind cannot retain suppression or budget spent only
in abandoned history. Burn provenance (`origin`) and wall clock (`at`) come
from the entries themselves:

```json
{ "namespace": "extension:pi-websearch", "origin": "fired", "at": "2026-08-10T16:00:00.000Z" }
{ "namespace": "extension:pi-fovea",    "origin": "organic", "at": "2026-08-10T16:12:11.000Z" }
```

A fork sees all ledger state before its fork point. A `/tree` rewind re-exposes
capabilities, budget, and vocabulary whose records lived only in the abandoned
future. A fresh session replays an empty branch. Inside one history a burn
stays burned without expiry; transient warmth, smoke, pending attribution, and
habituation reset at the session/tree boundary before durable replay.

## Furnace feedback

Combustion quality regulates the furnace. One advisory event can name two
namespaces, and using either means the event helped. The event remains pending
for $\tau$ `turn_end` checkpoints: its firing turn **and the following turn**
at the default $\tau=2$. A captured-tool call in either interval marks clean
combustion. Only when the second checkpoint closes unused does the event emit
one smoke quantum:

$$
\theta_i = \theta \cdot \bigl(1 + n / \tau^2\bigr), \qquad 0 \leq n \leq \tau^2
$$

Pending events overlap independently and resolve in event order. A clean event
clears the streak; an expired unused event increments it. The streak $n$ caps
at 4, so the ignition point stays at or below $2\theta$. A call after the
$\tau$-turn causal horizon still burns organic ash but cannot rewrite an
already resolved observation. Smoke feedback applies to the weak band alone;
strong one-surface evidence still ignites immediately.

Smoke stays transient and session-local. Unlike ash, echoes, and fire count,
it is not replayed from the transcript.

## Per-session cap

At most `maxPerSession` hints fire on the current session branch, whatever the
model does (default 3). Each replayed advisory custom message spends one unit,
so process reload cannot replenish the budget; rewinding before a hint restores
exactly that abandoned unit. Ash separately guards against repeat namespaces.

## Coverage matrix and compromises

Measured against a live-shaped catalog (fal-ai's 11 tools, a mixed
install of extension sources), θ at its default. "t*n*" is the ignition
turn for one repeated prompt; "weak"/"STRONG" is the rendered register.

| # | Evidence class | First turn | Sustained | After smokes | After ash | Lever |
|---|---|---|---|---|---|---|
| A | Phrased strong, one surface | **fires** (STRONG) | — | fires | ash | strong band |
| B | Phrased weak, shared vocab | silent | fires t2 (weak) | t4 | ash | warmth |
| C | Scatter, any raw mass | silent | fires t4 (weak) | **never** (W∞ = q < θᵢ) | ash | trickle cap, smoke |
| D | Lone generic word | silent | never | never | — | starvation |
| E | Lone brand (names its source) | silent | fires t4 (weak) | never | ash | brand trickle |
| F | Lone 2-letter token ("ai") | silent | never | never | — | ≥3-letter guard |
| G | Script boundary, brand | fires (weak) | — | fires | ash | name certification |
| H | Script boundary, glue noun ("model とは…") | silent | never | — | — | topic share $1 - 1/\tau$ |
| I | Script boundary, saturating topic | fires (weak) | — | fires | ash | topic share |
| J | Verbatim paraphrase of identity prose | **fires (STRONG)** | — | fires | ash | none — residual |
| K | Cross-tool adjacent, one namespace | silent | fires t4 (weak) | never | ash | co-surface clause |
| L | No overlap / units / code spans | never | never | never | never | tokenizer |
| M | Path-only URL evidence, repeated | silent | fires t2 (weak) | never | ash | q/2 path discount |
| N | Interleaved topic drift | silent | never | never | — | α decay |
| O | Quoted advisory / self-echo (our own words) | **never** | never, including reload | — | branch-exact | replayed echo ledger |
| P | Ambient word recurring across long pauses / casing shifts | silent, decaying | **never past a few episodes** | never | — | casing-invariant habituation $1/(1+e)$ |
| Q | One weak local pair + 32 cross-tool hits | silent | fires t4 (weak), same as 0 hits | **never** | ash | surface score $s_\phi$ |
| R | Hint followed on the next turn | pending | clean combustion | clears streak | fired ash | $\tau$-turn attribution |
| S | Process reload / branch rewind | exact replay | exact replay | transient reset | exact replay | transcript ledger |

What we could not close without learning (and chose not to fake):

- **Row J, unmarked verbatim paraphrase.** A prompt echoing a tool's identity
  sentence ("based on what you recommend, create my playlist") is phrased,
  strong, single-surface evidence. Every deterministic gate agrees with it —
  the evidence is real; only intent is absent. Ash caps the cost at one slot
  per session and smoke hardens later weak paths. Closing it would require a
  semantic paraphrase/source-attribution probability unavailable from the
  prompt × catalog × session state alone.

Deterministic fronts closed:

- **Catalog breadth (row Q).** Phrase certification now owns its arithmetic:
  the maximum score of one local tool surface. In the adversarial fixture, a
  weak surface plus 1, 8, or 32 source-unique terms scattered across other
  tools has the same effective score (1.0) and same t4 weak ignition. Raw
  namespace overlap can grow without changing either path or rank.
- **Delayed-follow attribution (row R).** A fire remains attributable through
  the following turn ($\tau$ checkpoints), removing the measured false smoke
  penalty (the companion weak signal stays t2, equal to a clean control).
  Credit after that finite causal horizon would itself be an attribution guess.
- **Transcript continuity (rows O/S).** Echoes and fire count now replay with
  ash. Reload preserves suppression and budget; rewind removes abandoned
  emissions and restores abandoned budget.
- **Case-shift habituation (row P).** Episode identity is lowercase-normalized,
  so alternating casing cannot reset ambient-vocabulary damping.

## Summary

| Knob | Where | Effect |
|---|---|---|
| `capture.advisory.mode` | config | enabled / hidden / disabled |
| `capture.advisory.threshold` | config | base ignition $\theta$ |
| `capture.advisory.maxPerSession` | config | session fire cap |
| `capture.advisory.budget` | config | token ceiling for the advisory text (chars/4, 128–8192, same range as [pi-fovea](https://github.com/monotykamary/pi-fovea)'s `sync.budget`) |

Everything else derives from $q=1$ and $\tau=2$: retention
$\alpha=1-1/\tau$, weak band $B=q$, phrase window $2\tau$, feedback horizon
$\tau$, smoke step $\theta/\tau^2$, streak cap $\tau^2$, episode gap $\tau^2$,
relapse gap $\tau^3$, and default session cap $2\tau-1$. Changing $\tau$
trades responsiveness for patience; the maximum furnace **raise** remains
exactly $\theta$ (so $\theta_i\leq2\theta$) for every value.
