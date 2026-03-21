import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { suite, test } from "mocha";
import { patternIrToDot, patternIrToDotWithMode } from "../../dot";
import { PatternIr } from "../../ir";
import { normalizeTypstMathSource } from "../../typst";

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
  test("typst math normalization strips both single and double dollar wrappers", () => {
    assert.equal(normalizeTypstMathSource("x + y"), "x + y");
    assert.equal(normalizeTypstMathSource("$x + y$"), "x + y");
    assert.equal(normalizeTypstMathSource("$$x + y$$"), "x + y");
  });

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
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
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
          bound_var: null,
          source_text: "ctx.union(pat.q, folded)",
          referenced_pat_vars: ["q"],
          referenced_action_vars: [],
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
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
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

  test("dot generation links action local bindings for seed rules", () => {
    const ir: PatternIr = {
      scope: {
        kind: "add_rule_call",
        text_range: { start: 0, end: 20 },
        pattern_range: { start: 0, end: 8 },
        action_range: { start: 9, end: 20 }
      },
      nodes: [],
      edges: [],
      roots: [],
      constraints: [],
      action_effects: [
        {
          id: "effect_0",
          bound_var: "x",
          source_text: "ctx.insert_m_var(\"x\".to_owned())",
          referenced_pat_vars: [],
          referenced_action_vars: [],
          range: { start: 0, end: 1 }
        },
        {
          id: "effect_1",
          bound_var: "ln_x",
          source_text: "ctx.insert_m_ln(x.clone())",
          referenced_pat_vars: [],
          referenced_action_vars: ["x"],
          range: { start: 2, end: 3 }
        },
        {
          id: "effect_2",
          bound_var: null,
          source_text: "ctx.insert_m_integral(ln_x, x.clone())",
          referenced_pat_vars: [],
          referenced_action_vars: ["ln_x", "x"],
          range: { start: 4, end: 5 }
        }
      ],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const dot = patternIrToDot(ir);

    assert.ok(dot.includes("MVar(\\\"x\\\".to_owned())"));
    assert.match(dot, /MLn\(x\.clone\(\)\)/);
    assert.match(dot, /MIntegral\(ln_x, x\.clone\(\)\)/);
    assert.match(dot, /"effect:effect_1" -> "effect:effect_0"/);
    assert.match(dot, /"effect:effect_2" -> "effect:effect_1"/);
    assert.match(dot, /"effect:effect_2" -> "effect:effect_0"/);
  });

  test("dot generation supports action-only and pattern-only views", () => {
    const ir: PatternIr = {
      scope: {
        kind: "add_rule_call",
        text_range: { start: 0, end: 20 },
        pattern_range: { start: 0, end: 8 },
        action_range: { start: 9, end: 20 }
      },
      nodes: [
        {
          id: "a",
          kind: "query_leaf",
          dsl_type: "Math",
          label: "a: Math",
          range: { start: 0, end: 1 },
          inputs: []
        },
        {
          id: "mul",
          kind: "query",
          dsl_type: "MMul",
          label: "mul: MMul",
          range: { start: 2, end: 3 },
          inputs: ["a"]
        }
      ],
      edges: [
        { from: "mul", to: "a", kind: "operand", index: 0 }
      ],
      roots: ["a", "mul"],
      constraints: [],
      action_effects: [
        {
          id: "effect_0",
          bound_var: null,
          source_text: "ctx.insert_m_mul(pat.a, pat.a)",
          referenced_pat_vars: ["a"],
          referenced_action_vars: [],
          range: { start: 10, end: 12 }
        }
      ],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const patternDot = patternIrToDotWithMode(ir, "pattern");
    assert.match(patternDot, /"mul" -> "a"/);
    assert.equal(patternDot.includes("cluster_actions"), false);

    const actionDot = patternIrToDotWithMode(ir, "action");
    assert.equal(actionDot.includes("\"mul\" -> \"a\""), false);
    assert.match(actionDot, /cluster_actions/);
    assert.match(actionDot, /MMul\(pat\.a, pat\.a\)/);
    assert.match(actionDot, /"effect:effect_0" -> "a"/);
  });

  test("compact labels strip API noise while full labels preserve debug text", () => {
    const ir: PatternIr = {
      scope: {
        kind: "add_rule_call",
        text_range: { start: 0, end: 20 },
        pattern_range: { start: 0, end: 8 },
        action_range: { start: 9, end: 20 }
      },
      nodes: [
        {
          id: "lhs",
          kind: "query_leaf",
          dsl_type: "DisplayMath",
          label: "lhs: DisplayMath",
          range: { start: 0, end: 1 },
          inputs: []
        }
      ],
      edges: [],
      roots: ["lhs"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "lhs_eq_rhs",
          resolved_text: "lhs.handle().eq(&rhs.handle())",
          referenced_vars: ["lhs"],
          range: { start: 2, end: 3 }
        }
      ],
      action_effects: [
        {
          id: "effect_0",
          bound_var: null,
          source_text: "ctx.union(pat.lhs, rhs.clone())",
          referenced_pat_vars: ["lhs"],
          referenced_action_vars: [],
          range: { start: 4, end: 5 }
        }
      ],
      seed_facts: [
        {
          id: "seed_0",
          source_text: "expr.commit()",
          committed_root: "expr",
          referenced_vars: ["expr"],
          range: { start: 6, end: 7 }
        }
      ],
      display_templates: [
        {
          variant_name: "MIntegral",
          template: "integ {f} {x}",
          fields: ["f", "x"]
        }
      ],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const compactDot = patternIrToDotWithMode(ir, "combined", "compact");
    const fullDot = patternIrToDotWithMode(ir, "combined", "full");

    assert.match(compactDot, /label="DisplayMath"/);
    assert.match(compactDot, /label="lhs == rhs"/);
    assert.match(compactDot, /label="union\(lhs, rhs\)"/);
    assert.match(compactDot, /label="expr\.commit\(\)"/);

    assert.match(fullDot, /label="lhs: DisplayMath"/);
    assert.match(fullDot, /lhs\.handle\(\)\.eq/);
    assert.match(fullDot, /ctx\.union\(pat\.lhs, rhs\.clone\(\)\)/);
  });

  test("compact labels prefer display templates when available", () => {
    const ir: PatternIr = {
      scope: {
        kind: "add_rule_call",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 4 },
        action_range: { start: 5, end: 10 }
      },
      nodes: [],
      edges: [],
      roots: [],
      constraints: [],
      action_effects: [
        {
          id: "effect_0",
          bound_var: null,
          source_text: "ctx.insert_m_integral(lhs.clone(), rhs.clone())",
          referenced_pat_vars: [],
          referenced_action_vars: [],
          range: { start: 1, end: 2 }
        }
      ],
      seed_facts: [],
      display_templates: [
        {
          variant_name: "MIntegral",
          template: "integ {f} {x}",
          fields: ["f", "x"]
        }
      ],
      typst_templates: [
        {
          variant_name: "MIntegral",
          template: "integral({f}, {x})",
          fields: ["f", "x"]
        }
      ],
      precedence_templates: [],
      diagnostics: []
    };

    const compactDot = patternIrToDotWithMode(ir, "action", "compact");
    assert.match(compactDot, /integral\(lhs, rhs\)/);
  });

  test("recursive labels collapse display-only trees with precedence-safe parentheses", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "x", kind: "query_leaf", dsl_type: "X", label: "x: X", range: { start: 0, end: 1 }, inputs: [] },
        { id: "y", kind: "query_leaf", dsl_type: "Y", label: "y: Y", range: { start: 2, end: 3 }, inputs: [] },
        { id: "z", kind: "query_leaf", dsl_type: "Z", label: "z: Z", range: { start: 4, end: 5 }, inputs: [] },
        { id: "sum", kind: "query", dsl_type: "Add", label: "sum: Add", range: { start: 6, end: 7 }, inputs: ["y", "z"] },
        { id: "root", kind: "query", dsl_type: "Mul", label: "root: Mul", range: { start: 8, end: 9 }, inputs: ["x", "sum"] }
      ],
      edges: [
        { from: "sum", to: "y", kind: "operand", index: 0 },
        { from: "sum", to: "z", kind: "operand", index: 1 },
        { from: "root", to: "x", kind: "operand", index: 0 },
        { from: "root", to: "sum", kind: "operand", index: 1 }
      ],
      roots: ["root"],
      constraints: [],
      action_effects: [],
      seed_facts: [],
      display_templates: [
        { variant_name: "X", template: "x", fields: [] },
        { variant_name: "Y", template: "y", fields: [] },
        { variant_name: "Z", template: "z", fields: [] },
        { variant_name: "Add", template: "{lhs} + {rhs}", fields: ["lhs", "rhs"] },
        { variant_name: "Mul", template: "{lhs} * {rhs}", fields: ["lhs", "rhs"] }
      ],
      typst_templates: [],
      precedence_templates: [
        { variant_name: "Add", precedence: 10 },
        { variant_name: "Mul", precedence: 20 }
      ],
      diagnostics: []
    };

    const recursiveDot = patternIrToDotWithMode(ir, "pattern", "recursive", "tree-safe");
    assert.match(recursiveDot, /label="y \+ z"/);
    assert.match(recursiveDot, /label="x \* \(y \+ z\)"/);
  });

  test("recursive precedence avoids redundant parentheses for tighter child expressions", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "x", kind: "query_leaf", dsl_type: "X", label: "x: X", range: { start: 0, end: 1 }, inputs: [] },
        { id: "y", kind: "query_leaf", dsl_type: "Y", label: "y: Y", range: { start: 2, end: 3 }, inputs: [] },
        { id: "z", kind: "query_leaf", dsl_type: "Z", label: "z: Z", range: { start: 4, end: 5 }, inputs: [] },
        { id: "mul", kind: "query", dsl_type: "Mul", label: "mul: Mul", range: { start: 6, end: 7 }, inputs: ["y", "z"] },
        { id: "root", kind: "query", dsl_type: "Add", label: "root: Add", range: { start: 8, end: 9 }, inputs: ["x", "mul"] }
      ],
      edges: [
        { from: "mul", to: "y", kind: "operand", index: 0 },
        { from: "mul", to: "z", kind: "operand", index: 1 },
        { from: "root", to: "x", kind: "operand", index: 0 },
        { from: "root", to: "mul", kind: "operand", index: 1 }
      ],
      roots: ["root"],
      constraints: [],
      action_effects: [],
      seed_facts: [],
      display_templates: [
        { variant_name: "X", template: "x", fields: [] },
        { variant_name: "Y", template: "y", fields: [] },
        { variant_name: "Z", template: "z", fields: [] },
        { variant_name: "Add", template: "{lhs} + {rhs}", fields: ["lhs", "rhs"] },
        { variant_name: "Mul", template: "{lhs} * {rhs}", fields: ["lhs", "rhs"] }
      ],
      typst_templates: [],
      precedence_templates: [
        { variant_name: "Add", precedence: 10 },
        { variant_name: "Mul", precedence: 20 }
      ],
      diagnostics: []
    };

    const recursiveDot = patternIrToDotWithMode(ir, "pattern", "recursive", "tree-safe");
    assert.match(recursiveDot, /label="x \+ y \* z"/);
    assert.doesNotMatch(recursiveDot, /label="x \+ \(y \* z\)"/);
  });

  test("recursive strategy distinguishes tree-safe fallback from dag expansion", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "a", kind: "query_leaf", dsl_type: "A", label: "a: A", range: { start: 0, end: 1 }, inputs: [] },
        { id: "b", kind: "query_leaf", dsl_type: "B", label: "b: B", range: { start: 2, end: 3 }, inputs: [] },
        { id: "shared", kind: "query", dsl_type: "Add", label: "shared: Add", range: { start: 4, end: 5 }, inputs: ["a", "b"] },
        { id: "root", kind: "query", dsl_type: "Mul", label: "root: Mul", range: { start: 6, end: 7 }, inputs: ["shared", "shared"] }
      ],
      edges: [
        { from: "shared", to: "a", kind: "operand", index: 0 },
        { from: "shared", to: "b", kind: "operand", index: 1 },
        { from: "root", to: "shared", kind: "operand", index: 0 },
        { from: "root", to: "shared", kind: "operand", index: 1 }
      ],
      roots: ["root"],
      constraints: [],
      action_effects: [],
      seed_facts: [],
      display_templates: [
        { variant_name: "A", template: "a", fields: [] },
        { variant_name: "B", template: "b", fields: [] },
        { variant_name: "Add", template: "{lhs} + {rhs}", fields: ["lhs", "rhs"] },
        { variant_name: "Mul", template: "{lhs} * {rhs}", fields: ["lhs", "rhs"] }
      ],
      typst_templates: [],
      precedence_templates: [
        { variant_name: "Add", precedence: 10 },
        { variant_name: "Mul", precedence: 20 }
      ],
      diagnostics: []
    };

    const treeSafeDot = patternIrToDotWithMode(ir, "pattern", "recursive", "tree-safe");
    const dagExpandDot = patternIrToDotWithMode(ir, "pattern", "recursive", "dag-expand");

    assert.match(treeSafeDot, /label="shared \* shared"/);
    assert.match(dagExpandDot, /label="\(a \+ b\) \* \(a \+ b\)"/);
  });
});
