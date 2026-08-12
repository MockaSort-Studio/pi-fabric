# Surprise experiments: causal advisor-signal search

This document records the offline search for a deterministic, LLM-free,
embedding-free gate that invokes an advisor only when its expected token savings
justify the call. The experiment code lives in `scripts/surprise-lab.ts` and
`scripts/optimize-surprise.ts`.

The result is deliberately not described as a near-perfect predictor. Real
human corrections are often semantic or abrupt and cannot be inferred from
host telemetry alone. The useful result is a reproducible economic operating
point, plus evidence about what the observable signals cannot do.

## Causal protocol

The first replay harness treated any user message following an assistant record
as a steer. That leaks ordinary follow-ups into both the feature and label and
inflates precision. The causal parser instead follows pi's agent-run structure:

- an initial or ordinary follow-up starts a run;
- `toolUse` keeps the run open;
- user input while the run is open is a steer;
- `stop`, `error`, `length`, or `aborted` closes the run;
- strong intervention labels are true in-run steers and aborted turns, clustered
  within one turn;
- an alarm matches only when it strictly precedes a label, by 1–20 turns;
- matching is one-to-one, so several alarms cannot claim one intervention and
  one alarm cannot claim several interventions.

Session files modified during the preceding hour are excluded. This prevents an
active JSONL from changing the nominal test set while an experiment is running.
Pass `--as-of-ms` to replay the exact same settled corpus.

Every project is split chronologically: 60% train, 20% validation, and 20% test.
Model families train only on the first split; equations and alarm settings are
selected only on validation. After selection, the chosen recent-epoch
architecture is refit on train plus validation, with every feature, seed, and
alarm setting frozen, before test evaluation.

## Candidate signals

The search compares the production EWMA-z score with:

- weighted count/entropy CUSUM;
- Naive Bayes hazard estimates;
- deterministic threshold-stump and conjunction forests;
- a seeded class-balanced random forest;
- project-local and recent-epoch variants;
- bounded feature hashing over tool names, arguments, results, and assistant
  output. Hashing retains only 128 numeric buckets; it stores no source text and
  computes no embedding.

Causal numeric features include errors, exact retries, file revisits, decayed
momentum, exact-call and tool-name entropy deficits, run length, input gap,
model/tool duration, token pressure, reasoning/output shape, terminal history,
and prior intervention momentum.

For every model, training scores define a distribution-free empirical tail
kernel:

$$
p_t = \frac{1 + \#\{q_j^{\text{train}} \ge q_t\}}{N + 1},
\qquad e_t = -\log p_t
$$

The unified evidence drives a leaky sequential accumulator:

$$
S_t = \max(0, \lambda S_{t-1} + e_t - d),
\qquad \text{fire when } S_t \ge h
$$

The configuration selected before test inspection was:

| Parameter | Value |
|---|---:|
| training history | up to 40 recent prior sessions per project |
| forest | 16 deterministic class-balanced trees, seed 42 |
| maximum depth | 6 |
| $\lambda$ | 0.5 |
| $d$ | 0.7 |
| $h$ | 5 |
| cooldown | 3 turns |
| cap | 5 fires/session |
| causal lead window | 20 turns |

## Acceptance equation

Raw precision alone is not the token objective. If an advisor call costs $C_A$
tokens, precision is $P$, and matched alarms lead by $L$ turns on average, the
smaller model must avoid this many tokens per led turn to break even:

$$
B = \frac{C_A}{P L}
$$

The predeclared economic gate is:

- precision at least 25% (prevents a wide horizon laundering chance matches);
- recall at least 15%;
- at least 30 fires;
- at most 8 fires per 1,000 turns;
- $B \le 1{,}500$ tokens per led turn for a 3,000-token advisor call.

This joint equation matters. Independent precision and lead minima can reject a
policy with lower precision but sufficiently earlier alarms even when that
policy has better token economics.

## Results

The settled 30-project corpus used 1,066 training sessions (75,182 turns), 360
validation sessions (about 26,600 turns), and 369 chronological test sessions
(about 28,900 turns).

The selected recent-epoch forest produced:

| Split | Precision | Recall | Mean lead | Rate / 1k | Matches / fires | Break-even |
|---|---:|---:|---:|---:|---:|---:|
| validation | 38.1% | 20.3% | 7.29 turns | 6.81 | 69 / 181 | 1,080 tokens/led-turn |
| chronological test, refit | 34.0% | 17.3% | 8.21 turns | 5.42 | 53 / 156 | 1,076 tokens/led-turn |

The test session-bootstrap intervals were precision 25.7–41.8%, recall
12.8–22.2%, and 4.10–7.12 fires per 1,000 turns. Point estimates satisfy the
token-economic equation; the recall lower interval does not yet certify the
policy prospectively.

A tuned deterministic random control reached about 22% validation precision and
10% recall at a comparable horizon. The selected gate therefore has meaningful
lift, but not near-perfect human imitation.

## Negative results and ceiling

These failures are part of the result:

- At a six-turn horizon, flexible random forests and Naive Bayes plateau near
  20% precision at 16% recall. More equation capacity does not solve timing.
- True in-run steers alone are largely semantic. Numeric telemetry reached 9.4%
  precision/4.8% recall; hashed lexical telemetry raised recall to 14.3% but
  precision was only 4.8%.
- Same-operation timers were effectively noise. Event-level error clusters
  reached about 48% precision but only 4.6% recall.
- Project-local models increased recall but usually reduced precision.
- High-precision conjunctions (75–100%) fired only 3–4 times and are not
  statistically supportable.
- Rolling-origin folds exposed era instability in those sparse conjunctions;
  they must not be promoted from a single recent 4/4 result.

Therefore no telemetry-only equation in this search predicts arbitrary first
human corrections near perfectly. The deterministic gate is useful as a
selective economic policy, not as a substitute for semantic judgment.

## Running the lab

```sh
pnpm run surprise:optimize
pnpm run surprise:optimize -- --labels steer
pnpm run surprise:optimize -- --final --as-of-ms <fixed-epoch-ms>
pnpm run surprise:simulate
```

`--final` should be used once for a newly frozen corpus. If a held-out result has
already informed another equation or threshold, label later runs
`--post-holdout`; the runner reports them as sensitivity checks rather than
untouched tests.

## Promotion gates

The companion [SWE-chat transfer lab](swe-chat-surprise.md) adds real-user
pushback supervision, process-debt features, authenticated dataset setup, and
domain-transfer results. Its external model remains offline because direct
transfer to local pi validation underperforms local causal fitting.

The learned gate remains offline. Production promotion requires all of:

1. prospective traces from sessions not used anywhere in this search;
2. at least 100 prospective advisor fires;
3. the token break-even target met at the conservative confidence bound, not
   only at the point estimate;
4. per-project rate control, because small projects currently vary widely;
5. enough `advisor-decision` traces to measure selectivity and cost, followed by
   a stronger post-advice stabilization or explicit-acceptance label; delivery
   alone is no longer treated as advice quality;
6. a privacy review for any persisted hashed-feature state.

Until then, the production EWMA/CUSUM detector remains the cheap broad sensor,
and the experiment runner is the falsification and calibration surface.
