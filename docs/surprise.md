# Surprise: the session sensor and its math

This document walks through the surprise detector: per-turn behavioral
features, the self-normalizing baselines, the CUSUM accumulator that turns
evidence into an alarm, and the calibration trace. The implementation lives
in `src/core/surprise.ts`; configuration under `surprise` (see
[configuration.md](configuration.md)).

## Why a sensor, and why this shape

Pi's turn lifecycle is a delivery primitive, not an estimate of need: settle
points arrive on schedule whether or not anything deserves attention, and
nothing fires when a session quietly degrades without an error event. The
surprise sensor closes that gap with the cheapest possible estimator —
counting statistics over events the host already observes, no model calls. A
sensor that costs tokens to run would defeat its purpose; it must stay
deterministic, replayable, and cheap enough to leave on.

It is deliberately only a *sensor*. What a fire means — a notification to
the human today, an event an advisor actor subscribes to later — is decided
by consumers, never by the sensor. It invites nobody, creates no actors, and
assumes none exist.

## Features

Five behavioral features accumulate between turn boundaries ($x_{t,i}$ for
turn $t$):

| Feature | Signal | Weight $w_i$ | Reads as |
|---|:--:|---|---|
| errors | tool executions ending `isError` | $1.0$ | the work is failing |
| retries | identical (tool, args) re-executions | $0.5$ | the loop is repeating itself |
| steers | interactive input arriving mid-stream | $1.25$ | a human watched and corrected |
| revisits | files re-touched after an intervening turn | $0.4$ | oscillation A→B→A |
| gap | $\log_2(1 + \text{turns since last interactive input})$ | $0.2$ | long unsupervised drift |

Human signal dominates on purpose: a mid-stream steer is the single
strongest piece of evidence that an observer would speak up, so it outweighs
every computed signal. Gap is log-compressed so doubling the silence doubles
the signal — long autonomous runs climb slowly instead of racing the cap.
Only interactive input carries the human signal; rpc/extension input and
fabric_exec's inner pi.* calls are invisible by construction (the latter
surface as their own tool events anyway).

## Normalization: each feature against its own history

Raw counts are incomparable across sessions — one session's normal is
another's alarm. Every feature carries a bias-corrected EWMA baseline
($\alpha = 1/\text{window}$, default window 16):

$$
\mu \leftarrow (1-\alpha)\mu + \alpha x, \qquad
\sigma^2 \leftarrow (1-\alpha)\bigl(\sigma^2 + \alpha\,(x - \mu_{\text{prev}})^2\bigr),
\qquad \hat\mu = \frac{\mu}{1-(1-\alpha)^{n}},\ \hat\sigma^2 = \frac{\sigma^2}{1-(1-\alpha)^{n}}
$$

Evidence enters per turn as a one-sided winsorized z against the baseline
*before* the turn joins it:

$$
z_i = \min\!\left(4,\ \max\!\left(0,\ \frac{x_i - \hat\mu_i}{\hat\sigma_i + 0.25}\right)\right)
$$

Three consequences of the shape:

- **Abstention at $n = 0$.** With no history there is no basis for judgment;
  the first turn of a session is silent by construction.
- **The 0.25 spread floor.** Count features live on zero-variance baselines.
  Without the floor a single rare error divides by ~0 and reads infinitely
  strange; with it, that error rings at exactly the z cap, while a feature at
  its own baseline rate scores z ≈ 0 regardless of the spread's shape.
- **Self-normalization means escalation, not steady state.** A constant
  wrongness rate is absorbed into the baseline within ~window turns and stops
  ringing. What keeps ringing is *change*: bursts against quiet, deepening
  retry loops, a steer where silence was the norm. Chronic low-grade failure
  stays invisible to the sensor by design — watching for that is the
  lifecycle floor's job (`tool_error` subscriptions); the sensor hunts drift.

## The accumulator

Per-turn nonconformity is the weighted sum $s_t = \sum_i w_i z_{t,i}$. A
one-sided CUSUM integrates it with a drift allowance:

$$
S_t = \max\bigl(0,\ S_{t-1} + s_t - d\bigr), \qquad \text{fire when } S_t \ge h
$$

with $d$ = `drift` (default 0.3) and $h$ = `threshold` (default 2). The
drift allowance is the quiet-session budget: evidence below $d$ per turn cools
away instead of accumulating, so e.g. one turn's z-cap retry loop
($s = 2.0$) moves S only to $1.7 < h$ and passes.

Firing dynamics reuse the combustion idiom:

- **Absorb on fire.** S resets to zero when the alarm rings.
- **Cooldown.** `cooldown` turns (default 3) hold S at zero — the
  accumulator *cannot* re-fire on embers left from the firing turn, the same
  structural property as fovea's disclosed-cascade ledger.
- **Session cap.** `maxPerSession` fires (default 5), spent permanently. An
  alarm is a finite reservoir, not a meter.

At defaults, a rare single-error turn ($z = 4$, $s = 4$) rings solo at
$S = 3.7 \ge 2$ — matching the lifecycle `tool_error` floor's sensitivity —
while an error rate the session has normalised contributes z ≈ 0 and never
accumulates. Steers ring solo by design; revisits ($w_i z_i \le 1.6$) and
gap ($\le 0.8$) cannot cross h in one step and only add to a case.

## The alarm event

Every fire publishes `fabric.surprise` on the fabric lifecycle bus (in both
live modes), with a scalar projection of the verdict as payload: `turn`,
`score`, `cusum`, `threshold`, `drift`, `firedTotal`, `cooldownLeft`, and a
joined `reasonText`. Publishing is gated on subscriber existence — an
unconsumed alarm is never persisted, so the event is free until someone
listens. Consumers put it in their event diet like any other lifecycle
signal (`agents.create({ events: ["agent_settled", "fabric.surprise"], ... })`,
the `fabric-advisor` skill documents the diet choice), keeping the
sensor/consumer split exact: the sensor assumes nothing about who listens,
and listeners assume nothing about how the evidence was computed.

## Self-tuning

With `learn: true` (default), the operator tunables replace themselves with
Robbins–Monro quantile tracking against one legible objective: `budget`,
target fires per 100 turns (default 1).

Per closed turn:

$$
h \leftarrow \operatorname{clamp}\!\bigl(h + 0.25\,(\mathbb{1}_{\text{fire}} - \tfrac{\text{budget}}{100}),\ [1, 16]\bigr), \qquad
d \leftarrow \operatorname{clamp}\!\bigl(d + 0.05\,(\mathbb{1}_{s_t > d} - 0.3),\ [0.1, 2]\bigr)
$$

h converges so the *empirical* fire rate equals the budget on whatever noise
distribution this project happens to have; d converges so about 30% of turns
score above it — routine churn structurally cannot accumulate.

The budget itself floats on **observed outcomes**. Each fire opens an
outcome window of `cooldown` turns — by the time another fire is
structurally possible, this one's fate is known — resolved as:

- **confirmed** — a `fabric.surprise` subscriber received the alarm within
  the window, or interactive input arrived strictly after it (causal order,
  so pre-fire typing never counts as applause): budget × 1.25.
- **ignored** — an audience existed but neither happened: budget ÷ 1.25.
- Audience-free sessions — no human input all session, no subscriber
  anywhere — **abstain**: nobody judged the alarm, so nothing tunes on it.

Budget is clamped to [0.2, 5] fires per 100 turns. Adapted state persists
per project at `<agentDir>/fabric-surprise/<encoded cwd>/tuning.json`, so a
noisy project learns a thicker skin across sessions while a clean one stays
sensitive. `learn: false` pins `threshold`/`drift` as exact values and
freezes all of this; outcome resolutions join the trace as
`{"kind":"outcome",...}` lines.


`surprise.mode` governs what the sensor does with its verdicts:

- `notify` (default) — post a single notification when the accumulator
  crosses h, bounded by cooldown and the session cap (worst case: a handful
  of one-line toasts); the per-turn trace is written too. Extending an
  invitation (running `/skill:fabric-advisor`, for instance) stays the
  human's call — the sensor never creates actors. The notification doubles
  as discovery: it names both the tuning surface and a consumer.
- `trace` — write one JSONL verdict per closed turn, act on nothing. The
  quiet calibration posture: work normally, then read the log.
- `off` — disabled entirely; the host is byte-identical to pre-sensor
  behavior.

Trace files land under the pi agent dir:

```
<agentDir>/fabric-surprise/<encoded cwd>/<sessionId>.jsonl
```

Each line carries the turn, raw features, per-feature z, $s_t$, $S_t$, the
fire decision, and the top contributors:

```json
{"at":"2026-04-30T12:00:00.000Z","mode":"trace","turn":41,"features":{"errors":2,"retries":1,"steers":0,"revisits":0,"gap":3.0},"z":{"errors":3.1,"retries":1.2,"steers":0,"revisits":0,"gap":0.4},"score":3.86,"cusum":5.1,"threshold":2,"fire":true,"firedTotal":1,"cooldownLeft":3,"reasons":["errors ×2 (z 3.10)","retries (z 1.20)"]}
```

With `learn` on, manual calibration is mostly unnecessary — h and d
track the alert budget by themselves. To reason about what the self-tuner is
doing (or to pin it with `learn: false`), `trace` plus this log is the
calibration kit: h sits mid-cliff between the S values of turns where you
*would* have wanted someone to speak up and the background where you
wouldn't; d sets how transient a disturbance may be before it cools.

## What this deliberately is not (yet)

- **No learned scorers.** Isolation-forest path lengths and kernel-entropy
  drift of embedded session state are alternative sources of $s_t$ behind the
  same accumulator interface; the gate does not care what produced the
  evidence. The counting estimator stays the default — free, deterministic,
  replayable.
- **No advice-quality learning.** The outcome loop measures *delivery-edge*
  engagement: the alarm reached a subscriber, a human reacted. Whether the
  resulting advice was good is a second loop that needs consumers to report
  back (accepted vs. dismissed advice, session recovery after engagement) —
  measurable once advisor actors exist that emit such signals, dishonest to
  approximate earlier.
