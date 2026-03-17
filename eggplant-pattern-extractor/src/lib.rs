pub mod extractor;
pub mod ir;

pub use extractor::{ExtractOptions, extract_pattern};
pub use ir::{
    Diagnostic, PatternConstraint, PatternEdge, PatternIr, PatternNode, ScopeInfo, ScopeKind,
    TextSpan,
};
