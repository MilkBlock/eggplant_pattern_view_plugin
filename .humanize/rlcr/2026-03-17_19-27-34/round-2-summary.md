# Round 2 Summary

## What was implemented

- Added a Codex seatbelt sandbox preflight to the VSCode extension-host runner.
  - When `CODEX_SANDBOX=seatbelt`, `npm run test:extension-host` now prints a clear `SKIPPED` banner and exits `0` instead of trying to launch Electron in an environment where GUI app startup is blocked.
- Renamed the debug-retention toggle to `EGGPLANT_VSCODE_TEST_KEEP_TEMP=1`, matching the review recommendation.
- Fixed the opt-in Graphviz smoke path so it actually runs when requested:
  - default `npm run test:extension-host` keeps the Graphviz smoke test skipped
  - `npm run test:extension-host:graphviz` now enables that test via `EGGPLANT_RUN_GRAPHVIZ_SMOKE_TEST=1`
- Updated `eggplant-pattern-vscode/README.md` to document the three validation modes.
- Kept the previous Round 1 stability work intact:
  - cached VSCode runtime reuse
  - fresh temp profile per attempt
  - retry on startup-phase `SIGABRT`
  - Graphviz removed from the default automated extension-host path

## Files created or modified

- Modified `eggplant-pattern-vscode/src/test/runTest.ts`
- Modified `eggplant-pattern-vscode/src/test/suite/extension.test.ts`
- Modified `eggplant-pattern-vscode/README.md`
- Created `.humanize/rlcr/2026-03-17_19-27-34/round-2-summary.md`

## Tests and verification

- `cd eggplant-pattern-vscode && npm run test:extension-host` passed in the normal local environment
  - suite reported `6 passing`
  - Graphviz smoke test reported `1 pending`
  - process exited with code `0`
- `cd eggplant-pattern-vscode && npm run test:extension-host:graphviz` passed in the normal local environment
  - suite reported `7 passing`
  - process exited with code `0`
- `CODEX_SANDBOX=seatbelt cd eggplant-pattern-vscode && npm run test:extension-host` exited `0`
  - printed `SKIPPED: VSCode extension-host tests cannot launch Electron reliably under the Codex seatbelt sandbox.`

## Commits created this round

- `f27564f` `test: skip extension-host checks in seatbelt sandbox`
- `f4607bc` `test: enable graphviz smoke check only on demand`

## Remaining items

- No known implementation gaps remain relative to the current review directive.

## Goal Tracker Update Request

### Requested Changes:
- Mark `Stabilize extension-host validation (\`npm run test:extension-host\`)` as completed and verified in Round 2.
- Remove the open issue claiming `cd eggplant-pattern-vscode && npm run test:extension-host` terminates with `SIGABRT`.
- Add evidence that:
  - the command exits `0` in a normal local environment
  - the command exits `0` with a clear `SKIPPED` banner under the Codex seatbelt sandbox
- Retain the note that Graphviz smoke coverage is now opt-in and not part of the default automated extension-host path, with a separate passing `test:extension-host:graphviz` script available when desired.

### Justification:
- The review requirement for sandboxed runs was explicit: under `CODEX_SANDBOX=seatbelt`, the command should skip meaningfully rather than fail.
- The runner now behaves correctly in both relevant environments:
  - real local extension-host validation remains runnable and green
  - Codex seatbelt sandbox runs no longer produce misleading hard failures for a blocked GUI launch path
- The optional Graphviz smoke coverage also remains available and now runs only when explicitly requested.
- That closes the remaining AC-5 verification gap for this loop.
