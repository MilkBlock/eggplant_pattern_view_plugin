import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { suite, test } from "mocha";
import { collectTypstReplacementSources, compactConstraintLabel, inlineConstraintAnnotation, patternIrToDot, patternIrToDotWithMode } from "../../dot";
import { PatternIr } from "../../ir";
import { mergeExternalMetadata, metadataCacheMatches, metadataSourceMatchesIdentifiers } from "../../metadataSources";
import {
  buildTraceSourcePreview,
  indexActionEffectsByStableId,
  normalizeActionRecoveryMode,
  resolveTraceEventEffect,
  resolveDynamicActionRecoveryPolicy,
  summarizeRuntimeActionSampleTrace
} from "../../actionRecovery";
import { normalizeTypstMathSource, renderTypstSnippets } from "../../typst";
import { resolveEggPreviewOffset } from "../../eggRuleMapping";

const WORKSPACE_ROOT = path.resolve(__dirname, "../../../../");
const FIXTURE_PATH = path.resolve(WORKSPACE_ROOT, "samples", "pattern_samples.rs");
const RELATION_FIXTURE_PATH = path.resolve(WORKSPACE_ROOT, "samples", "relation.rs");
const FIBONACCI_FUNC_FIXTURE_PATH = path.resolve(WORKSPACE_ROOT, "samples", "fibonacci_func.rs");
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

  test("trace source preview reorders action effects by trace events", () => {
    const preview = buildTraceSourcePreview(
      {
        version: 1,
        events: [
          {
            Union: {
              event_id: "evt_1",
              effect_id: "effect@30:44",
              lhs_debug: "lhs",
              rhs_debug: "rhs"
            }
          },
          {
            DynamicUnknown: {
              event_id: "evt_2",
              effect_id: "effect@10:24",
              reason: "branch not sampled"
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

    assert.ok(preview);
    assert.deepEqual(
      preview?.actionEffects.map((effect) => effect.id),
      ["trace:evt_1", "trace:evt_2"]
    );
    assert.equal(preview?.actionEffects[1].source_text, "dynamic-unknown: branch not sampled");
    assert.match(preview?.summary ?? "", /source=trace/);
  });

  test("trace source preview falls back to source ranges for nested inline calls", () => {
    const effects = [
      {
        id: "effect_0",
        effect_id: "effect@337:400",
        bound_var: null,
        source_text: "ctx.union(pat.bop, ctx.insert_bop(\"Add\", pat.y.val, pat.x.val))",
        referenced_pat_vars: ["bop", "x", "y"],
        referenced_action_vars: ["tmp_0"],
        range: { start: 337, end: 400 }
      },
      {
        id: "effect_1",
        effect_id: "effect@356:399",
        bound_var: "tmp_0",
        source_text: "ctx.insert_bop(\"Add\", pat.y.val, pat.x.val)",
        referenced_pat_vars: ["x", "y"],
        referenced_action_vars: [],
        range: { start: 356, end: 399 }
      }
    ] satisfies PatternIr["action_effects"];

    const preview = buildTraceSourcePreview(
      {
        version: 1,
        events: [
          {
            Insert: {
              event_id: "evt_insert",
              effect_id: "effect@line:12",
              source_range: { start: 356, end: 399 }
            }
          },
          {
            Union: {
              event_id: "evt_union",
              effect_id: "effect@line:13",
              source_range: { start: 337, end: 400 }
            }
          }
        ]
      },
      effects
    );

    assert.ok(preview);
    assert.deepEqual(
      preview?.actionEffects.map((effect) => effect.source_text),
      [
        "ctx.insert_bop(\"Add\", pat.y.val, pat.x.val)",
        "ctx.union(pat.bop, ctx.insert_bop(\"Add\", pat.y.val, pat.x.val))"
      ]
    );
    assert.match(preview?.summary ?? "", /matched=2/);
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

  test("extractor emits JSON for add_rule_with_hook closure scope", () => {
    const source = `
#[eggplant::pat_vars]
struct DemoPat<PR: PatRecSgl> {
  l: Const,
  r: Const,
  p: Add,
}

fn demo_pat<PR: PatRecSgl>() -> DemoPat<PR> {
  let l = Const::query();
  let r = Const::query();
  let p = Add::query(&l, &r);
  DemoPat::new(l, r, p)
}

fn demo(use_mul: bool, recorder: ActionSampleRecorder) {
  DemoTx::add_rule_with_hook(
    "dynamic_action_trace_demo_rule",
    ruleset,
    demo_pat,
    move |ctx, pat| {
      if use_mul {
        let two = ctx.insert_trace_const(2);
        let mul = ctx.insert_trace_mul(pat.r, two);
        ctx.union(pat.p, mul);
      } else {
        let one = ctx.insert_trace_const(1);
        let add = ctx.insert_trace_add(pat.l, one);
        ctx.union(pat.p, add);
      }
    },
    Box::new(recorder),
  );
}
`;
    const offset = source.indexOf("let add = ctx.insert_trace_add(pat.l, one);");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;
    assert.equal(ir.scope.kind, "add_rule_call");
    assert.ok(ir.scope.action_range);
    assert.ok(ir.scope.pattern_range);
    assert.ok(ir.action_effects.length >= 2);
  });

  test(".egg rule cursor mapping selects the matching transpiled add_rule ordinal", () => {
    const eggSource = [
      "(ruleset demo)",
      "(datatype Math (Num i64) (Add Math Math) (Mul Math Math))",
      "(rewrite (Add a (Num 0)) a :ruleset demo)",
      "(rewrite (Mul a (Num 1)) a :ruleset demo)",
    ].join("\n");

    const generatedRust = [
      "fn main() {",
      "  MyTx::add_rule(\"rule_add\", demo, || { /* add */ }, |ctx, pat| { ctx.union(pat.add_node1, pat.a); });",
      "  MyTx::add_rule(\"rule_mul\", demo, || { /* mul */ }, |ctx, pat| { ctx.union(pat.mul_node1, pat.a); });",
      "}",
    ].join("\n");

    const addRuleOffsets = Array.from(generatedRust.matchAll(/add_rule(?:_with_hook)?\s*\(/g)).map((match) => match.index ?? 0);
    assert.equal(addRuleOffsets.length, 2);

    const addRuleEggOffset = eggSource.indexOf("(rewrite (Add a (Num 0))");
    const mulRuleEggOffset = eggSource.indexOf("(rewrite (Mul a (Num 1))");
    assert.notEqual(addRuleEggOffset, -1);
    assert.notEqual(mulRuleEggOffset, -1);

    assert.equal(resolveEggPreviewOffset(eggSource, addRuleEggOffset, generatedRust), addRuleOffsets[0]);
    assert.equal(resolveEggPreviewOffset(eggSource, mulRuleEggOffset, generatedRust), addRuleOffsets[1]);
  });

  test("inline nested action calls get synthetic tmp bindings and separate graph nodes", () => {
    const source = `
fn demo() {
  MyTx::add_rule("demo", ruleset, || {
    let x = Expr::query_leaf();
    let y = Expr::query_leaf();
    let bop = Bop::query(&x, &y);
    DemoPat::new(x, y, bop)
  }, |ctx, pat| {
    ctx.union(pat.bop, ctx.insert_bop("Add", pat.y.val, pat.x.val));
  });
}
`;
    const offset = source.indexOf("ctx.union(pat.bop, ctx.insert_bop(");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;
    const inlineInsert = ir.action_effects.find(
      (effect) => effect.source_text === `ctx.insert_bop("Add", pat.y.val, pat.x.val)`
    );
    const union = ir.action_effects.find(
      (effect) => effect.source_text === `ctx.union(pat.bop, ctx.insert_bop("Add", pat.y.val, pat.x.val))`
    );

    assert.ok(inlineInsert);
    assert.equal(inlineInsert?.bound_var, "tmp_0");
    assert.ok(union);
    assert.deepEqual(union?.referenced_action_vars, ["tmp_0"]);

    const dot = patternIrToDotWithMode(ir, "action", "full");
    assert.match(dot, /Bop\(\\"Add\\", pat\.y\.val, pat\.x\.val\)/);
    assert.match(dot, /ctx\.union\(pat\.bop, ctx\.insert_bop\(\\\"Add\\\", pat\.y\.val, pat\.x\.val\)\)/);
    assert.match(dot, /"effect:effect_[0-9]+" -> "effect:effect_[0-9]+"/);
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

  test("copied relation sample stays covered by headless extraction flow", () => {
    const source = fs.readFileSync(RELATION_FIXTURE_PATH, "utf8");
    const offset = source.indexOf("let edge = Edge::query();");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    assert.deepEqual(ir.roots, ["edge"]);
    assert.equal(ir.nodes.length, 1);
    assert.equal(ir.nodes[0].dsl_type, "Edge");
    assert.equal(ir.seed_facts.length, 2);
    assert.deepEqual(
      ir.seed_facts.map((fact) => fact.source_text),
      ["Edge::<RelTx>::insert(1, 2)", "Edge::<RelTx>::insert(2, 3)"]
    );
  });

  test("extractor supports typed relation query surface", () => {
    const source = `
fn demo() {
  MyTx::add_rule("typed_relation", ruleset, || {
    let edge = Edge::query();
    let reach = Reach::query_fields(&edge.src, &edge.dst);
    let eq = edge.handle_src().eq(&edge.handle_dst());
    ReachPat::new(edge, reach).assert(eq)
  }, |ctx, pat| {
    let src = ctx.devalue(pat.edge.src);
    let dst = ctx.devalue(pat.edge.dst);
    ctx.insert_reach(src, dst);
  });
}
`;
    const offset = source.indexOf("Reach::query_fields");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    assert.deepEqual(ir.roots, ["edge", "reach"]);
    assert.equal(ir.nodes.length, 2);
    assert.deepEqual(
      ir.nodes.map((node) => ({ id: node.id, dsl_type: node.dsl_type, inputs: node.inputs })),
      [
        { id: "edge", dsl_type: "Edge", inputs: [] },
        { id: "reach", dsl_type: "Reach", inputs: ["edge", "edge"] }
      ]
    );
    assert.equal(ir.constraints.length, 1);
    assert.equal(ir.constraints[0].resolved_text, "edge.handle_src().eq(&edge.handle_dst())");
    assert.deepEqual(ir.constraints[0].referenced_vars, ["edge"]);
    assert.equal(ir.action_effects.length, 1);
    assert.deepEqual(ir.action_effects[0].referenced_pat_vars, ["edge"]);
  });

  test("action view renders func read calls as nodes", () => {
    const source = `
fn demo() {
  let add_1_2_key = Value::new(MyTx::canonical_raw(&add_1_2));
  let add_1_3_key = Value::new(MyTx::canonical_raw(&add_1_3));
  MyTx::add_rule("read_complex_output", ruleset, || {
    #[eggplant::pat_vars_catch]
    struct Unit {}
  }, move |ctx, _pat| {
    let out_v = ctx.read_lead_to(add_1_2_key);
    let missing = ctx.try_read_lead_to(add_1_3_key);
    println!("{:?} {:?}", out_v, missing);
  });
}
`;
    const offset = source.indexOf("ctx.read_lead_to");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    assert.deepEqual(
      ir.action_effects.map((effect) => ({
        boundVar: effect.bound_var,
        source: effect.source_text
      })),
      [
        { boundVar: "out_v", source: "ctx.read_lead_to(add_1_2_key)" },
        { boundVar: "missing", source: "ctx.try_read_lead_to(add_1_3_key)" }
      ]
    );

    const dot = patternIrToDotWithMode(ir, "action", "full");
    assert.match(dot, /Action Effects/);
    assert.match(dot, /ctx\.read_lead_to\(add_1_2_key\)/);
    assert.match(dot, /ctx\.try_read_lead_to\(add_1_3_key\)/);
  });

  test("multiline insert action labels drop insert_ prefix", () => {
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
          effect_id: "effect@10:40",
          bound_var: "ifnode",
          source_text: `ctx.insert_if_node(
              pat.if_eclass,
              pat.pred,
              pat.inputs,
              pat.then_branch,
              pat.else_branch,
          )`,
          referenced_pat_vars: ["if_eclass", "pred", "inputs", "then_branch", "else_branch"],
          referenced_action_vars: [],
          range: { start: 10, end: 40 }
        }
      ],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const dot = patternIrToDotWithMode(ir, "action", "compact");
    assert.match(dot, /label="IfNode\(/);
    assert.doesNotMatch(dot, /insert_if_node/);
  });

  test("action labels treat devalue as transparent bridge instead of visible syntax", () => {
    const ir: PatternIr = {
      scope: {
        kind: "add_rule_call",
        text_range: { start: 0, end: 20 },
        pattern_range: { start: 0, end: 8 },
        action_range: { start: 9, end: 20 }
      },
      nodes: [
        { id: "arg_get", kind: "query", dsl_type: "Get", label: "arg_get: Get", range: { start: 0, end: 1 }, inputs: [] }
      ],
      edges: [],
      roots: ["arg_get"],
      constraints: [],
      action_effects: [
        {
          id: "effect_0",
          effect_id: "effect@10:24",
          bound_var: "original_get_index",
          source_text: "ctx.insert_single(ctx.insert_get(tmp_arg, ctx.devalue(pat.arg_get.index)))",
          referenced_pat_vars: ["arg_get"],
          referenced_action_vars: ["tmp_arg"],
          range: { start: 10, end: 24 }
        }
      ],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const dot = patternIrToDotWithMode(ir, "action", "compact");
    assert.doesNotMatch(dot, /devalue/);
    assert.match(dot, /Single\(insert_get\(tmp_arg, arg_get.index\)\)/);
  });

  test("dot renders typed relation aggregate nodes and projected query-field edges", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 20 },
        pattern_range: { start: 0, end: 20 },
        action_range: null
      },
      nodes: [
        { id: "edge", kind: "query", dsl_type: "Edge", label: "edge: Edge", range: { start: 0, end: 4 }, inputs: [] },
        { id: "reach", kind: "query", dsl_type: "Reach", label: "reach: Reach", range: { start: 5, end: 10 }, inputs: ["edge", "edge"] }
      ],
      edges: [
        { from: "reach", to: "edge", kind: "input", index: 0 },
        { from: "reach", to: "edge", kind: "input", index: 1 }
      ],
      roots: ["edge", "reach"],
      constraints: [],
      action_effects: [],
      seed_facts: [],
      display_templates: [],
      typst_templates: [],
      precedence_templates: [],
      diagnostics: []
    };

    const dot = patternIrToDotWithMode(ir, "pattern", "compact");
    assert.match(dot, /"edge" \[label="Edge"/);
    assert.match(dot, /"reach" \[label="Reach"/);
    assert.match(dot, /"reach" -> "edge" \[label="0"\];/);
    assert.match(dot, /"reach" -> "edge" \[label="1"\];/);
  });

  test("extractor exports typed relation seed inserts and dot renders them as seed facts", () => {
    const source = fs.readFileSync(RELATION_FIXTURE_PATH, "utf8");
    const offset = source.indexOf("let edge = Edge::query();");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    assert.deepEqual(ir.roots, ["edge"]);
    assert.equal(ir.seed_facts.length, 2);
    assert.deepEqual(
      ir.seed_facts.map((fact) => fact.source_text),
      ["Edge::<RelTx>::insert(1, 2)", "Edge::<RelTx>::insert(2, 3)"]
    );

    const dot = patternIrToDotWithMode(ir, "combined", "full");
    assert.match(dot, /label="Seed Facts"/);
    assert.match(dot, /Edge::<RelTx>::insert\(1, 2\)/);
    assert.match(dot, /Edge::<RelTx>::insert\(2, 3\)/);
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

  test("metadata source matching detects relevant DSL enums and variants", () => {
    const source = `
#[eggplant::dsl]
enum SharedMath {
  #[eggplant::typst("integral {f} quad d {x}")]
  SharedIntegral { f: SharedMath, x: SharedMath },
}
`;
    assert.equal(metadataSourceMatchesIdentifiers(source, new Set(["SharedMath"])), true);
    assert.equal(metadataSourceMatchesIdentifiers(source, new Set(["SharedIntegral"])), true);
    assert.equal(metadataSourceMatchesIdentifiers(source, new Set(["OtherDsl"])), false);
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

    assert.equal(sqrtFive?.source, 'sqrt(upright("five"))');
    assert.equal(denom?.source, 'frac(1, (frac((1 + sqrt(upright("five"))), 2)  - frac((1 - sqrt(upright("five"))), 2) )) ');

    const renderings = await renderTypstSnippets(
      typstSources.filter((entry) => entry.targetId === "effect:effect_33" || entry.targetId === "effect:effect_41")
    );
    assert.ok(renderings["effect:effect_33"]);
    assert.ok(renderings["effect:effect_41"]);
  });

  test("typst sources quote multi-letter pattern leaves so root formulas still render", async () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "x", kind: "query_leaf", dsl_type: "Math", label: "x: Math", range: { start: 0, end: 1 }, inputs: [] },
        { id: "one", kind: "query", dsl_type: "MConst", label: "one: MConst", range: { start: 2, end: 5 }, inputs: [] },
        { id: "integ", kind: "query", dsl_type: "MIntegral", label: "integ: MIntegral", range: { start: 6, end: 11 }, inputs: ["one", "x"] }
      ],
      edges: [
        { from: "integ", to: "one", kind: "operand", index: 0 },
        { from: "integ", to: "x", kind: "operand", index: 1 }
      ],
      roots: ["integ"],
      constraints: [],
      action_effects: [],
      seed_facts: [],
      display_templates: [],
      typst_templates: [
        { variant_name: "MIntegral", template: "integral {f} quad d {x}", fields: ["f", "x"] }
      ],
      precedence_templates: [{ variant_name: "MIntegral", precedence: 90 }],
      diagnostics: []
    };

    const typstSources = collectTypstReplacementSources(ir, "pattern", "compact");
    assert.deepEqual(typstSources, [{ targetId: "integ", source: 'integral upright("one") quad d x' }]);

    const renderings = await renderTypstSnippets(typstSources);
    assert.ok(renderings.integ);
  });

  test("typst rendering falls back to plain text for non-math-safe raw DSL strings", async () => {
    const renderings = await renderTypstSnippets([
      {
        targetId: "complex-raw",
        source: '(get arg ("tmp_type", "in_func"(no-ctx))[if_len + len])'
      }
    ]);

    assert.ok(renderings["complex-raw"]);
    assert.ok(renderings["complex-raw"].width > 0);
    assert.ok(renderings["complex-raw"].height > 0);
  });

  test("typst text fallback strips internal upright wrappers from displayed text", async () => {
    const renderings = await renderTypstSnippets([
      {
        targetId: "upright-fallback",
        source: 'fib(upright("x1")) = ???'
      }
    ]);

    assert.ok(renderings["upright-fallback"]);
    assert.equal(renderings["upright-fallback"].mode, "text-fallback");
  });

  test("func typst templates are parsed and rendered for function-table query nodes", () => {
    const source = fs.readFileSync(FIBONACCI_FUNC_FIXTURE_PATH, "utf8");
    const offset = source.indexOf("ctx.set_fib(x2, f0 + f1);");
    assert.notEqual(offset, -1);

    const result = spawnSync(EXTRACTOR_PATH, ["--offset", String(offset)], {
      cwd: WORKSPACE_ROOT,
      input: source,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const ir = JSON.parse(result.stdout) as PatternIr;

    const fibTypst = ir.typst_templates.find((template) => template.variant_name === "fib");
    assert.ok(fibTypst);
    assert.equal(fibTypst?.template, "fib({x})");
    assert.deepEqual(fibTypst?.fields, ["x"]);

    const dot = patternIrToDotWithMode(ir, "pattern", "compact", "dag-expand");
    assert.match(dot, /"f0" \[label="fib\(x\)"/);
    assert.match(dot, /"f1" \[label="fib\(x1\)"/);

    const actionDot = patternIrToDotWithMode(ir, "action", "compact", "dag-expand");
    assert.match(actionDot, /label="fib\(x2\) = f0 \+ f1"/);

    const typstSources = collectTypstReplacementSources(ir, "combined", "compact", "dag-expand");
    const f1Source = typstSources.find((entry) => entry.targetId === "f1");
    const actionSource = typstSources.find((entry) => entry.targetId === "effect:effect_0");
    assert.equal(f1Source?.source, "fib(x1)");
    assert.equal(actionSource?.source, "fib(x2) = f0 + f1");
  });

  test("typst sources treat field access chains as math-safe atomic text", async () => {
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
          effect_id: "effect@10:20",
          bound_var: "out",
          source_text: "ctx.insert_get(tmp_arg, ctx.devalue(pat.arg_arg_get.index))",
          referenced_pat_vars: [],
          referenced_action_vars: [],
          range: { start: 10, end: 20 }
        }
      ],
      seed_facts: [],
      display_templates: [],
      typst_templates: [
        { variant_name: "Get", template: "{base} + {index}", fields: ["base", "index"] }
      ],
      precedence_templates: [{ variant_name: "Get", precedence: 90 }],
      diagnostics: []
    };

    const typstSources = collectTypstReplacementSources(ir, "action", "compact");
    assert.deepEqual(typstSources, [{ targetId: "effect:effect_0", source: 'upright("tmp_arg") + upright("arg_arg_get.index")' }]);

    const renderings = await renderTypstSnippets(typstSources);
    assert.ok(renderings["effect:effect_0"]);
    assert.equal(renderings["effect:effect_0"].mode, "math");
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
    assert.equal(/lhs\.handle\(\)\.eq/.test(dot), false);
    assert.equal(/constraint:constraint_0/.test(dot), false);
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

  test("full action labels suppress ctx.devalue wrappers in insert args", () => {
    const ir: PatternIr = {
      scope: {
        kind: "add_rule_call",
        text_range: { start: 0, end: 20 },
        pattern_range: { start: 0, end: 8 },
        action_range: { start: 9, end: 20 }
      },
      nodes: [
        {
          id: "arg_get",
          kind: "query",
          dsl_type: "Get",
          label: "arg_get: Get",
          range: { start: 0, end: 1 },
          inputs: []
        }
      ],
      edges: [],
      roots: ["arg_get"],
      constraints: [],
      action_effects: [
        {
          id: "effect_0",
          effect_id: "effect@10:12",
          bound_var: "original_get_index",
          source_text: "ctx.insert_get(tmp_arg, ctx.devalue(pat.arg_get.index))",
          referenced_pat_vars: ["arg_get"],
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

    const fullDot = patternIrToDotWithMode(ir, "action", "full");
    assert.match(fullDot, /Get\(tmp_arg, pat\.arg_get\.index\)/);
    assert.doesNotMatch(fullDot, /devalue\(/);
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

    assert.match(compactDot, /label="DisplayMath\\n= rhs"/);
    assert.match(compactDot, /label="union\(lhs, rhs\)"/);
    assert.match(compactDot, /label="expr\.commit\(\)"/);
    assert.equal(compactConstraintLabel("lhs_eq_rhs", "lhs.handle().eq(&rhs.handle())"), "lhs == rhs");

    assert.match(fullDot, /label="lhs: DisplayMath\\n= rhs"/);
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
      assert.equal(compactConstraintLabel("constraint_alias", resolvedText), expectedLabel);
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

    assert.equal(
      compactConstraintLabel("lhs.custom_constraint(rhs)", "lhs.handle().custom_constraint(&rhs.handle())"),
      "lhs.custom_constraint(rhs) [raw]"
    );
  });

  test("simple handle equality constraints become node annotations", () => {
    const annotation = inlineConstraintAnnotation({
      id: "constraint_0",
      source_text: "else1_is_second",
      resolved_text: "else1.handle_index().eq(&(&1_i64).as_handle())",
      referenced_vars: ["else1"],
      range: { start: 0, end: 10 }
    });
    assert.deepEqual(annotation, {
      nodeId: "else1",
      fieldName: "index",
      valueText: "1_i64",
      displayText: "index = 1_i64",
      hideInSidebar: true
    });
  });

  test("simple direct constant equality constraints become node annotations", () => {
    const annotation = inlineConstraintAnnotation({
      id: "constraint_0",
      source_text: "edge_src_is_one",
      resolved_text: "edge.handle_src().eq(&1_i64)",
      referenced_vars: ["edge"],
      range: { start: 0, end: 10 }
    });
    assert.deepEqual(annotation, {
      nodeId: "edge",
      fieldName: "src",
      valueText: "1_i64",
      displayText: "src = 1_i64",
      hideInSidebar: true
    });
  });

  test("simple handle-to-handle equality constraints become node annotations", () => {
    const annotation = inlineConstraintAnnotation({
      id: "constraint_0",
      source_text: "l_r_eq",
      resolved_text: "l.handle().eq(&r.handle())",
      referenced_vars: ["l", "r"],
      range: { start: 0, end: 10 }
    });
    assert.deepEqual(annotation, {
      nodeId: "l",
      fieldName: null,
      valueText: "r",
      displayText: "= r",
      hideInSidebar: true
    });
  });

  test("small binary handle arithmetic constraints become node annotations", () => {
    const annotation = inlineConstraintAnnotation({
      id: "constraint_0",
      source_text: "x1_constraint",
      resolved_text: "x1.handle().eq(&(x.handle() + (&1_i64).as_handle()))",
      referenced_vars: ["x1", "x"],
      range: { start: 0, end: 10 }
    });
    assert.deepEqual(annotation, {
      nodeId: "x1",
      fieldName: null,
      valueText: "x + 1_i64",
      displayText: "= x + 1_i64",
      hideInSidebar: true
    });
  });

  test("3-var handle arithmetic constraints stay in sidebar", () => {
    const annotation = inlineConstraintAnnotation({
      id: "constraint_0",
      source_text: "x2_constraint",
      resolved_text: "x2.handle().eq(&(x.handle() + y.handle()))",
      referenced_vars: ["x2", "x", "y"],
      range: { start: 0, end: 10 }
    });
    assert.equal(annotation, null);
  });

  test("simple relation field handle-equality joins become node annotations", () => {
    const annotation = inlineConstraintAnnotation({
      id: "constraint_0",
      source_text: "join",
      resolved_text: "path.handle_dst().eq(&edge.handle_src())",
      referenced_vars: ["path", "edge"],
      range: { start: 0, end: 10 }
    });
    assert.deepEqual(annotation, {
      nodeId: "path",
      fieldName: "dst",
      valueText: "edge.src",
      displayText: "dst = edge.src",
      hideInSidebar: true
    });
  });

  test("simple arithmetic handle equality constraints become node annotations", () => {
    const annotation = inlineConstraintAnnotation({
      id: "constraint_0",
      source_text: "x1_constraint",
      resolved_text: "x1.handle().eq(&(x.handle() + (&1_i64).as_handle()))",
      referenced_vars: ["x", "x1"],
      range: { start: 0, end: 10 }
    });
    assert.deepEqual(annotation, {
      nodeId: "x1",
      fieldName: null,
      valueText: "x + 1_i64",
      displayText: "= x + 1_i64",
      hideInSidebar: true
    });
  });

  test("dot labels inline simple constant constraints onto nodes", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "else1", kind: "query", dsl_type: "ElseBranch", label: "else1: ElseBranch", range: { start: 0, end: 1 }, inputs: [] }
      ],
      edges: [],
      roots: ["else1"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "else1_is_second",
          resolved_text: "else1.handle_index().eq(&(&1_i64).as_handle())",
          referenced_vars: ["else1"],
          range: { start: 2, end: 8 }
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
    assert.match(dot, /"else1" \[label="ElseBranch\\nindex = 1_i64"/);
  });

  test("dot labels inline handle-to-handle equality constraints onto nodes", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "l", kind: "query", dsl_type: "Const", label: "l: Const", range: { start: 0, end: 1 }, inputs: [] },
        { id: "r", kind: "query", dsl_type: "Const", label: "r: Const", range: { start: 2, end: 3 }, inputs: [] }
      ],
      edges: [],
      roots: ["l", "r"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "l_r_eq",
          resolved_text: "l.handle().eq(&r.handle())",
          referenced_vars: ["l", "r"],
          range: { start: 4, end: 8 }
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
    assert.match(dot, /"l" \[label="Const\\n= r"/);
  });

  test("dot labels inline simple relation handle-join constraints onto left node", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "path", kind: "query", dsl_type: "Path", label: "path: Path", range: { start: 0, end: 1 }, inputs: [] },
        { id: "edge", kind: "query", dsl_type: "Edge", label: "edge: Edge", range: { start: 2, end: 3 }, inputs: [] }
      ],
      edges: [],
      roots: ["path", "edge"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "join",
          resolved_text: "path.handle_dst().eq(&edge.handle_src())",
          referenced_vars: ["path", "edge"],
          range: { start: 4, end: 8 }
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
    assert.match(dot, /"path" \[label="Path\\ndst = edge\.src"/);
    assert.doesNotMatch(dot, /join/);
  });

  test("dot labels inline simple arithmetic handle constraints onto nodes", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "x", kind: "query_leaf", dsl_type: "i64", label: "x: i64", range: { start: 0, end: 1 }, inputs: [] },
        { id: "x1", kind: "query_leaf", dsl_type: "i64", label: "x1: i64", range: { start: 2, end: 3 }, inputs: [] }
      ],
      edges: [],
      roots: ["x", "x1"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "x1_constraint",
          resolved_text: "x1.handle().eq(&(x.handle() + (&1_i64).as_handle()))",
          referenced_vars: ["x", "x1"],
          range: { start: 4, end: 8 }
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
    assert.match(dot, /"x1" \[label="i64\\n= x \+ 1_i64"/);
    assert.doesNotMatch(dot, /x1_constraint/);
  });

  test("dot labels inline arithmetic constraints onto standalone root nodes", () => {
    const ir: PatternIr = {
      scope: {
        kind: "add_rule_call",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "f0", kind: "query", dsl_type: "fib", label: "f0: fib", range: { start: 0, end: 1 }, inputs: ["x"] },
        { id: "f1", kind: "query", dsl_type: "fib", label: "f1: fib", range: { start: 2, end: 3 }, inputs: ["x1"] }
      ],
      edges: [
        { from: "f0", to: "x", kind: "operand", index: 0 },
        { from: "f1", to: "x1", kind: "operand", index: 0 }
      ],
      roots: ["x", "x1", "x2", "f0", "f1"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "x1_constraint",
          resolved_text: "x1.handle().eq(&(x.handle() + (&1_i64).as_handle()))",
          referenced_vars: ["x", "x1"],
          range: { start: 4, end: 8 }
        },
        {
          id: "constraint_1",
          source_text: "x2_constraint",
          resolved_text: "x2.handle().eq(&(x.handle() + (&2_i64).as_handle()))",
          referenced_vars: ["x", "x2"],
          range: { start: 9, end: 13 }
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
    assert.match(dot, /"x1" \[label="x1\\n= x \+ 1_i64"/);
    assert.match(dot, /"x2" \[label="x2\\n= x \+ 2_i64"/);
    assert.doesNotMatch(dot, /x1_constraint|x2_constraint/);
  });

  test("typst replacement keeps annotated nodes as overlay candidates", () => {
    const ir: PatternIr = {
      scope: {
        kind: "pattern_function",
        text_range: { start: 0, end: 10 },
        pattern_range: { start: 0, end: 10 },
        action_range: null
      },
      nodes: [
        { id: "else1", kind: "query", dsl_type: "ElseBranch", label: "else1: ElseBranch", range: { start: 0, end: 1 }, inputs: [] }
      ],
      edges: [],
      roots: ["else1"],
      constraints: [
        {
          id: "constraint_0",
          source_text: "else1_is_second",
          resolved_text: "else1.handle_index().eq(&1_i64)",
          referenced_vars: ["else1"],
          range: { start: 2, end: 8 }
        }
      ],
      action_effects: [],
      seed_facts: [],
      display_templates: [],
      typst_templates: [{ variant_name: "ElseBranch", template: "ElseBranch", fields: [] }],
      precedence_templates: [],
      diagnostics: []
    };

    const replacements = collectTypstReplacementSources(ir, "pattern", "compact");
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].targetId, "else1");
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
