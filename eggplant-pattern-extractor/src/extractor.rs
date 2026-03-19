use anyhow::{Result, anyhow};
use ra_ap_syntax::{
    AstNode, Edition, SourceFile, SyntaxNode, TextRange, TextSize, algo,
    ast::{self, HasArgList, HasAttrs, HasName},
};
use std::collections::{BTreeSet, HashMap};

use crate::ir::{
    ActionEffect, Diagnostic, PatternConstraint, PatternEdge, PatternIr, PatternNode, ScopeInfo,
    ScopeKind, SeedFact, TextSpan,
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
    RuleCall(ast::CallExpr),
    Function(ast::Fn),
}

#[derive(Debug, Clone)]
struct ActionClosureBindings {
    ctx_name: String,
    pat_name: Option<String>,
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
        Scope::RuleCall(call) => extract_from_rule_call(call),
        Scope::Function(function) => extract_from_function(function),
    }?;
    ir.diagnostics.append(&mut diagnostics);
    Ok(ir)
}

fn find_scope(root: &SyntaxNode, offset: TextSize) -> Option<Scope> {
    if let Some(call) = root
        .token_at_offset(offset)
        .into_iter()
        .flat_map(|token| token.parent_ancestors().filter_map(ast::CallExpr::cast))
        .find(is_add_rule_call)
    {
        return Some(Scope::RuleCall(call));
    }

    if let Some(function) = algo::find_node_at_offset::<ast::Fn>(root, offset)
        && function_looks_like_pattern(&function)
    {
        return Some(Scope::Function(function));
    }

    None
}

fn is_add_rule_call(call: &ast::CallExpr) -> bool {
    let Some(callee) = call.expr() else {
        return false;
    };
    let callee_text = callee.syntax().text().to_string();
    if !callee_text.ends_with("add_rule") {
        return false;
    }
    call.arg_list()
        .and_then(|args| args.args().nth(2))
        .and_then(|arg| expr_as_closure(&arg))
        .is_some()
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

fn extract_from_rule_call(call: ast::CallExpr) -> Result<PatternIr> {
    let args = call
        .arg_list()
        .ok_or_else(|| anyhow!("add_rule call has no arg list"))?
        .args()
        .collect::<Vec<_>>();
    let pattern_closure = args
        .get(2)
        .and_then(expr_as_closure)
        .ok_or_else(|| anyhow!("add_rule pattern closure not found"))?;
    let action_closure = args.get(3).and_then(expr_as_closure);
    let action_bindings = action_closure
        .as_ref()
        .and_then(action_closure_bindings);
    let enclosing_function = call.syntax().ancestors().find_map(ast::Fn::cast);
    let Some(body) = pattern_closure.body() else {
        return Err(anyhow!("pattern closure has no body"));
    };
    let block = match body {
        ast::Expr::BlockExpr(block) => block,
        _ => return Err(anyhow!("pattern closure body is not a block")),
    };
    extract_from_block(
        block,
        ScopeInfo {
            kind: ScopeKind::AddRuleCall,
            text_range: span_from_text_range(call.syntax().text_range()),
        },
        action_closure.and_then(closure_block_body),
        action_bindings,
        enclosing_function.and_then(|function| function.body()),
        Some(call),
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
        None,
        None,
        None,
        None,
    )
}

fn extract_from_block(
    block: ast::BlockExpr,
    scope: ScopeInfo,
    action_block: Option<ast::BlockExpr>,
    action_bindings: Option<ActionClosureBindings>,
    enclosing_function_body: Option<ast::BlockExpr>,
    rule_call: Option<ast::CallExpr>,
) -> Result<PatternIr> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut roots = Vec::new();
    let mut constraints = Vec::new();
    let mut action_effects = Vec::new();
    let mut seed_facts = Vec::new();
    let mut diagnostics = Vec::new();
    let mut local_bindings = HashMap::new();
    let mut next_constraint_id = 0usize;

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
                        &mut next_constraint_id,
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
            &mut next_constraint_id,
            &mut roots,
            &mut constraints,
            &mut diagnostics,
        );
    }

    let known_pattern_vars = collect_known_pattern_vars(&nodes, &roots);
    for constraint in &mut constraints {
        constraint.referenced_vars = constraint
            .referenced_vars
            .iter()
            .filter(|name| known_pattern_vars.contains(name.as_str()))
            .cloned()
            .collect();
    }

    if let Some(action_block) = action_block
        && let Some(action_bindings) = action_bindings
    {
        action_effects = extract_action_effects(&action_block, &action_bindings, &known_pattern_vars);
    }

    if let Some(function_body) = enclosing_function_body
        && let Some(rule_call) = rule_call
    {
        seed_facts = extract_seed_facts(&function_body, &rule_call);
    }

    if roots.is_empty() && action_effects.is_empty() {
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
        action_effects,
        seed_facts,
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
    next_constraint_id: &mut usize,
    roots: &mut Vec<String>,
    constraints: &mut Vec<PatternConstraint>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let (base, extracted_constraints) =
        unwrap_assert_chain(expr.clone(), local_bindings, next_constraint_id);

    if let Some(call) = expr_as_call(&base)
        && call_path(&call).is_some_and(|path| path.ends_with("::new"))
    {
        constraints.extend(extracted_constraints);
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

    if let Some(block) = expr_as_block(&base) {
        let extracted_roots = block_pat_roots(&block);
        if !extracted_roots.is_empty() {
            constraints.extend(extracted_constraints);
            roots.extend(extracted_roots);
        }
    }
}

fn unwrap_assert_chain(
    expr: ast::Expr,
    local_bindings: &HashMap<String, ast::Expr>,
    next_constraint_id: &mut usize,
) -> (ast::Expr, Vec<PatternConstraint>) {
    let mut current = expr;
    let mut extracted_constraints = Vec::new();

    loop {
        let Some(method_call) = expr_as_method_call(&current) else {
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
            extracted_constraints.push(PatternConstraint {
                id: String::new(),
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

    extracted_constraints.reverse();
    let mut constraints = Vec::with_capacity(extracted_constraints.len());
    for mut constraint in extracted_constraints {
        constraint.id = format!("constraint_{}", *next_constraint_id);
        *next_constraint_id += 1;
        constraints.push(constraint);
    }
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

fn collect_known_pattern_vars(nodes: &[PatternNode], roots: &[String]) -> BTreeSet<String> {
    let mut vars = BTreeSet::new();
    for node in nodes {
        vars.insert(node.id.clone());
    }
    for root in roots {
        vars.insert(root.clone());
    }
    vars
}

fn closure_block_body(closure: ast::ClosureExpr) -> Option<ast::BlockExpr> {
    match closure.body()? {
        ast::Expr::BlockExpr(block) => Some(block),
        _ => None,
    }
}

fn expr_as_closure(expr: &ast::Expr) -> Option<ast::ClosureExpr> {
    ast::ClosureExpr::cast(expr.syntax().clone())
}

fn expr_as_call(expr: &ast::Expr) -> Option<ast::CallExpr> {
    match expr {
        ast::Expr::CallExpr(call) => Some(call.clone()),
        _ => ast::CallExpr::cast(expr.syntax().clone()),
    }
}

fn expr_as_block(expr: &ast::Expr) -> Option<ast::BlockExpr> {
    match expr {
        ast::Expr::BlockExpr(block) => Some(block.clone()),
        _ => ast::BlockExpr::cast(expr.syntax().clone()),
    }
}

fn expr_as_method_call(expr: &ast::Expr) -> Option<ast::MethodCallExpr> {
    match expr {
        ast::Expr::MethodCallExpr(method_call) => Some(method_call.clone()),
        _ => ast::MethodCallExpr::cast(expr.syntax().clone()),
    }
}

fn extract_action_effects(
    block: &ast::BlockExpr,
    bindings: &ActionClosureBindings,
    known_pattern_vars: &BTreeSet<String>,
) -> Vec<ActionEffect> {
    let action_bindings = collect_action_local_bindings(block, &bindings.ctx_name);
    let mut effects = Vec::new();
    let mut next_effect_id = 0usize;
    for method_call in block.syntax().descendants().filter_map(ast::MethodCallExpr::cast) {
        if method_call
            .syntax()
            .ancestors()
            .skip(1)
            .take_while(|ancestor| ancestor != block.syntax())
            .any(|ancestor| ast::ClosureExpr::can_cast(ancestor.kind()))
        {
            continue;
        }
        let Some(receiver) = method_call.receiver() else {
            continue;
        };
        if expr_variable_name(receiver) != Some(bindings.ctx_name.clone()) {
            continue;
        }
        let Some(name_ref) = method_call.name_ref() else {
            continue;
        };
        let method_name = name_ref.syntax().text().to_string();
        if method_name != "union" && !method_name.starts_with("insert_") {
            continue;
        }
        let referenced_pat_vars = collect_pat_field_references(method_call.syntax(), bindings.pat_name.as_deref())
            .into_iter()
            .filter(|name| known_pattern_vars.contains(name))
            .collect::<Vec<_>>();
        let referenced_action_vars = method_call
            .arg_list()
            .into_iter()
            .flat_map(|args| args.args())
            .flat_map(|arg| collect_variable_references(&arg))
            .filter(|name| action_bindings.contains(name))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        effects.push(ActionEffect {
            id: format!("effect_{next_effect_id}"),
            bound_var: enclosing_let_binding_name(method_call.syntax()),
            source_text: method_call.syntax().text().to_string(),
            referenced_pat_vars,
            referenced_action_vars,
            range: span_from_text_range(method_call.syntax().text_range()),
        });
        next_effect_id += 1;
    }
    effects
}

fn collect_action_local_bindings(block: &ast::BlockExpr, ctx_name: &str) -> BTreeSet<String> {
    block
        .statements()
        .filter_map(|stmt| match stmt {
            ast::Stmt::LetStmt(let_stmt) => Some(let_stmt),
            _ => None,
        })
        .filter_map(|let_stmt| {
            let init = let_stmt.initializer()?;
            let method_call = expr_as_method_call(&init)?;
            let receiver = method_call.receiver()?;
            (expr_variable_name(receiver) == Some(ctx_name.to_string()))
                .then(|| ident_pat_name(let_stmt.pat()?))
                .flatten()
        })
        .collect()
}

fn enclosing_let_binding_name(node: &SyntaxNode) -> Option<String> {
    let let_stmt = node.ancestors().find_map(ast::LetStmt::cast)?;
    let init = let_stmt.initializer()?;
    (init.syntax() == node).then(|| ident_pat_name(let_stmt.pat()?)).flatten()
}

fn collect_pat_field_references(node: &SyntaxNode, pat_name: Option<&str>) -> Vec<String> {
    let Some(pat_name) = pat_name else {
        return Vec::new();
    };
    let mut vars = BTreeSet::new();
    for field_expr in node.descendants().filter_map(ast::FieldExpr::cast) {
        let Some(first_pat_field) = first_pat_field_name(&field_expr, pat_name) else {
            continue;
        };
        vars.insert(first_pat_field);
    }
    vars.into_iter().collect()
}

fn extract_seed_facts(function_body: &ast::BlockExpr, rule_call: &ast::CallExpr) -> Vec<SeedFact> {
    let mut facts = Vec::new();
    let mut next_fact_id = 0usize;
    let rule_range = rule_call.syntax().text_range();
    let enclosing_item_range = function_body
        .syntax()
        .ancestors()
        .find_map(ast::Item::cast)
        .map(|item| item.syntax().text_range());
    for method_call in function_body
        .syntax()
        .descendants()
        .filter_map(ast::MethodCallExpr::cast)
    {
        let Some(name_ref) = method_call.name_ref() else {
            continue;
        };
        if name_ref.syntax().text() != "commit" {
            continue;
        }
        if method_call
            .syntax()
            .ancestors()
            .skip(1)
            .any(|ancestor| ast::ClosureExpr::can_cast(ancestor.kind()))
        {
            continue;
        }
        let nearest_item_range = method_call
            .syntax()
            .ancestors()
            .skip(1)
            .find_map(ast::Item::cast)
            .map(|item| item.syntax().text_range());
        if nearest_item_range != enclosing_item_range {
            continue;
        }
        let commit_range = method_call.syntax().text_range();
        if commit_range.start() >= rule_range.start() {
            continue;
        }
        if rule_range.contains_range(commit_range) {
            continue;
        }
        let Some(receiver) = method_call.receiver() else {
            continue;
        };
        let referenced_vars = collect_variable_references(&receiver)
            .into_iter()
            .collect::<Vec<_>>();
        facts.push(SeedFact {
            id: format!("seed_{next_fact_id}"),
            source_text: method_call.syntax().text().to_string(),
            committed_root: receiver.syntax().text().to_string(),
            referenced_vars,
            range: span_from_text_range(method_call.syntax().text_range()),
        });
        next_fact_id += 1;
    }
    facts
}

fn first_pat_field_name(field_expr: &ast::FieldExpr, pat_name: &str) -> Option<String> {
    let mut current = field_expr.clone();
    loop {
        let receiver = current.expr()?;
        match receiver {
            ast::Expr::PathExpr(path) => {
                if path.syntax().text() == pat_name {
                    return current
                        .name_ref()
                        .map(|name_ref| name_ref.syntax().text().to_string());
                }
                return None;
            }
            ast::Expr::FieldExpr(inner) => {
                current = inner;
            }
            _ => return None,
        }
    }
}

fn action_closure_bindings(closure: &ast::ClosureExpr) -> Option<ActionClosureBindings> {
    let mut params = closure.param_list()?.params();
    let ctx_name = ident_pat_name(params.next()?.pat()?)?;
    let pat_name = params
        .next()
        .and_then(|param| param.pat())
        .and_then(ident_pat_name);
    Some(ActionClosureBindings { ctx_name, pat_name })
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
    let expr = Add::new(&Const::new(1), &Const::new(2));
    expr.commit();
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        let eq = x1.handle().eq(&(x.handle() + (&1_i64).as_handle()));
        DemoPat::new(l, r, p).assert(eq)
    }, |ctx, pat| {
        let op_value = ctx.insert_const(3);
        ctx.union(pat.p, op_value);
    });
}
"#;
        let ir = extract(src, "let p =");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.nodes.len(), 3);
        assert_eq!(ir.edges.len(), 2);
        assert_eq!(ir.roots, vec!["l", "r", "p"]);
        assert_eq!(ir.constraints.len(), 1);
        assert_eq!(ir.constraints[0].source_text, "eq");
        assert_eq!(
            ir.constraints[0].resolved_text,
            "x1.handle().eq(&(x.handle() + (&1_i64).as_handle()))"
        );
        assert!(ir.constraints[0].referenced_vars.is_empty());
        assert_eq!(ir.action_effects.len(), 2);
        assert_eq!(ir.action_effects[1].source_text, "ctx.union(pat.p, op_value)");
        assert_eq!(ir.action_effects[1].referenced_pat_vars, vec!["p"]);
        assert_eq!(ir.seed_facts.len(), 1);
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
        let assert_arg_offset = src.rfind("l_r_eq").unwrap();
        assert_eq!(ir.constraints[0].range.start, assert_arg_offset);
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
    fn keeps_inline_assertion_text() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        DemoPat::new(l, r, p).assert(l.handle().eq(&r.handle()))
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, ".assert(");
        assert_eq!(ir.constraints.len(), 1);
        assert_eq!(ir.constraints[0].source_text, "l.handle().eq(&r.handle())");
        assert_eq!(ir.constraints[0].resolved_text, "l.handle().eq(&r.handle())");
        assert_eq!(ir.constraints[0].referenced_vars, vec!["l", "r"]);
    }

    #[test]
    fn preserves_multi_assert_order_and_unique_ids() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        let eq1 = l.handle().eq(&r.handle());
        let eq2 = r.handle().eq(&l.handle());
        DemoPat::new(l, r, p).assert(eq1).assert(eq2)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "eq2");
        assert_eq!(ir.constraints.len(), 2);
        assert_eq!(ir.constraints[0].source_text, "eq1");
        assert_eq!(ir.constraints[1].source_text, "eq2");
        assert_eq!(ir.constraints[0].id, "constraint_0");
        assert_eq!(ir.constraints[1].id, "constraint_1");
        assert_ne!(ir.constraints[0].id, ir.constraints[1].id);
    }

    #[test]
    fn keeps_constraint_ids_unique_across_pattern_hosts() {
        let src = r#"
fn demo() {
    let l = Const::query();
    let r = Const::query();
    let p = Add::query(&l, &r);
    let eq = l.handle().eq(&r.handle());
    DemoPat::new(l, r, p).assert(eq);
    DemoPat::new(l, r, p).assert(eq)
}
"#;
        let ir = extract(src, "DemoPat::new(l, r, p).assert(eq);");
        assert_eq!(ir.constraints.len(), 2);
        assert_eq!(ir.constraints[0].id, "constraint_0");
        assert_eq!(ir.constraints[1].id, "constraint_1");
    }

    #[test]
    fn captures_nested_pat_field_reads_in_action_effects() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let num = Const::query();
        let p = Add::query(&l, &l);
        DemoPat::new(l, num, p)
    }, |ctx, pat| {
        let folded = ctx.insert_const(ctx.devalue(pat.l.num));
        ctx.union(pat.p, folded);
    });
}
"#;
        let ir = extract(src, "ctx.devalue");
        assert_eq!(ir.action_effects.len(), 2);
        assert_eq!(ir.action_effects[0].referenced_pat_vars, vec!["l"]);
        assert_eq!(ir.action_effects[1].referenced_pat_vars, vec!["p"]);
    }

    #[test]
    fn extracts_action_effects_with_non_default_binding_names() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let p = Add::query(&l, &l);
        DemoPat::new(l, p)
    }, |tx, matched| {
        let folded = tx.insert_const(tx.devalue(matched.l.num));
        tx.union(matched.p, folded);
    });
}
"#;
        let ir = extract(src, "tx.insert_const");
        assert_eq!(ir.action_effects.len(), 2);
        assert_eq!(ir.action_effects[0].bound_var.as_deref(), Some("folded"));
        assert_eq!(ir.action_effects[0].referenced_pat_vars, vec!["l"]);
        assert_eq!(ir.action_effects[1].referenced_pat_vars, vec!["p"]);
        assert_eq!(ir.action_effects[1].referenced_action_vars, vec!["folded"]);
    }

    #[test]
    fn ignores_action_effects_inside_nested_closures() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let p = Add::query(&l, &l);
        DemoPat::new(l, p)
    }, |ctx, pat| {
        let _deferred = || {
            ctx.union(pat.p, ctx.insert_const(9));
        };
        let folded = ctx.insert_const(3);
        ctx.union(pat.p, folded);
    });
}
"#;
        let ir = extract(src, "ctx.union(pat.p, folded)");
        assert_eq!(ir.action_effects.len(), 2);
        assert_eq!(ir.action_effects[0].source_text, "ctx.insert_const(3)");
        assert_eq!(ir.action_effects[1].source_text, "ctx.union(pat.p, folded)");
    }

    #[test]
    fn extracts_action_effects_for_wildcard_pat_seed_rules() {
        let src = r#"
fn demo() {
    MyTx::add_rule("seed", ruleset, || {
        #[eggplant::pat_vars_catch]
        struct Unit {}
    }, |ctx, _pat| {
        let x = ctx.insert_m_var("x".to_owned());
        let ln_x = ctx.insert_m_ln(x.clone());
        ctx.insert_m_integral(ln_x, x.clone());
    });
}
"#;
        let ir = extract(src, "ctx.insert_m_ln");
        assert!(ir.diagnostics.is_empty());
        assert!(ir.roots.is_empty());
        assert_eq!(ir.action_effects.len(), 3);
        assert_eq!(ir.action_effects[0].bound_var.as_deref(), Some("x"));
        assert_eq!(ir.action_effects[1].bound_var.as_deref(), Some("ln_x"));
        assert_eq!(ir.action_effects[1].referenced_action_vars, vec!["x"]);
        assert_eq!(ir.action_effects[2].referenced_action_vars, vec!["ln_x", "x"]);
    }

    #[test]
    fn ignores_unrelated_add_rule_calls() {
        let src = r#"
fn demo() {
    helper.add_rule("demo", ruleset, 42, "not a closure");
}
"#;
        let offset = src.find("add_rule").unwrap();
        let error = extract_pattern(
            src,
            ExtractOptions {
                offset,
                edition: Edition::CURRENT,
            },
        )
        .expect_err("unrelated add_rule call should not be treated as a pattern scope");
        assert!(error.to_string().contains("no supported pattern scope found at cursor"));
    }

    #[test]
    fn ignores_non_pattern_blocks_followed_by_assert_like_methods() {
        let src = r#"
fn helper() {
    let l = Const::query();
    let r = Const::query();
    let p = Add::query(&l, &r);
    let eq = l.handle().eq(&r.handle());
    {
        let tmp = 1;
        tmp
    }
    .assert(eq);
    DemoPat::new(l, r, p)
}
"#;
        let ir = extract(src, "DemoPat::new");
        assert_eq!(ir.roots, vec!["l", "r", "p"]);
        assert!(ir.constraints.is_empty());
        assert!(ir.diagnostics.is_empty());
    }

    #[test]
    fn seed_facts_only_include_pre_rule_commits() {
        let src = r#"
fn demo() {
    let before = Add::new(&Const::new(1), &Const::new(2));
    before.commit();
    let nested = || {
        let hidden = Add::new(&Const::new(5), &Const::new(6));
        hidden.commit();
    };
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        DemoPat::new(l, r, p)
    }, |ctx, pat| {
        let folded = ctx.insert_const(6);
        ctx.union(pat.p, folded);
    });
    let after = Add::new(&Const::new(3), &Const::new(4));
    after.commit();
}
"#;
        let ir = extract(src, "DemoPat::new");
        assert_eq!(ir.seed_facts.len(), 1);
        assert_eq!(ir.seed_facts[0].committed_root, "before");
        assert_eq!(ir.seed_facts[0].source_text, "before.commit()");
    }

    #[test]
    fn seed_facts_ignore_nested_item_bodies() {
        let src = r#"
fn demo() {
    let before = Add::new(&Const::new(1), &Const::new(2));
    before.commit();
    fn helper() {
        let nested = Add::new(&Const::new(5), &Const::new(6));
        nested.commit();
    }
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        DemoPat::new(l, r, p)
    }, |ctx, pat| {
        let folded = ctx.insert_const(6);
        ctx.union(pat.p, folded);
    });
}
"#;
        let ir = extract(src, "DemoPat::new");
        assert_eq!(ir.seed_facts.len(), 1);
        assert_eq!(ir.seed_facts[0].committed_root, "before");
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
        assert!(ir.action_effects.is_empty());
        assert!(ir.seed_facts.is_empty());
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
