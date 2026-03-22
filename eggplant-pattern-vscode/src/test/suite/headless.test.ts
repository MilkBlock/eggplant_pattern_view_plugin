import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { suite, test } from "mocha";
import { collectTypstReplacementSources, patternIrToDot, patternIrToDotWithMode } from "../../dot";
import { PatternIr } from "../../ir";
import { mergeExternalMetadata, metadataCacheMatches } from "../../metadataSources";
import {
  indexActionEffectsByStableId,
  normalizeActionRecoveryMode,
  resolveTraceEventEffect,
  resolveDynamicActionRecoveryPolicy,
  summarizeRuntimeActionSampleTrace
} from "../../actionRecovery";
import { normalizeTypstMathSource, renderTypstSnippets } from "../../typst";

const WORKSPACE_ROOT = path.resolve(__dirname, "../../../../");
const FIXTURE_PATH = path.resolve(WORKSPACE_ROOT, "samples", "pattern_samples.rs");
const MATH_METADATA_FIXTURE = "/Users/mineralsteins/Repos/egg_related/eggplant_backup/benches/runners/eggplant_rewrite/math_microbenchmark.rs";
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

  test("dynamic action recovery policy normalizes experimental mode settings", () => {
    assert.equal(normalizeActionRecoveryMode("static"), "static");
    assert.equal(normalizeActionRecoveryMode("sample"), "sample");
    assert.equal(normalizeActionRecoveryMode("hybrid"), "hybrid");
    assert.equal(normalizeActionRecoveryMode("unexpected"), "hybrid");

    assert.deepEqual(
      resolveDynamicActionRecoveryPolicy({ enabled: true, mode: "sample" }),
      {
        enabled: true,
        mode: "sample",
        failOpen: true,
        unknownMarker: "dynamic-unknown"
      }
    );
  });

  test("stable action effect ids index back to source ranges", () => {
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
          effect_id: "effect@10:24",
          bound_var: "tmp",
          source_text: "ctx.insert_m_add(a, b)",
          referenced_pat_vars: ["a", "b"],
          referenced_action_vars: [],
          range: { start: 10, end: 24 }
        },
        {
          id: "effect_1",
          effect_id: "effect@30:44",
          bound_var: null,
          source_text: "ctx.union(pat.x, tmp)",
          referenced_pat_vars: ["x"],
          referenced_action_vars: ["tmp"],
          range: { start: 30, end: 44 }
        }
      ],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const byStableId = indexActionEffectsByStableId(ir.action_effects);
    assert.equal(byStableId.get("effect@10:24")?.range.start, 10);
    assert.equal(byStableId.get("effect@30:44")?.range.end, 44);
    assert.equal(byStableId.get("effect@999:1000"), undefined);

    assert.equal(
      resolveTraceEventEffect(
        {
          kind: "insert",
          id: "evt_0",
          effect_id: "effect@10:24",
          callee: "MAdd",
          rendered_label: null,
          source_range: { start: 10, end: 24 },
          input_ids: []
        },
        byStableId
      )?.id,
      "effect_0"
    );

    assert.equal(
      resolveTraceEventEffect(
        {
          kind: "dynamic-unknown",
          id: "evt_1",
          effect_id: null,
          source_range: null,
          reason: "branch not sampled"
        },
        byStableId
      ),
      null
    );
  });

  test("runtime action sample trace summary reports matches and diagnostics", () => {
    const summary = summarizeRuntimeActionSampleTrace(
      {
        version: 1,
        events: [
          {
            Insert: {
              event_id: "evt_0",
              effect_id: "effect@10:24",
              table: "MAdd",
              key_debug: ["a", "b"]
            }
          },
          {
            DynamicUnknown: {
              event_id: "evt_1",
              effect_id: "effect@30:44",
              reason: "branch not sampled"
            }
          },
          {
            Union: {
              event_id: "evt_2",
              effect_id: "effect@999:1000",
              lhs_debug: "lhs",
              rhs_debug: "rhs"
            }
          }
        ]
      },
      [
        {
          id: "effect_0",
          effect_id: "effect@10:24",
          bound_var: "tmp",
          source_text: "ctx.insert_m_add(a, b)",
          referenced_pat_vars: ["a", "b"],
          referenced_action_vars: [],
          range: { start: 10, end: 24 }
        },
        {
          id: "effect_1",
          effect_id: "effect@30:44",
          bound_var: null,
          source_text: "ctx.union(pat.x, tmp)",
          referenced_pat_vars: ["x"],
          referenced_action_vars: ["tmp"],
          range: { start: 30, end: 44 }
        }
      ]
    );

    assert.ok(summary);
    assert.equal(summary?.summary, "recovery=sample | events=3 | matched=2 | dynamic-unknown=1 | unresolved=1");
    assert.equal(summary?.diagnostics.length, 2);
    assert.match(summary?.diagnostics[0].message ?? "", /dynamic-unknown at evt_1: branch not sampled/);
    assert.equal(summary?.diagnostics[0].source_range?.start, 30);
    assert.match(summary?.diagnostics[1].message ?? "", /did not match any extracted action effect/);
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
    assert.equal(
      ir.action_effects[1].effect_id,
      `effect@${ir.action_effects[1].range.start}:${ir.action_effects[1].range.end}`
    );
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

  test("external metadata sources merge typst templates into the preview ir", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
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
          id: "b",
          kind: "query_leaf",
          dsl_type: "Math",
          label: "b: Math",
          range: { start: 2, end: 3 },
          inputs: []
        },
        {
          id: "mul",
          kind: "query",
          dsl_type: "MMul",
          label: "mul: MMul",
          range: { start: 4, end: 5 },
          inputs: ["a", "b"]
        }
      ],
      edges: [
        { from: "mul", to: "a", kind: "operand", index: 0 },
        { from: "mul", to: "b", kind: "operand", index: 1 }
      ],
      roots: ["mul"],
      constraints: [],
      action_effects: [],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const merged = mergeExternalMetadata(ir, [
      {
        display_templates: [],
        typst_templates: [{ variant_name: "MMul", template: "{a} * {b}", fields: ["a", "b"] }],
        precedence_templates: [{ variant_name: "MMul", precedence: 60 }]
      }
    ]);

    const dot = patternIrToDotWithMode(merged, "pattern", "compact");
    assert.match(dot, /label="a \* b"/);
  });

  test("metadata cache matching requires both mtime and size", () => {
    assert.equal(metadataCacheMatches({ mtimeMs: 10, size: 20 }, { mtimeMs: 10, size: 20 }), true);
    assert.equal(metadataCacheMatches({ mtimeMs: 10, size: 20 }, { mtimeMs: 10, size: 21 }), false);
    assert.equal(metadataCacheMatches({ mtimeMs: 10, size: 20 }, { mtimeMs: 11, size: 20 }), false);
  });

  test("recursive action labels inline nested math_microbenchmark inserts", () => {
    const source = fs.readFileSync(MATH_METADATA_FIXTURE, "utf8");
    const offset = source.indexOf("let pow_x_2 = ctx.insert_m_pow(x.clone(), ctx.insert_m_const(2));");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    const recursiveDot = patternIrToDotWithMode(ir, "action", "recursive", "dag-expand");
    assert.match(recursiveDot, /label="x\^2"/);
    assert.match(recursiveDot, /label="x\^3 - 7 \* x\^2"/);
    assert.doesNotMatch(recursiveDot, /insert_m_const\(2\)/);
    assert.doesNotMatch(recursiveDot, /"x"\^2/);
  });

  test("typst sources keep multi-letter action vars renderable in math_microbenchmark", async () => {
    const source = fs.readFileSync(MATH_METADATA_FIXTURE, "utf8");
    const offset = source.indexOf("let sqrt_five = ctx.insert_m_sqrt(five.clone());");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    const typstSources = collectTypstReplacementSources(ir, "action", "recursive", "dag-expand");
    const sqrtFive = typstSources.find((entry) => entry.targetId === "effect:effect_33");
    const denom = typstSources.find((entry) => entry.targetId === "effect:effect_41");

    assert.equal(sqrtFive?.source, 'sqrt("five")');
    assert.equal(denom?.source, 'frac(1, (frac((1 + sqrt("five")), 2)  - frac((1 - sqrt("five")), 2) )) ');

    const renderings = await renderTypstSnippets(
      typstSources.filter((entry) => entry.targetId === "effect:effect_33" || entry.targetId === "effect:effect_41")
    );
    assert.ok(renderings["effect:effect_33"]);
    assert.ok(renderings["effect:effect_41"]);
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
          effect_id: "effect@8:9",
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
          effect_id: "effect@0:1",
          bound_var: "x",
          source_text: "ctx.insert_m_var(\"x\".to_owned())",
          referenced_pat_vars: [],
          referenced_action_vars: [],
          range: { start: 0, end: 1 }
        },
        {
          id: "effect_1",
          effect_id: "effect@2:3",
          bound_var: "ln_x",
          source_text: "ctx.insert_m_ln(x.clone())",
          referenced_pat_vars: [],
          referenced_action_vars: ["x"],
          range: { start: 2, end: 3 }
        },
        {
          id: "effect_2",
          effect_id: "effect@4:5",
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
          effect_id: "effect@10:12",
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
          effect_id: "effect@4:5",
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

  test("compact labels hardcode known constraint primitives", () => {
    const makeIr = (resolvedText: string): PatternIr => ({
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        {
          id: "lhs",
          kind: "query_leaf",
          dsl_type: "Value",
          label: "lhs: Value",
          range: { start: 0, end: 1 },
          inputs: []
        },
        {
          id: "rhs",
          kind: "query_leaf",
          dsl_type: "Value",
          label: "rhs: Value",
          range: { start: 2, end: 3 },
          inputs: []
        }
      ],
      edges: [],
      roots: ["lhs", "rhs"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "constraint_alias",
          resolved_text: resolvedText,
          referenced_vars: ["lhs", "rhs"],
          range: { start: 4, end: 5 }
        }
      ],
      action_effects: [],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    });

    const cases: Array<[string, string]> = [
      ["lhs.handle().eq(&rhs.handle())", "lhs == rhs"],
      ["lhs.handle().ne(&rhs.handle())", "lhs != rhs"],
      ["lhs.handle().lt(&rhs.handle())", "lhs < rhs"],
      ["lhs.handle().le(&rhs.handle())", "lhs <= rhs"],
      ["lhs.handle().gt(&rhs.handle())", "lhs > rhs"],
      ["lhs.handle().ge(&rhs.handle())", "lhs >= rhs"]
    ];

    for (const [resolvedText, expectedLabel] of cases) {
      const dot = patternIrToDotWithMode(makeIr(resolvedText), "pattern", "compact");
      assert.match(dot, new RegExp(`label=\"${expectedLabel.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\"`));
    }
  });

  test("compact labels keep unknown constraint text with a raw marker", () => {
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
          kind: "query_leaf",
          dsl_type: "Value",
          label: "lhs: Value",
          range: { start: 0, end: 1 },
          inputs: []
        }
      ],
      edges: [],
      roots: ["lhs"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "lhs.custom_constraint(rhs)",
          resolved_text: "lhs.handle().custom_constraint(&rhs.handle())",
          referenced_vars: ["lhs"],
          range: { start: 4, end: 5 }
        }
      ],
      action_effects: [],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const dot = patternIrToDotWithMode(ir, "pattern", "compact");
    assert.match(dot, /label="lhs\.custom_constraint\(rhs\) \[raw\]"/);
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
          effect_id: "effect@1:2",
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

  test("recursive precedence keeps same-precedence child parenthesized conservatively", () => {
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
        { id: "c", kind: "query_leaf", dsl_type: "C", label: "c: C", range: { start: 4, end: 5 }, inputs: [] },
        { id: "inner", kind: "query", dsl_type: "Sub", label: "inner: Sub", range: { start: 6, end: 7 }, inputs: ["b", "c"] },
        { id: "root", kind: "query", dsl_type: "Sub", label: "root: Sub", range: { start: 8, end: 9 }, inputs: ["a", "inner"] }
      ],
      edges: [
        { from: "inner", to: "b", kind: "operand", index: 0 },
        { from: "inner", to: "c", kind: "operand", index: 1 },
        { from: "root", to: "a", kind: "operand", index: 0 },
        { from: "root", to: "inner", kind: "operand", index: 1 }
      ],
      roots: ["root"],
      constraints: [],
      action_effects: [],
      seed_facts: [],
      display_templates: [
        { variant_name: "A", template: "a", fields: [] },
        { variant_name: "B", template: "b", fields: [] },
        { variant_name: "C", template: "c", fields: [] },
        { variant_name: "Sub", template: "{lhs} - {rhs}", fields: ["lhs", "rhs"] }
      ],
      typst_templates: [],
      precedence_templates: [
        { variant_name: "Sub", precedence: 10 }
      ],
      diagnostics: []
    };

    const recursiveDot = patternIrToDotWithMode(ir, "pattern", "recursive", "tree-safe");
    assert.match(recursiveDot, /label="a - \(b - c\)"/);
  });

  test("recursive precedence does not parenthesize atomic siblings", () => {
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
        { id: "root", kind: "query", dsl_type: "Add", label: "root: Add", range: { start: 4, end: 5 }, inputs: ["a", "b"] }
      ],
      edges: [
        { from: "root", to: "a", kind: "operand", index: 0 },
        { from: "root", to: "b", kind: "operand", index: 1 }
      ],
      roots: ["root"],
      constraints: [],
      action_effects: [],
      seed_facts: [],
      display_templates: [
        { variant_name: "A", template: "a", fields: [] },
        { variant_name: "B", template: "b", fields: [] },
        { variant_name: "Add", template: "{lhs} + {rhs}", fields: ["lhs", "rhs"] }
      ],
      typst_templates: [],
      precedence_templates: [
        { variant_name: "Add", precedence: 10 }
      ],
      diagnostics: []
    };

    const recursiveDot = patternIrToDotWithMode(ir, "pattern", "recursive", "tree-safe");
    assert.match(recursiveDot, /label="a \+ b"/);
    assert.doesNotMatch(recursiveDot, /label="\((a|b)\) \+ \((a|b)\)"/);
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
