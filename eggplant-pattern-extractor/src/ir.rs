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
    AddRulePatternClosure,
    PatternFunction,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScopeInfo {
    pub kind: ScopeKind,
    pub text_range: TextSpan,
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
    pub label: String,
    pub range: TextSpan,
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
    pub diagnostics: Vec<Diagnostic>,
}
