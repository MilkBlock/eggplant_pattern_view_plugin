# Persisted Snapshot v1

## Locked Route
- `2A`: self-contained snapshot with full dictionaries
- `3A`: restore only needs semantic equivalence, not runtime ID/hash equivalence
- `4A`: JSON schema first, with explicit versioning and migration hook
- `5A`: first version covers eggplant common paths only

This document fixes the contract for `#t53` and defines the boundary for exporter/importer work.

## Goals

We want a persisted format that can support an interactive plugin or tool restarting from a large egraph without depending on internal runtime hashes or in-memory clone snapshots.

The first version optimizes for:
- semantic recoverability
- debuggability
- deterministic restore
- safe rejection of incompatible snapshots

The first version does **not** optimize for:
- byte-minimal encoding
- preserving runtime node/value/class IDs
- preserving internal hash-cons tables exactly
- full generic egglog coverage

## Non-Goals

v1 is not a direct serde of `EGraph`.

We do not persist:
- raw runtime hashes as semantic truth
- internal interner slot numbers as stable IDs
- temporary rebuild worklists or analysis caches
- clone-based `push/pop` stack frames
- every egglog feature outside the eggplant common path

## Core Rule

Any runtime hash, interner index, or transient ID may be used as a local optimization during export or restore, but it must not be the semantic key stored on disk.

The snapshot must remain self-describing after moving between machines, processes, and future hash implementations.

## Compatibility Header

Every snapshot must carry a compatibility header before any importer is allowed to interpret the body.

Required header fields:
- `format`: fixed protocol family name, currently `eggplant.persisted-snapshot`
- `snapshot_version`: integer schema version
- `profile`: restore-coverage profile, currently `eggplant-common-path-v1`
- `producer`: optional producer metadata for diagnostics

Compatibility rules:
- unknown `format` => hard rejection
- unsupported `snapshot_version` => hard rejection
- unsupported `profile` => hard rejection
- unknown extra fields => ignored unless a future profile says otherwise

## Top-Level Shape

```json
{
  "snapshot_version": 1,
  "format": "eggplant.persisted-snapshot",
  "profile": "eggplant-common-path-v1",
  "producer": {
    "crate": "eggplant",
    "version": "0.0.0-dev"
  },
  "dictionary": {
    "strings": [],
    "symbols": [],
    "sorts": [],
    "ops": [],
    "rulesets": []
  },
  "schema": {
    "sort_decls": [],
    "function_decls": [],
    "constructor_decls": [],
    "ruleset_decls": []
  },
  "state": {
    "facts": [],
    "function_rows": [],
    "unions": [],
    "runs": [],
    "fresh_id_cursor": null
  },
  "restore_mapping": {
    "value_ids": [],
    "notes": []
  },
  "diagnostics": []
}
```

## Dictionary Contract

### Why a dictionary exists

The runtime compresses repeated names and strings aggressively. That is fine in memory, but on disk we need a self-contained dictionary so restore never depends on opaque hashes.

### Required dictionaries

- `strings`: arbitrary literal strings
- `symbols`: user-visible symbol names or identifiers
- `sorts`: sort names
- `ops`: function / constructor / operator names
- `rulesets`: ruleset names

Each dictionary entry is append-only within one snapshot and addressed by a small integer index. Those indices are only snapshot-local.

### Rules

- Disk references use dictionary indices, not hashes.
- Restore rebuilds any runtime interner from dictionary contents.
- If a name appears in multiple semantic categories, it may appear in multiple dictionaries. We want clarity over clever deduplication in v1.
- Future versions may compress dictionaries differently, but v1 keeps them explicit.

## Schema Section

The `schema` section describes only the declarations needed to make the persisted `state` replayable.

### `sort_decls`

Each sort declaration contains:
- `sort_id`
- `name`
- `kind`
- optional `metadata`

Minimal kinds for v1:
- `eqsort`
- `container`
- `primitive`

### `function_decls`

Each function declaration contains:
- `op_id`
- `name`
- `input_sort_ids`
- `output_sort_id`
- `is_relation`
- `merge`
- optional `cost`

### `constructor_decls`

Separate from generic functions only if runtime restore needs the distinction. If not, v1 may encode constructors as normal function declarations with `is_constructor: true`.

### `ruleset_decls`

Each ruleset declaration contains:
- `ruleset_id`
- `name`

We only need enough ruleset information to continue later `run` calls against named rulesets.

## State Section

### `facts`

Logical relation facts inserted before or outside function-row materialization.

Each fact contains:
- `op_id`
- `inputs`

### `function_rows`

Materialized function table rows.

Each row contains:
- `op_id`
- `inputs`
- `output`

### `unions`

Union operations that express semantic equality between values.

Each union contains:
- `sort_id`
- `lhs`
- `rhs`
- optional `reason`

### `runs`

Replay hints for continuing execution, not proof artifacts.

Each run record contains:
- `ruleset_id`
- `sequence_no`
- optional `until`
- optional `node_limit`
- optional `time_limit_ms`

If a caller only needs a restorable graph and not scheduled continuation metadata, `runs` may be empty.

### `fresh_id_cursor`

Optional monotonic cursor for generators that must avoid reusing exported logical IDs during restore-driven replay.

If runtime can deterministically rebuild this from imported state, keep it `null`.
If not, persist the minimal cursor only, never opaque allocator internals.

## Value Encoding

All argument and result payloads use semantic value encoding rather than runtime slot numbers.

```json
{
  "kind": "lit",
  "sort_id": 3,
  "value": { "tag": "i64", "value": "7" }
}
```

```json
{
  "kind": "app",
  "op_id": 4,
  "args": [
    { "kind": "ref", "logical_id": "v12" },
    { "kind": "ref", "logical_id": "v19" }
  ],
  "logical_id": "v20"
}
```

Allowed v1 payload forms:
- `lit`: primitive literal
- `ref`: logical value reference inside the snapshot
- `app`: constructor application if exporter chooses explicit node form

Exporter may normalize all persisted rows into `lit` / `ref` and avoid nested `app` payloads if that simplifies restore.

## Restore Semantics

Restore always targets a fresh runtime.

Algorithm:
1. Validate `format` and `snapshot_version`.
2. Load dictionaries.
3. Recreate schema declarations needed by v1.
4. Rebuild runtime interners from dictionary contents.
5. Replay facts, function rows, and unions in deterministic order.
6. Reinstall ruleset names and optional run metadata.
7. Resume execution from the reconstructed runtime.

Success criterion:
- subsequent rule execution produces the same semantics
- internal runtime IDs and hashes may differ

## Restore Mapping Contract

`restore_mapping` exists to make the importer contract explicit, not to persist old runtime IDs.

Required v1 fields:
- `value_ids`: snapshot-local logical value identities that the importer must remap into fresh runtime values
- `notes`: optional human/debug notes; importer may ignore them

Rules:
- `restore_mapping` may reference snapshot-local IDs only
- it must never store old backend IDs, old symbol slots, or old eclass IDs as authoritative restore data
- importer is responsible for building an ephemeral `snapshot logical id -> runtime id` table while restoring
- that ephemeral table lives only during import and is not part of persisted semantic truth

## Field Matrix

This matrix is normative for v1 and resolves the `must persist` versus `can rebuild` boundary at field level.

| Field | Layer | Required | Exporter action | Importer action |
| --- | --- | --- | --- | --- |
| `format` | compatibility header | yes | write fixed protocol family | validate exact match |
| `snapshot_version` | compatibility header | yes | write current schema version | reject unsupported version |
| `profile` | compatibility header | yes | write supported coverage profile | reject unsupported profile |
| `producer` | compatibility header | no | write best-effort metadata | ignore or surface in diagnostics |
| `dictionary.strings` | dictionary | yes if referenced | de-intern strings | rebuild string table before state import |
| `dictionary.symbols` | dictionary | yes if referenced | export user-visible symbols | re-intern symbols |
| `dictionary.sorts` | dictionary | yes if referenced | export logical sort names | recreate sort declarations |
| `dictionary.ops` | dictionary | yes if referenced | export logical function/constructor names | recreate callable declarations |
| `dictionary.rulesets` | dictionary | yes if referenced | export logical ruleset names | recreate ruleset handles |
| `schema.sort_decls` | schema | yes if referenced | emit minimal sort declarations | rebuild sort layer |
| `schema.function_decls` | schema | yes if referenced | emit minimal function declarations | rebuild function layer |
| `schema.constructor_decls` | schema | conditional | emit only if restore needs distinct constructor path | rebuild constructor layer if present |
| `schema.ruleset_decls` | schema | yes if referenced | emit named ruleset declarations | rebuild ruleset layer |
| `state.facts` | logical state | yes when used | export relation facts in deterministic order | import after declarations exist |
| `state.function_rows` | logical state | yes when used | export logical rows in deterministic order | import after referenced values exist |
| `state.unions` | logical state | yes when used | export logical equalities | apply after referenced values exist |
| `state.runs` | logical state | no | export continuation hints if needed | restore scheduling hints if supported |
| `state.fresh_id_cursor` | logical state | conditional | export only if deterministic rebuild is impossible | restore minimal cursor state |
| `restore_mapping.value_ids` | restore mapping | yes | export snapshot-local logical IDs used by state | build ephemeral remap table |
| runtime hash / intern / backend IDs | none | forbidden | do not emit as authoritative fields | ignore if seen in debug-only extensions |

## Must Persist vs Can Rebuild

### Must persist
- compatibility header: `format`, `snapshot_version`, `profile`
- dictionary entries referenced by persisted state
- schema declarations referenced by persisted state
- logical facts, rows, unions, and continuation metadata that affect resumed execution
- snapshot-local logical IDs required for import-time remapping
- fresh ID cursor only when restore cannot safely derive it

### Can rebuild
- runtime hash-cons tables
- runtime interner slot numbers
- runtime eclass representatives
- backend row ordering if semantics do not depend on it
- visualization/export IDs
- importer remap tables after restore finishes

## Fail-Open / Compatibility Rules

If restore cannot prove compatibility, it must refuse to load the snapshot with diagnostics. It must not silently guess.

Hard rejection cases:
- unknown `format`
- unsupported `snapshot_version`
- missing dictionary entries
- dangling references
- unsupported declaration kind
- payload type outside the v1 common path

Required diagnostics fields:
- `code`
- `message`
- optional `path`

Recommended initial codes:
- `unsupported-version`
- `unsupported-feature`
- `missing-dictionary-entry`
- `dangling-reference`
- `invalid-schema`

## Migration Hook

Even though v1 ships as JSON first, the loader should be structured as:
- parse raw JSON
- inspect `snapshot_version`
- dispatch through `migrate_to_latest(...)`
- validate normalized form
- restore

That keeps future upgrades additive instead of scattering version checks through restore logic.

## Coverage Boundary For `5A`

v1 only promises restore for the eggplant common path:
- constructor applications
- relation facts
- function rows
- unions
- named rulesets
- continuing `run` after restore

Explicitly outside the first cut unless represented as one of the logical forms above:
- arbitrary egglog host objects
- analysis-specific caches
- proof logs / explanation graphs
- full `push/pop` historical stack recovery
- every upstream egglog extension surface

## Practical Consequences

### Large egraphs

Self-contained dictionaries increase snapshot size, but they avoid the worse failure mode where a huge graph is present and its symbol meaning is gone.

### Hash-consed data

Hash-consing still helps at runtime, but restore recomputes it from semantic rows. We never trust stored hashes as canonical.

### Interactive plugin use

For the plugin use case, this route is safer than direct runtime serde:
- it debugs well
- it can be cached
- it can be diffed
- it can fail loudly on incompatible snapshots

## Next Tasks

This contract leaves the next implementation steps straightforward:
1. exporter from eggplant common-path runtime state to `PersistedSnapshot`
2. importer that rebuilds a fresh runtime from the snapshot
3. roundtrip semantic regression tests
4. large-graph size and latency baseline
