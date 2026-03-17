# Eggplant Pattern View Plugin

Local workspace for an MVP eggplant pattern visualizer built from two repo-local components:

- `eggplant-pattern-extractor/`: Rust CLI that parses Rust source and emits `PatternIR` JSON for the cursor-scoped pattern.
- `eggplant-pattern-vscode/`: VSCode extension that invokes the extractor, converts `PatternIR` to DOT, and forwards it to Graphviz preview.

## Requirements

- Rust toolchain with `cargo`
- Node.js and `npm`
- VSCode
- VSCode extension `tintinweb.graphviz-interactive-preview`

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
npm run compile
npm test
```

## Run In VSCode

1. Open `eggplant-pattern-vscode/` in VSCode.
2. Start the extension host with `F5`.
3. In the extension host, open a Rust file containing a supported eggplant pattern.
4. Run `Eggplant Pattern: Preview Current Scope`, or leave `eggplantPattern.autoPreview` enabled for automatic refresh.

By default, the extension looks for the extractor binary at:

```text
<repo>/eggplant-pattern-extractor/target/debug/eggplant-pattern-extractor
```

Override that path with the `eggplantPattern.extractorPath` setting if needed.

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
- The preview depends on a DOT preview command. The default is `tintinweb.graphviz-interactive-preview`, but `eggplantPattern.previewCommand` can be overridden for testing or alternate preview hosts.
- The current automated validation focuses on extension-host command flow and preview payload generation. It does not assert Graphviz panel pixels or richer Graphviz extension behavior.
