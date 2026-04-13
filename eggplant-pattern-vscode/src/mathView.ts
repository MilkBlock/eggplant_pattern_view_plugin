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

function stripTypstPreviewDecorations(source: string): string {
  let current = source.trim();
  while (true) {
    const next = current
      .replace(/^#text\(fill: rgb\("#[0-9A-Fa-f]{6}"\)\)\[\$ ([\s\S]+) \$\]$/, "$1")
      .replace(/^\(#text\(fill: rgb\("#[0-9A-Fa-f]{6}"\)\)\[([\s\S]+)\]\)$/, "$1")
      .trim();
    if (next === current) {
      return next;
    }
    current = next;
  }
}

function splitTopLevelArgs(source: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) {
    args.push(trimmed);
  }
  return args;
}

function fallbackPatternSource(nodeId: string, ir: PatternIr, seen = new Set<string>()): string {
  const node = ir.nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    return semanticTextToTypst(nodeId);
  }
  if (seen.has(nodeId)) {
    return semanticTextToTypst(nodeId);
  }
  if (node.inputs.length === 0) {
    return semanticTextToTypst(node.id);
  }
  const nextSeen = new Set(seen);
  nextSeen.add(nodeId);
  const callee = semanticIdentifierToTypst(node.dsl_type, true);
  const args = node.inputs.map((input) => fallbackPatternSource(input, ir, nextSeen)).join(", ");
  return `${callee}(${args})`;
}

function fallbackActionValueSource(value: string, ir: PatternIr): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("pat.") || trimmed.startsWith("matched.")) {
    return fallbackPatternSource(trimmed.replace(/^(?:pat|matched)\./, ""), ir);
  }
  return semanticTextToTypst(trimmed);
}

function fallbackActionSource(effect: ActionEffect, ir: PatternIr): string | null {
  const match = effect.source_text.match(/(?:[A-Za-z_][A-Za-z0-9_]*\.)?insert_([A-Za-z0-9_]+)\(([\s\S]*)\)$/);
  if (!match) {
    return effect.bound_var ? semanticTextToTypst(effect.bound_var) : null;
  }
  const target = match[1].replace(/^m_/, "");
  const args = splitTopLevelArgs(match[2]);
  if (target === "const" && args.length === 1) {
    return fallbackActionValueSource(args[0], ir);
  }
  const callee = semanticIdentifierToTypst(target, true);
  return `${callee}(${args.map((arg) => fallbackActionValueSource(arg, ir)).join(", ")})`;
}

function collectDescendantPatternIds(nodeId: string, ir: PatternIr, seen = new Set<string>()): Set<string> {
  if (seen.has(nodeId)) {
    return new Set();
  }
  const node = ir.nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    return new Set();
  }
  const nextSeen = new Set(seen);
  nextSeen.add(nodeId);
  const descendants = new Set<string>();
  for (const input of node.inputs) {
    descendants.add(input);
    for (const nested of collectDescendantPatternIds(input, ir, nextSeen)) {
      descendants.add(nested);
    }
  }
  return descendants;
}

function buildEntry(targetId: string, source: string, ir: PatternIr): MathViewEntry {
  const node = ir.nodes.find((entry) => entry.id === targetId);
  const effect = ir.action_effects.find((entry) => `effect:${entry.id}` === targetId);
  const plainSource = stripTypstPreviewDecorations(source);
  const semanticSource = effect?.semantic_text
    ? semanticTextToTypst(effect.semantic_text)
    : node?.kind === "query_leaf"
      ? semanticTextToTypst(node.id)
      : node && isFunctionLikeDslType(node.dsl_type)
        ? semanticTextToTypst(`${node.dsl_type}(${node.inputs.join(", ")})`)
        : plainSource;
  return {
    targetId,
    source: semanticSource,
    label: buildEntryLabel(targetId, node, effect),
  };
}

function hasResidualTypstPreviewArtifacts(source: string): boolean {
  return source.includes("#text(") || source.includes("$]");
}

function parseUnionConclusion(effect: ActionEffect): { patternVar: string; targetKind: "action" | "pattern"; targetVar: string } | null {
  const match = effect.source_text.match(
    /(?:[A-Za-z_][A-Za-z0-9_]*\.)?union\(\s*(?:pat|matched)\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*((?:(?:pat|matched)\.)?)([A-Za-z_][A-Za-z0-9_]*)\s*\)/
  );
  if (match) {
    return {
      patternVar: match[1],
      targetKind: match[2] ? "pattern" : "action",
      targetVar: match[3],
    };
  }
  return null;
}

export function buildMathViewModel(ir: PatternIr, source: string): MathViewModel {
  const candidateRootIds = ir.roots.filter((rootId) => ir.nodes.find((node) => node.id === rootId)?.kind !== "query_leaf");
  const descendantRootIds = new Set<string>();
  for (const rootId of candidateRootIds) {
    for (const descendant of collectDescendantPatternIds(rootId, ir)) {
      if (candidateRootIds.includes(descendant)) {
        descendantRootIds.add(descendant);
      }
    }
  }
  const rootPatternIds = new Set(candidateRootIds.filter((rootId) => !descendantRootIds.has(rootId)));
  const collectedPatternSources = new Map(
    collectTypstReplacementSources(ir, "pattern", "recursive", "tree-safe")
      .map((entry) => [entry.targetId, entry.source] as const)
  );
  const patternEntries = Array.from(rootPatternIds)
    .sort((left, right) => entrySortOrder(ir, left) - entrySortOrder(ir, right))
    .map((targetId) => buildEntry(targetId, collectedPatternSources.get(targetId) ?? fallbackPatternSource(targetId, ir), ir));

  const collectedActionSources = new Map(
    collectTypstReplacementSources(ir, "action", "recursive", "tree-safe")
      .map((entry) => [entry.targetId, entry.source] as const)
  );
  const actionEntries = ir.action_effects
    .map((effect) => {
      const targetId = `effect:${effect.id}`;
      const collected = collectedActionSources.get(targetId);
      const sourceText = collected && !hasResidualTypstPreviewArtifacts(stripTypstPreviewDecorations(collected))
        ? collected
        : fallbackActionSource(effect, ir);
      return sourceText ? { targetId, sourceText } : null;
    })
    .filter((entry): entry is { targetId: string; sourceText: string } => entry !== null)
    .sort((left, right) => entrySortOrder(ir, left.targetId) - entrySortOrder(ir, right.targetId))
    .map((entry) => buildEntry(entry.targetId, entry.sourceText, ir));

  const patternById = new Map(patternEntries.map((entry) => [entry.targetId, entry] as const));
  const ensurePatternEntry = (targetId: string): MathViewEntry | undefined => {
    const existing = patternById.get(targetId);
    if (existing) {
      return existing;
    }
    const knownPatternTarget =
      ir.nodes.some((node) => node.id === targetId) || ir.roots.includes(targetId);
    if (!knownPatternTarget) {
      return undefined;
    }
    const fallback = buildEntry(targetId, semanticTextToTypst(targetId), ir);
    patternById.set(targetId, fallback);
    return fallback;
  };
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
    const from = ensurePatternEntry(union.patternVar);
    const to = union.targetKind === "pattern"
      ? ensurePatternEntry(union.targetVar)
      : actionByBoundVar.get(union.targetVar);
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
