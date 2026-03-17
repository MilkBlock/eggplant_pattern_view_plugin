# Eggplant Pattern Preview

VSCode shell for the `eggplant-pattern-extractor` Rust CLI.

## Current status

This first shell:

- listens to Rust cursor/document changes
- calls the local Rust extractor with the current cursor offset
- converts `PatternIR` to DOT
- forwards DOT to `tintinweb.graphviz-interactive-preview`

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
