# Eggplant Pattern Preview

VSCode shell for the `eggplant-pattern-extractor` Rust CLI.

## Current status

This extension:

- listens to Rust cursor/document changes
- calls the local Rust extractor with the current cursor offset
- converts `PatternIR` to DOT
- renders DOT to SVG with Graphviz in the extension host
- shows the graph in a built-in VSCode webview panel with an in-panel dropdown

## Development

Build and bundle the Rust extractor first:

```bash
cd ../eggplant-pattern-extractor
cargo build
cd ../eggplant-pattern-vscode
npm run bundle:extractor
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

For one-shot local packaging, use:

```bash
npm run package:extension
```

This builds the Rust extractor, copies the current platform binary into `bin/<platform-arch>/`, and compiles the TypeScript extension.

To create a local VSIX from the current platform build, use:

```bash
npm run package:vsix
```

For CI/release packaging, the repository includes `.github/workflows/release-extension.yml`. That workflow:

- builds extractor binaries for `darwin/linux/windows` across `x64/arm64`
- stages them into `bin/<platform-arch>/`
- packages a single VSIX containing all supported native binaries
- optionally publishes to the VSCode Marketplace when both `VSCE_PAT` secret and `VSCE_PUBLISHER` repo variable are configured

Marketplace notes:

- `package.json.publisher` is set for Marketplace publishing
- CI overrides it with `VSCE_PUBLISHER` before packaging/publishing when needed
- publish requires a Visual Studio Marketplace publisher plus a PAT with marketplace publish rights
- the extension package ships with a checked-in `LICENSE`
