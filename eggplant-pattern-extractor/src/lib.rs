pub mod extractor;
pub mod ir;

pub use extractor::{ExtractOptions, extract_pattern};
pub use ir::{
    ActionEffect, Diagnostic, PatternConstraint, PatternEdge, PatternIr, PatternNode, ScopeInfo,
    ScopeKind, SeedFact, TextSpan,
};
