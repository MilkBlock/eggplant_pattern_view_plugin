use anyhow::{Result, anyhow};
use ra_ap_syntax::{
    AstNode, Edition, SourceFile, SyntaxNode, TextRange, TextSize, algo,
    ast::{self, HasArgList, HasAttrs, HasName},
};
use regex::Regex;
use std::collections::{BTreeSet, HashMap, HashSet};

use crate::ir::{
    ActionEffect, Diagnostic, DisplayTemplate, MathView, MathViewConclusion, MathViewEntry,
    MathViewFormulaSource, NodeKind, PatternConstraint, PatternEdge, PatternIr, PatternNode,
    PrecedenceTemplate, ScopeInfo, ScopeKind, SeedFact, TextSpan, TypstTemplate,
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

    let scope = find_scope(syntax, offset)
        .ok_or_else(|| anyhow!("no supported pattern scope found at cursor"))?;
    let display_templates = extract_display_templates(source);
    let typst_templates = extract_typst_templates(source);
    let precedence_templates = extract_precedence_templates(source);
    let mut ir = match scope {
        Scope::RuleCall(call) => extract_from_rule_call(call),
        Scope::Function(function) => extract_from_function(function),
    }?;
    ir.display_templates = display_templates;
    ir.typst_templates = typst_templates;
    ir.precedence_templates = precedence_templates;
    ir.diagnostics.append(&mut diagnostics);
    ir.math_view = build_math_view(source, &ir);
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

    if let Some(call) = root
        .descendants()
        .filter_map(ast::CallExpr::cast)
        .filter(|call| {
            let call_range = call.syntax().text_range();
            let callee_range = call.expr().map(|expr| expr.syntax().text_range());
            callee_range
                .map(|range| range.contains(offset) || range.start() == offset)
                .unwrap_or(false)
                || call_range.contains(offset)
                || call_range.start() == offset
        })
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
    if !callee_text.ends_with("add_rule") && !callee_text.ends_with("add_rule_with_hook") {
        return false;
    }
    call.arg_list()
        .and_then(|args| args.args().nth(3))
        .and_then(|arg| expr_as_closure(&arg))
        .is_some()
}

fn function_looks_like_pattern(function: &ast::Fn) -> bool {
    let Some(body) = function.body() else {
        return false;
    };
    let top_level_exprs = block_top_level_exprs(&body);
    let has_pat_new = top_level_exprs
        .iter()
        .flat_map(|expr| expr.syntax().descendants().filter_map(ast::CallExpr::cast))
        .any(|call| call_path(&call).is_some_and(|path| path.ends_with("::new")));
    let has_query = top_level_exprs
        .iter()
        .flat_map(|expr| expr.syntax().descendants().filter_map(ast::CallExpr::cast))
        .any(|call| is_query_call(&call));
    has_pat_new && has_query
}

fn block_top_level_exprs(block: &ast::BlockExpr) -> Vec<ast::Expr> {
    let mut exprs = Vec::new();
    for stmt in block.statements() {
        match stmt {
            ast::Stmt::LetStmt(let_stmt) => {
                if let Some(init) = let_stmt.initializer() {
                    exprs.push(init);
                }
            }
            ast::Stmt::ExprStmt(expr_stmt) => {
                if let Some(expr) = expr_stmt.expr() {
                    exprs.push(expr);
                }
            }
            ast::Stmt::Item(_) => {}
        }
    }
    if let Some(tail) = block.tail_expr() {
        exprs.push(tail);
    }
    exprs
}

fn extract_from_rule_call(call: ast::CallExpr) -> Result<PatternIr> {
    let args = call
        .arg_list()
        .ok_or_else(|| anyhow!("add_rule call has no arg list"))?
        .args()
        .collect::<Vec<_>>();
    let pattern_arg = args
        .get(2)
        .ok_or_else(|| anyhow!("add_rule pattern argument not found"))?;
    let action_closure = args.get(3).and_then(expr_as_closure);
    let action_bindings = action_closure.as_ref().and_then(action_closure_bindings);
    let enclosing_function = call.syntax().ancestors().find_map(ast::Fn::cast);
    let block = resolve_rule_pattern_block(&call, pattern_arg)?;
    extract_from_block(
        block,
        ScopeInfo {
            kind: ScopeKind::AddRuleCall,
            text_range: span_from_text_range(call.syntax().text_range()),
            pattern_range: Some(span_from_text_range(pattern_arg.syntax().text_range())),
            action_range: action_closure
                .as_ref()
                .map(|closure| span_from_text_range(closure.syntax().text_range())),
        },
        action_closure.and_then(closure_block_body),
        action_bindings,
        enclosing_function.and_then(|function| function.body()),
        Some(call),
    )
}

fn resolve_rule_pattern_block(
    call: &ast::CallExpr,
    pattern_arg: &ast::Expr,
) -> Result<ast::BlockExpr> {
    if let Some(pattern_closure) = expr_as_closure(pattern_arg) {
        let Some(body) = pattern_closure.body() else {
            return Err(anyhow!("pattern closure has no body"));
        };
        return match body {
            ast::Expr::BlockExpr(block) => Ok(block),
            _ => Err(anyhow!("pattern closure body is not a block")),
        };
    }

    let pattern_fn_name = expr_variable_name(pattern_arg.clone())
        .and_then(|name| name.split("::").last().map(str::to_string))
        .ok_or_else(|| anyhow!("add_rule pattern closure or function not found"))?;
    let file_root = call
        .syntax()
        .ancestors()
        .last()
        .ok_or_else(|| anyhow!("failed to resolve syntax root for add_rule call"))?;
    let pattern_fn = file_root
        .descendants()
        .filter_map(ast::Fn::cast)
        .find(|function| {
            function
                .name()
                .is_some_and(|name| name.syntax().text().to_string() == pattern_fn_name)
        })
        .ok_or_else(|| anyhow!("referenced pattern function not found: {pattern_fn_name}"))?;
    pattern_fn
        .body()
        .ok_or_else(|| anyhow!("pattern function has no body"))
}

fn extract_from_function(function: ast::Fn) -> Result<PatternIr> {
    let Some(body) = function.body() else {
        return Err(anyhow!("pattern function has no body"));
    };
    let pattern_range = span_from_text_range(body.syntax().text_range());
    extract_from_block(
        body,
        ScopeInfo {
            kind: ScopeKind::PatternFunction,
            text_range: span_from_text_range(function.syntax().text_range()),
            pattern_range: Some(pattern_range),
            action_range: None,
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
    let mut query_vec_bindings: HashMap<String, Vec<String>> = HashMap::new();
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
                if let Some(pat) = let_stmt.pat()
                    && let Some(name) = ident_pat_name(pat)
                    && let Some(init) = let_stmt.initializer()
                {
                    if let Some(inputs) = collect_query_vec_binding_inputs(&init, &query_vec_bindings)
                        && !inputs.is_empty()
                    {
                        query_vec_bindings.insert(name, inputs);
                    }
                }
                if let Some(node) = extract_let_node(&let_stmt, &query_vec_bindings) {
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
                    extend_query_vec_binding(&expr, &mut query_vec_bindings);
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
            ast::Stmt::Item(item) => {
                if let ast::Item::Struct(strukt) = item
                    && struct_has_pat_attr(&strukt)
                {
                    roots.extend(struct_pat_roots(&strukt));
                }
            }
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
        action_effects =
            extract_action_effects(&action_block, &action_bindings, &known_pattern_vars);
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
        display_templates: Vec::new(),
        typst_templates: Vec::new(),
        precedence_templates: Vec::new(),
        diagnostics,
        math_view: None,
    })
}

fn extract_display_templates(source: &str) -> Vec<DisplayTemplate> {
    extract_templates(source, "display")
        .into_iter()
        .map(|template| DisplayTemplate {
            variant_name: template.variant_name,
            template: template.template,
            fields: template.fields,
        })
        .collect()
}

fn extract_typst_templates(source: &str) -> Vec<TypstTemplate> {
    extract_templates(source, "typst")
        .into_iter()
        .map(|template| TypstTemplate {
            variant_name: template.variant_name,
            template: template.template,
            fields: template.fields,
        })
        .collect()
}

fn extract_precedence_templates(source: &str) -> Vec<PrecedenceTemplate> {
    let attr_re = Regex::new(
        r#"(?s)#\s*\[\s*(?:eggplant::)?precedence\((?P<precedence>\d+)\)\s*\]\s*(?:#\s*\[[^\]]+\]\s*)*(?:(?:struct|enum)\s+)?(?P<variant>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\{[^}]*\})?"#
    )
    .expect("valid precedence regex");

    attr_re
        .captures_iter(source)
        .filter_map(|caps| {
            let variant_name = caps.name("variant")?.as_str().to_string();
            let precedence = caps.name("precedence")?.as_str().parse::<u16>().ok()?;
            Some(PrecedenceTemplate {
                variant_name,
                precedence,
            })
        })
        .collect()
}

#[derive(Debug, Clone)]
struct RawTemplate {
    variant_name: String,
    template: String,
    fields: Vec<String>,
}

fn extract_templates(source: &str, attr_name: &str) -> Vec<RawTemplate> {
    let attr_re = Regex::new(
        &format!(
            r#"(?s)#\s*\[\s*(?:eggplant::)?{attr_name}\("(?P<template>(?:\\.|[^"])*)"\)\s*\]\s*(?:#\s*\[[^\]]+\]\s*)*(?:(?:struct|enum)\s+)?(?P<variant>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\{{(?P<fields>[^}}]*)\}})?"#
        ),
    )
    .expect("valid template regex");
    let field_re =
        Regex::new(r#"(?m)([A-Za-z_][A-Za-z0-9_]*)\s*:"#).expect("valid template field regex");

    attr_re
        .captures_iter(source)
        .map(|caps| {
            let template = caps
                .name("template")
                .map(|value| value.as_str().replace("\\\"", "\""))
                .unwrap_or_default();
            let variant_name = caps
                .name("variant")
                .map(|value| value.as_str().to_string())
                .unwrap_or_default();
            let fields = caps
                .name("fields")
                .map(|body| {
                    field_re
                        .captures_iter(body.as_str())
                        .filter_map(|field_caps| {
                            field_caps.get(1).map(|name| name.as_str().to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            RawTemplate {
                variant_name,
                template,
                fields,
            }
        })
        .collect()
}

fn extract_let_node(
    let_stmt: &ast::LetStmt,
    query_vec_bindings: &HashMap<String, Vec<String>>,
) -> Option<PatternNode> {
    let name = ident_pat_name(let_stmt.pat()?)?;
    let init = let_stmt.initializer()?;
    let query = query_spec(&init, query_vec_bindings)?;
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

fn normalize_query_dsl_type(path: &str) -> String {
    path.split("::").last().unwrap_or(path).to_string()
}

fn query_spec(expr: &ast::Expr, query_vec_bindings: &HashMap<String, Vec<String>>) -> Option<QuerySpec> {
    let call = ast::CallExpr::cast(expr.syntax().clone())?;
    let callee = call_path(&call)?;
    let (kind, suffix) = if callee.ends_with("::query_leaf") {
        (crate::ir::NodeKind::QueryLeaf, "::query_leaf")
    } else if callee.ends_with("::query_fields") {
        (crate::ir::NodeKind::Query, "::query_fields")
    } else if callee.ends_with("::query_named") {
        (crate::ir::NodeKind::Query, "::query_named")
    } else if callee.ends_with("::query") {
        (crate::ir::NodeKind::Query, "::query")
    } else {
        return None;
    };
    let dsl_type = normalize_query_dsl_type(callee.trim_end_matches(suffix));
    let inputs = call
        .arg_list()
        .into_iter()
        .flat_map(|args| args.args())
        .flat_map(|arg| collect_query_inputs_from_expr(&arg, query_vec_bindings))
        .collect();
    Some(QuerySpec {
        kind,
        dsl_type,
        inputs,
    })
}

fn collect_query_inputs_from_expr(
    expr: &ast::Expr,
    query_vec_bindings: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    match expr {
        ast::Expr::RefExpr(ref_expr) => ref_expr
            .expr()
            .map(|inner| collect_query_inputs_from_expr(&inner, query_vec_bindings))
            .unwrap_or_default(),
        ast::Expr::ParenExpr(paren_expr) => paren_expr
            .expr()
            .map(|inner| collect_query_inputs_from_expr(&inner, query_vec_bindings))
            .unwrap_or_default(),
        ast::Expr::ArrayExpr(array_expr) => array_expr
            .exprs()
            .flat_map(|item| collect_query_inputs_from_expr(&item, query_vec_bindings))
            .collect(),
        ast::Expr::FieldExpr(field_expr) => field_expr
            .expr()
            .map(|receiver| collect_query_inputs_from_expr(&receiver, query_vec_bindings))
            .unwrap_or_default(),
        ast::Expr::MethodCallExpr(method_call) => {
            let mut inputs = method_call
                .receiver()
                .map(|receiver| collect_query_inputs_from_expr(&receiver, query_vec_bindings))
                .unwrap_or_default();
            if let Some(args) = method_call.arg_list() {
                for arg in args.args() {
                    inputs.extend(collect_query_inputs_from_expr(&arg, query_vec_bindings));
                }
            }
            if inputs.is_empty() {
                expr_variable_name(expr.clone()).into_iter().collect()
            } else {
                inputs
            }
        }
        ast::Expr::CallExpr(call_expr) => call_expr
            .arg_list()
            .into_iter()
            .flat_map(|args| args.args())
            .flat_map(|arg| collect_query_inputs_from_expr(&arg, query_vec_bindings))
            .collect(),
        ast::Expr::PathExpr(path_expr) => {
            let name = path_expr.syntax().text().to_string();
            if let Some(inputs) = query_vec_bindings.get(&name) {
                return inputs.clone();
            }
            vec![name]
        }
        ast::Expr::MacroExpr(macro_expr) => {
            collect_vec_macro_items(&macro_expr.syntax().text().to_string())
                .into_iter()
                .filter_map(|item| parse_simple_ident_expr(&item))
                .flat_map(|name| query_vec_bindings.get(&name).cloned().unwrap_or_else(|| vec![name]))
                .collect()
        }
        _ => expr_variable_name(expr.clone()).into_iter().collect(),
    }
}

fn collect_query_vec_binding_inputs(
    expr: &ast::Expr,
    query_vec_bindings: &HashMap<String, Vec<String>>,
) -> Option<Vec<String>> {
    if query_spec(expr, query_vec_bindings).is_some() {
        return None;
    }

    match expr {
        ast::Expr::RefExpr(ref_expr) => ref_expr
            .expr()
            .and_then(|inner| collect_query_vec_binding_inputs(&inner, query_vec_bindings)),
        ast::Expr::ParenExpr(paren_expr) => paren_expr
            .expr()
            .and_then(|inner| collect_query_vec_binding_inputs(&inner, query_vec_bindings)),
        ast::Expr::ArrayExpr(array_expr) => Some(
            array_expr
                .exprs()
                .flat_map(|item| collect_query_inputs_from_expr(&item, query_vec_bindings))
                .collect(),
        ),
        ast::Expr::MacroExpr(_macro_expr) => {
            let inputs = collect_query_inputs_from_expr(expr, query_vec_bindings);
            if inputs.is_empty() { None } else { Some(inputs) }
        }
        ast::Expr::PathExpr(path_expr) => {
            let name = path_expr.syntax().text().to_string();
            query_vec_bindings.get(&name).cloned()
        }
        ast::Expr::MethodCallExpr(method_call) => {
            let mut inputs = method_call
                .receiver()
                .and_then(|receiver| collect_query_vec_binding_inputs(&receiver, query_vec_bindings))
                .unwrap_or_default();
            if let Some(args) = method_call.arg_list() {
                for arg in args.args() {
                    inputs.extend(collect_query_inputs_from_expr(&arg, query_vec_bindings));
                }
            }
            if inputs.is_empty() { None } else { Some(inputs) }
        }
        ast::Expr::CallExpr(call_expr) => {
            let inputs = call_expr
                .arg_list()
                .into_iter()
                .flat_map(|args| args.args())
                .flat_map(|arg| collect_query_inputs_from_expr(&arg, query_vec_bindings))
                .collect::<Vec<_>>();
            if inputs.is_empty() { None } else { Some(inputs) }
        }
        _ => None,
    }
}

fn extend_query_vec_binding(expr: &ast::Expr, query_vec_bindings: &mut HashMap<String, Vec<String>>) {
    let Some(method_call) = expr_as_method_call(expr) else {
        return;
    };
    if method_call.name_ref().map(|name| name.syntax().text().to_string()) != Some("push".into()) {
        return;
    }
    let Some(receiver_name) = method_call.receiver().and_then(expr_variable_name) else {
        return;
    };
    let Some(new_input) = method_call
        .arg_list()
        .and_then(|args| args.args().next())
        .map(|arg| collect_query_inputs_from_expr(&arg, query_vec_bindings))
    else {
        return;
    };
    if new_input.is_empty() {
        return;
    }
    if let Some(existing_inputs) = query_vec_bindings.get_mut(&receiver_name) {
        existing_inputs.extend(new_input);
    }
}

fn collect_vec_macro_items(text: &str) -> Vec<String> {
    let compact = text
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    if !compact.starts_with("vec![") || !compact.ends_with(']') {
        return Vec::new();
    }
    let inner = &compact["vec![".len()..compact.len() - 1];
    split_top_level_commas(inner)
}

fn split_top_level_commas(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut paren = 0usize;
    let mut bracket = 0usize;
    let mut brace = 0usize;
    let mut angle = 0usize;
    for (index, ch) in input.char_indices() {
        match ch {
            '(' => paren += 1,
            ')' => paren = paren.saturating_sub(1),
            '[' => bracket += 1,
            ']' => bracket = bracket.saturating_sub(1),
            '{' => brace += 1,
            '}' => brace = brace.saturating_sub(1),
            '<' => angle += 1,
            '>' => angle = angle.saturating_sub(1),
            ',' if paren == 0 && bracket == 0 && brace == 0 && angle == 0 => {
                let item = input[start..index].trim();
                if !item.is_empty() {
                    parts.push(item.to_string());
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    let tail = input[start..].trim();
    if !tail.is_empty() {
        parts.push(tail.to_string());
    }
    parts
}

fn parse_simple_ident_expr(input: &str) -> Option<String> {
    let mut text = input.trim();
    loop {
        let trimmed = text.trim_start_matches('&').trim();
        if trimmed.len() != text.len() {
            text = trimmed;
            continue;
        }
        if trimmed.starts_with('(') && trimmed.ends_with(')') && trimmed.len() > 1 {
            text = &trimmed[1..trimmed.len() - 1];
            continue;
        }
        break;
    }
    if let Some((receiver, _)) = text.split_once('.')
        && is_plain_ident(receiver)
    {
        return Some(receiver.to_string());
    }
    if text.is_empty()
        || !text
            .chars()
            .all(|ch| ch == '_' || ch == ':' || ch.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(text.to_string())
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
            let semantic_text =
                semanticize_constraint_text(&arg.syntax().text().to_string(), &resolved_text);
            extracted_constraints.push(PatternConstraint {
                id: String::new(),
                source_text: arg.syntax().text().to_string(),
                resolved_text,
                semantic_text,
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

fn semanticize_constraint_text(source_text: &str, resolved_text: &str) -> Option<String> {
    let semantic_source = if source_text == resolved_text {
        source_text
    } else {
        resolved_text
    };
    semanticize_comparison_expr_text(semantic_source)
}

fn semanticize_action_effect_text(source_text: &str) -> Option<String> {
    let trimmed = source_text.trim().trim_end_matches(';').trim();
    let set_match = Regex::new(r"^(?:[A-Za-z_][A-Za-z0-9_]*\.)?set_([A-Za-z0-9_]+)\(([\s\S]*)\)$")
        .ok()?
        .captures(trimmed)?;
    let target = set_match.get(1)?.as_str();
    let args = split_top_level_args(set_match.get(2)?.as_str());
    if args.len() < 2 {
        return None;
    }
    let lhs_args = args[..args.len() - 1]
        .iter()
        .map(|arg| semanticize_value_expr_text(arg))
        .collect::<Option<Vec<_>>>()?;
    let rhs = semanticize_value_expr_text(args.last()?)?;
    Some(format!("{target}({}) = {rhs}", lhs_args.join(", ")))
}

fn semanticize_comparison_expr_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let primitive_ops = [
        ("eq", "=="),
        ("ne", "!="),
        ("lt", "<"),
        ("le", "<="),
        ("gt", ">"),
        ("ge", ">="),
    ];
    for (method, operator) in primitive_ops {
        let suffix = format!(".{method}(");
        if let Some(index) = find_top_level_method_suffix(trimmed, &suffix) {
            let lhs = trimmed[..index].trim();
            let arg_start = index + suffix.len();
            if !trimmed.ends_with(')') {
                return None;
            }
            let rhs = &trimmed[arg_start..trimmed.len() - 1];
            let lhs_semantic = semanticize_handle_expr_text(lhs)?;
            let rhs_semantic = semanticize_handle_expr_text(rhs)?;
            return Some(format!("{lhs_semantic} {operator} {rhs_semantic}"));
        }
    }
    None
}

fn semanticize_value_expr_text(text: &str) -> Option<String> {
    let trimmed = trim_wrapping_expr(text);
    if trimmed.is_empty() {
        return None;
    }

    if let Some(stripped) = trimmed.strip_prefix('&') {
        return semanticize_value_expr_text(stripped);
    }

    if let Some(inner) = strip_suffix_call(trimmed, ".clone()") {
        return semanticize_value_expr_text(inner);
    }
    if let Some(inner) = strip_suffix_call(trimmed, ".as_handle()") {
        return semanticize_value_expr_text(inner);
    }
    if let Some(inner) = strip_suffix_call(trimmed, ".handle()") {
        return semanticize_value_expr_text(inner);
    }
    if let Some((base, field)) = strip_handle_field_call(trimmed) {
        let base_semantic = semanticize_value_expr_text(base)?;
        return Some(format!("{base_semantic}.{field}"));
    }

    if let Some((left, operator, right)) = split_top_level_binary(trimmed) {
        let left_semantic = semanticize_value_expr_text(left)?;
        let right_semantic = semanticize_value_expr_text(right)?;
        return Some(format!("{left_semantic} {operator} {right_semantic}"));
    }

    if let Some((name, args)) = split_call_expr(trimmed) {
        let args_semantic = args
            .iter()
            .map(|arg| semanticize_value_expr_text(arg))
            .collect::<Option<Vec<_>>>()?;
        return Some(format!("{name}({})", args_semantic.join(", ")));
    }

    Some(normalize_atomic_value(trimmed))
}

fn semanticize_handle_expr_text(text: &str) -> Option<String> {
    semanticize_value_expr_text(text)
}

fn normalize_atomic_value(text: &str) -> String {
    let trimmed = trim_wrapping_expr(text);
    let integer_suffix = Regex::new(r"^(-?\d+)_i(?:8|16|32|64|128|size)$").unwrap();
    if let Some(captures) = integer_suffix.captures(trimmed)
        && let Some(number) = captures.get(1)
    {
        return number.as_str().to_string();
    }
    trimmed.to_string()
}

fn trim_wrapping_expr(text: &str) -> &str {
    let mut current = text.trim();
    loop {
        let mut chars = current.chars();
        if matches!(chars.next(), Some('(')) && matches!(current.chars().last(), Some(')')) && expr_wrapped_by_outer_parens(current) {
            current = current[1..current.len() - 1].trim();
            continue;
        }
        break;
    }
    current
}

fn expr_wrapped_by_outer_parens(text: &str) -> bool {
    let mut depth = 0usize;
    for (index, ch) in text.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 && index != text.len() - 1 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

fn strip_suffix_call<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    text.strip_suffix(suffix).map(trim_wrapping_expr)
}

fn strip_handle_field_call<'a>(text: &'a str) -> Option<(&'a str, &'a str)> {
    let captures = Regex::new(r"^(.+)\.handle_([A-Za-z_][A-Za-z0-9_]*)\(\)$")
        .ok()?
        .captures(text)?;
    Some((
        captures.get(1)?.as_str().trim(),
        captures.get(2)?.as_str().trim(),
    ))
}

fn split_call_expr(text: &str) -> Option<(&str, Vec<&str>)> {
    if !text.ends_with(')') {
        return None;
    }
    let open = text.find('(')?;
    if open == 0 {
        return None;
    }
    let name = text[..open].trim();
    if name.is_empty() || text[open + 1..text.len() - 1].contains("=>") {
        return None;
    }
    Some((name, split_top_level_args(&text[open + 1..text.len() - 1])))
}

fn split_top_level_args(text: &str) -> Vec<&str> {
    let mut args = Vec::new();
    let mut depth_paren = 0usize;
    let mut depth_bracket = 0usize;
    let mut depth_brace = 0usize;
    let mut start = 0usize;
    for (index, ch) in text.char_indices() {
        match ch {
            '(' => depth_paren += 1,
            ')' => depth_paren = depth_paren.saturating_sub(1),
            '[' => depth_bracket += 1,
            ']' => depth_bracket = depth_bracket.saturating_sub(1),
            '{' => depth_brace += 1,
            '}' => depth_brace = depth_brace.saturating_sub(1),
            ',' if depth_paren == 0 && depth_bracket == 0 && depth_brace == 0 => {
                args.push(text[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    let tail = text[start..].trim();
    if !tail.is_empty() {
        args.push(tail);
    }
    args
}

fn split_top_level_binary(text: &str) -> Option<(&str, &str, &str)> {
    let operators = ["==", "!=", "<=", ">=", "+", "-", "*", "/"];
    let mut depth_paren = 0usize;
    let mut depth_bracket = 0usize;
    let mut depth_brace = 0usize;
    for (index, ch) in text.char_indices().rev() {
        match ch {
            ')' => depth_paren += 1,
            '(' => depth_paren = depth_paren.saturating_sub(1),
            ']' => depth_bracket += 1,
            '[' => depth_bracket = depth_bracket.saturating_sub(1),
            '}' => depth_brace += 1,
            '{' => depth_brace = depth_brace.saturating_sub(1),
            _ => {}
        }
        if depth_paren != 0 || depth_bracket != 0 || depth_brace != 0 {
            continue;
        }
        for operator in operators {
            if index + operator.len() <= text.len() && &text[index..index + operator.len()] == operator {
                let left = text[..index].trim();
                let right = text[index + operator.len()..].trim();
                if !left.is_empty() && !right.is_empty() {
                    return Some((left, operator, right));
                }
            }
        }
    }
    None
}

fn find_top_level_method_suffix(text: &str, suffix: &str) -> Option<usize> {
    let mut depth_paren = 0usize;
    let mut depth_bracket = 0usize;
    let mut depth_brace = 0usize;
    for (index, ch) in text.char_indices() {
        match ch {
            '(' => depth_paren += 1,
            ')' => depth_paren = depth_paren.saturating_sub(1),
            '[' => depth_bracket += 1,
            ']' => depth_bracket = depth_bracket.saturating_sub(1),
            '{' => depth_brace += 1,
            '}' => depth_brace = depth_brace.saturating_sub(1),
            _ => {}
        }
        if depth_paren == 0 && depth_bracket == 0 && depth_brace == 0 && text[index..].starts_with(suffix) {
            return Some(index);
        }
    }
    None
}

const MATH_VIEW_PATTERN_COLOR: &str = "#5F7A8A";
const MATH_VIEW_ACTION_COLOR: &str = "#B86A5B";
const MAX_MATH_PRECEDENCE: u16 = u16::MAX;

#[derive(Debug, Clone)]
struct TemplateRef<'a> {
    template: &'a str,
    fields: &'a [String],
    kind: TemplateKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TemplateKind {
    Typst,
    Display,
}

#[derive(Debug, Clone)]
struct RenderedMathExpr {
    plain: String,
    colored: String,
    precedence: u16,
    is_atomic: bool,
}

#[derive(Debug, Clone)]
struct InsertCall {
    variant_name: String,
    args: Vec<String>,
}

#[derive(Debug, Clone)]
struct SetCall {
    target_name: String,
    lhs_args: Vec<String>,
    rhs_arg: String,
}

#[derive(Debug, Clone)]
enum UnionTarget {
    Pattern(String),
    Action(String),
}

#[derive(Debug, Clone)]
struct UnionConclusion {
    pattern_var: String,
    target: UnionTarget,
}

fn build_math_view(source: &str, ir: &PatternIr) -> Option<MathView> {
    let rule_name = parse_rule_name_from_source(source, ir);
    let node_by_id = ir
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let effect_by_id = ir
        .action_effects
        .iter()
        .map(|effect| (effect.id.as_str(), effect))
        .collect::<HashMap<_, _>>();
    let effect_by_binding = ir
        .action_effects
        .iter()
        .filter_map(|effect| effect.bound_var.as_deref().map(|bound| (bound, effect.id.as_str())))
        .collect::<HashMap<_, _>>();
    let incoming_counts = build_incoming_counts(ir);
    let visible_root_ids = visible_premise_root_ids(ir, &node_by_id);
    let mut pattern_entry_cache = HashMap::<String, MathViewEntry>::new();
    let mut action_entry_cache = HashMap::<String, MathViewEntry>::new();

    let premises = visible_root_ids
        .iter()
        .map(|target_id| build_pattern_entry(
            target_id,
            ir,
            &node_by_id,
            &incoming_counts,
            &mut pattern_entry_cache,
        ))
        .collect::<Vec<_>>();

    let mut visible_effect_ids = BTreeSet::<String>::new();
    let mut conclusions = Vec::<MathViewConclusion>::new();
    for effect in &ir.action_effects {
        let Some(union) = parse_union_conclusion(&effect.source_text) else {
            continue;
        };
        let from = build_pattern_entry(
            &union.pattern_var,
            ir,
            &node_by_id,
            &incoming_counts,
            &mut pattern_entry_cache,
        );
        let to = match union.target {
            UnionTarget::Pattern(ref target_id) => build_pattern_entry(
                target_id,
                ir,
                &node_by_id,
                &incoming_counts,
                &mut pattern_entry_cache,
            ),
            UnionTarget::Action(ref bound_var) => build_action_entry_by_binding(
                bound_var,
                ir,
                &node_by_id,
                &effect_by_id,
                &effect_by_binding,
                &incoming_counts,
                &mut pattern_entry_cache,
                &mut action_entry_cache,
            ),
        };
        conclusions.push(MathViewConclusion::Rewrite {
            id: effect.id.clone(),
            from,
            to,
        });
        if let UnionTarget::Action(ref bound_var) = union.target {
            collect_action_dependencies(bound_var, &effect_by_binding, &effect_by_id, &mut visible_effect_ids);
        }
    }

    if conclusions.is_empty() && !ir.action_effects.is_empty() {
        let consumed_action_vars = ir
            .action_effects
            .iter()
            .flat_map(|effect| effect.referenced_action_vars.iter().cloned())
            .collect::<HashSet<_>>();
        let terminal_effects = ir
            .action_effects
            .iter()
            .filter(|effect| {
                effect
                    .bound_var
                    .as_ref()
                    .map(|bound| !consumed_action_vars.contains(bound))
                    .unwrap_or_else(|| effect.semantic_text.is_some())
            })
            .collect::<Vec<_>>();
        for effect in terminal_effects {
            if let Some(bound_var) = effect.bound_var.as_deref() {
                collect_action_dependencies(bound_var, &effect_by_binding, &effect_by_id, &mut visible_effect_ids);
            }
            conclusions.push(MathViewConclusion::Derive {
                id: effect.id.clone(),
                entry: build_action_entry_from_effect(
                    effect,
                    ir,
                    &node_by_id,
                    &effect_by_id,
                    &effect_by_binding,
                    &incoming_counts,
                    &mut pattern_entry_cache,
                    &mut action_entry_cache,
                ),
            });
        }
    }

    let derivations = ir
        .action_effects
        .iter()
        .filter(|effect| visible_effect_ids.contains(&effect.id))
        .map(|effect| {
            build_action_entry_from_effect(
                effect,
                ir,
                &node_by_id,
                &effect_by_id,
                &effect_by_binding,
                &incoming_counts,
                &mut pattern_entry_cache,
                &mut action_entry_cache,
            )
        })
        .collect::<Vec<_>>();

    let side_conditions = ir
        .constraints
        .iter()
        .map(|constraint| {
            constraint
                .semantic_text
                .as_deref()
                .map(semantic_text_to_typst)
                .unwrap_or_else(|| compact_constraint_label(&constraint.source_text, &constraint.resolved_text))
        })
        .collect::<Vec<_>>();

    let formula_source = build_math_view_formula_source(&premises, &derivations, &conclusions, &side_conditions);
    Some(MathView {
        rule_name,
        premises,
        side_conditions,
        derivations,
        conclusions,
        formula_source,
    })
}

fn parse_rule_name_from_source(source: &str, ir: &PatternIr) -> String {
    let start = ir.scope.text_range.start.min(source.len());
    let end = ir.scope.text_range.end.min(source.len());
    let slice = &source[start..end];
    Regex::new(r#"add_rule(?:_with_hook)?\(\s*"([^"]+)""#)
        .ok()
        .and_then(|regex| regex.captures(slice))
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_string())
        .unwrap_or_else(|| format!("rule@{}", ir.scope.text_range.start))
}

fn build_incoming_counts(ir: &PatternIr) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for edge in &ir.edges {
        *counts.entry(edge.to.clone()).or_insert(0) += 1;
    }
    counts
}

fn visible_premise_root_ids(
    ir: &PatternIr,
    node_by_id: &HashMap<&str, &PatternNode>,
) -> Vec<String> {
    let has_non_leaf_root = ir.roots.iter().any(|root| {
        node_by_id
            .get(root.as_str())
            .map(|node| node.kind != NodeKind::QueryLeaf)
            .unwrap_or(false)
    });
    ir.roots
        .iter()
        .filter(|root| {
            if !has_non_leaf_root {
                return true;
            }
            node_by_id
                .get(root.as_str())
                .map(|node| node.kind != NodeKind::QueryLeaf)
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

fn build_pattern_entry(
    target_id: &str,
    ir: &PatternIr,
    node_by_id: &HashMap<&str, &PatternNode>,
    incoming_counts: &HashMap<String, usize>,
    cache: &mut HashMap<String, MathViewEntry>,
) -> MathViewEntry {
    if let Some(entry) = cache.get(target_id) {
        return entry.clone();
    }
    let rendered = render_pattern_expr(ir, target_id, node_by_id, incoming_counts, &mut HashSet::new())
        .unwrap_or_else(|| pattern_atomic_expr(target_id));
    let label = node_by_id
        .get(target_id)
        .map(|node| format!("{}: {}", node.id, node.dsl_type))
        .unwrap_or_else(|| target_id.to_string());
    let entry = MathViewEntry {
        target_id: target_id.to_string(),
        label,
        plain_source: rendered.plain,
        colored_source: rendered.colored,
    };
    cache.insert(target_id.to_string(), entry.clone());
    entry
}

fn build_action_entry_by_binding(
    bound_var: &str,
    ir: &PatternIr,
    node_by_id: &HashMap<&str, &PatternNode>,
    effect_by_id: &HashMap<&str, &ActionEffect>,
    effect_by_binding: &HashMap<&str, &str>,
    incoming_counts: &HashMap<String, usize>,
    pattern_cache: &mut HashMap<String, MathViewEntry>,
    action_cache: &mut HashMap<String, MathViewEntry>,
) -> MathViewEntry {
    let effect_id = effect_by_binding
        .get(bound_var)
        .copied()
        .unwrap_or(bound_var);
    let effect = effect_by_id
        .get(effect_id)
        .copied()
        .or_else(|| {
            ir.action_effects
                .iter()
                .find(|effect| effect.bound_var.as_deref() == Some(bound_var))
        })
        .expect("bound action effect should exist");
    build_action_entry_from_effect(
        effect,
        ir,
        node_by_id,
        effect_by_id,
        effect_by_binding,
        incoming_counts,
        pattern_cache,
        action_cache,
    )
}

fn build_action_entry_from_effect(
    effect: &ActionEffect,
    ir: &PatternIr,
    node_by_id: &HashMap<&str, &PatternNode>,
    effect_by_id: &HashMap<&str, &ActionEffect>,
    effect_by_binding: &HashMap<&str, &str>,
    incoming_counts: &HashMap<String, usize>,
    pattern_cache: &mut HashMap<String, MathViewEntry>,
    action_cache: &mut HashMap<String, MathViewEntry>,
) -> MathViewEntry {
    let target_id = format!("effect:{}", effect.id);
    if let Some(entry) = action_cache.get(&target_id) {
        return entry.clone();
    }
    let rendered = render_action_effect_expr(
        effect,
        ir,
        node_by_id,
        effect_by_id,
        effect_by_binding,
        incoming_counts,
        pattern_cache,
        action_cache,
        &mut HashSet::new(),
    )
    .unwrap_or_else(|| action_atomic_expr(effect.bound_var.as_deref().unwrap_or(&effect.id)));
    let entry = MathViewEntry {
        target_id: target_id.clone(),
        label: effect.bound_var.clone().unwrap_or_else(|| effect.id.clone()),
        plain_source: rendered.plain,
        colored_source: rendered.colored,
    };
    action_cache.insert(target_id, entry.clone());
    entry
}

fn collect_action_dependencies(
    bound_var: &str,
    effect_by_binding: &HashMap<&str, &str>,
    effect_by_id: &HashMap<&str, &ActionEffect>,
    visible_effect_ids: &mut BTreeSet<String>,
) {
    let Some(effect_id) = effect_by_binding.get(bound_var).copied() else {
        return;
    };
    if !visible_effect_ids.insert(effect_id.to_string()) {
        return;
    }
    let Some(effect) = effect_by_id.get(effect_id).copied() else {
        return;
    };
    for dependency in &effect.referenced_action_vars {
        collect_action_dependencies(dependency, effect_by_binding, effect_by_id, visible_effect_ids);
    }
}

fn render_pattern_expr(
    ir: &PatternIr,
    target_id: &str,
    node_by_id: &HashMap<&str, &PatternNode>,
    incoming_counts: &HashMap<String, usize>,
    seen: &mut HashSet<String>,
) -> Option<RenderedMathExpr> {
    let Some(node) = node_by_id.get(target_id).copied() else {
        return Some(pattern_atomic_expr(target_id));
    };
    if node.kind == NodeKind::QueryLeaf {
        return Some(pattern_atomic_expr(&node.id));
    }
    if seen.contains(target_id) || incoming_counts.get(target_id).copied().unwrap_or(0) > 1 {
        return None;
    }

    if let Some(template) = find_preferred_template(ir, &node.dsl_type) {
        seen.insert(target_id.to_string());
        let child_exprs = node
            .inputs
            .iter()
            .map(|input| render_pattern_expr(ir, input, node_by_id, incoming_counts, seen))
            .collect::<Option<Vec<_>>>();
        seen.remove(target_id);
        if let Some(child_exprs) = child_exprs {
            return render_template_expr(
                template,
                variant_precedence(ir, &node.dsl_type),
                &child_exprs,
                MATH_VIEW_PATTERN_COLOR,
                node.inputs.is_empty(),
            );
        }
        let atomic_args = node
            .inputs
            .iter()
            .map(|input| pattern_atomic_expr(input))
            .collect::<Vec<_>>();
        if let Some(rendered) = render_template_expr(
            template,
            variant_precedence(ir, &node.dsl_type),
            &atomic_args,
            MATH_VIEW_PATTERN_COLOR,
            node.inputs.is_empty(),
        ) {
            return Some(rendered);
        }
    }

    if node.inputs.is_empty() {
        return Some(pattern_atomic_expr(&node.id));
    }
    let args = node
        .inputs
        .iter()
        .map(|input| {
            render_pattern_expr(ir, input, node_by_id, incoming_counts, &mut HashSet::new())
                .unwrap_or_else(|| pattern_atomic_expr(input))
        })
        .collect::<Vec<_>>();
    Some(render_constructor_expr(&node.dsl_type, &args))
}

fn render_action_effect_expr(
    effect: &ActionEffect,
    ir: &PatternIr,
    node_by_id: &HashMap<&str, &PatternNode>,
    effect_by_id: &HashMap<&str, &ActionEffect>,
    effect_by_binding: &HashMap<&str, &str>,
    incoming_counts: &HashMap<String, usize>,
    pattern_cache: &mut HashMap<String, MathViewEntry>,
    action_cache: &mut HashMap<String, MathViewEntry>,
    seen_effects: &mut HashSet<String>,
) -> Option<RenderedMathExpr> {
    if !seen_effects.insert(effect.id.clone()) {
        return None;
    }

    let rendered = if let Some(set_call) = parse_set_call(&effect.source_text) {
        render_set_expr(
            ir,
            &set_call,
            node_by_id,
            effect_by_id,
            effect_by_binding,
            incoming_counts,
            pattern_cache,
            action_cache,
            seen_effects,
        )
    } else if let Some(semantic) = effect.semantic_text.as_deref() {
        let plain = semantic_text_to_typst(semantic);
        Some(RenderedMathExpr {
            plain: plain.clone(),
            colored: plain,
            precedence: MAX_MATH_PRECEDENCE,
            is_atomic: false,
        })
    } else if let Some(insert_call) = parse_insert_call(&effect.source_text) {
        render_insert_expr(
            ir,
            &insert_call,
            node_by_id,
            effect_by_id,
            effect_by_binding,
            incoming_counts,
            pattern_cache,
            action_cache,
            seen_effects,
        )
    } else {
        None
    };

    seen_effects.remove(&effect.id);
    rendered
}

fn render_insert_expr(
    ir: &PatternIr,
    insert_call: &InsertCall,
    node_by_id: &HashMap<&str, &PatternNode>,
    effect_by_id: &HashMap<&str, &ActionEffect>,
    effect_by_binding: &HashMap<&str, &str>,
    incoming_counts: &HashMap<String, usize>,
    pattern_cache: &mut HashMap<String, MathViewEntry>,
    action_cache: &mut HashMap<String, MathViewEntry>,
    seen_effects: &mut HashSet<String>,
) -> Option<RenderedMathExpr> {
    let args = insert_call
        .args
        .iter()
        .map(|arg| {
            render_action_arg_expr(
                arg,
                ir,
                node_by_id,
                effect_by_id,
                effect_by_binding,
                incoming_counts,
                pattern_cache,
                action_cache,
                seen_effects,
            )
        })
        .collect::<Option<Vec<_>>>()?;
    if let Some(template) = find_preferred_template(ir, &insert_call.variant_name) {
        return render_template_expr(
            template,
            variant_precedence(ir, &insert_call.variant_name),
            &args,
            MATH_VIEW_ACTION_COLOR,
            args.is_empty(),
        );
    }
    Some(render_constructor_expr(&insert_call.variant_name, &args))
}

fn render_set_expr(
    ir: &PatternIr,
    set_call: &SetCall,
    node_by_id: &HashMap<&str, &PatternNode>,
    effect_by_id: &HashMap<&str, &ActionEffect>,
    effect_by_binding: &HashMap<&str, &str>,
    incoming_counts: &HashMap<String, usize>,
    pattern_cache: &mut HashMap<String, MathViewEntry>,
    action_cache: &mut HashMap<String, MathViewEntry>,
    seen_effects: &mut HashSet<String>,
) -> Option<RenderedMathExpr> {
    let lhs_args = set_call
        .lhs_args
        .iter()
        .map(|arg| {
            render_action_arg_expr(
                arg,
                ir,
                node_by_id,
                effect_by_id,
                effect_by_binding,
                incoming_counts,
                pattern_cache,
                action_cache,
                seen_effects,
            )
        })
        .collect::<Option<Vec<_>>>()?;
    let rhs = render_action_arg_expr(
        &set_call.rhs_arg,
        ir,
        node_by_id,
        effect_by_id,
        effect_by_binding,
        incoming_counts,
        pattern_cache,
        action_cache,
        seen_effects,
    )?;
    let lhs = render_set_lhs(ir, &set_call.target_name, &lhs_args)?;
    Some(RenderedMathExpr {
        plain: format!("{} = {}", lhs.plain, rhs.plain),
        colored: format!("{} = {}", lhs.colored, rhs.colored),
        precedence: MAX_MATH_PRECEDENCE,
        is_atomic: false,
    })
}

fn render_set_lhs(ir: &PatternIr, target_name: &str, args: &[RenderedMathExpr]) -> Option<RenderedMathExpr> {
    for candidate in [target_name.to_string(), to_variant_type_name(target_name)] {
        if let Some(template) = find_preferred_template(ir, &candidate) {
            return render_template_expr(
                template,
                variant_precedence(ir, &candidate),
                args,
                MATH_VIEW_ACTION_COLOR,
                args.is_empty(),
            );
        }
    }
    Some(render_constructor_expr(target_name, args))
}

fn render_action_arg_expr(
    arg: &str,
    ir: &PatternIr,
    node_by_id: &HashMap<&str, &PatternNode>,
    effect_by_id: &HashMap<&str, &ActionEffect>,
    effect_by_binding: &HashMap<&str, &str>,
    incoming_counts: &HashMap<String, usize>,
    pattern_cache: &mut HashMap<String, MathViewEntry>,
    action_cache: &mut HashMap<String, MathViewEntry>,
    seen_effects: &mut HashSet<String>,
) -> Option<RenderedMathExpr> {
    let compacted = compact_expression(arg);
    if let Some(effect) = ir
        .action_effects
        .iter()
        .find(|effect| effect.bound_var.as_deref() == Some(compacted.as_str()))
    {
        return render_action_effect_expr(
            effect,
            ir,
            node_by_id,
            effect_by_id,
            effect_by_binding,
            incoming_counts,
            pattern_cache,
            action_cache,
            seen_effects,
        );
    }
    if let Some(effect_id) = effect_by_binding.get(compacted.as_str()).copied()
        && let Some(effect) = effect_by_id.get(effect_id).copied()
    {
        return render_action_effect_expr(
            effect,
            ir,
            node_by_id,
            effect_by_id,
            effect_by_binding,
            incoming_counts,
            pattern_cache,
            action_cache,
            seen_effects,
        );
    }
    if let Some(insert_call) = parse_insert_call(&compacted) {
        return render_insert_expr(
            ir,
            &insert_call,
            node_by_id,
            effect_by_id,
            effect_by_binding,
            incoming_counts,
            pattern_cache,
            action_cache,
            seen_effects,
        );
    }
    let pattern_target = compacted
        .strip_prefix("pat.")
        .or_else(|| compacted.strip_prefix("matched."))
        .unwrap_or(&compacted);
    if node_by_id.contains_key(pattern_target)
        || ir.roots.iter().any(|root| root == pattern_target)
    {
        let entry = build_pattern_entry(pattern_target, ir, node_by_id, incoming_counts, pattern_cache);
        return Some(RenderedMathExpr {
            plain: entry.plain_source,
            colored: entry.colored_source,
            precedence: MAX_MATH_PRECEDENCE,
            is_atomic: true,
        });
    }
    if let Some(semantic) = semanticize_value_expr_text(&compacted) {
        let plain = semantic_text_to_typst(&semantic);
        return Some(RenderedMathExpr {
            plain: plain.clone(),
            colored: color_wrap(&plain, MATH_VIEW_ACTION_COLOR),
            precedence: MAX_MATH_PRECEDENCE,
            is_atomic: !semantic.contains(' '),
        });
    }
    Some(action_atomic_expr(&compacted))
}

fn render_template_expr(
    template: TemplateRef<'_>,
    precedence: u16,
    args: &[RenderedMathExpr],
    top_level_color: &str,
    is_atomic: bool,
) -> Option<RenderedMathExpr> {
    if template.fields.len() != args.len() {
        return None;
    }
    if (template.kind == TemplateKind::Display
        || (template.kind == TemplateKind::Typst && template.template.contains(',')))
        && let Some(prefix_name) = extract_prefix_template_name(template.template)
    {
        let function_name = template_identifier_to_typst(&prefix_name, true);
        let plain_args = args.iter().map(|arg| arg.plain.clone()).collect::<Vec<_>>();
        let colored_args = args.iter().map(|arg| arg.colored.clone()).collect::<Vec<_>>();
        let plain = format!("{function_name}({})", plain_args.join(", "));
        let colored = format!("{function_name}({})", colored_args.join(", "));
        return Some(RenderedMathExpr {
            plain,
            colored: color_wrap(&colored, top_level_color),
            precedence,
            is_atomic,
        });
    }
    let plain = render_template_text(&template, precedence, args, false)?;
    let colored = render_template_text(&template, precedence, args, true)?;
    let normalized_plain = if plain.contains("upright(") {
        plain.clone()
    } else {
        semantic_text_to_typst(&plain)
    };
    Some(RenderedMathExpr {
        plain: normalized_plain,
        colored: if colored.is_empty() { colored } else { color_wrap(&colored, top_level_color) },
        precedence,
        is_atomic,
    })
}

fn extract_prefix_template_name(template: &str) -> Option<String> {
    if template.contains('(') {
        return None;
    }
    let trimmed = template.trim();
    let captures = Regex::new(r"^([A-Za-z_][A-Za-z0-9_]*)\b")
        .ok()?
        .captures(trimmed)?;
    Some(captures.get(1)?.as_str().to_string())
}

fn render_template_text(
    template: &TemplateRef<'_>,
    parent_precedence: u16,
    args: &[RenderedMathExpr],
    colored: bool,
) -> Option<String> {
    let chars = template.template.chars().collect::<Vec<_>>();
    let mut rendered = String::new();
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index] == '{' {
            if chars.get(index + 1) == Some(&'{') {
                rendered.push('{');
                index += 2;
                continue;
            }
            let start = index + 1;
            let mut end = start;
            while end < chars.len() && chars[end] != '}' {
                end += 1;
            }
            if end >= chars.len() {
                return None;
            }
            let placeholder = chars[start..end].iter().collect::<String>();
            let field_index = template.fields.iter().position(|field| field == &placeholder)?;
            let value = args.get(field_index)?;
            let text = if colored { &value.colored } else { &value.plain };
            let needs_parens = value.precedence < parent_precedence
                || (value.precedence == parent_precedence
                    && parent_precedence != MAX_MATH_PRECEDENCE
                    && !value.is_atomic);
            if needs_parens {
                rendered.push('(');
            }
            rendered.push_str(text);
            if needs_parens {
                rendered.push(')');
            }
            index = end + 1;
            continue;
        }
        if chars[index] == '}' && chars.get(index + 1) == Some(&'}') {
            rendered.push('}');
            index += 2;
            continue;
        }
        let start = index;
        while index < chars.len() {
            if chars[index] == '{' {
                break;
            }
            if chars[index] == '}' && chars.get(index + 1) == Some(&'}') {
                break;
            }
            index += 1;
        }
        let literal = chars[start..index].iter().collect::<String>();
        rendered.push_str(&sanitize_template_literal(&literal));
    }
    Some(rendered)
}

fn render_constructor_expr(name: &str, args: &[RenderedMathExpr]) -> RenderedMathExpr {
    let plain_args = args.iter().map(|arg| arg.plain.clone()).collect::<Vec<_>>();
    let colored_args = args.iter().map(|arg| arg.colored.clone()).collect::<Vec<_>>();
    let constructor_name = template_identifier_to_typst(name, true);
    RenderedMathExpr {
        plain: format!("{constructor_name}({})", plain_args.join(", ")),
        colored: format!("{constructor_name}({})", colored_args.join(", ")),
        precedence: MAX_MATH_PRECEDENCE,
        is_atomic: args.is_empty(),
    }
}

fn parse_insert_call(source_text: &str) -> Option<InsertCall> {
    let captures = Regex::new(r"^(?:[A-Za-z_][A-Za-z0-9_]*\.)?insert_([A-Za-z0-9_]+)\(([\s\S]*)\)\s*;?$")
        .ok()?
        .captures(source_text.trim())?;
    Some(InsertCall {
        variant_name: to_variant_type_name(captures.get(1)?.as_str()),
        args: split_top_level_args(captures.get(2)?.as_str())
            .into_iter()
            .map(|arg| arg.to_string())
            .collect(),
    })
}

fn parse_set_call(source_text: &str) -> Option<SetCall> {
    let captures = Regex::new(r"^(?:[A-Za-z_][A-Za-z0-9_]*\.)?set_([A-Za-z0-9_]+)\(([\s\S]*)\)\s*;?$")
        .ok()?
        .captures(source_text.trim())?;
    let target_name = captures.get(1)?.as_str().to_string();
    let args = split_top_level_args(captures.get(2)?.as_str())
        .into_iter()
        .map(|arg| arg.to_string())
        .collect::<Vec<_>>();
    if args.len() < 2 {
        return None;
    }
    Some(SetCall {
        target_name,
        lhs_args: args[..args.len() - 1].to_vec(),
        rhs_arg: args[args.len() - 1].clone(),
    })
}

fn parse_union_conclusion(source_text: &str) -> Option<UnionConclusion> {
    let captures = Regex::new(
        r"^(?:[A-Za-z_][A-Za-z0-9_]*\.)?union\(\s*(?:pat|matched)\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*((?:(?:pat|matched)\.)?)([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;?$",
    )
    .ok()?
    .captures(source_text.trim())?;
    let pattern_var = captures.get(1)?.as_str().to_string();
    let target = if captures.get(2)?.as_str().is_empty() {
        UnionTarget::Action(captures.get(3)?.as_str().to_string())
    } else {
        UnionTarget::Pattern(captures.get(3)?.as_str().to_string())
    };
    Some(UnionConclusion { pattern_var, target })
}

fn build_math_view_formula_source(
    premises: &[MathViewEntry],
    _derivations: &[MathViewEntry],
    conclusions: &[MathViewConclusion],
    side_conditions: &[String],
) -> MathViewFormulaSource {
    let plain_top = join_math_lines(
        premises
            .iter()
            .map(|entry| entry.plain_source.clone())
            .collect(),
        r#"upright("no matched premise")"#,
    );
    let colored_top = join_math_lines(
        premises
            .iter()
            .map(|entry| entry.colored_source.clone())
            .collect(),
        r#"upright("no matched premise")"#,
    );
    let plain_bottom = join_math_lines(
        conclusions
            .iter()
            .map(math_view_conclusion_plain)
            .collect(),
        r#"upright("no conclusion")"#,
    );
    let colored_bottom = join_math_lines(
        conclusions
            .iter()
            .map(math_view_conclusion_colored)
            .collect(),
        r#"upright("no conclusion")"#,
    );
    let side_condition_source = join_math_lines(
        side_conditions.to_vec(),
        r#"upright("None")"#,
    );
    MathViewFormulaSource {
        plain: format!("frac({plain_top}, {plain_bottom}) quad upright(\"if\") quad {side_condition_source}"),
        colored: format!("frac({colored_top}, {colored_bottom}) quad upright(\"if\") quad {side_condition_source}"),
    }
}

fn math_view_conclusion_plain(conclusion: &MathViewConclusion) -> String {
    match conclusion {
        MathViewConclusion::Rewrite { from, to, .. } => {
            format!("{} arrow.r.double {}", from.plain_source, to.plain_source)
        }
        MathViewConclusion::Derive { entry, .. } => entry.plain_source.clone(),
    }
}

fn math_view_conclusion_colored(conclusion: &MathViewConclusion) -> String {
    match conclusion {
        MathViewConclusion::Rewrite { from, to, .. } => {
            format!("{} arrow.r.double {}", from.colored_source, to.colored_source)
        }
        MathViewConclusion::Derive { entry, .. } => entry.colored_source.clone(),
    }
}

fn join_math_lines(entries: Vec<String>, fallback: &str) -> String {
    let filtered = entries
        .into_iter()
        .filter(|entry| !entry.trim().is_empty())
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        fallback.to_string()
    } else {
        filtered.join(" \\ ")
    }
}

fn find_preferred_template<'a>(ir: &'a PatternIr, variant_name: &str) -> Option<TemplateRef<'a>> {
    ir.typst_templates
        .iter()
        .find(|template| template.variant_name == variant_name)
        .map(|template| TemplateRef {
            template: &template.template,
            fields: &template.fields,
            kind: TemplateKind::Typst,
        })
        .or_else(|| {
            ir.display_templates
                .iter()
                .find(|template| template.variant_name == variant_name)
                .map(|template| TemplateRef {
                    template: &template.template,
                    fields: &template.fields,
                    kind: TemplateKind::Display,
                })
        })
}

fn variant_precedence(ir: &PatternIr, variant_name: &str) -> u16 {
    ir.precedence_templates
        .iter()
        .find(|template| template.variant_name == variant_name)
        .map(|template| template.precedence)
        .unwrap_or(MAX_MATH_PRECEDENCE)
}

fn to_variant_type_name(name: &str) -> String {
    name.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<String>()
}

fn compact_expression(text: &str) -> String {
    let mut current = text
        .replace(['\n', '\t'], " ")
        .replace(".clone()", "")
        .replace(".handle()", "")
        .trim()
        .to_string();
    loop {
        let next = current
            .replace("pat.", "")
            .replace("matched.", "")
            .replace("ctx.", "")
            .replace("tx.", "")
            .replace("&", "")
            .trim()
            .to_string();
        if next == current {
            break;
        }
        current = next;
    }
    loop {
        let next = Regex::new(r"\bdevalue\(\s*([^()]+?)\s*\)")
            .ok()
            .map(|regex| regex.replace_all(&current, "$1").to_string())
            .unwrap_or_else(|| current.clone());
        if next == current {
            break;
        }
        current = next;
    }
    current = Regex::new(r#""([^"]+)"\.to_owned\(\)"#)
        .ok()
        .map(|regex| regex.replace_all(&current, r#""$1""#).to_string())
        .unwrap_or(current);
    current.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn pattern_atomic_expr(value: &str) -> RenderedMathExpr {
    let plain = typst_atomic_expression(value);
    RenderedMathExpr {
        plain: plain.clone(),
        colored: color_wrap(&plain, MATH_VIEW_PATTERN_COLOR),
        precedence: MAX_MATH_PRECEDENCE,
        is_atomic: true,
    }
}

fn action_atomic_expr(value: &str) -> RenderedMathExpr {
    let plain = typst_atomic_expression(value);
    RenderedMathExpr {
        plain: plain.clone(),
        colored: color_wrap(&plain, MATH_VIEW_ACTION_COLOR),
        precedence: MAX_MATH_PRECEDENCE,
        is_atomic: true,
    }
}

fn color_wrap(source: &str, color: &str) -> String {
    format!(r#"#text(fill: rgb("{}"))[$ {} $]"#, color, source)
}

fn typst_atomic_expression(value: &str) -> String {
    let compacted = compact_expression(value);
    let string_literal = Regex::new(r#"^"((?:\\.|[^"])*)"$"#)
        .ok()
        .and_then(|regex| regex.captures(&compacted));
    if let Some(captures) = string_literal {
        let unescaped = captures
            .get(1)
            .map(|capture| {
                capture
                    .as_str()
                    .replace(r#"\""#, "\"")
                    .replace(r#"\\"#, "\\")
            })
            .unwrap_or_else(|| compacted.clone());
        if Regex::new(r"^[A-Za-z]$")
            .ok()
            .is_some_and(|regex| regex.is_match(&unescaped))
        {
            return unescaped;
        }
        return typst_text_atom(&unescaped);
    }

    if Regex::new(r"^[A-Za-z]$")
        .ok()
        .is_some_and(|regex| regex.is_match(&compacted))
    {
        return compacted;
    }
    if Regex::new(r"^[A-Za-z][A-Za-z0-9]*$")
        .ok()
        .is_some_and(|regex| regex.is_match(&compacted))
        && compacted.chars().any(|ch| ch.is_ascii_digit())
    {
        if let Some(captures) = Regex::new(r"^([A-Za-z])(\d+)$")
            .ok()
            .and_then(|regex| regex.captures(&compacted))
        {
            return format!(
                "{}_{}",
                captures.get(1).unwrap().as_str(),
                captures.get(2).unwrap().as_str()
            );
        }
        return compacted;
    }
    if Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$")
        .ok()
        .is_some_and(|regex| regex.is_match(&compacted))
    {
        return typst_text_atom(&compacted);
    }
    if Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$")
        .ok()
        .is_some_and(|regex| regex.is_match(&compacted))
    {
        return typst_text_atom(&compacted);
    }
    compacted
}

fn typst_text_atom(value: &str) -> String {
    format!("upright({})", serde_json::to_string(value).unwrap_or_else(|_| format!(r#""{}""#, value)))
}

fn semantic_text_to_typst(source: &str) -> String {
    let mut rendered = String::new();
    let chars = source.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if !(ch.is_ascii_alphabetic() || ch == '_') {
            rendered.push(ch);
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < chars.len() && (chars[index].is_ascii_alphanumeric() || chars[index] == '_' || chars[index] == '.') {
            index += 1;
        }
        let identifier = chars[start..index].iter().collect::<String>();
        let mut lookahead = index;
        while lookahead < chars.len() && chars[lookahead].is_whitespace() {
            lookahead += 1;
        }
        let is_function_call = chars.get(lookahead) == Some(&'(');
        rendered.push_str(&semantic_identifier_to_typst(&identifier, is_function_call));
    }
    rendered
}

fn sanitize_template_literal(source: &str) -> String {
    let mut rendered = String::new();
    let chars = source.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if !(ch.is_ascii_alphabetic() || ch == '_') {
            rendered.push(ch);
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < chars.len() && (chars[index].is_ascii_alphanumeric() || chars[index] == '_') {
            index += 1;
        }
        let identifier = chars[start..index].iter().collect::<String>();
        let mut lookahead = index;
        while lookahead < chars.len() && chars[lookahead].is_whitespace() {
            lookahead += 1;
        }
        let is_function_call = chars.get(lookahead) == Some(&'(');
        rendered.push_str(&template_identifier_to_typst(&identifier, is_function_call));
    }
    rendered
}

fn semantic_identifier_to_typst(identifier: &str, is_function_call: bool) -> String {
    let reserved = [
        "frac", "sqrt", "sin", "cos", "ln", "integral", "quad", "upright", "text", "arrow",
    ];
    if reserved.contains(&identifier) {
        return identifier.to_string();
    }
    if Regex::new(r"^[A-Za-z]$")
        .ok()
        .is_some_and(|regex| regex.is_match(identifier))
    {
        return identifier.to_string();
    }
    if let Some(captures) = Regex::new(r"^([A-Za-z])(\d+)$")
        .ok()
        .and_then(|regex| regex.captures(identifier))
    {
        return format!("{}_{}", captures.get(1).unwrap().as_str(), captures.get(2).unwrap().as_str());
    }
    if identifier.contains('.')
        || is_function_call
        || Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$")
            .ok()
            .is_some_and(|regex| regex.is_match(identifier))
    {
        return typst_text_atom(identifier);
    }
    identifier.to_string()
}

fn template_identifier_to_typst(identifier: &str, is_function_call: bool) -> String {
    let reserved = ["frac", "sqrt", "sin", "cos", "ln", "integral", "quad", "upright", "text", "arrow"];
    if reserved.contains(&identifier) {
        return identifier.to_string();
    }
    if Regex::new(r"^[A-Za-z]$")
        .ok()
        .is_some_and(|regex| regex.is_match(identifier))
    {
        return identifier.to_string();
    }
    if let Some(captures) = Regex::new(r"^([A-Za-z])(\d+)$")
        .ok()
        .and_then(|regex| regex.captures(identifier))
    {
        return format!("{}_{}", captures.get(1).unwrap().as_str(), captures.get(2).unwrap().as_str());
    }
    if is_function_call
        || Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$")
            .ok()
            .is_some_and(|regex| regex.is_match(identifier))
    {
        return typst_text_atom(identifier);
    }
    identifier.to_string()
}

fn compact_constraint_label(source_text: &str, resolved_text: &str) -> String {
    let compacted = compact_expression(resolved_text);
    for (method, operator) in [("eq", "=="), ("ne", "!="), ("lt", "<"), ("le", "<="), ("gt", ">"), ("ge", ">=")] {
        let pattern = format!(r"^(.+)\.{}\((.+)\)$", method);
        if let Some(captures) = Regex::new(&pattern).ok().and_then(|regex| regex.captures(&compacted)) {
            return format!("{} {} {}", captures.get(1).unwrap().as_str(), operator, captures.get(2).unwrap().as_str());
        }
    }
    if source_text.len() < compacted.len() {
        format!("{source_text} [raw]")
    } else {
        format!("{compacted} [raw]")
    }
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

fn is_action_effect_method(method_name: &str) -> bool {
    method_name == "union"
        || method_name.starts_with("insert_")
        || method_name.starts_with("set_")
        || method_name.starts_with("read_")
        || method_name.starts_with("try_read_")
}

fn extract_action_effects(
    block: &ast::BlockExpr,
    bindings: &ActionClosureBindings,
    known_pattern_vars: &BTreeSet<String>,
) -> Vec<ActionEffect> {
    let action_bindings = collect_action_local_bindings(block, &bindings.ctx_name);
    let devalue_pat_bindings = collect_devalue_pat_bindings(
        block,
        &bindings.ctx_name,
        bindings.pat_name.as_deref(),
        known_pattern_vars,
    );
    let action_method_calls = block
        .syntax()
        .descendants()
        .filter_map(ast::MethodCallExpr::cast)
        .filter(|method_call| {
            !method_call
                .syntax()
                .ancestors()
                .skip(1)
                .take_while(|ancestor| ancestor != block.syntax())
                .any(|ancestor| ast::ClosureExpr::can_cast(ancestor.kind()))
        })
        .filter(|method_call| {
            method_call
                .receiver()
                .and_then(expr_variable_name)
                .is_some_and(|receiver| receiver == bindings.ctx_name)
        })
        .filter(|method_call| {
            method_call
                .name_ref()
                .map(|name_ref| {
                    let method_name = name_ref.syntax().text().to_string();
                    is_action_effect_method(&method_name)
                })
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    let synthetic_inline_bindings = action_method_calls
        .iter()
        .filter_map(|method_call| {
            let method_name = method_call.name_ref()?.syntax().text().to_string();
            if !method_name.starts_with("insert_") {
                return None;
            }
            if enclosing_let_binding_name(method_call.syntax()).is_some() {
                return None;
            }
            has_enclosing_action_method_call(method_call.syntax(), &bindings.ctx_name)
                .then(|| method_call.syntax().text_range())
        })
        .enumerate()
        .map(|(index, range)| (range, format!("tmp_{index}")))
        .collect::<HashMap<_, _>>();

    let mut effects = Vec::new();
    let mut next_effect_id = 0usize;
    for method_call in action_method_calls {
        let mut referenced_pat_vars =
            collect_pat_field_references(method_call.syntax(), bindings.pat_name.as_deref())
                .into_iter()
                .filter(|name| known_pattern_vars.contains(name))
                .collect::<BTreeSet<_>>();
        let mut referenced_action_vars = method_call
            .arg_list()
            .into_iter()
            .flat_map(|args| args.args())
            .flat_map(|arg| collect_variable_references(&arg))
            .filter(|name| action_bindings.contains(name))
            .collect::<BTreeSet<_>>();
        for action_var in &referenced_action_vars {
            if let Some(pat_var) = devalue_pat_bindings.get(action_var) {
                referenced_pat_vars.insert(pat_var.clone());
            }
        }
        for inline_binding in collect_nested_action_bindings(
            &method_call,
            &bindings.ctx_name,
            &synthetic_inline_bindings,
        ) {
            referenced_action_vars.insert(inline_binding);
        }
        effects.push(ActionEffect {
            id: format!("effect_{next_effect_id}"),
            effect_id: stable_action_effect_id(method_call.syntax().text_range()),
            bound_var: enclosing_let_binding_name(method_call.syntax()).or_else(|| {
                synthetic_inline_bindings
                    .get(&method_call.syntax().text_range())
                    .cloned()
            }),
            source_text: method_call.syntax().text().to_string(),
            semantic_text: semanticize_action_effect_text(&method_call.syntax().text().to_string()),
            referenced_pat_vars: referenced_pat_vars.into_iter().collect(),
            referenced_action_vars: referenced_action_vars.into_iter().collect(),
            range: span_from_text_range(method_call.syntax().text_range()),
        });
        next_effect_id += 1;
    }
    effects
}

fn stable_action_effect_id(range: TextRange) -> String {
    format!(
        "effect@{}:{}",
        u32::from(range.start()),
        u32::from(range.end())
    )
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

fn collect_devalue_pat_bindings(
    block: &ast::BlockExpr,
    ctx_name: &str,
    pat_name: Option<&str>,
    known_pattern_vars: &BTreeSet<String>,
) -> HashMap<String, String> {
    let Some(pat_name) = pat_name else {
        return HashMap::new();
    };

    block
        .statements()
        .filter_map(|stmt| match stmt {
            ast::Stmt::LetStmt(let_stmt) => Some(let_stmt),
            _ => None,
        })
        .filter_map(|let_stmt| {
            let bound_name = ident_pat_name(let_stmt.pat()?)?;
            let init = let_stmt.initializer()?;
            let method_call = expr_as_method_call(&init)?;
            let method_name = method_call.name_ref()?.syntax().text().to_string();
            if method_name != "devalue" {
                return None;
            }
            if method_call
                .receiver()
                .and_then(expr_variable_name)
                .is_some_and(|receiver| receiver != ctx_name)
            {
                return None;
            }
            let arg = method_call.arg_list()?.args().next()?;
            let first_pat_field = arg
                .syntax()
                .descendants()
                .filter_map(ast::FieldExpr::cast)
                .find_map(|field_expr| first_pat_field_name(&field_expr, pat_name))?;
            known_pattern_vars
                .contains(&first_pat_field)
                .then_some((bound_name, first_pat_field))
        })
        .collect()
}

fn has_enclosing_action_method_call(node: &SyntaxNode, ctx_name: &str) -> bool {
    node.ancestors()
        .skip(1)
        .filter_map(ast::MethodCallExpr::cast)
        .any(|method_call| {
            method_call
                .receiver()
                .and_then(expr_variable_name)
                .is_some_and(|receiver| receiver == ctx_name)
                && method_call
                    .name_ref()
                    .map(|name_ref| {
                        let method_name = name_ref.syntax().text().to_string();
                        is_action_effect_method(&method_name)
                    })
                    .unwrap_or(false)
        })
}

fn collect_nested_action_bindings(
    method_call: &ast::MethodCallExpr,
    ctx_name: &str,
    synthetic_inline_bindings: &HashMap<TextRange, String>,
) -> Vec<String> {
    let Some(arg_list) = method_call.arg_list() else {
        return Vec::new();
    };
    let mut bindings = BTreeSet::new();
    for nested_call in arg_list
        .syntax()
        .descendants()
        .filter_map(ast::MethodCallExpr::cast)
    {
        if nested_call.syntax() == method_call.syntax() {
            continue;
        }
        if !nested_call
            .receiver()
            .and_then(expr_variable_name)
            .is_some_and(|receiver| receiver == ctx_name)
        {
            continue;
        }
        if !nested_call
            .name_ref()
            .map(|name_ref| {
                let method_name = name_ref.syntax().text().to_string();
                is_action_effect_method(&method_name)
            })
            .unwrap_or(false)
        {
            continue;
        }
        let is_direct_child = nested_call
            .syntax()
            .ancestors()
            .skip(1)
            .take_while(|ancestor| ancestor != method_call.syntax())
            .filter_map(ast::MethodCallExpr::cast)
            .all(|ancestor| ancestor.syntax() == method_call.syntax());
        if !is_direct_child {
            continue;
        }
        if let Some(binding) = enclosing_let_binding_name(nested_call.syntax()).or_else(|| {
            synthetic_inline_bindings
                .get(&nested_call.syntax().text_range())
                .cloned()
        }) {
            bindings.insert(binding);
        }
    }
    bindings.into_iter().collect()
}

fn enclosing_let_binding_name(node: &SyntaxNode) -> Option<String> {
    let let_stmt = node.ancestors().find_map(ast::LetStmt::cast)?;
    let init = let_stmt.initializer()?;
    (init.syntax() == node)
        .then(|| ident_pat_name(let_stmt.pat()?))
        .flatten()
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
    let rule_range = rule_call.syntax().text_range();
    let enclosing_item_range = function_body
        .syntax()
        .ancestors()
        .find_map(ast::Item::cast)
        .map(|item| item.syntax().text_range());
    let mut raw_facts = Vec::new();
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
        raw_facts.push(SeedFact {
            id: String::new(),
            source_text: method_call.syntax().text().to_string(),
            committed_root: receiver.syntax().text().to_string(),
            referenced_vars,
            range: span_from_text_range(method_call.syntax().text_range()),
        });
    }

    for call in function_body
        .syntax()
        .descendants()
        .filter_map(ast::CallExpr::cast)
    {
        let Some(callee) = call_path(&call) else {
            continue;
        };
        if !callee.ends_with("::insert") {
            continue;
        }
        if call
            .syntax()
            .ancestors()
            .skip(1)
            .any(|ancestor| ast::ClosureExpr::can_cast(ancestor.kind()))
        {
            continue;
        }
        let nearest_item_range = call
            .syntax()
            .ancestors()
            .skip(1)
            .find_map(ast::Item::cast)
            .map(|item| item.syntax().text_range());
        if nearest_item_range != enclosing_item_range {
            continue;
        }
        let call_range = call.syntax().text_range();
        if call_range.start() >= rule_range.start() {
            continue;
        }
        if rule_range.contains_range(call_range) {
            continue;
        }
        let referenced_vars = call
            .arg_list()
            .into_iter()
            .flat_map(|args| args.args())
            .flat_map(|arg| collect_variable_references(&arg))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        raw_facts.push(SeedFact {
            id: String::new(),
            source_text: call.syntax().text().to_string(),
            committed_root: callee.trim_end_matches("::insert").to_string(),
            referenced_vars,
            range: span_from_text_range(call_range),
        });
    }

    raw_facts.sort_by_key(|fact| fact.range.start);
    for (index, fact) in raw_facts.iter_mut().enumerate() {
        fact.id = format!("seed_{index}");
    }
    raw_facts
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
        return struct_pat_roots(&strukt);
    }
    Vec::new()
}

fn struct_pat_roots(strukt: &ast::Struct) -> Vec<String> {
    let roots = strukt
        .syntax()
        .descendants()
        .filter_map(ast::RecordField::cast)
        .filter_map(|field| field.name().map(|name| name.syntax().text().to_string()))
        .collect::<Vec<_>>();
    if !roots.is_empty() {
        return roots;
    }
    strukt
        .name()
        .map(|name| vec![name.syntax().text().to_string()])
        .unwrap_or_default()
}

fn struct_has_pat_attr(strukt: &ast::Struct) -> bool {
    strukt
        .attrs()
        .any(|attr| attr.syntax().text().to_string().contains("pat_vars"))
}

fn is_plain_ident(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
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
    call_path(call).is_some_and(|path| {
        path.ends_with("::query")
            || path.ends_with("::query_leaf")
            || path.ends_with("::query_fields")
            || path.ends_with("::query_named")
    })
}

fn span_from_text_range(range: TextRange) -> TextSpan {
    TextSpan::new(
        u32::from(range.start()) as usize,
        u32::from(range.end()) as usize,
    )
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
        assert_eq!(
            ir.action_effects[0].effect_id,
            format!(
                "effect@{}:{}",
                ir.action_effects[0].range.start, ir.action_effects[0].range.end
            )
        );
        assert_eq!(
            ir.action_effects[1].effect_id,
            format!(
                "effect@{}:{}",
                ir.action_effects[1].range.start, ir.action_effects[1].range.end
            )
        );
        assert_eq!(
            ir.action_effects[1].source_text,
            "ctx.union(pat.p, op_value)"
        );
        assert_eq!(ir.action_effects[1].referenced_pat_vars, vec!["p"]);
        assert_eq!(ir.seed_facts.len(), 1);
    }

    #[test]
    fn extracts_display_templates_from_dsl_enum() {
        let src = r#"
#[eggplant::dsl]
enum DisplayMath {
    #[eggplant::display("{x} + {f}")]
    #[eggplant::typst("diff({x}, {f})")]
    #[eggplant::precedence(5)]
    MDiff { x: DisplayMath, f: DisplayMath },
    #[eggplant::display("integ {f} {x}")]
    #[typst("integral({f}, {x})")]
    MIntegral { f: DisplayMath, x: DisplayMath },
}

fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let x = DisplayMath::query_leaf();
        let f = DisplayMath::query_leaf();
        let root = MDiff::query(&x, &f);
        DemoPat::new(x, f, root)
    }, |ctx, pat| {
        let out = ctx.insert_m_integral(pat.f, pat.x);
        ctx.union(pat.root, out);
    });
}
"#;
        let ir = extract(src, "ctx.insert_m_integral");
        assert_eq!(ir.display_templates.len(), 2);
        assert_eq!(ir.display_templates[0].variant_name, "MDiff");
        assert_eq!(ir.display_templates[0].template, "{x} + {f}");
        assert_eq!(ir.display_templates[0].fields, vec!["x", "f"]);
        assert_eq!(ir.display_templates[1].variant_name, "MIntegral");
        assert_eq!(ir.display_templates[1].template, "integ {f} {x}");
        assert_eq!(ir.display_templates[1].fields, vec!["f", "x"]);
        assert_eq!(ir.typst_templates.len(), 2);
        assert_eq!(ir.typst_templates[0].variant_name, "MDiff");
        assert_eq!(ir.typst_templates[0].template, "diff({x}, {f})");
        assert_eq!(ir.typst_templates[0].fields, vec!["x", "f"]);
        assert_eq!(ir.typst_templates[1].variant_name, "MIntegral");
        assert_eq!(ir.typst_templates[1].template, "integral({f}, {x})");
        assert_eq!(ir.typst_templates[1].fields, vec!["f", "x"]);
        assert_eq!(ir.precedence_templates.len(), 1);
        assert_eq!(ir.precedence_templates[0].variant_name, "MDiff");
        assert_eq!(ir.precedence_templates[0].precedence, 5);
    }

    #[test]
    fn extracts_typst_templates_from_func_struct() {
        let src = r#"
use eggplant::prelude::*;

#[eggplant::typst("fib({x})")]
#[eggplant::func(output = i64, no_merge)]
struct fib {
    x: i64,
}

fn demo(step_ruleset: Ruleset) {
    MyTx::add_rule(
        "fib_step",
        step_ruleset,
        || {
            let x = fib::x();
            let f0 = fib::query(&x);
            FibStep::new(x, f0)
        },
        |ctx, pat| {
            ctx.set_fib(ctx.devalue(pat.x), ctx.devalue(pat.f0));
        },
    );
}
"#;
        let ir = extract(src, "ctx.set_fib");
        assert_eq!(ir.typst_templates.len(), 1);
        assert_eq!(ir.typst_templates[0].variant_name, "fib");
        assert_eq!(ir.typst_templates[0].template, "fib({x})");
        assert_eq!(ir.typst_templates[0].fields, vec!["x"]);
        assert_eq!(
            ir.nodes
                .iter()
                .map(|node| (node.id.as_str(), node.dsl_type.as_str()))
                .collect::<Vec<_>>(),
            vec![("f0", "fib")]
        );
    }

    #[test]
    fn extracts_query_inputs_from_vec_macro_literal() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let a = Expr::query_leaf();
        let b = Expr::query_leaf();
        let pair = Pair::query(vec![&a, &b]);
        DemoPat::new(a, b, pair)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "Pair::query");
        let pair = ir
            .nodes
            .iter()
            .find(|node| node.id == "pair")
            .expect("pair node should exist");
        assert_eq!(pair.inputs, vec!["a", "b"]);
        let pair_edges = ir
            .edges
            .iter()
            .filter(|edge| edge.from == "pair")
            .collect::<Vec<_>>();
        assert_eq!(pair_edges.len(), 2);
        assert_eq!(pair_edges[0].to, "a");
        assert_eq!(pair_edges[0].index, 0);
        assert_eq!(pair_edges[1].to, "b");
        assert_eq!(pair_edges[1].index, 1);
    }

    #[test]
    fn normalizes_namespaced_query_leaf_types_to_variant_name() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let perm = schema_dsl::Expr::query_leaf();
        DemoPat::new(perm)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "schema_dsl::Expr::query_leaf");
        let perm = ir
            .nodes
            .iter()
            .find(|node| node.id == "perm")
            .expect("perm node should exist");
        assert_eq!(perm.kind, crate::ir::NodeKind::QueryLeaf);
        assert_eq!(perm.dsl_type, "Expr");
        assert_eq!(perm.label, "perm: Expr");
    }

    #[test]
    fn extracts_query_inputs_from_vec_alias_binding() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let a = Expr::query_leaf();
        let b = Expr::query_leaf();
        let items = vec![&a, &b];
        let pair = Pair::query(items);
        DemoPat::new(a, b, pair)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "Pair::query(items)");
        let pair = ir
            .nodes
            .iter()
            .find(|node| node.id == "pair")
            .expect("pair node should exist");
        assert_eq!(pair.inputs, vec!["a", "b"]);
    }

    #[test]
    fn extracts_query_inputs_from_push_built_vec_binding() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let a = Expr::query_leaf();
        let b = Expr::query_leaf();
        let mut items = vec![&a];
        items.push(&b);
        let pair = Pair::query(items);
        DemoPat::new(a, b, pair)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "items.push");
        let pair = ir
            .nodes
            .iter()
            .find(|node| node.id == "pair")
            .expect("pair node should exist");
        assert_eq!(pair.inputs, vec!["a", "b"]);
        let pair_edges = ir
            .edges
            .iter()
            .filter(|edge| edge.from == "pair")
            .collect::<Vec<_>>();
        assert_eq!(pair_edges.len(), 2);
        assert_eq!(pair_edges[0].to, "a");
        assert_eq!(pair_edges[1].to, "b");
    }

    #[test]
    fn does_not_flatten_nested_query_bindings_into_parent_query_inputs() {
        let src = r#"
fn mul_pow_combine_pat<PR: PatRecSgl>() -> MulPowCombinePat<PR> {
    let a = Math::query_leaf();
    let b = Math::query_leaf();
    let c = Math::query_leaf();
    let p1 = MPow::query(&a, &b);
    let p2 = MPow::query(&a, &c);
    let mul = MMul::query(&p1, &p2);
    MulPowCombinePat::new(a, b, c, mul)
}
"#;
        let ir = extract(src, "MMul::query");
        let mul = ir
            .nodes
            .iter()
            .find(|node| node.id == "mul")
            .expect("mul node should exist");
        assert_eq!(mul.inputs, vec!["p1", "p2"]);
        let mul_edges = ir
            .edges
            .iter()
            .filter(|edge| edge.from == "mul")
            .collect::<Vec<_>>();
        assert_eq!(mul_edges.len(), 2);
        assert_eq!(mul_edges[0].to, "p1");
        assert_eq!(mul_edges[0].index, 0);
        assert_eq!(mul_edges[1].to, "p2");
        assert_eq!(mul_edges[1].index, 1);
    }

    #[test]
    fn extracts_query_fields_inputs_from_relation_field_aliases() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let edge = Edge::query();
        let src = edge.src();
        let dst = edge.handle_dst();
        let reach = Reach::query_fields(&src, &dst);
        DemoPat::new(edge, reach)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "Reach::query_fields");
        let reach = ir
            .nodes
            .iter()
            .find(|node| node.id == "reach")
            .expect("reach node should exist");
        assert_eq!(reach.dsl_type, "Reach");
        assert_eq!(reach.inputs, vec!["src", "dst"]);
        let reach_edges = ir
            .edges
            .iter()
            .filter(|edge| edge.from == "reach")
            .collect::<Vec<_>>();
        assert_eq!(reach_edges.len(), 2);
        assert_eq!(reach_edges[0].to, "src");
        assert_eq!(reach_edges[0].index, 0);
        assert_eq!(reach_edges[1].to, "dst");
        assert_eq!(reach_edges[1].index, 1);
    }

    #[test]
    fn extracts_relation_field_inputs_from_vec_macro_alias_binding() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let edge = Edge::query();
        let fields = vec![&edge.src, &edge.handle_dst()];
        let reach = Reach::query_fields(fields);
        DemoPat::new(edge, reach)
    }, |ctx, pat| {});
}
"#;
        let ir = extract(src, "Reach::query_fields(fields)");
        let reach = ir
            .nodes
            .iter()
            .find(|node| node.id == "reach")
            .expect("reach node should exist");
        assert_eq!(reach.inputs, vec!["edge", "edge"]);
    }

    #[test]
    fn recognizes_query_fields_inside_plain_pattern_function_scope() {
        let src = r#"
fn relation_pattern() {
    let src = Edge::src();
    let dst = Edge::dst();
    let reach = Reach::query_fields(&src, &dst);
    DemoPat::new(src, dst, reach);
}
"#;
        let ir = extract(src, "Reach::query_fields");
        assert!(matches!(ir.scope.kind, ScopeKind::PatternFunction));
        let reach = ir
            .nodes
            .iter()
            .find(|node| node.id == "reach")
            .expect("reach node should exist");
        assert_eq!(reach.dsl_type, "Reach");
        assert_eq!(reach.inputs, vec!["src", "dst"]);
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
        assert_eq!(
            ir.constraints[0].resolved_text,
            "l.handle().eq(&r.handle())"
        );
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
        assert_eq!(
            ir.constraints[0].resolved_text,
            "l.handle().eq(&r.handle())"
        );
        assert_eq!(ir.constraints[0].referenced_vars, vec!["l", "r"]);
    }

    #[test]
    fn extracts_empty_pat_vars_catch_struct_name_as_unit_root() {
        let src = r#"
fn demo() {
    MyTx::add_rule("seed", ruleset, || {
        #[eggplant::pat_vars_catch]
        struct Unit {}
    }, |ctx, _pat| {
        ctx.set_fib(0, 0);
        ctx.set_fib(1, 1);
    });
}
"#;
        let ir = extract(src, "#[eggplant::pat_vars_catch]");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.roots, vec!["Unit"]);
        assert!(ir.nodes.is_empty());
        assert_eq!(
            ir.action_effects
                .iter()
                .map(|effect| effect.source_text.as_str())
                .collect::<Vec<_>>(),
            vec!["ctx.set_fib(0, 0)", "ctx.set_fib(1, 1)"]
        );
    }

    #[test]
    fn attribute_offset_inside_unit_pattern_still_resolves_add_rule_scope() {
        let src = r#"
fn demo() {
    MyTx::add_rule("seed", ruleset, || {
        #[eggplant::pat_vars_catch]
        struct Unit {}
    }, |ctx, _pat| {
        ctx.set_fib(0, 0);
    });
}
"#;
        let ir = extract(src, "#[eggplant::pat_vars_catch]");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.roots, vec!["Unit"]);
        assert_eq!(ir.action_effects.len(), 1);
        assert_eq!(ir.action_effects[0].source_text, "ctx.set_fib(0, 0)");
    }

    #[test]
    fn add_rule_callee_offset_prefers_rule_scope_over_enclosing_function() {
        let src = r#"
use eggplant::prelude::*;
use eggplant::tx_rx_vt_pr;

tx_rx_vt_pr!(MyTx, MyPatRec);

#[eggplant::func(output = i64, no_merge)]
struct fib {
    x: i64,
}

fn main() {
    let step_ruleset = MyTx::new_ruleset("fib_step");
    MyTx::add_rule(
        "fib_step",
        step_ruleset,
        || {
            let x = fib::x();
            let f0 = fib::query(&x);
            FibStep::new(x, f0)
        },
        |ctx, pat| {
            ctx.set_fib(ctx.devalue(pat.x), ctx.devalue(pat.f0));
        },
    );
}
"#;
        let ir = extract(src, "MyTx::add_rule(");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.roots, vec!["x", "f0"]);
        assert_eq!(ir.action_effects.len(), 1);
        assert_eq!(
            ir.action_effects[0].source_text,
            "ctx.set_fib(ctx.devalue(pat.x), ctx.devalue(pat.f0))"
        );
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
        assert_eq!(
            ir.constraints[0].resolved_text,
            "l.handle().eq(&r.handle())"
        );
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
    fn captures_set_effects_and_devalue_back_references() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        DemoPat::new(l, r, p)
    }, |ctx, pat| {
        let src = ctx.devalue(pat.l);
        let dst = ctx.devalue(pat.r);
        ctx.set_reach_flag(src, dst, true);
    });
}
"#;
        let ir = extract(src, "ctx.set_reach_flag");
        assert_eq!(ir.action_effects.len(), 1);
        assert_eq!(
            ir.action_effects[0].source_text,
            "ctx.set_reach_flag(src, dst, true)"
        );
        assert_eq!(ir.action_effects[0].referenced_pat_vars, vec!["l", "r"]);
        assert_eq!(ir.action_effects[0].referenced_action_vars, vec!["dst", "src"]);
    }

    #[test]
    fn captures_func_reads_as_action_nodes() {
        let src = r#"
fn demo() {
    let add_1_2_key = Value::new(MyTx::canonical_raw(&add_1_2));
    let add_1_3_key = Value::new(MyTx::canonical_raw(&add_1_3));
    MyTx::add_rule("read_complex_output", ruleset, || {
        #[eggplant::pat_vars_catch]
        struct Unit {}
    }, move |ctx, _pat| {
        let out_v = ctx.read_lead_to(add_1_2_key);
        let missing = ctx.try_read_lead_to(add_1_3_key);
        println!("{:?} {:?}", out_v, missing);
    });
}
"#;
        let ir = extract(src, "ctx.read_lead_to");
        assert_eq!(ir.action_effects.len(), 2);
        assert_eq!(
            ir.action_effects[0].source_text,
            "ctx.read_lead_to(add_1_2_key)"
        );
        assert_eq!(ir.action_effects[0].bound_var.as_deref(), Some("out_v"));
        assert!(ir.action_effects[0].referenced_pat_vars.is_empty());
        assert!(ir.action_effects[0].referenced_action_vars.is_empty());
        assert_eq!(
            ir.action_effects[1].source_text,
            "ctx.try_read_lead_to(add_1_3_key)"
        );
        assert_eq!(ir.action_effects[1].bound_var.as_deref(), Some("missing"));
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
    fn synthesizes_tmp_bindings_for_inline_nested_action_calls() {
        let src = r#"
fn demo() {
    MyTx::add_rule("demo", ruleset, || {
        let x = Expr::query_leaf();
        let y = Expr::query_leaf();
        let bop = Bop::query(&x, &y);
        DemoPat::new(x, y, bop)
    }, |ctx, pat| {
        ctx.union(pat.bop, ctx.insert_bop("Add", pat.y.val, pat.x.val));
    });
}
"#;
        let ir = extract(src, "ctx.union(pat.bop, ctx.insert_bop(");
        assert_eq!(ir.action_effects.len(), 2);

        let inline_insert = ir
            .action_effects
            .iter()
            .find(|effect| effect.source_text == r#"ctx.insert_bop("Add", pat.y.val, pat.x.val)"#)
            .expect("inline insert action effect should be extracted");
        assert_eq!(inline_insert.bound_var.as_deref(), Some("tmp_0"));

        let union = ir
            .action_effects
            .iter()
            .find(|effect| {
                effect.source_text
                    == r#"ctx.union(pat.bop, ctx.insert_bop("Add", pat.y.val, pat.x.val))"#
            })
            .expect("union effect should be extracted");
        assert_eq!(union.referenced_pat_vars, vec!["bop", "x", "y"]);
        assert_eq!(union.referenced_action_vars, vec!["tmp_0"]);
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
        assert_eq!(ir.roots, vec!["Unit"]);
        assert_eq!(ir.action_effects.len(), 3);
        assert_eq!(ir.action_effects[0].bound_var.as_deref(), Some("x"));
        assert_eq!(ir.action_effects[1].bound_var.as_deref(), Some("ln_x"));
        assert_eq!(ir.action_effects[1].referenced_action_vars, vec!["x"]);
        assert_eq!(
            ir.action_effects[2].referenced_action_vars,
            vec!["ln_x", "x"]
        );
    }

    #[test]
    fn extracts_add_rule_with_pattern_function_reference_from_action_scope() {
        let src = r#"
#[eggplant::pat_vars]
struct MulDistribPat<PR: PatRecSgl> {
    a: Math,
    b: Math,
    c: Math,
    mul: MMul,
}

fn mul_distrib_pat<PR: PatRecSgl>() -> MulDistribPat<PR> {
    let a = Math::query_leaf();
    let b = Math::query_leaf();
    let c = Math::query_leaf();
    let add = MAdd::query(&b, &c);
    let mul = MMul::query(&a, &add);
    MulDistribPat::new(a, b, c, mul)
}

fn demo(rs: Ruleset) {
    MyTx::add_rule("mul_distrib", rs, mul_distrib_pat, |ctx, pat| {
        let ab = ctx.insert_m_mul(pat.a, pat.b);
        let ac = ctx.insert_m_mul(pat.a, pat.c);
        let rhs = ctx.insert_m_add(ab, ac);
        ctx.union(pat.mul, rhs);
    });
}
"#;
        let ir = extract(src, "let rhs = ctx.insert_m_add(ab, ac);");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.roots, vec!["a", "b", "c", "mul"]);
        assert_eq!(ir.action_effects.len(), 4);
        assert_eq!(ir.action_effects[2].bound_var.as_deref(), Some("rhs"));
        assert_eq!(
            ir.action_effects[2].referenced_action_vars,
            vec!["ab", "ac"]
        );
        assert_eq!(ir.action_effects[3].referenced_pat_vars, vec!["mul"]);
    }

    #[test]
    fn extracts_add_rule_with_hook_with_pattern_function_reference_from_action_scope() {
        let src = r#"
#[eggplant::pat_vars]
struct MulDistribPat<PR: PatRecSgl> {
    a: Math,
    b: Math,
    c: Math,
    mul: MMul,
}

fn mul_distrib_pat<PR: PatRecSgl>() -> MulDistribPat<PR> {
    let a = Math::query_leaf();
    let b = Math::query_leaf();
    let c = Math::query_leaf();
    let add = MAdd::query(&b, &c);
    let mul = MMul::query(&a, &add);
    MulDistribPat::new(a, b, c, mul)
}

fn demo(rs: Ruleset, recorder: ActionSampleRecorder) {
    DemoTx::add_rule_with_hook("mul_distrib", rs, mul_distrib_pat, |ctx, pat| {
        let ab = ctx.insert_m_mul(pat.a, pat.b);
        let ac = ctx.insert_m_mul(pat.a, pat.c);
        let rhs = ctx.insert_m_add(ab, ac);
        ctx.union(pat.mul, rhs);
    }, Box::new(recorder));
}
"#;
        let ir = extract(src, "let rhs = ctx.insert_m_add(ab, ac);");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.roots, vec!["a", "b", "c", "mul"]);
        assert_eq!(ir.action_effects.len(), 4);
        assert_eq!(ir.action_effects[2].bound_var.as_deref(), Some("rhs"));
        assert_eq!(
            ir.action_effects[2].referenced_action_vars,
            vec!["ab", "ac"]
        );
        assert_eq!(ir.action_effects[3].referenced_pat_vars, vec!["mul"]);
    }

    #[test]
    fn extracts_function_table_rule_from_action_scope() {
        let src = r#"
use eggplant::prelude::*;
use eggplant::tx_rx_vt_pr;

tx_rx_vt_pr!(MyTx, MyPatRec);

#[eggplant::func(output = i64, no_merge)]
struct fib {
    x: i64,
}

#[eggplant::pat_vars]
struct FibStep<PR: PatRecSgl> {
    x: i64,
    x1: i64,
    x2: i64,
    f0: i64,
    f1: i64,
}

fn demo(step_ruleset: Ruleset) {
    MyTx::add_rule(
        "fib_step",
        step_ruleset,
        || {
            let (x, x1, x2) = (fib::x(), fib::x().named("x1"), fib::x().named("x2"));
            let x1_constraint = x1.handle().eq(&(x.handle() + (&1_i64).as_handle()));
            let x2_constraint = x2.handle().eq(&(x.handle() + (&2_i64).as_handle()));
            let f0 = fib::query(&x);
            let f1 = fib::query(&x1);
            FibStep::new(x, x1, x2, f0, f1)
                .assert(x1_constraint)
                .assert(x2_constraint)
        },
        |ctx, pat| {
            let x2 = ctx.devalue(pat.x2);
            let f0 = ctx.devalue(pat.f0);
            let f1 = ctx.devalue(pat.f1);
            ctx.set_fib(x2, f0 + f1);
        },
    );
}
"#;
        let ir = extract(src, "ctx.set_fib(x2, f0 + f1);");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.roots, vec!["x", "x1", "x2", "f0", "f1"]);
        assert_eq!(
            ir.nodes
                .iter()
                .map(|node| (node.id.as_str(), node.dsl_type.as_str()))
                .collect::<Vec<_>>(),
            vec![("f0", "fib"), ("f1", "fib")]
        );
        assert_eq!(ir.constraints.len(), 2);
        assert_eq!(ir.constraints[0].semantic_text.as_deref(), Some("x1 == x + 1"));
        assert_eq!(ir.constraints[1].semantic_text.as_deref(), Some("x2 == x + 2"));
        assert_eq!(ir.action_effects.len(), 1);
        assert_eq!(ir.action_effects[0].source_text, "ctx.set_fib(x2, f0 + f1)");
        assert_eq!(
            ir.action_effects[0].semantic_text.as_deref(),
            Some("fib(x2) = f0 + f1")
        );
        assert_eq!(ir.action_effects[0].referenced_pat_vars, vec!["f0", "f1", "x2"]);
    }

    #[test]
    fn math_view_set_effect_expands_rhs_action_binding_instead_of_leaking_binding_name() {
        let src = r#"
fn demo() {
    PeepholeTx::add_rule(
        "ivt_analysis_finish_passthrough_access",
        ruleset,
        || {
            let len = Math::query_leaf();
            let if_len = Math::query_leaf();
            let arg_get = Math::query_leaf();
            let perm = Math::query_leaf();
            let pperm = Math::query_leaf();
            let passthrough_tys = Math::query_leaf();
            let new_ty = Math::query_leaf();
            let if_eclass = Math::query_leaf();
            let pred = Math::query_leaf();
            let inputs = Math::query_leaf();
            let then_branch = Math::query_leaf();
            let else_branch = Math::query_leaf();
            let loop_body = Math::query_leaf();
            let curr = Math::query_leaf();
            let analysis = Math::query_leaf();
            let ifnode = MIf::query(&if_eclass, &pred);
            DemoPat::new(
                len, if_len, arg_get, perm, pperm, passthrough_tys, new_ty,
                if_eclass, pred, inputs, then_branch, else_branch, loop_body, curr, analysis, ifnode
            )
        },
        |ctx, pat| {
            let tmp_type = ctx.insert_tmp_type();
            let no_ctx = ctx.insert_in_func("no-ctx".to_owned());
            let tmp_arg = ctx.insert_arg(tmp_type, no_ctx);
            let len = ctx.devalue(pat.len);
            let if_len = ctx.devalue(pat.if_len);
            let get_passed_through = ctx.insert_single(ctx.insert_get(tmp_arg, if_len + len));
            let new_perm = ctx.insert_concat(pat.perm, get_passed_through);
            let original_get_index =
                ctx.insert_single(ctx.insert_get(tmp_arg, ctx.devalue(pat.arg_get.index)));
            let new_pperm = ctx.insert_concat(pat.pperm, original_get_index);
            let tnil = ctx.insert_t_nil();
            let new_passthrough_tys =
                ctx.insert_tl_concat(pat.passthrough_tys, ctx.insert_t_cons(pat.new_ty, tnil));
            let ifnode = ctx.insert_if_node(
                pat.if_eclass,
                pat.pred,
                pat.inputs,
                pat.then_branch,
                pat.else_branch,
            );
            let res =
                ctx.insert_ivt_analysis_res(new_perm, new_pperm, new_passthrough_tys, len + 1);
            ctx.set_ivt_new_inputs_analysis(pat.loop_body, ifnode, res);
        },
    );
}
"#;
        let ir = extract(src, "ctx.set_ivt_new_inputs_analysis");
        let math_view = ir.math_view.expect("math_view should exist");

        assert_eq!(math_view.rule_name, "ivt_analysis_finish_passthrough_access");
        assert_eq!(math_view.conclusions.len(), 1);
        let formula = &math_view.formula_source.plain;
        assert!(!formula.contains("= res"));
        assert!(!formula.contains(" res)"));
        assert!(formula.contains("ivt_new_inputs_analysis"));
        assert!(formula.contains(r#"upright("IvtAnalysisRes")"#));
        assert!(formula.contains(r#"upright("IfNode")"#));
    }

    #[test]
    fn math_view_emits_structured_formula_sources_for_int_one() {
        let source = include_str!("../../samples/math_microbenchmark.rs");
        let ir = extract(source, r#"MyTxMath::add_rule("int_one","#);
        let math_view = ir.math_view.expect("math_view should exist");

        assert_eq!(math_view.rule_name, "int_one");
        assert!(math_view.formula_source.plain.contains("arrow.r.double x"));
        assert!(!math_view.formula_source.plain.contains("#text(fill:"));
        assert!(math_view.formula_source.colored.contains("#text(fill:"));
        assert_eq!(math_view.conclusions.len(), 1);
        match &math_view.conclusions[0] {
            MathViewConclusion::Rewrite { from, to, .. } => {
                assert_eq!(from.target_id, "integ");
                assert_eq!(to.target_id, "x");
            }
            other => panic!("expected rewrite conclusion, got {other:?}"),
        }
    }

    #[test]
    fn math_view_keeps_only_true_union_conclusions_for_diff_mul() {
        let source = include_str!("../../samples/math_microbenchmark.rs");
        let ir = extract(source, r#"MyTxMath::add_rule("diff_mul","#);
        let math_view = ir.math_view.expect("math_view should exist");

        assert_eq!(
            math_view
                .premises
                .iter()
                .map(|entry| entry.target_id.as_str())
                .collect::<Vec<_>>(),
            vec!["diff"]
        );
        assert_eq!(
            math_view
                .derivations
                .iter()
                .map(|entry| entry.label.as_str())
                .collect::<Vec<_>>(),
            vec!["db", "da", "a_db", "b_da", "rhs"]
        );
        assert_eq!(math_view.conclusions.len(), 1);
        assert!(math_view.formula_source.plain.contains("(a * b)'(x)"));
        assert!(math_view.formula_source.plain.contains("a * b'(x) + b * a'(x)"));
        match &math_view.conclusions[0] {
            MathViewConclusion::Rewrite { from, to, .. } => {
                assert_eq!(from.target_id, "diff");
                assert_eq!(to.target_id, "effect:effect_4");
            }
            other => panic!("expected rewrite conclusion, got {other:?}"),
        }
    }

    #[test]
    fn math_view_falls_back_to_constructor_call_formulas_without_metadata() {
        let source = include_str!("../../samples/pattern_samples.rs");
        let ir = extract(source, r#""demo_assert_block""#);
        let math_view = ir.math_view.expect("math_view should exist");

        assert!(math_view.formula_source.plain.contains(r#"upright("Add")(l, r)"#));
        assert!(math_view.formula_source.plain.contains(r#"upright("Const")(6)"#));
        assert!(!math_view
            .formula_source
            .plain
            .contains(r#"upright("no matched premise")"#));
        assert!(!math_view
            .formula_source
            .plain
            .contains(r#"upright("no conclusion")"#));
        assert!(math_view.side_conditions.iter().any(|cond| cond == "l == r"));
    }

    #[test]
    fn math_view_preserves_leaf_premises_and_multiple_rewrite_conclusions() {
        let source = r#"
fn demo() {
    MyTx::add_rule("leaf_multi", ruleset, || {
        let x = Math::query_leaf();
        let y = Math::query_leaf();
        #[eggplant::pat_vars_catch]
        struct Pat {
            x: Math,
            y: Math,
        }
    }, |ctx, pat| {
        ctx.union(pat.x, pat.y);
        ctx.union(pat.y, pat.x);
    });
}
"#;
        let ir = extract(source, r#""leaf_multi""#);
        let math_view = ir.math_view.expect("math_view should exist");

        assert_eq!(
            math_view
                .premises
                .iter()
                .map(|entry| entry.target_id.as_str())
                .collect::<Vec<_>>(),
            vec!["x", "y"]
        );
        assert_eq!(math_view.conclusions.len(), 2);
        assert!(math_view.formula_source.plain.contains("x"));
        assert!(math_view.formula_source.plain.contains("y"));
    }

    #[test]
    fn math_view_uses_integral_math_notation_and_keeps_derivations_out_of_premise_row() {
        let source = include_str!("../../samples/math_microbenchmark.rs");
        let ir = extract(source, r#"MyTxMath::add_rule("int_add","#);
        let math_view = ir.math_view.expect("math_view should exist");

        assert_eq!(math_view.rule_name, "int_add");
        assert_eq!(
            math_view
                .premises
                .iter()
                .map(|entry| entry.target_id.as_str())
                .collect::<Vec<_>>(),
            vec!["integ"]
        );
        assert!(math_view.formula_source.plain.contains("integral"));
        assert!(math_view.formula_source.plain.contains("quad d"));
        assert!(!math_view.formula_source.plain.contains(r#"upright("integral")"#));
        assert!(!math_view.formula_source.plain.contains("i_f"));
        assert!(!math_view.formula_source.plain.contains("i_g"));
        assert!(!math_view.formula_source.plain.contains("rhs"));
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
        assert!(
            error
                .to_string()
                .contains("no supported pattern scope found at cursor")
        );
    }

    #[test]
    fn add_rule_token_start_offset_resolves_rule_call_scope() {
        let src = r#"
fn demo() {
    MyTx::add_rule("seed", ruleset, || {
        #[eggplant::pat_vars_catch]
        struct Unit {}
    }, |ctx, _pat| {
        ctx.set_fib(0, 0);
    });
}
"#;
        let offset = src.find("MyTx::add_rule(").expect("add_rule should exist");
        let ir = extract_pattern(
            src,
            ExtractOptions {
                offset,
                edition: Edition::CURRENT,
            },
        )
        .expect("extract should succeed at add_rule token start");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.roots, vec!["Unit"]);
        assert_eq!(ir.action_effects.len(), 1);
        assert_eq!(ir.action_effects[0].source_text, "ctx.set_fib(0, 0)");
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
    fn typed_relation_query_fields_tracks_relation_projection_inputs() {
        let src = r#"
fn demo() {
    MyTx::add_rule("typed_relation", ruleset, || {
        let edge = Edge::query();
        let src = edge.src();
        let dst = edge.dst();
        let reach = Reach::query_fields(&src, &dst);
        ReachPat::new(edge, reach)
    }, |ctx, pat| {
        ctx.union(pat.reach, pat.edge);
    });
}
"#;
        let ir = extract(src, "Reach::query_fields");
        let reach = ir
            .nodes
            .iter()
            .find(|node| node.id == "reach")
            .expect("reach query node should be extracted");
        assert_eq!(reach.dsl_type, "Reach");
        assert_eq!(reach.inputs, vec!["src", "dst"]);

        let reach_inputs = ir
            .edges
            .iter()
            .filter(|edge| edge.from == "reach")
            .map(|edge| edge.to.clone())
            .collect::<Vec<_>>();
        assert_eq!(reach_inputs, vec!["src", "dst"]);
    }

    #[test]
    fn typed_relation_query_fields_keeps_tuple_binding_inputs() {
        let src = r#"
fn demo() {
    MyTx::add_rule("typed_relation_tuple", ruleset, || {
        let src = Edge::src();
        let dst = Edge::dst();
        let edge = Edge::query_fields(&src, &dst);
        ReachPat::new(src, dst, edge)
    }, |ctx, pat| {
        ctx.union(pat.edge, pat.edge);
    });
}
"#;
        let ir = extract(src, "Edge::query_fields");
        let edge = ir
            .nodes
            .iter()
            .find(|node| node.id == "edge")
            .expect("edge query node should be extracted");
        assert_eq!(edge.dsl_type, "Edge");
        assert_eq!(edge.inputs, vec!["src", "dst"]);
        assert_eq!(ir.roots, vec!["src", "dst", "edge"]);
    }

    #[test]
    fn typed_relation_handle_field_sugar_is_tracked_in_constraints() {
        let src = r#"
fn demo() {
    MyTx::add_rule("typed_relation_handle", ruleset, || {
        let edge = Edge::query();
        let eq = edge.handle_src().eq(&edge.handle_dst());
        ReachPat::new(edge).assert(eq)
    }, |ctx, pat| {
        ctx.union(pat.edge, pat.edge);
    });
}
"#;
        let ir = extract(src, "edge.handle_src()");
        assert_eq!(ir.constraints.len(), 1);
        assert_eq!(
            ir.constraints[0].resolved_text,
            "edge.handle_src().eq(&edge.handle_dst())"
        );
        assert_eq!(
            ir.constraints[0].semantic_text.as_deref(),
            Some("edge.src == edge.dst")
        );
        assert_eq!(ir.constraints[0].referenced_vars, vec!["edge"]);
    }

    #[test]
    fn typed_relation_seed_inserts_are_exported_as_seed_facts() {
        let src = r#"
fn demo() {
    RelEdge::<RelTx>::insert(1, 2);
    RelEdge::<RelTx>::insert(2, 3);
    MyTx::add_rule("typed_relation_seed", ruleset, || {
        let edge = RelEdge::query();
        #[eggplant::pat_vars_catch]
        struct Pat {
            edge: RelEdge,
        }
    }, |ctx, pat| {
        let src = ctx.devalue(pat.edge.src);
        let dst = ctx.devalue(pat.edge.dst);
        ctx.insert_rel_path(src, dst);
        ctx.set_rel_path_mark(src, dst, true);
    });
}
"#;
        let ir = extract(src, "RelEdge::query");
        assert_eq!(ir.seed_facts.len(), 2);
        assert_eq!(
            ir.seed_facts
                .iter()
                .map(|fact| fact.source_text.as_str())
                .collect::<Vec<_>>(),
            vec![
                "RelEdge::<RelTx>::insert(1, 2)",
                "RelEdge::<RelTx>::insert(2, 3)"
            ]
        );
        assert_eq!(ir.seed_facts[0].committed_root, "RelEdge::<RelTx>");
        assert_eq!(ir.roots, vec!["edge"]);
        assert_eq!(ir.action_effects.len(), 2);
        assert_eq!(ir.action_effects[0].referenced_pat_vars, vec!["edge"]);
        assert_eq!(ir.action_effects[1].referenced_pat_vars, vec!["edge"]);
    }

    #[test]
    fn resolves_add_rule_pattern_function_with_query_named() {
        let src = r#"
fn pat_vec_check_vec_of<PR: PatRecSgl>() -> CheckIVecPat<PR> {
    let v = BaseVar::<IVec, PR>::query_named("v");
    CheckIVecPat::new(v)
}

fn demo() {
    MyTx::add_rule("vec_check_vec_of", ruleset, pat_vec_check_vec_of, |_ctx, _pat| {});
}
"#;
        let ir = extract(src, "pat_vec_check_vec_of, |_ctx");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert_eq!(ir.roots, vec!["v"]);
        assert_eq!(ir.nodes.len(), 1);
        assert_eq!(ir.nodes[0].id, "v");
    }

    #[test]
    fn resolves_add_rule_pattern_function_without_query_calls() {
        let src = r#"
fn pat_no_query<PR: PatRecSgl>() -> CheckUnitPat<PR> {
    let e = true;
    CheckUnitPat::new().assert(e)
}

fn demo() {
    MyTx::add_rule("no_query", ruleset, pat_no_query, |_ctx, _pat| {});
}
"#;
        let ir = extract(src, "pat_no_query, |_ctx");
        assert!(matches!(ir.scope.kind, ScopeKind::AddRuleCall));
        assert!(
            ir.diagnostics
                .iter()
                .any(|diag| diag.message.contains("no supported pattern roots found in scope"))
        );
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

        assert!(
            error
                .to_string()
                .contains("no supported pattern scope found at cursor")
        );
    }
}
