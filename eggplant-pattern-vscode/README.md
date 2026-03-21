# Eggplant Pattern Preview

VSCode shell for the `eggplant-pattern-extractor` Rust CLI.

## Current status

This first shell:

- listens to Rust cursor/document changes
- calls the local Rust extractor with the current cursor offset
- converts `PatternIR` to DOT
- renders DOT to SVG with Graphviz in the extension host
- shows the graph in a built-in VSCode webview panel with an in-panel dropdown

## Development

Compile the Rust extractor first:

```bash
cd ../eggplant-pattern-extractor
cargo build
```

Then compile the extension:

```bash
cd ../eggplant-pattern-vscode
npm install
npm run compile
```

Default repo-local validation paths:

```bash
npm test
npm run test:extension-host
```

- `npm test` runs the headless-safe suite.
- `npm run test:extension-host` runs extension-host validation for the built-in preview panel, including mode switching through the panel message path.
