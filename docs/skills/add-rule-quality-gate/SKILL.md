---
name: add-rule-quality-gate
description: Validate Rust eggplant rule parse quality after rewriting `.egg` programs into eggplant native `add_rule`/`add_rule_with_hook` calls. Use when an agent adds or rewrites rules and must batch-check whether the plugin extractor can parse every discovered rule site in a Rust project.
---

# Add Rule Quality Gate

Run the project-level detector and gate rewritten rules before review.

## Required Command

From `eggplant-pattern-vscode`:

```bash
npm run check:rust-project-rules -- --project /abs/path/to/rust-project
```

Optional strict mode:

```bash
npm run check:rust-project-rules -- --project /abs/path/to/rust-project --fail-on-warnings
```

JSON report mode (for agent post-processing):

```bash
npm run check:rust-project-rules -- --project /abs/path/to/rust-project --json
```

## Pass Criteria

- Hard gate: `fail = 0` is required.
- Soft gate: keep `warn` as low as possible; do not block merge unless strict mode is requested.

## Quality Rubric

- `pass`: rule is parseable by extractor and scope kind is valid.
- `warn`: extractor returned warning diagnostics; parse succeeded but quality is weaker.
- `fail`: parse blocked (extractor error or scope mismatch). Treat as must-fix.

## Triage Order

1. Fix all `FAIL` rules first.
2. Re-run detector.
3. If `fail = 0`, decide whether `WARN` should be fixed now or deferred.

## Common Fail Reasons And Fixes

- `referenced pattern function not found`
  - Ensure referenced pattern function exists and is in supported shape.
  - Ensure the function is visible to the current file/module parse context.
- `no supported pattern scope found at cursor`
  - Ensure rule uses supported `add_rule(...)` / `add_rule_with_hook(...)` structure.
  - Avoid placing rule shape only inside unsupported macro/template forms.
- `scope kind mismatch: expected add_rule_call, got ...`
  - Ensure detector offset resolves to the actual rule call scope, not unrelated code.

## Agent Output Template

After running, report in this format:

```text
Rule parse gate result:
- project: <path>
- pass: <n>
- warn: <n>
- fail: <n>
- decision: PASS | PASS_WITH_WARNINGS | FAIL
- top fail buckets: <reason x count>...
- next action: <what to fix now>
```

Set `decision` as:

- `FAIL` when `fail > 0`
- `PASS_WITH_WARNINGS` when `fail = 0` and `warn > 0`
- `PASS` when `fail = 0` and `warn = 0`
