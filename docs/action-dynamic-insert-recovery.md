# Dynamic Action Insert Recovery

## Locked Route
- Primary route: `hybrid`
- Integration: feature branch only
- Failure semantics: fail-open with `dynamic-unknown`

This document fixes the contract for `#t44` and `#t45` so later implementation tasks can proceed without re-litigating scope.

## Problem

The current preview pipeline assumes action inserts are recoverable from static closure syntax. That fails once action closures contain real control flow:
- `if` / `else`
- `match`
- helper calls
- loops
- branch-local bindings that merge later

In those cases the extractor can still recover source ranges and direct method calls, but it can no longer prove a single deterministic inserted node graph at compile time.

## Strategy

We will implement a hybrid strategy behind an explicit feature flag:

1. Try static deep-inline recovery first.
2. If static recovery hits a dynamic boundary, attempt sampled insert recovery.
3. If neither path can produce a stable result, keep the current preview behavior and mark the unresolved segment as `dynamic-unknown`.

This preserves the current extension as the baseline while opening a controlled path for more powerful previews.

## Feature Flag

The feature branch will expose two settings:
- `eggplantPattern.experimentalDynamicActionRecovery: boolean`
- `eggplantPattern.dynamicActionRecoveryMode: "static" | "sample" | "hybrid"`

Expected semantics:
- `false`: current mainline behavior only
- `true + static`: deep inline only
- `true + sample`: sampled trace only
- `true + hybrid`: static first, sample fallback

`hybrid` is the default mode once the experimental flag is enabled.

## Failure Contract

Failure stays fail-open. We do not block the preview, and we do not fabricate certainty.

When recovery cannot continue:
- keep the preview rendering alive
- attach `dynamic-unknown` to the unresolved segment
- preserve the best available source anchor

The marker is diagnostic, not fatal.

## Trace IR Contract

Sampled recovery will emit an `ActionSampleTrace` with:
- `action_range`
- ordered `events`
- diagnostic messages

Required event families:
- `insert`
- `union`
- `branch`
- `dynamic-unknown`

Each event must carry a stable source anchor when one exists. This is required so sampled nodes still support node-to-source reveal.

## Division Of Responsibility

### Static path
- continues from the current action label / action graph recovery code
- owns deterministic AST-local value flow
- may stop at dynamic boundaries

### Sample path
- records actual insert/union behavior for a chosen sample execution
- owns branch resolution after runtime choice is known
- emits trace IR, not ad-hoc preview strings

### Preview path
- consumes either static recovery results or sampled trace results
- must not care whether a node originated from static or sample mode beyond metadata badges / diagnostics

## Minimal First Deliverable

The first usable feature-branch slice should do only this:

1. Add the feature flag and mode settings.
2. Define `ActionSampleTrace` and the `dynamic-unknown` marker contract.
3. Thread a mode switch through the preview pipeline without changing default behavior.
4. Leave actual sampling implementation to later tasks.

That gives `#t46`, `#t47`, and `#t48` a stable interface to target.
