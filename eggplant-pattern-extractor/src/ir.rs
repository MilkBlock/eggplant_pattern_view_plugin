use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct TextSpan {
    pub start: usize,
    pub end: usize,
}

impl TextSpan {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    AddRuleCall,
    PatternFunction,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScopeInfo {
    pub kind: ScopeKind,
    pub text_range: TextSpan,
    pub pattern_range: Option<TextSpan>,
    pub action_range: Option<TextSpan>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Query,
    QueryLeaf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PatternNode {
    pub id: String,
    pub kind: NodeKind,
    pub dsl_type: String,
    pub label: String,
    pub range: TextSpan,
    pub inputs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PatternEdge {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub index: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PatternConstraint {
    pub id: String,
    pub source_text: String,
    pub resolved_text: String,
    pub semantic_text: Option<String>,
    pub referenced_vars: Vec<String>,
    pub range: TextSpan,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ActionEffect {
    pub id: String,
    pub effect_id: String,
    pub bound_var: Option<String>,
    pub source_text: String,
    pub semantic_text: Option<String>,
    pub referenced_pat_vars: Vec<String>,
    pub referenced_action_vars: Vec<String>,
    pub range: TextSpan,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SeedFact {
    pub id: String,
    pub source_text: String,
    pub committed_root: String,
    pub referenced_vars: Vec<String>,
    pub range: TextSpan,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DisplayTemplate {
    pub variant_name: String,
    pub template: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TypstTemplate {
    pub variant_name: String,
    pub template: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PrecedenceTemplate {
    pub variant_name: String,
    pub precedence: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: Severity,
    pub message: String,
    pub range: Option<TextSpan>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PatternIr {
    pub scope: ScopeInfo,
    pub nodes: Vec<PatternNode>,
    pub edges: Vec<PatternEdge>,
    pub roots: Vec<String>,
    pub constraints: Vec<PatternConstraint>,
    pub action_effects: Vec<ActionEffect>,
    pub seed_facts: Vec<SeedFact>,
    pub display_templates: Vec<DisplayTemplate>,
    pub typst_templates: Vec<TypstTemplate>,
    pub precedence_templates: Vec<PrecedenceTemplate>,
    pub diagnostics: Vec<Diagnostic>,
}
