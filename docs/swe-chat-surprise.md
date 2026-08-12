# SWE-chat surprise transfer lab

This offline lab tests whether real human-agent traces can improve the advisor
invitation signal without adding an LLM, embedding service, network request, or
Hugging Face dependency to production.

Nothing in this experiment changes `src/core/surprise.ts`. Dataset files and
compiled scripts stay under ignored `node_modules/.cache` paths.

## Dataset setup

Request and accept access to
[`SALT-NLP/SWE-chat`](https://huggingface.co/datasets/SALT-NLP/SWE-chat) in the
same browser profile used by `browser-harness-js`, then run:

```sh
pnpm run surprise:swe-chat:download
```

The downloader resolves the gated browser session to short-lived signed URLs.
It never prints cookies, credentials, or signed URLs. It pins dataset revision
`f66cca95b14caaa4177f7ed5eaa424608dadcffa`, checks exact byte sizes, and caches
only:

- `conversations.parquet` (1,311,422,253 bytes)
- `sessions.parquet` (1,997,377 bytes)

Raw transcripts, commit patches, and repository snapshots are unnecessary for
this experiment. SWE-chat is licensed ODC-BY 1.0; the data itself is not
redistributed by pi-fabric.

The experiment requires `duckdb` on `PATH`. DuckDB performs column projection
and streams selected rows; Node does not load the 1.3 GB table into memory.

## Causal conversion

`scripts/swe-chat-lab.ts` converts the flattened table into the same
source-neutral `LabSession` shape used by local pi JSONLs.

Each completed tool-result batch is a decision row. A following assistant
response augments that row rather than creating a second synthetic decision.
Ordinary user prompts establish run boundaries. Labels are placed at the
boundary after all preceding decisions, so neither intervention text nor
post-intervention behavior can enter a firing feature.

Label provenance remains explicit:

| Signal | Provenance | Confidence |
|---|---|---:|
| queued human input while the agent is busy | observed | 1.0 |
| correction/rejection/failure-report prompt | weak LLM annotation | 0.79 |
| tool-result failure parsing | heuristic feature only | not a target |

The 0.79 value is the paper's reported binary pushback accuracy for the released
annotator. It is metadata, not a claim that the four-way class is 79% accurate.
Subagent/task notifications are excluded from queued-human labels, and repeated
queue snapshots are deduplicated per session and content.

## Added process signals

The common lab feature vector now includes structured signals that transfer
between pi and SWE-chat:

- research, action, and verification bursts;
- action before recent research;
- decisions since verification;
- continued action after a failed verification;
- decayed action-versus-research imbalance.

These are derived only from preceding tool names and arguments. They are cheap,
deterministic, and contain no embeddings.

## Running the experiment

```sh
# Past 60% -> next 20%; final 20% remains sealed
pnpm run surprise:swe-chat -- --repositories 200 --sessions 4000 --labels soft

# Detailed validation-only Pareto frontier
pnpm run surprise:swe-chat -- \
  --repositories 200 --sessions 4000 --labels soft --report-frontier

# Directly observed busy-run input only
pnpm run surprise:swe-chat -- \
  --repositories 200 --sessions 4000 --labels observed

# Expensive rejection/failure-report risk only
pnpm run surprise:swe-chat -- \
  --repositories 200 --sessions 4000 --labels critical

# External model, locally calibrated, evaluated on frozen local validation
pnpm run surprise:swe-chat -- \
  --repositories 200 --sessions 4000 --labels soft \
  --local-transfer --local-as-of-ms 1786464000000
```

The default chronological cutoffs are frozen at this dataset revision:

- train before `2026-03-07T10:49:43.704Z`;
- validation before `2026-03-22T17:19:05.523Z`;
- test at or after the validation cutoff.

`--repository-split` is available as a domain-shift diagnostic. `--final` opens
the external test and must not be used until a validation policy is accepted.
The local transfer experiment never opens the local chronological test.

## Current evidence

On 2,675 historical training sessions (144,457 decision rows) and 1,150 later
validation sessions (61,291 rows), weak soft-pushback training produced this
validated frontier:

| Policy | Precision | Recall | Mean lead | Calls/1k | Break-even |
|---|---:|---:|---:|---:|---:|
| fixed 8-call budget | 71.9% | 11.5% | 3.00 | 7.95 | 1,393 |
| recall-qualified, over budget | 68.3% | 15.7% | 3.11 | 11.44 | 1,410 |
| early-risk head | 44.1% | 5.9% | 6.22 | 6.62 | 1,093 |

The optimizer keeps the fixed-budget row when no candidate satisfies every hard
gate; it never selects the over-budget recall row.

The original raw-recall gate was internally inconsistent with the token budget.
Validation has 3,051 clustered weak labels in 61,291 decision rows. With one
alarm matched to at most one label, an 8/1,000 budget permits about 490 matches:
a 16.1% absolute recall ceiling even at 100% precision. Reaching 15% raw recall
would require 93.3% precision and consume 93% of the theoretical alarm capacity.

The corrected pre-test gate therefore uses budget-normalized recall,
`raw recall / recall ceiling`: precision at least 65%, at least 70% of attainable
recall, no more than 8 calls/1,000 turns, at most 1,500 tokens per led turn, and
at least 30 fires. The fixed-budget policy captures 71.4% of attainable recall
at 71.9% precision and passes this token-capped coverage gate.

Validation-only ablations tested proximal 1–3/1–4/1–6-turn hazard heads,
rank-calibrated structured/lexical ensembles, cooldowns of 0–20 turns, per-session
caps of 3 and 6, train-only repository and agent base-rate priors, and a
four-times-larger lexical sketch. None materially moved the rate-qualified
frontier; the best reached 11.7% recall at 72.4% precision and about 8 calls/1,000.
The later chronological half was harder (roughly 10–11% recall), so the small
aggregate gain is not a promotion candidate. Lowering a threshold cannot close
this gap without violating the call budget.

Direct transfer to frozen local pi validation is negative: 20.3% precision,
10.8% recall, 5.73-turn lead, 6.84 calls/1,000, and 2,575 tokens per led turn.
The local-only recent forest remains better on the same corpus after adding the
new structured features: 35.3% precision, 21.3% recall, 7.75-turn lead, 7.78
calls/1,000, and 1,097-token break-even.

Therefore SWE-chat must not replace the local model. Its demonstrated value is:

1. discovering transferable structured features;
2. supplying a broad weak prior for future local adaptation experiments;
3. defining a realistic semantic-friction evaluation surface.

After freezing the corrected validation gate and fixed-budget d6 policy, the
chronological external test was opened once. It contained 1,092 sessions,
101,300 decision rows, and 4,509 weak labels. The frozen policy produced 68.7%
precision, 10.0% raw recall, 2.80-turn mean lead, and 6.47 calls/1,000 turns
(450 matches / 655 fires). Its budget-normalized recall was 55.5%, below the
70% target, and the 3,000-token advisor break-even was 1,560 tokens per led
turn, above the predeclared 1,500 limit. The session-bootstrap intervals were
64.9–72.2% precision, 9.0–11.1% raw recall, and 5.88–7.10 calls/1,000.

That is a real sealed-test miss, so no external policy is promoted and the test
will not be used for further tuning. The local chronological test remains
sealed. Production promotion still requires prospective advisor outcome traces,
because archived human interventions do not establish that an advisor call
would have helped. The offline objective must ultimately move from recall over
every weak correction to expected advisor utility; repeated weak corrections
are not equivalent to independent advisor opportunities.

The runtime now records an `advisor-decision` row when an actor named `advisor`
handles a `fabric.surprise` event. It correlates the lifecycle event and fire
turn with the directive action (`silent`, `message`, or `stop`) and token usage,
but deliberately stores no advice text. This measures advisor selectivity and
cost. The online budget tuner treats `silent` as negative selectivity evidence
and `message`/`stop` as positive selectivity evidence, instead of treating mere
event delivery as success. It is still not a usefulness label: acceptance and
post-advice stabilization require prospective evidence.

A validation-only local adaptation experiment also fit a recent-project local
forest and blended it with the external SWE-chat model. Local-only reached
35.3% precision / 21.3% recall at 7.78 calls/1k turns. External weights of
0.15, 0.30, and 0.50 either reduced precision or exceeded the 8/1k rate cap.
Therefore SWE-chat remains an offline structural prior only; the promoted
runtime model is not seeded with external weights.
