import { DisplayTemplate, PatternIr, PatternNode, TypstTemplate } from "./ir";

export type DotViewMode = "pattern" | "action" | "combined";
export type DotLabelStyle = "compact" | "full" | "recursive";
export type RecursiveStrategy = "tree-safe" | "dag-expand";

export interface TypstReplacementSource {
  targetId: string;
  source: string;
}

interface RenderedTemplateField {
  precedence: number;
  text: string;
  isAtomic: boolean;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function toVariantTypeName(insertTarget: string): string {
  return insertTarget
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function compactExpression(value: string): string {
  return value
    .replace(/\b(?:pat|matched|ctx|tx)\./g, "")
    .replace(/\.clone\(\)/g, "")
    .replace(/\.handle\(\)/g, "")
    .replace(/&([A-Za-z_][A-Za-z0-9_]*)/g, "$1")
    .replace(/"([^"]+)"\.to_owned\(\)/g, "\"$1\"")
    .replace(/\s+/g, " ")
    .trim();
}

function compactConstraintLabel(sourceText: string, resolvedText: string): string {
  const compactResolved = compactExpression(resolvedText);
  const primitiveOperators: Array<[string, string]> = [
    ["eq", "=="],
    ["ne", "!="],
    ["lt", "<"],
    ["le", "<="],
    ["gt", ">"],
    ["ge", ">="],
  ];

  for (const [primitive, operator] of primitiveOperators) {
    const primitiveMatch = compactResolved.match(
      new RegExp(`^(.+)\\.${primitive}\\((.+)\\)$`)
    );
    if (primitiveMatch) {
      return `${primitiveMatch[1]} ${operator} ${primitiveMatch[2]}`;
    }
  }
  const fallback = sourceText.length < compactResolved.length ? sourceText : compactResolved;
  return `${fallback} [raw]`;
}

function semanticInsertLabel(sourceText: string): string {
  const trimmed = sourceText.trim();
  const insertMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*\.insert_([A-Za-z0-9_]+)\((.*)\)$/);
  if (!insertMatch) {
    return trimmed;
  }

  const [, insertTarget, args] = insertMatch;
  return `${toVariantTypeName(insertTarget)}(${args})`;
}

function findDisplayTemplate(ir: PatternIr, variantName: string): DisplayTemplate | undefined {
  return ir.display_templates.find((template) => template.variant_name === variantName);
}

function findTypstTemplate(ir: PatternIr, variantName: string): TypstTemplate | undefined {
  return ir.typst_templates.find((template) => template.variant_name === variantName);
}

function findPreferredTemplate(
  ir: PatternIr,
  variantName: string
): DisplayTemplate | TypstTemplate | undefined {
  return findTypstTemplate(ir, variantName) ?? findDisplayTemplate(ir, variantName);
}

function variantPrecedence(ir: PatternIr, variantName: string): number {
  return ir.precedence_templates.find((template) => template.variant_name === variantName)?.precedence ?? Number.MAX_SAFE_INTEGER;
}

function renderTemplateWithPrecedence(
  template: DisplayTemplate | TypstTemplate,
  parentPrecedence: number,
  fields: Array<{ name: string; value: RenderedTemplateField }>
): string | null {
  const chars = Array.from(template.template);
  let rendered = "";
  let idx = 0;

  while (idx < chars.length) {
    if (chars[idx] === "{") {
      if (chars[idx + 1] === "{") {
        rendered += "{";
        idx += 2;
        continue;
      }

      const start = idx + 1;
      let end = start;
      while (end < chars.length && chars[end] !== "}") {
        end += 1;
      }
      if (end >= chars.length) {
        return null;
      }

      const placeholder = chars.slice(start, end).join("");
      const field = fields.find((entry) => entry.name === placeholder);
      if (!field) {
        return null;
      }

      const needsParens =
        field.value.precedence < parentPrecedence ||
        (
          field.value.precedence === parentPrecedence &&
          parentPrecedence !== Number.MAX_SAFE_INTEGER &&
          !field.value.isAtomic
        );
      rendered += needsParens ? `(${field.value.text})` : field.value.text;
      idx = end + 1;
      continue;
    }

    if (chars[idx] === "}" && chars[idx + 1] === "}") {
      rendered += "}";
      idx += 2;
      continue;
    }

    rendered += chars[idx];
    idx += 1;
  }

  return rendered;
}

function applyDisplayTemplate(
  template: DisplayTemplate | TypstTemplate,
  args: string[],
  parentPrecedence = Number.MAX_SAFE_INTEGER
): string | null {
  if (template.fields.length !== args.length) {
    return null;
  }
  return renderTemplateWithPrecedence(
    template,
    parentPrecedence,
    template.fields.map((name, index) => ({
      name,
      value: { text: args[index], precedence: Number.MAX_SAFE_INTEGER, isAtomic: true }
    }))
  );
}

function parseArgsList(rawArgs: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of rawArgs) {
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    }
    current += char;
  }
  if (current.trim().length > 0) {
    args.push(current.trim());
  }
  return args;
}

function parseSemanticInsert(sourceText: string): { variantName: string; args: string[]; semantic: string } | null {
  const trimmed = sourceText.trim();
  const insertMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*\.insert_([A-Za-z0-9_]+)\((.*)\)$/);
  if (!insertMatch) {
    return null;
  }

  const [, insertTarget, args] = insertMatch;
  const variantName = toVariantTypeName(insertTarget);
  return {
    variantName,
    args: parseArgsList(args).map((arg) => compactExpression(arg)),
    semantic: `${variantName}(${args})`,
  };
}

interface RecursivePatternResult {
  text: string;
  precedence: number;
  isAtomic: boolean;
}

function recursivePatternLabel(
  ir: PatternIr,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>,
  nodeId: string,
  strategy: RecursiveStrategy,
  seen: Set<string>
): RecursivePatternResult | null {
  const node = nodeById.get(nodeId);
  if (!node) {
    return {
      text: compactExpression(nodeId),
      precedence: Number.MAX_SAFE_INTEGER,
      isAtomic: true,
    };
  }
  if (seen.has(nodeId)) {
    return null;
  }
  if (strategy === "tree-safe" && (incomingCounts.get(nodeId) ?? 0) > 1) {
    return null;
  }

  const template = findPreferredTemplate(ir, node.dsl_type);
  if (!template) {
    return node.inputs.length === 0
      ? { text: compactExpression(node.id), precedence: Number.MAX_SAFE_INTEGER, isAtomic: true }
      : null;
  }

  const nextSeen = new Set(seen);
  nextSeen.add(nodeId);
  const renderedArgs: Array<{ name: string; value: RenderedTemplateField }> = [];
  for (const input of node.inputs) {
    const child = recursivePatternLabel(ir, nodeById, incomingCounts, input, strategy, nextSeen);
    if (!child) {
      return null;
    }
    renderedArgs.push({
      name: template.fields[renderedArgs.length],
      value: {
        text: child.text,
        precedence: child.precedence,
        isAtomic: child.isAtomic
      }
    });
  }

  const rendered = renderTemplateWithPrecedence(template, variantPrecedence(ir, node.dsl_type), renderedArgs);
  if (!rendered) {
    return null;
  }
  return {
    text: rendered,
    precedence: variantPrecedence(ir, node.dsl_type),
    isAtomic: node.inputs.length === 0,
  };
}

function typstPatternSource(
  ir: PatternIr,
  node: PatternNode,
  labelStyle: DotLabelStyle,
  strategy: RecursiveStrategy,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>
): string {
  if (labelStyle !== "full" && node.inputs.length > 0) {
    const recursive = recursivePatternLabel(
      ir,
      nodeById,
      incomingCounts,
      node.id,
      strategy,
      new Set()
    );
    if (recursive) {
      return recursive.text;
    }
  }

  return nodeLabel(
    ir,
    node.label,
    node.dsl_type,
    node.inputs,
    labelStyle,
    strategy,
    node.id,
    nodeById,
    incomingCounts
  );
}

function recursivePatternLabelForAction(
  ir: PatternIr,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>,
  nodeId: string
): RecursivePatternResult | null {
  return recursivePatternLabel(ir, nodeById, incomingCounts, nodeId, "dag-expand", new Set());
}

interface RecursiveActionResult {
  text: string;
  precedence: number;
  isAtomic: boolean;
}

function recursiveActionLabel(
  ir: PatternIr,
  strategy: RecursiveStrategy,
  effectByBinding: Map<string, string>,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>,
  effectId: string,
  seen: Set<string>
): RecursiveActionResult | null {
  if (seen.has(effectId)) {
    return null;
  }
  const effect = ir.action_effects.find((entry) => entry.id === effectId);
  if (!effect) {
    return null;
  }

  const parsed = parseSemanticInsert(effect.source_text);
  if (!parsed) {
    return null;
  }

  const template = findPreferredTemplate(ir, parsed.variantName);
  if (!template) {
    return null;
  }

  const nextSeen = new Set(seen);
  nextSeen.add(effectId);
  const renderedArgs = parsed.args.map((arg, index) => {
    const trimmed = compactExpression(arg);
    if (effectByBinding.has(trimmed)) {
      const childEffectId = effectByBinding.get(trimmed);
      if (childEffectId) {
        const child = recursiveActionLabel(ir, strategy, effectByBinding, nodeById, incomingCounts, childEffectId, nextSeen);
        if (child) {
          return {
            name: template.fields[index],
            value: { text: child.text, precedence: child.precedence, isAtomic: child.isAtomic }
          };
        }
      }
    }
    const patVar = trimmed.replace(/^(?:pat|matched)\./, "");
    if (nodeById.has(patVar)) {
      const child = recursivePatternLabelForAction(ir, nodeById, incomingCounts, patVar);
      if (child) {
        return {
          name: template.fields[index],
          value: { text: child.text, precedence: child.precedence, isAtomic: child.isAtomic }
        };
      }
      if (strategy === "tree-safe") {
        return null;
      }
    }
    return {
      name: template.fields[index],
      value: { text: trimmed, precedence: Number.MAX_SAFE_INTEGER, isAtomic: true }
    };
  });

  if (renderedArgs.some((arg) => arg === null)) {
    return null;
  }

  const rendered = renderTemplateWithPrecedence(
    template,
    variantPrecedence(ir, parsed.variantName),
    renderedArgs as Array<{ name: string; value: RenderedTemplateField }>
  );
  if (!rendered) {
    return null;
  }
  return {
    text: rendered,
    precedence: variantPrecedence(ir, parsed.variantName),
    isAtomic: false,
  };
}

function actionEffectLabel(
  ir: PatternIr,
  sourceText: string,
  labelStyle: DotLabelStyle,
  strategy: RecursiveStrategy,
  effectByBinding: Map<string, string>,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>,
  effectId: string
): string {
  const parsed = parseSemanticInsert(sourceText);
  const semantic = parsed?.semantic ?? semanticInsertLabel(sourceText);
  if (labelStyle === "full") {
    return semantic;
  }
  if (labelStyle === "recursive") {
    const rendered = recursiveActionLabel(ir, strategy, effectByBinding, nodeById, incomingCounts, effectId, new Set());
    if (rendered) {
      return rendered.text;
    }
  }
  if (parsed) {
    const template = findPreferredTemplate(ir, parsed.variantName);
    const rendered = template ? applyDisplayTemplate(template, parsed.args, variantPrecedence(ir, parsed.variantName)) : null;
    if (rendered) {
      return rendered;
    }
  }
  return compactExpression(semantic);
}

function nodeLabel(
  ir: PatternIr,
  label: string,
  dslType: string,
  inputs: string[],
  labelStyle: DotLabelStyle,
  strategy: RecursiveStrategy,
  nodeId: string,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>
): string {
  if (labelStyle === "full") {
    return label;
  }
  if (labelStyle === "recursive") {
    const rendered = recursivePatternLabel(ir, nodeById, incomingCounts, nodeId, strategy, new Set());
    if (rendered) {
      return rendered.text;
    }
  }
  const template = findPreferredTemplate(ir, dslType);
  const rendered = template ? applyDisplayTemplate(template, inputs.map((input) => compactExpression(input)), variantPrecedence(ir, dslType)) : null;
  if (rendered) {
    return rendered;
  }
  return dslType;
}

function constraintLabel(sourceText: string, resolvedText: string, labelStyle: DotLabelStyle): string {
  if (labelStyle === "full") {
    return resolvedText;
  }
  return compactConstraintLabel(sourceText, resolvedText);
}

function seedFactLabel(sourceText: string, labelStyle: DotLabelStyle): string {
  if (labelStyle === "full") {
    return sourceText;
  }
  return compactExpression(sourceText);
}

export function patternIrToDot(ir: PatternIr): string {
  return patternIrToDotWithMode(ir, "combined");
}

export function patternIrToDotWithMode(
  ir: PatternIr,
  mode: DotViewMode,
  labelStyle: DotLabelStyle = "full",
  recursiveStrategy: RecursiveStrategy = "tree-safe"
): string {
  const lines: string[] = [
    "digraph EggplantPattern {",
    "  rankdir=TB;",
    "  graph [pad=0.3, nodesep=0.5, ranksep=0.6];",
    "  node [shape=box, style=\"rounded,filled\", fillcolor=\"#f8f5ec\", color=\"#6b5b3e\", fontname=\"Helvetica\"];",
    "  edge [color=\"#7a7468\"];"
  ];

  const rootSet = new Set(ir.roots);
  const nodeSet = new Set(ir.nodes.map((node) => node.id));
  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const incomingCounts = new Map<string, number>();
  for (const edge of ir.edges) {
    incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
  }
  const showPattern = mode === "pattern" || mode === "combined";
  const showAction = mode === "action" || mode === "combined";
  const actionAnchorVars = !showPattern
    ? Array.from(new Set(ir.action_effects.flatMap((effect) => effect.referenced_pat_vars)))
    : [];

  if (showPattern) {
    for (const node of ir.nodes) {
      const attrs: string[] = [
        `label=${quote(nodeLabel(ir, node.label, node.dsl_type, node.inputs, labelStyle, recursiveStrategy, node.id, nodeById, incomingCounts))}`,
        `shape=${node.kind === "query_leaf" ? "ellipse" : "box"}`
      ];
      if (rootSet.has(node.id)) {
        attrs.push("penwidth=2");
        attrs.push(`color=${quote("#c26d00")}`);
      }
      lines.push(`  ${quote(node.id)} [${attrs.join(", ")}];`);
    }
  }

  if (!showPattern) {
    for (const anchor of actionAnchorVars) {
      lines.push(`  ${quote(anchor)} [label=${quote(anchor)}, shape=ellipse, style="dashed,filled", fillcolor="#f3f0ea", color="#8d8477", fontname="Helvetica"];`);
    }
  }

  if (showPattern) {
    for (const edge of ir.edges) {
      lines.push(`  ${quote(edge.from)} -> ${quote(edge.to)} [label=${quote(String(edge.index))}];`);
    }
  }

  if (showPattern) {
    for (const constraint of ir.constraints) {
      const id = `constraint:${constraint.id}`;
      lines.push(`  ${quote(id)} [label=${quote(constraintLabel(constraint.source_text, constraint.resolved_text, labelStyle))}, shape=note, fillcolor="#eef3fb", color="#4e6a85"];`);
    }

    for (const constraint of ir.constraints) {
      const id = `constraint:${constraint.id}`;
      const targets = constraint.referenced_vars.filter((name) => nodeSet.has(name) || rootSet.has(name));
      const attachmentTargets = targets.length > 0 ? targets : ir.roots;
      for (const target of attachmentTargets) {
        lines.push(`  ${quote(id)} -> ${quote(target)} [style=dashed, arrowhead=none, color="#7b8ea3"];`);
      }
    }
  }

  if (showAction && ir.action_effects.length > 0) {
    lines.push("  subgraph cluster_actions {");
    lines.push(`    label=${quote("Action Effects")};`);
    lines.push("    color=\"#a55d35\";");
    lines.push("    style=rounded;");
    const actionBindingMap = new Map(
      ir.action_effects
        .filter((effect) => effect.bound_var !== null)
        .map((effect) => [effect.bound_var as string, `effect:${effect.id}`])
    );
    const effectByBinding = new Map(
      ir.action_effects
        .filter((effect) => effect.bound_var !== null)
        .map((effect) => [effect.bound_var as string, effect.id])
    );
    for (const effect of ir.action_effects) {
      const id = `effect:${effect.id}`;
      lines.push(`    ${quote(id)} [label=${quote(actionEffectLabel(ir, effect.source_text, labelStyle, recursiveStrategy, effectByBinding, nodeById, incomingCounts, effect.id))}, shape=note, fillcolor="#fff0e8", color="#a55d35"];`);
      const targets = effect.referenced_pat_vars.filter((name) =>
        showPattern ? (nodeSet.has(name) || rootSet.has(name)) : actionAnchorVars.includes(name)
      );
      for (const target of targets) {
        lines.push(`    ${quote(id)} -> ${quote(target)} [style=dashed, color="#c47a4a"];`);
      }
      for (const actionVar of effect.referenced_action_vars) {
        const target = actionBindingMap.get(actionVar);
        if (target) {
          lines.push(`    ${quote(id)} -> ${quote(target)} [style=dashed, color="#c47a4a"];`);
        }
      }
    }
    lines.push("  }");
  }

  if (showAction && ir.seed_facts.length > 0) {
    lines.push("  subgraph cluster_seed_facts {");
    lines.push(`    label=${quote("Seed Facts")};`);
    lines.push("    color=\"#4a7d63\";");
    lines.push("    style=rounded;");
    for (const fact of ir.seed_facts) {
      const id = `seed:${fact.id}`;
      lines.push(`    ${quote(id)} [label=${quote(seedFactLabel(fact.source_text, labelStyle))}, shape=note, fillcolor="#ebf7ef", color="#4a7d63"];`);
    }
    lines.push("  }");
  }

  lines.push("}");
  return lines.join("\n");
}

export function collectTypstReplacementSources(
  ir: PatternIr,
  mode: DotViewMode,
  labelStyle: DotLabelStyle = "full",
  recursiveStrategy: RecursiveStrategy = "tree-safe"
): TypstReplacementSource[] {
  if (labelStyle === "full") {
    return [];
  }

  const sources: TypstReplacementSource[] = [];
  const rootSet = new Set(ir.roots);
  const nodeSet = new Set(ir.nodes.map((node) => node.id));
  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const incomingCounts = new Map<string, number>();
  for (const edge of ir.edges) {
    incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
  }

  const showPattern = mode === "pattern" || mode === "combined";
  const showAction = mode === "action" || mode === "combined";

  if (showPattern) {
    for (const node of ir.nodes) {
      if (!findTypstTemplate(ir, node.dsl_type)) {
        continue;
      }
      sources.push({
        targetId: node.id,
        source: typstPatternSource(ir, node, labelStyle, recursiveStrategy, nodeById, incomingCounts)
      });
    }
  }

  if (showAction && ir.action_effects.length > 0) {
    const effectByBinding = new Map(
      ir.action_effects
        .filter((effect) => effect.bound_var !== null)
        .map((effect) => [effect.bound_var as string, effect.id])
    );

    for (const effect of ir.action_effects) {
      const parsed = parseSemanticInsert(effect.source_text);
      if (!parsed || !findTypstTemplate(ir, parsed.variantName)) {
        continue;
      }
      sources.push({
        targetId: `effect:${effect.id}`,
        source: actionEffectLabel(ir, effect.source_text, labelStyle, recursiveStrategy, effectByBinding, nodeById, incomingCounts, effect.id)
      });
    }
  }

  return sources.filter((entry) => entry.source.trim().length > 0 && (nodeSet.has(entry.targetId) || rootSet.has(entry.targetId) || entry.targetId.startsWith("effect:")));
}
