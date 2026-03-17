# Goal Tracker

<!--
This file tracks the ultimate goal, acceptance criteria, and plan evolution.
It prevents goal drift by maintaining a persistent anchor across all rounds.

RULES:
- IMMUTABLE SECTION: Do not modify after initialization
- MUTABLE SECTION: Update each round, but document all changes
- Every task must be in one of: Active, Completed, or Deferred
- Deferred items require explicit justification
-->

## IMMUTABLE SECTION
<!-- Do not modify after initialization -->

### Ultimate Goal
Build a local-development MVP VSCode plugin that renders the eggplant pattern scope under the cursor as a graph while editing Rust, using the Rust extractor as the sole source of truth for syntax recognition and PatternIR generation.

### Acceptance Criteria
<!-- Each criterion must be independently verifiable -->
<!-- Claude must extract or define these in Round 0 -->
1. In Rust files, a manual preview command renders the supported pattern scope under the cursor for both `add_rule` pattern closures and standalone pattern builder functions.
2. The VSCode extension invokes the Rust extractor through a stable JSON boundary and does not duplicate eggplant AST recognition logic in TypeScript.
3. Automatic refresh updates a single preview panel during cursor or document changes without overlapping extractor runs or stale-result overwrites.
4. Failures from unsupported scopes, missing extractor binaries, or non-zero extractor exits surface clearly and do not crash the extension host or present stale graphs as current.
5. Another developer can build and run the extractor plus extension from repo-local documentation without editing source paths.

---

## MUTABLE SECTION
<!-- Update each round with justification for changes -->

### Plan Version: 1 (Updated: Round 0)

#### Plan Evolution Log
<!-- Document any changes to the plan with justification -->
| Round | Change | Reason | Impact on AC |
|-------|--------|--------|--------------|
| 0 | Initial plan | - | - |

#### Active Tasks
<!-- Map each task to its target Acceptance Criterion -->
| Task | Target AC | Status | Notes |
|------|-----------|--------|-------|
| None | - | completed | Current `HEAD` satisfies the planned MVP and all repo-local verification passes locally. |

### Completed and Verified
<!-- Only move tasks here after Codex verification -->
| AC | Task | Completed Round | Verified Round | Evidence |
|----|------|-----------------|----------------|----------|
| 1,2,3,4,5 | Initialize goal tracker from the draft plan | 0 | 0 | Goal tracker populated from `PLAN_DRAFT.md` and current repository state |
| 2,5 | Resolve the extractor from the common repo layout without source edits | 0 | 0 | Default extractor path is repo-relative in `eggplant-pattern-vscode/src/extractor.ts` |
| 1,2,3,4 | Keep TypeScript orchestration-only and render DOT from extractor `PatternIR` | 0 | 0 | Extension pipeline remains editor events -> extractor JSON -> DOT -> preview command |
| 1,3,4 | Support manual preview plus debounced single-panel auto-refresh without stale overwrites | 0 | 0 | Extension-host suite passes manual preview coverage and `auto preview coalesces rapid cursor updates into a single render` |
| 4 | Surface unsupported scopes and preview-command failures safely | 0 | 0 | Rust tests cover unsupported scope; extension-host suite passes diagnostic and preview-failure warning cases |
| 5 | Make repo-local validation reproducible for both headless and extension-host paths | 0 | 0 | `npm test` passes with 3 headless tests; `npm run test:extension-host` passes with 7 extension-host tests |
| 1,2,3,4,5 | Re-run current end-to-end verification on the repo snapshot used to start this loop | 0 | 0 | `cargo test` passed; `cd eggplant-pattern-vscode && npm test` passed; `cd eggplant-pattern-vscode && npm run test:extension-host` passed with exit code `0` |

### Explicitly Deferred
<!-- Items here require strong justification -->
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
|------|-------------|----------------|---------------|-------------------|
| None | - | - | - | - |

### Open Issues
<!-- Issues discovered during implementation -->
| Issue | Discovered Round | Blocking AC | Resolution Path |
|-------|-----------------|-------------|-----------------|
| None | - | - | - |
