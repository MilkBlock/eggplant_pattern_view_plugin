pub mod extractor;
pub mod ir;
pub mod project_detector;

pub use extractor::{ExtractOptions, extract_pattern};
pub use ir::{
    ActionEffect, Diagnostic, DisplayTemplate, PatternConstraint, PatternEdge, PatternIr,
    PatternNode, PrecedenceTemplate, ScopeInfo, ScopeKind, SeedFact, TextSpan, TypstTemplate,
};

#[cfg(target_arch = "wasm32")]
use ra_ap_syntax::Edition;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn extract_pattern_json(source: &str, offset: usize, edition: Option<String>) -> Result<String, JsValue> {
    let parsed_edition = edition
        .as_deref()
        .and_then(|value| value.parse::<Edition>().ok())
        .unwrap_or(Edition::CURRENT);
    let ir = extract_pattern(
        source,
        ExtractOptions {
            offset,
            edition: parsed_edition,
        },
    )
    .map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_json::to_string(&ir).map_err(|error| JsValue::from_str(&error.to_string()))
}
