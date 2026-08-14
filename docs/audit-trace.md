# Fabric execution trace V1

The final `fabric_exec` result details form a bounded durable envelope that holds only `success` and `trace`. Rich `audits`, logs, values, type errors, elapsed time, media, and raw runtime or provider errors stay in memory. Fabric never copies them into final session JSONL details. Live partial updates can still carry richer audits for the active UI.

The serialized final details object never exceeds 512 KiB. Consumers use current traces structurally. The chat renderer allows one compatibility exception. It can match a pre-change bash digest against string literals or named strings already visible in the outer `fabric_exec` arguments, so old previews can show the original command.

## Envelope

```ts
interface FabricPersistedExecutionDetailsV1 {
  success: boolean;
  trace: FabricExecutionTraceV1;
}

interface FabricExecutionTraceV1 {
  kind: "pi-fabric.execution";
  version: 1;
  outcome: "succeeded" | "failed" | "aborted" | "timed_out";
  phases: string[];
  operations: FabricExecutionTraceOperationV1[];
  counts: {
    droppedValues: number;
    truncatedValues: number;
    redactedValues: number;
    droppedOperations: number;
  };
  error?: string;
}
```

A trace excludes run and call timestamps, elapsed durations, random call IDs, source code, media payloads, and arbitrary argument or result content. Runtime and call errors become fixed stage and outcome messages. Provider, validator, approval, or guest exception prose never enters the trace.

`phases` records occurrences in order. Repeated transitions stay in place, so `A → B → A` appears as `["A", "B", "A"]`.

## Call operation

```ts
interface FabricExecutionTraceOperationV1 {
  type: "call";
  sequence: number;
  ref: string;
  provider?: string;
  action?: string;
  args: Record<string, JsonValue>;
  outcome: "succeeded" | "failed" | "aborted" | "timed_out";
  failureStage?: "resolve" | "prepare" | "validate" | "approve" | "invoke" | "guard";
  error?: string;
  result?: JsonValue;
}
```

The host bridge assigns `sequence` when it receives any durable operation. A parallel completion only updates the existing record, and operation order stays unchanged. Fabric issues action attempts before reference resolution, preparation, schema validation, approval, and execution guards. Discovery and workflow attempts go out before their guards, lookups, validation, or activity mutation, so failures in those stages stay visible. The configured executor returns a typed termination reason. Trace sealing uses that reason for deadline and cancellation outcomes, and it never classifies exception text.

V1 keeps `type: "call"` for wire compatibility. Exact internal refs separate discovery, lifecycle, and combinator operations from provider action calls. V1 also leaves `result` optional, and discovery, workflow lifecycle, and combinator operations never persist one. The generic recorder drops provider results, with a single exception: the exact `{ created: true }` creation outcome from `pi.write`. No output or provider details accompany that outcome. Argument projection follows the exact reference:

- `pi.read`: local `path`, numeric `offset`, numeric `limit`
- `pi.grep`: local `path`, numeric `context`, numeric `limit`. Drops pattern and query
- `pi.find`, `pi.ls`: local `path`, numeric `limit`. Drops pattern and query
- `pi.edit`, `pi.write`: local `path` only. Drops edit replacements and write content. `pi.write` can keep `{ created: true }`
- `pi.bash`: bounded command text
- selected `agents.*` lifecycle calls: `id` only. Drops task, message, instructions, names, model options, and outputs
- `mesh.publish`/`read`: topic/address and numeric cursor/limit. Drops payload text and data
- `mesh.get`/`put`/`delete`/`list`: key or prefix and limit. Drops values
- memory, state, schema, compact, MCP, extension, unknown, and external calls: no arguments or results

### Discovery operations

Read-only discovery still bypasses mutation authorization and approval budgets. Fabric persists every attempt in the same `sequence` space as actions and workflow activity:

- `fabric.discovery.providers`: no arguments or results
- `fabric.discovery.models`: no arguments or results
- `fabric.discovery.catalog`: identifier-shaped `provider` plus numeric `limit`. Drops catalog metadata and results
- `fabric.discovery.list`: identifier-shaped `provider` and `namespace`, plus numeric `limit`. Drops the free-form `query` and results
- `fabric.discovery.search`: numeric `limit`. Drops the free-form `query` and results
- `fabric.discovery.describe`: identifier-shaped action `ref`. Drops results

Each discovery operation records `succeeded`, `failed`, `aborted`, or `timed_out`, along with the applicable `guard`, `resolve`, or `invoke` stage. Model-registry enumeration keeps its best-effort empty-list behavior when enumeration throws. Fabric marks the corresponding operation failed.

### Workflow lifecycle operations

Declarative workflow calls still feed transient activity updates to the live UI. Each call also persists as a durable occurrence record:

- `fabric.workflow.configure`: `name`. Drops the description
- `fabric.workflow.phase`: `name`, identifier-shaped `id`, numeric `total`. Drops the description
- `fabric.workflow.item`: identifier-shaped `id`, `status`, `phase`, and `kind`, plus numeric `total` and `completed`. Drops label, detail, current value, and data
- `fabric.workflow.event`: identifier-shaped `level`. Drops message and data
- `fabric.workflow.progress`: no arguments. Drops the message

Fabric records these operations in bridge issue order, alongside actions and discovery. The separate `phases` compatibility field keeps occurrence order and retains repeated transitions.

### Workflow combinator spans

The shared guest implementation instruments calls to `workflow.parallel` and `workflow.pipeline` and records them as `fabric.workflow.parallel` and `fabric.workflow.pipeline`. Start creates one operation, and end updates that same operation. Persisted metadata stays limited to `kind`, numeric `itemCount`, numeric `stageCount` for pipelines, and the effective bounded `concurrency` for parallel calls. Empty combinators produce records too. A pipeline nests its parallel fan-out, so the pipeline operation goes out before the nested parallel operation, and both precede stage actions.

Guest span IDs are deterministic execution-local bridge correlation values. Fabric never persists them, and the internal start/end bridge stays closure-private, outside the guest API. Internal span calls skip provider resolution, authorization, approval, and agent-budget accounting. A thrown stage closes active spans as failed. A runtime failure, deadline, or cancellation seals any still-open operation with the typed final execution outcome.

Traces retain only plain local paths. They drop URL paths, together with credentials and query/fragment data. Plain paths lose their query/fragment suffixes as well. Sensitive-key normalization, media/base64 rejection, JSON safety, depth/node limits, and UTF-8 truncation still run after projection and add defense in depth. Projection provides the primary secrecy mechanism.

Identifiers (`ref`, `provider`, `action`), outcomes, failure stage, operation sequence, and occurrence-ordered phase labels stay durable. These fields, the retained local paths and mesh addresses, and bash command text are not secret containers. Callers must never place credentials in identifiers, local filenames, topics, keys, phase names, or commands.

## Reading and rendering traces

The package exports `isFabricExecutionTraceV1`, `isFabricExecutionTraceOperationV1`, `readFabricExecutionTraceV1`, `createFabricPersistedExecutionDetails`, and `readFabricExecutionRenderDetails`. Its guards reject malformed envelopes, extra fields, oversized data, and unknown versions.

Current trace-only sessions rebuild compact nested-call rows from operation metadata, including bash command text. Old sessions that contain `details.audits` and `details.phases` still render through the legacy adapter. For old digest-only bash traces, the renderer matches the digest against literal and named strings that the outer `fabric_exec` arguments already expose. When the renderer finds no exact command, it drops the digest and shows no hash. New final details never write `audits`.

Compaction and memory read only `toolResult.details.trace`, and both pass it through the trace guard. Compaction emits phases and operations in sequence order with stable `entryId/subordinal` addresses. Memory emits one normalized child per operation with address `<outer-entry-id>/<sequence>`. Neither consumer parses `fabric_exec` source, outer output, operation results, or rendered audit prose to recover calls, files, or failures.

An invalid or unknown trace, when present, blocks semantic legacy reinterpretation. Compaction can use its separate strict old-session `details.audits` adapter only when the trace field is absent. Memory indexes trace operations only.

## Limitations

Durable traces store bounded projections. Final rendering cannot show read bodies, edit diffs, write bodies, agent tasks, discovery queries and results, workflow descriptions, labels, messages, and data, external and MCP arguments, or provider results. Bash command text stays in the trace. Combinator traces carry structure and typed outcome. Item values, stage functions, stage results, parent IDs, and timing never persist. When arguments are omitted, generic failure resolution keeps only the ref identity. Rich action audits and workflow activity content stay available only while the live execution result or activity store remains in memory.
