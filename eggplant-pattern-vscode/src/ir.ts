export interface TextSpan {
  start: number;
  end: number;
}

export interface ScopeInfo {
  kind: "add_rule_pattern_closure" | "pattern_function";
  text_range: TextSpan;
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
  referenced_vars: string[];
  range: TextSpan;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  range: TextSpan | null;
}

export interface PatternIr {
  scope: ScopeInfo;
  nodes: PatternNode[];
  edges: PatternEdge[];
  roots: string[];
  constraints: PatternConstraint[];
  diagnostics: Diagnostic[];
}
