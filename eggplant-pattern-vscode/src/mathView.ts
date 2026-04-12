import { collectTypstReplacementSources, compactConstraintLabel } from "./dot";
import type { ActionEffect, PatternIr, PatternNode, TextSpan } from "./ir";

export interface MathViewEntry {
  targetId: string;
  source: string;
  label: string;
}

export interface MathViewConclusion {
  id: string;
  kind: "rewrite" | "derive";
  from?: MathViewEntry;
  to?: MathViewEntry;
  entry?: MathViewEntry;
}

export interface MathViewModel {
  ruleName: string;
  premises: MathViewEntry[];
  sideConditions: string[];
  derivations: MathViewEntry[];
  conclusions: MathViewConclusion[];
}

const MATH_VIEW_RESERVED_IDENTIFIERS = new Set([
  "frac",
  "sqrt",
  "sin",
  "cos",
  "ln",
  "integral",
  "quad",
  "upright",
  "text",
  "arrow",
]);

function parseRuleNameFromSource(source: string, range: TextSpan): string {
  const slice = source.slice(range.start, range.end);
  const match = slice.match(/add_rule(?:_with_hook)?\(\s*"([^"]+)"/);
  return match?.[1] ?? `rule@${range.start}`;
}

function entrySortOrder(ir: PatternIr, targetId: string): number {
  if (targetId.startsWith("effect:")) {
    return ir.action_effects.find((effect) => `effect:${effect.id}` === targetId)?.range.start ?? Number.MAX_SAFE_INTEGER;
  }
  return ir.nodes.find((node) => node.id === targetId)?.range.start ?? Number.MAX_SAFE_INTEGER;
}

function buildEntryLabel(targetId: string, node?: PatternNode, effect?: ActionEffect): string {
  if (effect?.bound_var) {
    return effect.bound_var;
  }
  if (node?.dsl_type) {
    return `${node.id}: ${node.dsl_type}`;
  }
  return targetId;
}

function isFunctionLikeDslType(dslType: string): boolean {
  return /^[a-z][A-Za-z0-9_]*$/.test(dslType);
}

function semanticIdentifierToTypst(identifier: string, isFunctionCall: boolean): string {
  if (MATH_VIEW_RESERVED_IDENTIFIERS.has(identifier)) {
    return identifier;
  }
  if (/^[A-Za-z]$/.test(identifier)) {
    return identifier;
  }
  const singleLetterWithIndex = identifier.match(/^([A-Za-z])(\d+)$/);
  if (singleLetterWithIndex) {
    return `${singleLetterWithIndex[1]}_${singleLetterWithIndex[2]}`;
  }
  if (identifier.includes(".")) {
    return `upright(${JSON.stringify(identifier)})`;
  }
  if (isFunctionCall || /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return `upright(${JSON.stringify(identifier)})`;
  }
  return identifier;
}

function semanticTextToTypst(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (!/[A-Za-z_]/.test(char)) {
      result += char;
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) {
      end += 1;
    }

    const identifier = source.slice(index, end);
    let lookahead = end;
    while (lookahead < source.length && /\s/.test(source[lookahead])) {
      lookahead += 1;
    }
    const isFunctionCall = source[lookahead] === "(";
    result += semanticIdentifierToTypst(identifier, isFunctionCall);
    index = end;
  }
  return result;
}

function buildEntry(targetId: string, source: string, ir: PatternIr): MathViewEntry {
  const node = ir.nodes.find((entry) => entry.id === targetId);
  const effect = ir.action_effects.find((entry) => `effect:${entry.id}` === targetId);
  const semanticSource = effect?.semantic_text
    ? semanticTextToTypst(effect.semantic_text)
    : node?.kind === "query_leaf"
      ? semanticTextToTypst(node.id)
      : node && isFunctionLikeDslType(node.dsl_type)
        ? semanticTextToTypst(`${node.dsl_type}(${node.inputs.join(", ")})`)
        : source;
  return {
    targetId,
    source: semanticSource,
    label: buildEntryLabel(targetId, node, effect),
  };
}

function parseUnionConclusion(effect: ActionEffect): { patternVar: string; actionVar: string } | null {
  const match = effect.source_text.match(
    /(?:[A-Za-z_][A-Za-z0-9_]*\.)?union\(\s*(?:pat|matched)\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/
  );
  if (match) {
    return {
      patternVar: match[1],
      actionVar: match[2],
    };
  }
  if (effect.referenced_pat_vars.length === 1 && effect.referenced_action_vars.length === 1) {
    return {
      patternVar: effect.referenced_pat_vars[0],
      actionVar: effect.referenced_action_vars[0],
    };
  }
  return null;
}

export function buildMathViewModel(ir: PatternIr, source: string): MathViewModel {
  const patternEntries = collectTypstReplacementSources(ir, "pattern", "recursive", "tree-safe")
    .sort((left, right) => entrySortOrder(ir, left.targetId) - entrySortOrder(ir, right.targetId))
    .map((entry) => buildEntry(entry.targetId, entry.source, ir));

  const actionEntries = collectTypstReplacementSources(ir, "action", "recursive", "tree-safe")
    .sort((left, right) => entrySortOrder(ir, left.targetId) - entrySortOrder(ir, right.targetId))
    .map((entry) => buildEntry(entry.targetId, entry.source, ir));

  const patternById = new Map(patternEntries.map((entry) => [entry.targetId, entry] as const));
  const actionByBoundVar = new Map(
    ir.action_effects
      .filter((effect) => effect.bound_var)
      .map((effect) => [effect.bound_var as string, actionEntries.find((entry) => entry.targetId === `effect:${effect.id}`)] as const)
      .filter((entry): entry is readonly [string, MathViewEntry] => entry[1] !== undefined)
  );

  const conclusions: MathViewConclusion[] = [];
  for (const effect of ir.action_effects) {
    const union = parseUnionConclusion(effect);
    if (!union) {
      continue;
    }
    const from = patternById.get(union.patternVar);
    const to = actionByBoundVar.get(union.actionVar);
    if (!from || !to) {
      continue;
    }
    conclusions.push({
      id: effect.id,
      kind: "rewrite",
      from,
      to,
    });
  }

  if (conclusions.length === 0 && actionEntries.length > 0) {
    const consumedByMaterial = new Set<string>();
    for (const effect of ir.action_effects) {
      const hasMaterializedEntry = actionEntries.some((entry) => entry.targetId === `effect:${effect.id}`);
      if (!hasMaterializedEntry) {
        continue;
      }
      for (const actionVar of effect.referenced_action_vars) {
        consumedByMaterial.add(actionVar);
      }
    }

    for (const effect of ir.action_effects) {
      const entry = actionEntries.find((candidate) => candidate.targetId === `effect:${effect.id}`);
      if (!entry) {
        continue;
      }
      if (effect.bound_var && consumedByMaterial.has(effect.bound_var)) {
        continue;
      }
      if (!effect.bound_var && !effect.semantic_text) {
        continue;
      }
      conclusions.push({
        id: effect.id,
        kind: "derive",
        entry,
      });
    }
  }

  return {
    ruleName: parseRuleNameFromSource(source, ir.scope.text_range),
    premises: patternEntries,
    sideConditions: ir.constraints.map((constraint) => {
      const semantic = constraint.semantic_text?.trim();
      return semantic ? semanticTextToTypst(semantic) : compactConstraintLabel(constraint.source_text, constraint.resolved_text);
    }),
    derivations: actionEntries,
    conclusions,
  };
}

export function buildMathViewTypstSource(model: MathViewModel): string {
  const premises = model.premises.length > 0
    ? model.premises.map((entry) => entry.source).join(" \\ ")
    : 'upright("no matched premise")';
  const sideConditions = model.sideConditions.length > 0
    ? model.sideConditions.join(" \\ ")
    : "upright(\"None\")";

  let conclusion = 'upright("no conclusion")';
  const rewrite = model.conclusions.find((entry) => entry.kind === "rewrite" && entry.from && entry.to);
  if (rewrite?.from && rewrite.to) {
    conclusion = `${rewrite.from.source} arrow.r.double ${rewrite.to.source}`;
  } else if (model.conclusions[0]?.entry) {
    conclusion = model.conclusions[0].entry.source;
  }

  return `frac(${premises}, ${conclusion}) quad upright("if") quad ${sideConditions}`;
}
