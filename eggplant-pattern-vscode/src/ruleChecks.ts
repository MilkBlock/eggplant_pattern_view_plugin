import { PatternIr, TextSpan } from "./ir";

export interface RuleCheckEntry {
  id: string;
  severity: "warning";
  kind: "redundant-action-insert";
  message: string;
  suggestion: string;
  duplicatePatternNodeIds: string[];
  duplicateActionEffectIds: string[];
  sourceRange: TextSpan | null;
}

function toVariantTypeName(insertTarget: string): string {
  return insertTarget
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function parseArgsList(rawArgs: string): string[] {
  const args: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const ch = rawArgs[i];
    if (ch === "(") {
      paren += 1;
    } else if (ch === ")") {
      paren = Math.max(paren - 1, 0);
    } else if (ch === "[") {
      bracket += 1;
    } else if (ch === "]") {
      bracket = Math.max(bracket - 1, 0);
    } else if (ch === "{") {
      brace += 1;
    } else if (ch === "}") {
      brace = Math.max(brace - 1, 0);
    } else if (ch === "<") {
      angle += 1;
    } else if (ch === ">") {
      angle = Math.max(angle - 1, 0);
    } else if (ch === "," && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      args.push(rawArgs.slice(start, i).trim());
      start = i + 1;
    }
  }

  const tail = rawArgs.slice(start).trim();
  if (tail.length > 0) {
    args.push(tail);
  }
  return args;
}

function stripRedundantActionSyntax(value: string): string {
  let compacted = value.trim();
  let previous = "";
  while (previous !== compacted) {
    previous = compacted;
    compacted = compacted
      .replace(/\b(?:ctx|tx|matched|pat)\./g, "")
      .replace(/\.clone\(\)/g, "")
      .replace(/\.handle\(\)/g, "")
      .replace(/\.as_handle\(\)/g, "")
      .replace(/\bdevalue\(\s*([^()]+?)\s*\)/g, "$1")
      .trim();
  }
  return compacted;
}

interface ParsedInsertEffect {
  variantName: string;
  normalizedArgs: string[];
}

function parseInsertEffect(sourceText: string): ParsedInsertEffect | null {
  const trimmed = sourceText.trim();
  const match = trimmed.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?insert_([A-Za-z0-9_]+)\s*\(([\s\S]*)\)\s*;?$/);
  if (!match) {
    return null;
  }

  const [, insertTarget, rawArgs] = match;
  return {
    variantName: toVariantTypeName(insertTarget),
    normalizedArgs: parseArgsList(rawArgs).map(stripRedundantActionSyntax)
  };
}

export function findRedundantActionInsertChecks(ir: PatternIr): RuleCheckEntry[] {
  const nodeIndex = new Map<string, string[]>();
  for (const node of ir.nodes) {
    const key = `${node.dsl_type}(${(node.inputs || []).join(",")})`;
    if (!nodeIndex.has(key)) {
      nodeIndex.set(key, []);
    }
    nodeIndex.get(key)?.push(node.id);
  }

  const checks: RuleCheckEntry[] = [];
  let nextId = 0;
  for (const effect of ir.action_effects) {
    const parsed = parseInsertEffect(effect.source_text);
    if (!parsed) {
      continue;
    }
    const key = `${parsed.variantName}(${parsed.normalizedArgs.join(",")})`;
    const matchedNodeIds = nodeIndex.get(key) || [];
    if (matchedNodeIds.length === 0) {
      continue;
    }
    const suggestionTarget = matchedNodeIds[0];
    checks.push({
      id: `rule-check-${nextId++}`,
      severity: "warning",
      kind: "redundant-action-insert",
      message: `Action insert duplicates an existing pattern sub-DAG: ${effect.source_text}`,
      suggestion: `Reuse matched pattern sub-DAG ${suggestionTarget} instead of reinserting ${parsed.variantName} in the action.`,
      duplicatePatternNodeIds: matchedNodeIds,
      duplicateActionEffectIds: [`effect:${effect.id}`],
      sourceRange: effect.range ?? null
    });
  }

  return checks;
}
