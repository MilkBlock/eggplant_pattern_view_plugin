# Eggplant Pattern View Plugin

Local workspace for an MVP eggplant pattern visualizer built from two repo-local components:

- `eggplant-pattern-extractor/`: Rust CLI that parses Rust source and emits `PatternIR` JSON for the cursor-scoped pattern.
- `eggplant-pattern-vscode/`: VSCode extension that invokes the extractor, converts `PatternIR` to DOT, renders SVG via Graphviz in the extension host, and shows it in a built-in webview preview panel.

## Requirements

- Rust toolchain with `cargo`
- Node.js and `npm`
- VSCode

## Build

Build the extractor:

```bash
cd eggplant-pattern-extractor
cargo build
```

Compile the extension:

```bash
cd eggplant-pattern-vscode
npm install
npm run bundle:extractor
npm run compile
npm test
```

`npm test` runs headless-safe validation only: extractor CLI checks plus DOT generation tests.

For the full VSCode extension-host validation, run:

```bash
cd eggplant-pattern-vscode
npm run test:extension-host
```

That script now rebuilds the extractor and recompiles the extension before launching the VSCode test host.

## Run In VSCode

1. Open `eggplant-pattern-vscode/` in VSCode.
2. Start the extension host with `F5`.
3. In the extension host, open a Rust file containing a supported eggplant pattern.
4. Run `Eggplant Pattern: Preview Current Scope`, or leave `eggplantPattern.autoPreview` enabled for automatic refresh.
5. Use the built-in preview panel toolbar to switch between `pattern.dot`, `action.dot`, and `action + pattern.dot`.

By default, the extension looks for a bundled platform binary at:

```text
<extension>/bin/<platform-arch>/eggplant-pattern-extractor
```

During repo-local development, it falls back to:

```text
<repo>/eggplant-pattern-extractor/target/debug/eggplant-pattern-extractor
```

Override that path with the `eggplantPattern.extractorPath` setting if needed.

## Release / Publish

The repo now includes a multi-platform packaging path for the VSCode extension:

- GitHub Actions workflow: `.github/workflows/release-extension.yml`
- Native extractor targets:
  - `darwin-arm64`
  - `darwin-x64`
  - `linux-arm64`
  - `linux-x64`
  - `win32-arm64`
  - `win32-x64`
- Packaging strategy:
  - build each Rust extractor as a release artifact
  - stage them into `eggplant-pattern-vscode/bin/<platform-arch>/`
  - package one VSIX containing all supported binaries

Local commands:

```bash
cd eggplant-pattern-vscode
npm run package:extension
npm run package:vsix
```

Marketplace publishing is wired for CI, but still requires repository configuration:

- repo variable `VSCE_PUBLISHER`
- repo secret `VSCE_PAT`
- a real Marketplace publisher identity instead of the development placeholder `publisher: \"local\"`
- the repo now includes a proprietary `LICENSE`; replace it only if you later want a different distribution model

For a repo-local validation target, use `samples/pattern_samples.rs`, which includes:

- an `add_rule(..., || { ... })` pattern closure
- a standalone pattern builder function
- a non-pattern Rust scope

## Supported Pattern Shapes

- `MyTx::add_rule(..., || { ... }, ...)` pattern closures
- Standalone pattern builder functions containing `Pat::new(...)`
- `query(...)` and `query_leaf(...)` nodes
- `Pat::new(...)` roots
- Chained `.assert(...)` constraints

Unsupported scopes render a diagnostic preview instead of reusing stale graph data.

## Limitations / Unsupported

- The MVP recognizes only the supported pattern shapes listed above; other Rust scopes return a diagnostic notice instead of a graph.
- The built-in preview panel currently focuses on dropdown mode switching and graph rendering; richer interactions such as node click-to-source are not implemented yet.
