# Capability combustion: the math behind fabric advisory hints

The advisor has a limited hint budget. By default, one session branch permits
three hints. Each hint burns its matched namespace for the rest of
that branch.

A capability acts like a battery cell. One hint spends its charge. A false fire
removes useful information from later turns. The advisor fires when the prompt
contains enough evidence for likely tool use.

The code is in `src/core/capability-advisory.ts`.

## How the advisor scores a prompt

The index groups tools by source namespace. It reads each tool name and the
first sentence of its description. Later instruction sentences often contain
common request words. The index skips those sentences.

For example, a description tail can contain words such as "understand" and
"how." Those words once linked a question about `docs/heat-diffusion.md` to
fal.ai. The first sentence gives a narrower identity for each tool.

The advisor gives each unburned source a raw score:

$$
s(p, j) = \sum_{w \in W(p)} \max_{t \in R(w) \cap T(j)} \frac{1}{\mathrm{df}(t)}, \qquad \mathrm{df}(t) = \Bigl|\{ j : t \in T(j) \}\Bigr|
$$

$W(p)$ contains the unique written words in prompt $p$. CamelCase atoms and the
full spelling of word $w$ form $R(w)$. The set $T(j)$ holds the indexed terms
for source $j$.

One written word supplies one evidence unit. The scorer selects its rarest
valid reading. Casing changes the spelling form. It keeps the same readings and
weight. All letter-case forms have equal scores.

The term weight is $1/\mathrm{df}$. A logarithmic idf can fall below one in a
small catalog. That scale can starve a valid pair. The selected scale gives a
source-unique term one full quantum.

The raw source score $s(p,j)$ opens the scatter lane. One tool surface sets the
score for a phrase. The advisor calculates this value:

$$
s_\phi(p,j)=\max_{u \in U(j):L(p,u)} s(p,u), \qquad
\hat{s}(p,j)=
\begin{cases}
s_\phi(p,j) & s_\phi(p,j) \geq \theta \\
\min(s(p,j),q) & \text{otherwise.}
\end{cases}
$$

$U(j)$ is the set of tool surfaces in source $j$. A local word pair on surface
$u$ makes $L(p,u)$ true for prompt $p$. The effective score $\hat{s}$ controls
the fire path. It also controls source rank and the score in advisory details.

One surface owns all phrase mass. Extra tools can increase the raw source
score. The scatter cap limits their effective score to $q$.

## Rules before a fire

### Remove skill envelopes

Pi can add loaded skills to the prompt in XML regions. The matcher removes
`<available_skills>` and `<skill>` regions before it makes tokens. It also
removes an open region that reaches the end of the prompt.

### Reduce path terms

A word that occurs only in a file path or URL gets half a quantum. This rule
covers text such as `docs/heat-diffusion.md` and `worker.ts`. One word falls
below the default threshold. A pair supplies one weak quantum.

The filename matcher uses an extension list. A brand domain such as `fal.ai` keeps its full prose weight. Full weight also
applies when the term occurs in free prose.

### Require two written words

A Latin prompt needs two matched written words. One generic word supplies zero
heat. This rule blocks source-unique filler such as "project" in a small
catalog.

A source name has a narrow exception. Label tokens with at least three letters
can enter the weak lane by themselves. Tokens such as `ai` and `pi` stay silent.
The script rule below supplies the other exception.

### Bind a phrase to one tool

Two matched words form a phrase when both conditions apply:

1. Their positions differ by at most $2\tau$ prompt survivors.
2. One tool surface contains both terms.

The default window contains four survivors. Each tool surface gets a separate
score. Its strongest local surface supplies $s_\phi$ after it
clears $\theta$.

Terms on separate tools form scatter. Distant terms also use this lane. Scatter
feeds at $\min(s,q)$ per turn. The cap stays at $q$ for every raw mass and source tool count.

### Check a script boundary

A prompt is mostly non-Latin when its non-Latin letter count exceeds its Latin
word count. This check covers Chinese, Japanese, Korean, Cyrillic, Arabic,
Hebrew, and Thai text.

One source-unique Latin word can fire on the first turn after it passes one of
these checks:

1. The word names the source with a label token of at least three letters.
2. At least $1-1/\tau$ of the source tool surfaces contain the word.

The second check measures the source topic. For fal.ai, `model` appears on 5 of
11 surfaces. Its share stays below one half, so `model とは何ですか` stays
silent. A word that covers at least one half of the tools passes at the default
$\tau=2$.

This route uses the weak headline text. The full furnace rules still apply.

### Reduce familiar session words

The advisor stores a lowercase key for each written word. Continuous use on
adjacent turns stays in one episode. A return after $\tau^2$ turns starts a new
episode. An absence of $\tau^3$ turns resets the episode count.

Each completed episode multiplies the term weight by $1/(1+e)$:

$$
w(t)=\frac{1}{\mathrm{df}(t)(1+e_w)}
$$

This rule reduces ambient words that return after long gaps. A continuous weak
signal keeps its full weight. Source brand words also keep full weight. All
casing forms share one episode key.

### Remove advisor echoes

The advisor stores every word that it emits. Those words leave the evidence
stream for later prompts. A quote or paste of the advisory then supplies zero
heat to another namespace.

Custom messages hold the emitted text. A process reload rebuilds the word set from the current branch. Words that
occur only in the abandoned future leave the set after a tree rewind.

### Make tokens

The tokenizer accepts Latin letters and digits. A token starts with a letter
and has at least two characters. Other scripts supply context for the script
boundary check.

The stopword set removes common English filler. It includes the question words
`what`, `how`, `why`, `where`, `which`, and `who`. These words frame requests. The filter removes their capability weight.

## How heat builds

Two values define the model:

| Value | Default | Meaning |
|---|---:|---|
| score quantum $q$ | 1 | weight of a source-unique term |
| memory scale $\tau$ | 2 turns | time scale for heat and feedback |

The configured threshold is $\theta$. Its default is 0.9. The other constants
come from $q$ and $\tau$.

| Constant | Value | Formula |
|---|---:|---|
| heat retention $\alpha$ | 0.5 | $1-1/\tau$ |
| cool half-life | 1 turn | $\ln(1/2)/\ln(1-1/\tau)$ |
| weak band width $B$ | 1 | $q$ |
| smoke step | $0.25\theta$ | $\theta/\tau^2$ |
| smoke streak limit | 4 | $\tau^2$ |
| largest furnace raise | $\theta$ | $(\theta/\tau^2)\tau^2$ |
| default branch cap | 3 | $2\tau-1$ |
| phrase window | 4 survivors | $2\tau$ |
| scatter feed limit | 1 | $q$ |
| topic share | 1/2 | $1-1/\tau$ |
| feedback window | 2 turns | $\tau$ |
| episode gap | 4 turns | $\tau^2$ |
| episode reset gap | 8 turns | $\tau^3$ |
| familiar-word factor | $1/(1+e)$ | episode count $e$ |

Heat estimates the recent mean score. Smoke tracks whether hints lead to tool
use. The smoke streak uses a $\tau^2$ range because its observed variance falls
with the event count.

An unburned source enters one of these bands:

| Band | Condition | Action |
|---|---|---|
| strong | $s_\phi\geq\theta+B$ | fire on this turn |
| weak | $\theta\leq s_\phi<\theta+B$ | add surface heat |
| scatter | raw $s\geq\theta$ | add at most $q$ heat |

The headline tells the model how the source fired. A strong surface writes
"matched your prompt." A heat crossing writes "might match your prompt."
The `details.matches[].score` field contains $\hat{s}$.

Heat uses this exponential filter:

$$
W_k=(1-\alpha)\tilde{s}_k+\alpha W_{k-1}=(K_\tau*\tilde{s})_k
$$

$$
\tilde{s}_k=
\begin{cases}
s_\phi & s_\phi\geq\theta \text{ on one local surface} \\
\min(s,q) & s\geq\theta \text{ in the scatter lane} \\
0 & \text{otherwise.}
\end{cases}
$$

At $\tau=2$, each processed prompt retains half of the prior heat. A weak score of 1 reaches 0.9375 on its fourth continuous turn. With a score of
1.5, the heat crosses the default threshold on turn 2.

Scatter approaches $W_\infty=q=1$. One smoke event raises its fire point to
1.125. Scatter then stays below that point.

A held weak signal with score $s$ uses this crossing time:

$$
k_{\text{fire}}=\left\lceil\frac{\ln(1-\theta_i/s)}{\ln(1-1/\tau)}\right\rceil
$$

An unrelated prompt halves stored heat at the default setting. A later related
prompt continues from the remaining value. For example, `query results` has a
fixture score of 1.5. It fires on its second continuous prompt. One unrelated
turn moves that fire to the third processed turn.

## How the transcript stores state

The transcript stores durable advisor state on the current branch.

A `pi-fabric-capability` custom message stores the fired namespaces in
`details`. Its `content` stores the words for echo removal. Each custom message
also spends one unit of branch hint budget.

A captured tool call stores organic discovery. The advisor burns that namespace
because the model has found the capability.

At `session_start` and `session_tree`, the advisor replays
`ctx.sessionManager.getBranch()`. The replay replaces ash, emitted words, and
the spent hint count with values from that branch leaf.

```json
{ "namespace": "extension:pi-websearch", "origin": "fired", "at": "2026-08-10T16:00:00.000Z" }
{ "namespace": "extension:pi-fovea", "origin": "organic", "at": "2026-08-10T16:12:11.000Z" }
```

A fork receives the records before its fork point. Tree rewind restores budget
from abandoned hints. It also removes their ash and emitted words. A fresh
session starts with an empty branch.

Heat, smoke, pending feedback, and familiar-word episodes are transient. The
runtime clears them at a session or tree boundary before it replays the durable
state.

## How smoke changes the fire point

One advisory event can name up to two namespaces. A tool call from either
namespace marks the event as used.

The event stays open for $\tau$ `turn_end` points. At the default value, this
window includes its fire turn and the following turn. An unused event adds one
smoke unit after the second point closes.

The smoke streak raises the weak fire point:

$$
\theta_i=\theta\left(1+\frac{n}{\tau^2}\right), \qquad 0\leq n\leq\tau^2
$$

A used event clears the streak. An expired event increases it by one. Events
resolve in their fire order when their windows overlap. The streak limit keeps
$\theta_i$ at or below $2\theta$.

A tool call after the $\tau$ window burns organic ash. The completed smoke event
keeps its prior result. Strong surface evidence can fire at every smoke level.

Smoke stays in runtime memory for the active branch view. Transcript replay
starts it at zero.

## How the branch cap works

`maxPerSession` sets the hint limit for the current branch. The default value is
3. Replay counts each advisory custom message as one spent unit. A process
reload keeps the spent count. Rewind before a hint returns that unit.

Ash blocks a burned namespace. The branch cap limits the total hint count.

## Measured behavior matrix

These tests use a live-shaped catalog. It contains 11 fal.ai tools and several
extension sources. The threshold uses its default value.

`tN` gives the fire turn for one repeated prompt. The words `weak` and `strong`
give the headline register.

| ID | Evidence | First prompt | Repeated prompt | With smoke | After burn | Rule |
|---|---|---|---|---|---|---|
| A | strong phrase on one surface | fires, strong | n/a | fires | blocked | strong band |
| B | weak phrase with shared words | silent | t2, weak | t4 | blocked | heat |
| C | scatter with any raw mass | silent | t4, weak | blocked | blocked | scatter cap |
| D | one generic word | silent | blocked | blocked | n/a | two-word gate |
| E | one source brand | silent | t4, weak | blocked | blocked | brand lane |
| F | one two-letter label token | silent | blocked | blocked | n/a | length gate |
| G | script boundary with brand | fires, weak | n/a | fires | blocked | brand check |
| H | script boundary with `model` | silent | blocked | n/a | n/a | topic share |
| I | script boundary with source topic | fires, weak | n/a | fires | blocked | topic share |
| J | unmarked identity paraphrase | fires, strong | n/a | fires | blocked | open semantic case |
| K | adjacent words on separate tools | silent | t4, weak | blocked | blocked | surface rule |
| L | zero useful overlap | silent | blocked | blocked | blocked | tokenizer |
| M | repeated path-only URL words | silent | t2, weak | blocked | blocked | path factor |
| N | interleaved topic drift | silent | stays silent | blocked | n/a | heat decay |
| O | quote of advisor text | blocked | blocked after reload | n/a | branch exact | echo set |
| P | familiar word with case changes | decays | blocked after episodes | blocked | n/a | episode factor |
| Q | weak local pair plus 32 tool hits | silent | t4, score 1 | blocked | blocked | surface score |
| R | hint used on the next turn | pending | clean event | clears streak | fired ash | feedback window |
| S | process reload or tree rewind | exact replay | exact replay | transient reset | exact replay | transcript |

## Open semantic case

Row J contains an unmarked paraphrase of one tool identity sentence. The prompt
forms a strong local surface. Every value that the advisor can observe supports
the capability match. User intent remains outside the prompt, catalog, and
session state.

For example, `based on what you recommend, create my playlist` can match the
same identity words as a direct tool request. The sentence source is unknown.
Ash limits this fire to one slot on the branch. Later weak paths use the smoke
result.

A semantic model could estimate the source and intent of that sentence. The
current model uses deterministic catalog and session data.

A tool call after the $\tau$ feedback window has a related cause question. The
advisor records the call as organic use. It keeps the completed smoke result.

## Configuration

| Setting | Purpose |
|---|---|
| `capture.advisory.mode` | set hint visibility |
| `capture.advisory.threshold` | set base fire point $\theta$ |
| `capture.advisory.maxPerSession` | set branch hint limit |
| `capture.advisory.budget` | set advisory text limit in tokens |
