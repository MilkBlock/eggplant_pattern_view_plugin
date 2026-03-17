# eggplant-pattern-extractor

Rust-side AST extractor for cursor-scoped eggplant pattern visualization.

## Current scope

The first implementation supports:

- `MyTx::add_rule(..., || { ... }, ...)` pattern closures
- standalone pattern builder functions that contain `Pat::new(...)`
- extraction of:
  - `Foo::query(...)`
  - `Foo::query_leaf(...)`
  - `Pat::new(...)` roots
  - chained `.assert(...)` constraints

It returns a JSON `PatternIR` intended for a TypeScript VSCode shell.

## CLI

Read source from stdin:

```bash
cargo run -- --offset 123 --pretty < sample.rs
```

Read source from a file:

```bash
cargo run -- --file sample.rs --offset 123 --pretty
```
