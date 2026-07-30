# bench — DeepSWE-style verification loop

Local, paired before/after benchmark for measuring Fabric's token-efficiency
regressions against plain Pi, built to mirror the methodology and metrics of
github.com/Whamp/pi-fabric-deepswe-trajectories (issue: "DeepSWE Performance
Trajectories with GPT-5.6-sol:low").

## What it measures

Per (task, config, rep) cell:

- `reward_binary`, `reward_partial` — from the task's `verify.sh`, whose
  checks are derived mechanically from the task's stated acceptance criteria
- `combined_total_tokens`, input/cached/output breakdown, `combined_cost_usd`
  (GPT-5.6 Sol rates: $5/M fresh input, $0.50/M cached input, $30/M output)
- `agent_wall_s`, `turns`, `tool_calls`, `patch_bytes`
- Read-pathology statistics: total reads, whole-file (unbounded) read share,
  tool results over 50 KB. Fabric cells parse `details.trace.operations`, the
  same extraction that reproduces the trajectories repo's published numbers
  (1505 reads / 78.5% whole-file / 79 results over 50 KB).

## Layout

    tasks/<slug>/task.json   repo URL, base ref (extracted from archived sessions), timeouts
    tasks/<slug>/prompt.txt  verbatim DeepSWE user prompt from the archived cell
    tasks/<slug>/verify.sh   acceptance probes -> reward_binary/reward_partial
    run-cell.sh              one cell: checkout at base ref -> agent -> verifier
    run-matrix.sh            isolated agent dir, vendoring, task x config x rep loop, analysis
    analyze.py               paired summary (solves, McNemar, token deltas, read pathology)

Configs:

- `baseline` — clean stock pi: `--no-skills --no-extensions`, isolated
  `PI_CODING_AGENT_DIR` with only the `openai-codex` OAuth entry
- `fabric-local` — this repo (`-e <repo root>`), what ships right now
- `fabric-<version>` — vendored published package (e.g. `pi-fabric@0.25.6`,
  the version benchmarked in the trajectories repo)

## Run

    ./run-matrix.sh --tasks scc-bounded-memory-spilling \
      --configs baseline,fabric-0.25.6,fabric-local --reps 3 \
      --vendor pi-fabric@0.25.6 --run-id myrun

Results land in `results/<run-id>/<config>/<task>/rep<N>/` in the same layout
as the trajectories repo; `analysis-summary.json` is written next to them.

Notes:

- Model is pinned to `openai-codex/gpt-5.6-sol` at thinking `low`, matching
  the trajectories benchmark.
- Run cells serially: the codex OAuth token is shared and refresh writes race.
- `results/`, `.cache/`, `.runtime/` (if any) and `vendor/` are git-ignored.
