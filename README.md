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

## Supported Pattern Shapes

- `MyTx::add_rule(..., || { ... }, ...)` pattern closures
- Standalone pattern builder functions containing `Pat::new(...)`
- `query(...)` and `query_leaf(...)` nodes
- `Pat::new(...)` roots
- Chained `.assert(...)` constraints

Unsupported scopes render a diagnostic preview instead of reusing stale graph data.
