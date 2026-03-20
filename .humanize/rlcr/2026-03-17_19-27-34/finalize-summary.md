# Finalize Summary

## What Was Implemented

- Stabilized the VSCode extension-host test harness:
  - fresh temp profile per run
  - SIGABRT retry support
  - seatbelt sandbox skip behavior
  - safer cleanup that does not mask the underlying test failure
- Split Graphviz-specific coverage from the default extension-host suite:
  - `npm run test:extension-host` validates the extension behavior without asserting Graphviz-specific preview-host behavior
  - `npm run test:extension-host:graphviz` runs the optional Graphviz smoke test
  - added a dedicated prebuild hook and cross-platform smoke-test launcher
- Improved extension runtime behavior around preview-host failures:
  - missing preview commands now produce a clear `PreviewHostUnavailableError`
  - installed preview hosts can still activate on demand via `executeCommand`
  - repeated auto-preview failures keep refreshing the notice graph while suppressing repeated warning toasts
- Expanded test coverage for:
  - missing configured preview hosts
  - auto-preview warning deduplication
  - Graphviz smoke-test activation timing
- Updated repo docs to match the actual extension-host harness behavior and Graphviz expectations.

## Files Modified

- `README.md`
- `eggplant-pattern-vscode/README.md`
- `eggplant-pattern-vscode/package.json`
- `eggplant-pattern-vscode/src/extension.ts`
- `eggplant-pattern-vscode/src/test/runTest.ts`
- `eggplant-pattern-vscode/src/test/suite/extension.test.ts`
- RLCR artifacts under `.humanize/rlcr/2026-03-17_19-27-34/`

## Key Commits

- `c0f7b78` `test: isolate vscode test user data per run`
- `06d61f8` `test: retry extension-host runs after startup aborts`
- `ffa90a3` `test: decouple extension-host validation from graphviz`
- `6077036` `test: make graphviz smoke check opt-in`
- `f27564f` `test: skip extension-host checks in seatbelt sandbox`
- `bbd9f4d` `test: keep final failing vscode profile for debugging`
- `363bd97` `test: harden extension-host harness cross-platform`
- `1da8de5` `fix: degrade gracefully without graphviz preview host`
- `5663cb3` `test: align graphviz dependency handling`
- `b69a15c` `fix: allow preview host on-demand activation`
- `298df0e` `fix: keep preview notice updates on repeated errors`
- `85e3961` `docs: align extension-host graphviz expectations`

## Tests / Validation

- `cd eggplant-pattern-extractor && cargo test`
  - passes
- `cd eggplant-pattern-vscode && npm test`
  - passes (`3 passing`)
- `cd eggplant-pattern-vscode && npm run test:extension-host`
  - passes (`8 passing, 1 pending`)
- `cd eggplant-pattern-vscode && npm run test:extension-host:graphviz`
  - passes (`9 passing`)
- `CODEX_SANDBOX=seatbelt cd eggplant-pattern-vscode && npm run test:extension-host`
  - earlier in the loop, verified to print a skip banner and exit `0`

## Remaining Items

- No product-code items remain from the plan.
- The only recurring review noise was about committed `.humanize` artifacts, which are required here for RLCR state progression and are not product-code blockers.
