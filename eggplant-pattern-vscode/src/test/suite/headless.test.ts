import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { suite, test } from "mocha";
import { patternIrToDot } from "../../dot";
import { PatternIr } from "../../ir";

const WORKSPACE_ROOT = path.resolve(__dirname, "../../../../");
const FIXTURE_PATH = path.resolve(WORKSPACE_ROOT, "samples", "pattern_samples.rs");
const EXTRACTOR_PATH = path.resolve(
  WORKSPACE_ROOT,
  "eggplant-pattern-extractor",
  "target",
  "debug",
  process.platform === "win32" ? "eggplant-pattern-extractor.exe" : "eggplant-pattern-extractor"
);

suite("eggplant pattern headless tests", () => {
  test("extractor emits JSON for add_rule closure scope", () => {
    const source = fs.readFileSync(FIXTURE_PATH, "utf8");
    const offset = source.indexOf("let p = Add::query");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    assert.deepEqual(ir.roots, ["l", "r", "p"]);
    assert.equal(ir.nodes.length, 3);
    assert.equal(ir.edges.length, 2);
  });

  test("extractor reports unsupported non-pattern scope", () => {
    const source = fs.readFileSync(FIXTURE_PATH, "utf8");
    const offset = source.indexOf("println!(\"not a pattern\")");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no supported pattern scope found at cursor/);
  });

  test("dot generation uses PatternIR only", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 }
      },
      nodes: [
        {
          id: "lhs",
          kind: "query",
          dsl_type: "Const",
          label: "lhs: Const",
          range: { start: 0, end: 1 },
          inputs: []
        },
        {
          id: "rhs",
          kind: "query",
          dsl_type: "Const",
          label: "rhs: Const",
          range: { start: 2, end: 3 },
          inputs: []
        },
        {
          id: "q",
          kind: "query",
          dsl_type: "Mul",
          label: "q: Mul",
          range: { start: 4, end: 5 },
          inputs: ["lhs", "rhs"]
        }
      ],
      edges: [
        { from: "q", to: "lhs", kind: "operand", index: 0 },
        { from: "q", to: "rhs", kind: "operand", index: 1 }
      ],
      roots: ["lhs", "rhs", "q"],
      constraints: [],
      diagnostics: []
    };

    const dot = patternIrToDot(ir);

    assert.match(dot, /digraph EggplantPattern/);
    assert.match(dot, /"q" -> "lhs" \[label="0"\]/);
    assert.match(dot, /"q" -> "rhs" \[label="1"\]/);
    assert.match(dot, /penwidth=2/);
  });
});
