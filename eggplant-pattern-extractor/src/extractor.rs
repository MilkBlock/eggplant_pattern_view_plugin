use anyhow::{Result, anyhow};
use ra_ap_syntax::{
    AstNode, Edition, SourceFile, SyntaxNode, TextRange, TextSize, algo,
    ast::{self, HasArgList, HasAttrs, HasName},
};
use std::collections::{BTreeSet, HashMap};

use crate::ir::{
    Diagnostic, PatternConstraint, PatternEdge, PatternIr, PatternNode, ScopeInfo, ScopeKind,
    TextSpan,
};

#[derive(Debug, Clone, Copy)]
pub struct ExtractOptions {
    pub offset: usize,
    pub edition: Edition,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            offset: 0,
            edition: Edition::CURRENT,
        }
    }
}

#[derive(Debug, Clone)]
enum Scope {
    Closure(ast::ClosureExpr),
    Function(ast::Fn),
}

pub fn extract_pattern(source: &str, options: ExtractOptions) -> Result<PatternIr> {
    let parse = SourceFile::parse(source, options.edition);
    let file = parse.tree();
    let syntax = file.syntax();
    let offset = TextSize::from(options.offset as u32);
    let mut diagnostics = parse
        .errors()
        .iter()
        .map(|err| Diagnostic {
            severity: crate::ir::Severity::Warning,
            message: err.to_string(),
            range: Some(span_from_text_range(err.range())),
        })
        .collect::<Vec<_>>();

    let scope = find_scope(syntax, offset).ok_or_else(|| anyhow!("no supported pattern scope found at cursor"))?;
    let mut ir = match scope {
        Scope::Closure(closure) => extract_from_closure(closure),
        Scope::Function(function) => extract_from_function(function),
    }?;
    ir.diagnostics.append(&mut diagnostics);
    Ok(ir)
}

fn find_scope(root: &SyntaxNode, offset: TextSize) -> Option<Scope> {
    if let Some(closure) = algo::find_node_at_offset::<ast::ClosureExpr>(root, offset)
        && is_add_rule_pattern_closure(&closure)
    {
        return Some(Scope::Closure(closure));
    }

    if let Some(function) = algo::find_node_at_offset::<ast::Fn>(root, offset)
        && function_looks_like_pattern(&function)
    {
        return Some(Scope::Function(function));
    }

    None
}

fn is_add_rule_pattern_closure(closure: &ast::ClosureExpr) -> bool {
    let Some(call) = closure.syntax().ancestors().find_map(ast::CallExpr::cast) else {
        return false;
    };
    let Some(callee) = call.expr() else {
        return false;
    };
    let callee_text = callee.syntax().text().to_string();
    if !callee_text.ends_with("add_rule") {
        return false;
    }
    let Some(arg_list) = call.arg_list() else {
        return false;
    };
    arg_list
        .args()
        .enumerate()
        .find(|(_, arg)| arg.syntax().text_range() == closure.syntax().text_range())
        .map(|(idx, _)| idx == 2)
        .unwrap_or(false)
}

fn function_looks_like_pattern(function: &ast::Fn) -> bool {
    let Some(body) = function.body() else {
        return false;
    };
    let has_pat_new = body
        .syntax()
        .descendants()
        .filter_map(ast::CallExpr::cast)
        .any(|call| call_path(&call).is_some_and(|path| path.ends_with("::new")));
    let has_query = body
        .syntax()
        .descendants()
        .filter_map(ast::CallExpr::cast)
        .any(|call| is_query_call(&call));
    has_pat_new && has_query
}

fn extract_from_closure(closure: ast::ClosureExpr) -> Result<PatternIr> {
    let Some(body) = closure.body() else {
        return Err(anyhow!("pattern closure has no body"));
    };
    let block = match body {
        ast::Expr::BlockExpr(block) => block,
        _ => return Err(anyhow!("pattern closure body is not a block")),
    };
    extract_from_block(
        block,
        ScopeInfo {
            kind: ScopeKind::AddRulePatternClosure,
            text_range: span_from_text_range(closure.syntax().text_range()),
        },
    )
}

fn extract_from_function(function: ast::Fn) -> Result<PatternIr> {
    let Some(body) = function.body() else {
        return Err(anyhow!("pattern function has no body"));
    };
    extract_from_block(
        body,
        ScopeInfo {
            kind: ScopeKind::PatternFunction,
            text_range: span_from_text_range(function.syntax().text_range()),
        },
    )
}

fn extract_from_block(block: ast::BlockExpr, scope: ScopeInfo) -> Result<PatternIr> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut roots = Vec::new();
    let mut constraints = Vec::new();
    let mut diagnostics = Vec::new();
    let mut local_bindings = HashMap::new();

    for stmt in block.statements() {
        match stmt {
            ast::Stmt::LetStmt(let_stmt) => {
                if let Some(pat) = let_stmt.pat()
                    && let Some(name) = ident_pat_name(pat)
                    && let Some(init) = let_stmt.initializer()
                {
                    local_bindings.insert(name, init);
                }
                if let Some(node) = extract_let_node(&let_stmt) {
                    for (index, input) in node.inputs.iter().enumerate() {
                        edges.push(PatternEdge {
                            from: node.id.clone(),
                            to: input.clone(),
                            kind: "operand".into(),
                            index,
                        });
                    }
                    nodes.push(node);
                }
            }
            ast::Stmt::ExprStmt(expr_stmt) => {
                if let Some(expr) = expr_stmt.expr() {
                    collect_roots_and_constraints(
                        &expr,
                        &local_bindings,
                        &mut roots,
                        &mut constraints,
                        &mut diagnostics,
                    );
                }
            }
            ast::Stmt::Item(_) => {}
        }
    }

    if let Some(tail_expr) = block.tail_expr() {
        collect_roots_and_constraints(
            &tail_expr,
            &local_bindings,
            &mut roots,
            &mut constraints,
            &mut diagnostics,
        );
    }

    if roots.is_empty() {
        diagnostics.push(Diagnostic {
            severity: crate::ir::Severity::Warning,
            message: "no supported pattern roots found in scope".into(),
            range: Some(span_from_text_range(block.syntax().text_range())),
        });
    }

    Ok(PatternIr {
        scope,
        nodes,
        edges,
        roots,
        constraints,
        diagnostics,
    })
}

fn extract_let_node(let_stmt: &ast::LetStmt) -> Option<PatternNode> {
    let name = ident_pat_name(let_stmt.pat()?)?;
    let init = let_stmt.initializer()?;
    let query = query_spec(&init)?;
    Some(PatternNode {
        id: name.clone(),
        kind: query.kind,
        dsl_type: query.dsl_type.clone(),
        label: format!("{name}: {}", query.dsl_type),
        range: span_from_text_range(let_stmt.syntax().text_range()),
        inputs: query.inputs,
    })
}

#[derive(Debug, Clone)]
struct QuerySpec {
    kind: crate::ir::NodeKind,
    dsl_type: String,
    inputs: Vec<String>,
}

fn query_spec(expr: &ast::Expr) -> Option<QuerySpec> {
    let call = ast::CallExpr::cast(expr.syntax().clone())?;
    let callee = call_path(&call)?;
    let kind = if callee.ends_with("::query_leaf") {
        crate::ir::NodeKind::QueryLeaf
    } else if callee.ends_with("::query") {
        crate::ir::NodeKind::Query
    } else {
        return None;
    };
    let suffix = match kind {
        crate::ir::NodeKind::QueryLeaf => "::query_leaf",
        crate::ir::NodeKind::Query => "::query",
    };
    let dsl_type = callee.trim_end_matches(suffix).to_string();
    let inputs = call
        .arg_list()
        .into_iter()
        .flat_map(|args| args.args())
        .filter_map(expr_variable_name)
        .collect();
    Some(QuerySpec {
        kind,
        dsl_type,
        inputs,
    })
}

fn collect_roots_and_constraints(
    expr: &ast::Expr,
    local_bindings: &HashMap<String, ast::Expr>,
    roots: &mut Vec<String>,
    constraints: &mut Vec<PatternConstraint>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let (base, extracted_constraints) = unwrap_assert_chain(expr.clone(), local_bindings);
    constraints.extend(extracted_constraints);

    if let Some(call) = ast::CallExpr::cast(base.syntax().clone())
        && call_path(&call).is_some_and(|path| path.ends_with("::new"))
    {
        let mut found = 0usize;
        for arg in call.arg_list().into_iter().flat_map(|args| args.args()) {
            if let Some(name) = expr_variable_name(arg) {
                roots.push(name);
                found += 1;
            }
        }

        if found == 0 {
            diagnostics.push(Diagnostic {
                severity: crate::ir::Severity::Warning,
                message: "Pat::new(...) found, but no root variables could be extracted".into(),
                range: Some(span_from_text_range(call.syntax().text_range())),
            });
        }
        return;
    }

    if let Some(block) = ast::BlockExpr::cast(base.syntax().clone()) {
        let extracted_roots = block_pat_roots(&block);
        if extracted_roots.is_empty() {
            diagnostics.push(Diagnostic {
                severity: crate::ir::Severity::Warning,
                message: "pattern block found, but no root variables could be extracted".into(),
                range: Some(span_from_text_range(block.syntax().text_range())),
            });
        } else {
            roots.extend(extracted_roots);
        }
    }
}

fn unwrap_assert_chain(
    expr: ast::Expr,
    local_bindings: &HashMap<String, ast::Expr>,
) -> (ast::Expr, Vec<PatternConstraint>) {
    let mut current = expr;
    let mut constraints = Vec::new();

    loop {
        let Some(method_call) = ast::MethodCallExpr::cast(current.syntax().clone()) else {
            break;
        };
        let Some(name_ref) = method_call.name_ref() else {
            break;
        };
        let method_name = name_ref.syntax().text().to_string();
        if method_name != "assert" {
            break;
        }

        if let Some(arg) = method_call.arg_list().and_then(|args| args.args().next()) {
            let (resolved_text, referenced_vars) = resolve_constraint(&arg, local_bindings);
            constraints.push(PatternConstraint {
                id: format!("constraint_{}", constraints.len()),
                source_text: arg.syntax().text().to_string(),
                resolved_text,
                referenced_vars,
                range: span_from_text_range(arg.syntax().text_range()),
            });
        }

        let Some(receiver) = method_call.receiver() else {
            break;
        };
        current = receiver;
    }

    constraints.reverse();
    (current, constraints)
}

fn resolve_constraint(
    expr: &ast::Expr,
    local_bindings: &HashMap<String, ast::Expr>,
) -> (String, Vec<String>) {
    if let Some(name) = expr_variable_name(expr.clone())
        && let Some(bound_expr) = local_bindings.get(&name)
    {
        return (
            bound_expr.syntax().text().to_string(),
            collect_variable_references(bound_expr),
        );
    }

    (
        expr.syntax().text().to_string(),
        collect_variable_references(expr),
    )
}

fn collect_variable_references(expr: &ast::Expr) -> Vec<String> {
    let mut vars = BTreeSet::new();
    for path_expr in expr.syntax().descendants().filter_map(ast::PathExpr::cast) {
        if let Some(segment) = path_expr
            .syntax()
            .text()
            .to_string()
            .split("::")
            .next()
            .map(str::to_string)
            && is_plain_ident(&segment)
        {
            vars.insert(segment);
        }
    }
    vars.into_iter().collect()
}

fn block_pat_roots(block: &ast::BlockExpr) -> Vec<String> {
    for stmt in block.statements() {
        let ast::Stmt::Item(item) = stmt else {
            continue;
        };
        let ast::Item::Struct(strukt) = item else {
            continue;
        };
        if !struct_has_pat_attr(&strukt) {
            continue;
        }
        return strukt
            .syntax()
            .descendants()
            .filter_map(ast::RecordField::cast)
            .filter_map(|field| field.name().map(|name| name.syntax().text().to_string()))
            .collect();
    }
    Vec::new()
}

fn struct_has_pat_attr(strukt: &ast::Struct) -> bool {
    strukt
        .attrs()
        .any(|attr| attr.syntax().text().to_string().contains("pat_vars"))
}

fn is_plain_ident(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn ident_pat_name(pat: ast::Pat) -> Option<String> {
    let ident_pat = ast::IdentPat::cast(pat.syntax().clone())?;
    Some(ident_pat.name()?.syntax().text().to_string())
}

fn expr_variable_name(expr: ast::Expr) -> Option<String> {
    match expr {
        ast::Expr::RefExpr(ref_expr) => ref_expr.expr().and_then(expr_variable_name),
        ast::Expr::ParenExpr(paren) => paren.expr().and_then(expr_variable_name),
        ast::Expr::PathExpr(path) => Some(path.syntax().text().to_string()),
        _ => None,
    }
}

fn call_path(call: &ast::CallExpr) -> Option<String> {
    Some(call.expr()?.syntax().text().to_string())
}

fn is_query_call(call: &ast::CallExpr) -> bool {
    call_path(call).is_some_and(|path| path.ends_with("::query") || path.ends_with("::query_leaf"))
}

fn span_from_text_range(range: TextRange) -> TextSpan {
    TextSpan::new(u32::from(range.start()) as usize, u32::from(range.end()) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(source: &str, needle: &str) -> PatternIr {
        let offset = source.find(needle).expect("needle not found");
        extract_pattern(
            source,
            ExtractOptions {
                offset,
                edition: Edition::CURRENT,
            },
        )
        .expect("extract should succeed")
    }

    #[test]
    fn extracts_add_rule_pattern_closure() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        let eq = x1.handle().eq(&(x.handle() + (&1_i64).as_handle()));
        DemoPat::new(l, r, p).assert(eq)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "let p =");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRulePatternClosure));
        assert_eq!(ir.nodes.len(), 3);
        assert_eq!(ir.edges.len(), 2);
        assert_eq!(ir.roots, vec!["l", "r", "p"]);
        assert_eq!(ir.constraints.len(), 1);
        assert_eq!(ir.constraints[0].source_text, "eq");
        assert_eq!(
            ir.constraints[0].resolved_text,
            "x1.handle().eq(&(x.handle() + (&1_i64).as_handle()))"
        );
    }

    #[test]
    fn resolves_assertion_variables_and_targets() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        let l_r_eq = l.handle().eq(&r.handle());
        DemoPat::new(l, r, p).assert(l_r_eq)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "let l_r_eq =");
        assert_eq!(ir.roots, vec!["l", "r", "p"]);
        assert_eq!(ir.constraints.len(), 1);
        assert_eq!(ir.constraints[0].source_text, "l_r_eq");
        assert_eq!(ir.constraints[0].resolved_text, "l.handle().eq(&r.handle())");
        assert_eq!(ir.constraints[0].referenced_vars, vec!["l", "r"]);
    }

    #[test]
    fn extracts_pat_vars_catch_assertion_roots() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        let l_h_eq_r_h = l.handle().eq(&r.handle());
        {
            #[eggplant::pat_vars_catch]
            struct AddPat {
                l: Const,
                r: Const,
                p: Add,
            }
        }
        .assert(l_h_eq_r_h)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "#[eggplant::pat_vars_catch]");
        assert_eq!(ir.roots, vec!["l", "r", "p"]);
        assert_eq!(ir.constraints.len(), 1);
        assert_eq!(ir.constraints[0].resolved_text, "l.handle().eq(&r.handle())");
        assert_eq!(ir.constraints[0].referenced_vars, vec!["l", "r"]);
    }

    #[test]
    fn extracts_pattern_function() {
        let src = r#"
fn step_pat<PR: PatRecSgl>() -> StepPat<PR> {
    let l = Const::query();
    let r = Const::query();
    let p = Add::query(&l, &r);
    StepPat::new(l, r, p)
}
"#;
        let ir = extract(src, "let r =");
        assert!(matches!(ir.scope.kind, ScopeKind::PatternFunction));
        assert_eq!(ir.nodes.len(), 3);
        assert_eq!(ir.roots, vec!["l", "r", "p"]);
    }

    #[test]
    fn rejects_non_pattern_scope() {
        let src = r#"
fn helper() {
    let value = 42;
    println!("{value}");
}
"#;
        let offset = src.find("println!").expect("needle not found");
        let error = extract_pattern(
            src,
            ExtractOptions {
                offset,
                edition: Edition::CURRENT,
            },
        )
        .expect_err("non-pattern scope should fail");

        assert!(error.to_string().contains("no supported pattern scope found at cursor"));
    }
}
