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

    assert.equal(ir.scope.kind, "add_rule_call");
    assert.deepEqual(ir.roots, ["l", "r", "p"]);
    assert.equal(ir.nodes.length, 3);
    assert.equal(ir.edges.length, 2);
    assert.equal(ir.constraints[0].source_text, "eq");
    assert.match(ir.constraints[0].resolved_text, /x1\.handle\(\)\.eq/);
    assert.equal(ir.action_effects.length, 2);
    assert.equal(ir.action_effects[1].source_text, "ctx.union(pat.p, op_value)");
    assert.deepEqual(ir.action_effects[1].referenced_pat_vars, ["p"]);
    assert.equal(ir.seed_facts.length, 1);

    const dot = patternIrToDot(ir);
    assert.match(dot, /"effect:effect_1" -> "p"/);
  });

  test("extractor resolves assertion references for block host patterns", () => {
    const source = fs.readFileSync(FIXTURE_PATH, "utf8");
    const offset = source.indexOf("#[eggplant::pat_vars_catch]");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    assert.deepEqual(ir.roots, ["l", "r", "p"]);
    assert.equal(ir.constraints.length, 1);
    assert.equal(ir.constraints[0].source_text, "l_r_eq");
    assert.equal(ir.constraints[0].resolved_text, "l.handle().eq(&r.handle())");
    assert.deepEqual(ir.constraints[0].referenced_vars, ["l", "r"]);
    assert.equal(ir.action_effects.length, 2);
    assert.equal(ir.seed_facts.length, 1);
  });

  test("extractor keeps inline assertions and unique ids", () => {
    const source = `
fn demo() {
  MyTx::add_rule("demo", ruleset, || {
    let l = Const::query();
    let r = Const::query();
    let p = Add::query(&l, &r);
    DemoPat::new(l, r, p)
      .assert(l.handle().eq(&r.handle()))
      .assert(r.handle().eq(&l.handle()))
  }, |ctx, pat| {
    let folded = ctx.insert_const(6);
    ctx.union(pat.p, folded);
  });
}
`;
    const offset = source.indexOf(".assert(l.handle()");
    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;
    assert.equal(ir.constraints.length, 2);
    assert.equal(ir.constraints[0].source_text, "l.handle().eq(&r.handle())");
    assert.equal(ir.constraints[1].source_text, "r.handle().eq(&l.handle())");
    assert.notEqual(ir.constraints[0].id, ir.constraints[1].id);
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
      constraints: [
        {
          id: "constraint_0",
          source_text: "lhs_eq_rhs",
          resolved_text: "lhs.handle().eq(&rhs.handle())",
          referenced_vars: ["lhs", "rhs"],
          range: { start: 6, end: 7 }
        }
      ],
      action_effects: [
        {
          id: "effect_0",
          source_text: "ctx.union(pat.q, folded)",
          referenced_pat_vars: ["q"],
          range: { start: 8, end: 9 }
        }
      ],
      seed_facts: [
        {
          id: "seed_0",
          source_text: "expr.commit()",
          committed_root: "expr",
          referenced_vars: ["expr"],
          range: { start: 10, end: 11 }
        }
      ],
      diagnostics: []
    };

    const dot = patternIrToDot(ir);

    assert.match(dot, /digraph EggplantPattern/);
    assert.match(dot, /"q" -> "lhs" \[label="0"\]/);
    assert.match(dot, /"q" -> "rhs" \[label="1"\]/);
    assert.match(dot, /penwidth=2/);
    assert.match(dot, /lhs\.handle\(\)\.eq/);
    assert.match(dot, /"constraint:constraint_0" -> "lhs"/);
    assert.match(dot, /"constraint:constraint_0" -> "rhs"/);
    assert.equal(/"constraint:constraint_0" -> "q"/.test(dot), false);
    assert.match(dot, /cluster_actions/);
    assert.match(dot, /ctx\.union\(pat\.q, folded\)/);
    assert.match(dot, /cluster_seed_facts/);
    assert.match(dot, /expr\.commit\(\)/);
  });
});
