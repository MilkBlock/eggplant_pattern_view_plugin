use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use ra_ap_syntax::{
    AstNode, Edition, SourceFile, TextRange,
    ast::{self, HasArgList},
};
use serde::Serialize;

use crate::{ExtractOptions, extract_pattern};

#[derive(Debug, Clone, Serialize)]
pub struct ProjectCheckReport {
    pub root: PathBuf,
    pub files_scanned: usize,
    pub rust_files: usize,
    pub rules_total: usize,
    pub passed: usize,
    pub failed: usize,
    pub results: Vec<RuleCheckResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuleCheckResult {
    pub file: PathBuf,
    pub rule_name: Option<String>,
    pub callee: String,
    pub offset: usize,
    pub line: usize,
    pub column: usize,
    pub ok: bool,
    pub error: Option<String>,
}

pub fn check_project(root: &Path, edition: Edition) -> Result<ProjectCheckReport> {
    let mut rust_files = Vec::new();
    collect_rust_files(root, &mut rust_files)?;

    let mut results = Vec::new();
    for path in &rust_files {
        let source = fs::read_to_string(path)
            .with_context(|| format!("failed to read Rust source {}", path.display()))?;
        let candidates = find_rule_candidates(&source, edition);
        for candidate in candidates {
            let extraction = extract_pattern(
                &source,
                ExtractOptions {
                    offset: candidate.offset,
                    edition,
                },
            );
            let (ok, error) = match extraction {
                Ok(_) => (true, None),
                Err(err) => (false, Some(err.to_string())),
            };
            results.push(RuleCheckResult {
                file: path.to_path_buf(),
                rule_name: candidate.rule_name,
                callee: candidate.callee,
                offset: candidate.offset,
                line: candidate.line,
                column: candidate.column,
                ok,
                error,
            });
        }
    }

    let passed = results.iter().filter(|result| result.ok).count();
    let failed = results.len().saturating_sub(passed);

    Ok(ProjectCheckReport {
        root: root.to_path_buf(),
        files_scanned: rust_files.len(),
        rust_files: rust_files.len(),
        rules_total: results.len(),
        passed,
        failed,
        results,
    })
}

#[derive(Debug, Clone)]
struct RuleCandidate {
    rule_name: Option<String>,
    callee: String,
    offset: usize,
    line: usize,
    column: usize,
}

fn collect_rust_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    if is_ignored_dir(root) {
        return Ok(());
    }

    let metadata = fs::metadata(root)
        .with_context(|| format!("failed to stat scan root {}", root.display()))?;
    if metadata.is_file() {
        if root.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            files.push(root.to_path_buf());
        }
        return Ok(());
    }

    for entry in
        fs::read_dir(root).with_context(|| format!("failed to read dir {}", root.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            if is_ignored_dir(&path) {
                continue;
            }
            collect_rust_files(&path, files)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            files.push(path);
        }
    }

    Ok(())
}

fn is_ignored_dir(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(".git" | "target" | "node_modules" | ".next" | "dist" | "out")
    )
}

fn find_rule_candidates(source: &str, edition: Edition) -> Vec<RuleCandidate> {
    let parse = SourceFile::parse(source, edition);
    let file = parse.tree();
    file.syntax()
        .descendants()
        .filter_map(ast::CallExpr::cast)
        .filter_map(|call| rule_candidate_from_call(source, &call))
        .collect()
}

fn rule_candidate_from_call(source: &str, call: &ast::CallExpr) -> Option<RuleCandidate> {
    if !is_add_rule_call(call) {
        return None;
    }

    let callee = call.expr()?.syntax().text().to_string();
    let arg_list = call.arg_list()?;
    let rule_name = arg_list.args().next().map(|arg| trim_string_literal(arg.syntax().text().to_string()));
    let start: TextRange = call.syntax().text_range();
    let offset = u32::from(start.start()) as usize;
    let (line, column) = line_col_for_offset(source, offset);

    Some(RuleCandidate {
        rule_name,
        callee,
        offset,
        line,
        column,
    })
}

fn is_add_rule_call(call: &ast::CallExpr) -> bool {
    let Some(callee) = call.expr() else {
        return false;
    };
    let callee_text = callee.syntax().text().to_string();
    if !callee_text.ends_with("add_rule") && !callee_text.ends_with("add_rule_with_hook") {
        return false;
    }
    call.arg_list().and_then(|args| args.args().nth(3)).is_some()
}

fn trim_string_literal(raw: String) -> String {
    raw.trim_matches('"').to_string()
}

fn line_col_for_offset(source: &str, offset: usize) -> (usize, usize) {
    let safe_offset = offset.min(source.len());
    let prefix = &source[..safe_offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = prefix
        .rsplit_once('\n')
        .map(|(_, tail)| tail.chars().count() + 1)
        .unwrap_or_else(|| prefix.chars().count() + 1);
    (line, column)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_add_rule_candidates_in_source() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        Pat::new(p)
    }, |_, _| {});

    DemoTx::add_rule_with_hook("hooked", ruleset, pat_fn, |_, _| {});
}
"#;

        let candidates = find_rule_candidates(src, Edition::CURRENT);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].rule_name.as_deref(), Some("demo"));
        assert!(candidates[0].callee.ends_with("add_rule"));
        assert_eq!(candidates[1].rule_name.as_deref(), Some("hooked"));
        assert!(candidates[1].callee.ends_with("add_rule_with_hook"));
    }

    #[test]
    fn project_check_runs_extractor_against_rules() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/pattern_samples.rs");
        let report = check_project(&root, Edition::CURRENT).expect("project check should succeed");

        assert!(report.rules_total >= 1);
        assert_eq!(report.failed, 0);
        assert_eq!(report.passed, report.rules_total);
    }
}
