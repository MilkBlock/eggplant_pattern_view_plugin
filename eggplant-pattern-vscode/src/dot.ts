import { DisplayTemplate, PatternIr } from "./ir";

export type DotViewMode = "pattern" | "action" | "combined";
export type DotLabelStyle = "compact" | "full";

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
  const eqMatch = compactResolved.match(/^([A-Za-z_][A-Za-z0-9_]*)\.eq\(([A-Za-z_][A-Za-z0-9_]*)\)$/);
  if (eqMatch) {
    return `${eqMatch[1]} == ${eqMatch[2]}`;
  }
  return sourceText.length < compactResolved.length ? sourceText : compactResolved;
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

function applyDisplayTemplate(template: DisplayTemplate, args: string[]): string | null {
  if (template.fields.length !== args.length) {
    return null;
  }

  let rendered = template.template;
  for (let index = 0; index < template.fields.length; index += 1) {
    rendered = rendered.split(`{${template.fields[index]}}`).join(args[index]);
  }
  return rendered;
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
    args: args.split(",").map((arg) => compactExpression(arg)),
    semantic: `${variantName}(${args})`,
  };
}

function actionEffectLabel(ir: PatternIr, sourceText: string, labelStyle: DotLabelStyle): string {
  const parsed = parseSemanticInsert(sourceText);
  const semantic = parsed?.semantic ?? semanticInsertLabel(sourceText);
  if (labelStyle === "full") {
    return semantic;
  }
  if (parsed) {
    const template = findDisplayTemplate(ir, parsed.variantName);
    const rendered = template ? applyDisplayTemplate(template, parsed.args) : null;
    if (rendered) {
      return rendered;
    }
  }
  return compactExpression(semantic);
}

function nodeLabel(ir: PatternIr, label: string, dslType: string, inputs: string[], labelStyle: DotLabelStyle): string {
  if (labelStyle === "full") {
    return label;
  }
  const template = findDisplayTemplate(ir, dslType);
  const rendered = template ? applyDisplayTemplate(template, inputs.map((input) => compactExpression(input))) : null;
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

export function patternIrToDotWithMode(ir: PatternIr, mode: DotViewMode, labelStyle: DotLabelStyle = "full"): string {
  const lines: string[] = [
    "digraph EggplantPattern {",
    "  rankdir=TB;",
    "  graph [pad=0.3, nodesep=0.5, ranksep=0.6];",
    "  node [shape=box, style=\"rounded,filled\", fillcolor=\"#f8f5ec\", color=\"#6b5b3e\", fontname=\"Helvetica\"];",
    "  edge [color=\"#7a7468\"];"
  ];

  const rootSet = new Set(ir.roots);
  const nodeSet = new Set(ir.nodes.map((node) => node.id));
  const showPattern = mode === "pattern" || mode === "combined";
  const showAction = mode === "action" || mode === "combined";
  const actionAnchorVars = !showPattern
    ? Array.from(new Set(ir.action_effects.flatMap((effect) => effect.referenced_pat_vars)))
    : [];

  if (showPattern) {
    for (const node of ir.nodes) {
      const attrs: string[] = [
        `label=${quote(nodeLabel(ir, node.label, node.dsl_type, node.inputs, labelStyle))}`,
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
      lines.push(`  ${quote(id)} [label=${quote(constraintLabel(constraint.source_text, constraint.resolved_text, labelStyle))}, shape=note, fillcolor=\"#eef3fb\", color=\"#4e6a85\"];`);
    }

    for (const constraint of ir.constraints) {
      const id = `constraint:${constraint.id}`;
      const targets = constraint.referenced_vars.filter((name) => nodeSet.has(name) || rootSet.has(name));
      const attachmentTargets = targets.length > 0 ? targets : ir.roots;
      for (const target of attachmentTargets) {
        lines.push(`  ${quote(id)} -> ${quote(target)} [style=dashed, arrowhead=none, color=\"#7b8ea3\"];`);
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
    for (const effect of ir.action_effects) {
      const id = `effect:${effect.id}`;
      lines.push(`    ${quote(id)} [label=${quote(actionEffectLabel(ir, effect.source_text, labelStyle))}, shape=note, fillcolor=\"#fff0e8\", color=\"#a55d35\"];`);
      const targets = effect.referenced_pat_vars.filter((name) =>
        showPattern ? (nodeSet.has(name) || rootSet.has(name)) : actionAnchorVars.includes(name)
      );
      for (const target of targets) {
        lines.push(`    ${quote(id)} -> ${quote(target)} [style=dashed, color=\"#c47a4a\"];`);
      }
      for (const actionVar of effect.referenced_action_vars) {
        const target = actionBindingMap.get(actionVar);
        if (target) {
          lines.push(`    ${quote(id)} -> ${quote(target)} [style=dashed, color=\"#c47a4a\"];`);
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
      lines.push(`    ${quote(id)} [label=${quote(seedFactLabel(fact.source_text, labelStyle))}, shape=note, fillcolor=\"#ebf7ef\", color=\"#4a7d63\"];`);
    }
    lines.push("  }");
  }

  lines.push("}");
  return lines.join("\n");
}
