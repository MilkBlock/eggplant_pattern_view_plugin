export interface TextSpan {
  start: number;
  end: number;
}

export interface ScopeInfo {
  kind: "add_rule_call" | "pattern_function";
  text_range: TextSpan;
  pattern_range: TextSpan | null;
  action_range: TextSpan | null;
}

export interface PatternNode {
  id: string;
  kind: "query" | "query_leaf";
  dsl_type: string;
  label: string;
  range: TextSpan;
  inputs: string[];
}

export interface PatternEdge {
  from: string;
  to: string;
  kind: string;
  index: number;
}

export interface PatternConstraint {
  id: string;
  source_text: string;
  resolved_text: string;
  semantic_text?: string | null;
  referenced_vars: string[];
  range: TextSpan;
}

export interface ActionEffect {
  id: string;
  effect_id: string;
  bound_var: string | null;
  source_text: string;
  semantic_text?: string | null;
  referenced_pat_vars: string[];
  referenced_action_vars: string[];
  range: TextSpan;
}

export interface SeedFact {
  id: string;
  source_text: string;
  committed_root: string;
  referenced_vars: string[];
  range: TextSpan;
}

export interface DisplayTemplate {
  variant_name: string;
  template: string;
  fields: string[];
}

export interface TypstTemplate {
  variant_name: string;
  template: string;
  fields: string[];
}

export interface PrecedenceTemplate {
  variant_name: string;
  precedence: number;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  range: TextSpan | null;
}

export interface MathViewEntry {
  target_id: string;
  label: string;
  plain_source: string;
  colored_source: string;
}

export type MathViewConclusion =
  | {
      kind: "rewrite";
      id: string;
      from: MathViewEntry;
      to: MathViewEntry;
    }
  | {
      kind: "derive";
      id: string;
      entry: MathViewEntry;
    };

export interface MathViewFormulaSource {
  plain: string;
  colored: string;
}

export interface MathViewModel {
  rule_name: string;
  premises: MathViewEntry[];
  side_conditions: string[];
  derivations: MathViewEntry[];
  conclusions: MathViewConclusion[];
  formula_source: MathViewFormulaSource;
}

export interface PatternIr {
  scope: ScopeInfo;
  nodes: PatternNode[];
  edges: PatternEdge[];
  roots: string[];
  constraints: PatternConstraint[];
  action_effects: ActionEffect[];
  seed_facts: SeedFact[];
  display_templates: DisplayTemplate[];
  typst_templates: TypstTemplate[];
  precedence_templates: PrecedenceTemplate[];
  diagnostics: Diagnostic[];
  math_view?: MathViewModel | null;
}
