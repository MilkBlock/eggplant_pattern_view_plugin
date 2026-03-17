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
| Stabilize extension-host validation (`npm run test:extension-host`) | 5 | todo | Still terminates with `SIGABRT` in this environment (Round 1 runner changes did not resolve). |

### Completed and Verified
<!-- Only move tasks here after Codex verification -->
| AC | Task | Completed Round | Verified Round | Evidence |
|----|------|-----------------|----------------|----------|
| 1,2,3,4,5 | Initialize goal tracker from the draft plan | 0 | 0 | Goal tracker populated from `PLAN_DRAFT.md` and current repository state |
| 2,5 | Resolve the extractor from the common repo layout without source edits | 0 | 0 | Default extractor path is repo-relative in `eggplant-pattern-vscode/src/extractor.ts` |
| 1,2,3,4 | Keep TypeScript orchestration-only and render DOT from extractor `PatternIR` | 0 | 0 | Extension pipeline remains editor events -> extractor JSON -> DOT -> preview command |
| 1,3,4 | Support manual preview plus debounced single-panel auto-refresh without stale overwrites | 0 | 0 | Debounce + single-panel render + stale-run suppression is implemented in `eggplant-pattern-vscode/src/extension.ts` |
| 4 | Surface unsupported scopes and preview-command failures safely | 0 | 0 | Missing-binary + unsupported-scope + non-zero exit handling is implemented in `eggplant-pattern-vscode/src/extractor.ts` and `eggplant-pattern-vscode/src/extension.ts` |
| 5 | Make repo-local validation reproducible for extractor + headless extension path | 0 | 0 | `cd eggplant-pattern-extractor && cargo test` passes; `cd eggplant-pattern-vscode && npm test` passes |

### Explicitly Deferred
<!-- Items here require strong justification -->
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
|------|-------------|----------------|---------------|-------------------|
| None | - | - | - | - |

### Open Issues
<!-- Issues discovered during implementation -->
| Issue | Discovered Round | Blocking AC | Resolution Path |
|-------|-----------------|-------------|-----------------|
| `cd eggplant-pattern-vscode && npm run test:extension-host` terminates with `SIGABRT` | 0 | 5 | Preserve failing temp profiles for logs; gate `test:extension-host` to skip with a clear message when running under the Codex seatbelt sandbox, and collect real extension-host evidence on a normal developer machine. |
| Codex seatbelt sandbox appears to block macOS app launches (even `open /System/Applications/Calculator.app` fails with `kLSNoExecutableErr`) | 1 | 5 | Treat this as an environment constraint: document it and/or gate `test:extension-host` so it remains meaningful on developer machines while not hard-failing in sandboxed runs. |
