import { DisplayTemplate, PatternConstraint, PatternIr, PatternNode, TypstTemplate } from "./ir";

export type DotViewMode = "pattern" | "action" | "combined";
export type DotLabelStyle = "compact" | "full" | "recursive";
export type RecursiveStrategy = "tree-safe" | "dag-expand";

export interface TypstReplacementSource {
  targetId: string;
  source: string;
}

export interface TypstSizingInfo {
  width: number;
  height: number;
}

export interface ActionRenderOverrides {
  effectLabels?: Record<string, string>;
  visibleEffectIds?: Set<string> | null;
}

export interface InlineConstraintAnnotation {
  nodeId: string;
  fieldName: string | null;
  valueText: string;
  displayText: string;
  hideInSidebar: boolean;
}

interface RenderedTemplateField {
  precedence: number;
  text: string;
  isAtomic: boolean;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function inchesFromPoints(points: number, paddingPoints: number, minimumInches: number): string {
  return Math.max((points + paddingPoints) / 72, minimumInches).toFixed(3);
}

function applyTypstSizing(attrs: string[], targetId: string, typstSizing: Record<string, TypstSizingInfo>): void {
  const sizing = typstSizing[targetId];
  if (!sizing || !sizing.width || !sizing.height) {
    return;
  }

  attrs.push(`width=${inchesFromPoints(sizing.width, 22, 0.75)}`);
  attrs.push(`height=${inchesFromPoints(sizing.height, 18, 0.45)}`);
  attrs.push('margin="0.16,0.12"');
}

function toVariantTypeName(insertTarget: string): string {
  return insertTarget
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function compactExpression(value: string): string {
  let compacted = value
    .replace(/\b(?:pat|matched|ctx|tx)\./g, "")
    .replace(/\.clone\(\)/g, "")
    .replace(/\.handle\(\)/g, "")
    .replace(/&([A-Za-z_][A-Za-z0-9_]*)/g, "$1")
    .replace(/"([^"]+)"\.to_owned\(\)/g, "\"$1\"")
    .replace(/\s+/g, " ")
    .trim();

  let previous = "";
  while (previous !== compacted) {
    previous = compacted;
    compacted = compacted
      .replace(/\bdevalue\(\s*([^()]+?)\s*\)/g, "$1");
  }

  return compacted;
}

function stripOuterParens(value: string): string {
  let current = value.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let balanced = true;
    for (let index = 0; index < current.length; index += 1) {
      const ch = current[index];
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0 && index !== current.length - 1) {
          balanced = false;
          break;
        }
      }
    }
    if (!balanced || depth !== 0) {
      break;
    }
    current = current.slice(1, -1).trim();
  }
  return current;
}

function parseSimpleComparable(value: string): string | null {
  let current = stripOuterParens(value);
  while (current.startsWith("&")) {
    current = stripOuterParens(current.slice(1));
  }
  if (current.endsWith(".as_handle()")) {
    current = stripOuterParens(current.slice(0, -".as_handle()".length));
    while (current.startsWith("&")) {
      current = stripOuterParens(current.slice(1));
    }
  }
  const compacted = compactExpression(current);
  if (
    /^-?\d[\w]*/.test(compacted) ||
    /^"(?:\\.|[^"])*"$/.test(compacted) ||
    /^(?:true|false)$/.test(compacted) ||
    /^[A-Z][A-Za-z0-9_:<>]*$/.test(compacted)
  ) {
    return compacted;
  }
  return null;
}

function parseHandleComparable(value: string): { valueText: string } | null {
  const simple = parseSimpleComparable(value);
  if (simple) {
    return {
      valueText: simple
    };
  }

  let current = stripOuterParens(value);
  while (current.startsWith("&")) {
    current = stripOuterParens(current.slice(1));
  }
  const handleMatch = current.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\.handle(?:_([A-Za-z_][A-Za-z0-9_]*))?\(\)$/
  );
  if (!handleMatch) {
    return parseBinaryHandleComparable(current);
  }
  const nodeId = handleMatch[1];
  const fieldName = handleMatch[2] ?? null;
  return {
    valueText: fieldName ? `${nodeId}.${fieldName}` : nodeId
  };
}

function parseBinaryHandleComparable(value: string): { valueText: string } | null {
  let parenDepth = 0;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const ch = value[i];
    if (ch === ")") {
      parenDepth += 1;
      continue;
    }
    if (ch === "(") {
      parenDepth -= 1;
      continue;
    }
    if (parenDepth !== 0 || (ch !== "+" && ch !== "-")) {
      continue;
    }
    const left = parseHandleComparable(value.slice(0, i).trim());
    const right = parseHandleComparable(value.slice(i + 1).trim());
    if (!left || !right) {
      return null;
    }
    return {
      valueText: `${left.valueText} ${ch} ${right.valueText}`
    };
  }
  return null;
}

export function inlineConstraintAnnotation(constraint: PatternConstraint): InlineConstraintAnnotation | null {
  const match = constraint.resolved_text.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\.handle(?:_([A-Za-z_][A-Za-z0-9_]*))?\(\)\.eq\(&(.+)\)$/
  );
  if (!match) {
    return null;
  }
  if (new Set(constraint.referenced_vars).size >= 3) {
    return null;
  }
  const nodeId = match[1];
  if (!constraint.referenced_vars.includes(nodeId)) {
    return null;
  }
  const comparable = parseHandleComparable(match[3]);
  if (!comparable) {
    return null;
  }
  const fieldName = match[2] ?? null;
  return {
    nodeId,
    fieldName,
    valueText: comparable.valueText,
    displayText: fieldName ? `${fieldName} = ${comparable.valueText}` : `= ${comparable.valueText}`,
    hideInSidebar: true
  };
}

function inlineConstraintAnnotationsByNode(ir: PatternIr): Map<string, InlineConstraintAnnotation[]> {
  const annotations = new Map<string, InlineConstraintAnnotation[]>();
  for (const constraint of ir.constraints) {
    const annotation = inlineConstraintAnnotation(constraint);
    if (!annotation) {
      continue;
    }
    const entries = annotations.get(annotation.nodeId) ?? [];
    entries.push(annotation);
    annotations.set(annotation.nodeId, entries);
  }
  return annotations;
}

function displayAtomicExpression(value: string): string {
  const compacted = compactExpression(value);
  const stringLiteralMatch = compacted.match(/^"((?:\\.|[^"])*)"$/);
  if (!stringLiteralMatch) {
    return compacted;
  }
  return stringLiteralMatch[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function typstTextAtom(value: string): string {
  return `upright(${JSON.stringify(value)})`;
}

function typstAtomicExpression(value: string): string {
  const compacted = compactExpression(value);
  const stringLiteralMatch = compacted.match(/^"((?:\\.|[^"])*)"$/);
  if (!stringLiteralMatch) {
    if (/^[A-Za-z]$/.test(compacted)) {
      return compacted;
    }
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(compacted) && /[0-9]/.test(compacted)) {
      return compacted;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(compacted)) {
      return typstTextAtom(compacted);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(compacted)) {
      return typstTextAtom(compacted);
    }
    return compacted;
  }

  const unescaped = stringLiteralMatch[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  if (/^[A-Za-z]$/.test(unescaped)) {
    return unescaped;
  }
  return typstTextAtom(unescaped);
}

export function compactConstraintLabel(sourceText: string, resolvedText: string): string {
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
  const insertMatch = trimmed.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?insert_([A-Za-z0-9_]+)\(([\s\S]*)\)\s*;?$/
  );
  if (!insertMatch) {
    return trimmed;
  }

  const [, insertTarget, args] = insertMatch;
  return `${toVariantTypeName(insertTarget)}(${args})`;
}

function renderSetCall(
  ir: PatternIr,
  sourceText: string,
  atomicRenderer: (value: string) => string,
  templateLookup: (ir: PatternIr, variantName: string) => DisplayTemplate | TypstTemplate | undefined
): string | null {
  const trimmed = sourceText.trim();
  const setMatch = trimmed.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?set_([A-Za-z0-9_]+)\(([\s\S]*)\)\s*;?$/
  );
  if (!setMatch) {
    return null;
  }

  const [, setTarget, rawArgs] = setMatch;
  const args = parseArgsList(rawArgs).map((arg) => compactExpression(arg));
  if (args.length < 2) {
    return null;
  }

  const variantCandidates = [setTarget, toVariantTypeName(setTarget)];
  const rhs = atomicRenderer(args[args.length - 1]);
  for (const variantName of variantCandidates) {
    const template = templateLookup(ir, variantName);
    if (!template) {
      continue;
    }
    if (template.fields.length !== args.length - 1) {
      continue;
    }
    const lhs = applyDisplayTemplate(
      template,
      args.slice(0, -1).map((arg) => atomicRenderer(arg)),
      variantPrecedence(ir, variantName)
    );
    if (lhs) {
      return `${lhs} = ${rhs}`;
    }
  }

  return `${setTarget}(${args.slice(0, -1).map((arg) => atomicRenderer(arg)).join(", ")}) = ${rhs}`;
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
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of rawArgs) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      current += char;
      quote = char;
      continue;
    }
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

function stripSemanticActionArgNoise(value: string): string {
  let current = value.trim();
  while (true) {
    const next = current
      .replace(
        /\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?devalue\(\s*([^()]+?)\s*\)/g,
        "$1"
      )
      .trim();
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function parseSemanticInsert(sourceText: string): { variantName: string; args: string[]; semantic: string } | null {
  const trimmed = sourceText.trim();
  const insertMatch = trimmed.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?insert_([A-Za-z0-9_]+)\(([\s\S]*)\)\s*;?$/
  );
  if (!insertMatch) {
    return null;
  }

  const [, insertTarget, args] = insertMatch;
  const variantName = toVariantTypeName(insertTarget);
  const parsedArgs = parseArgsList(args);
  return {
    variantName,
    args: parsedArgs.map((arg) => compactExpression(arg)),
    semantic: `${variantName}(${parsedArgs.map((arg) => stripSemanticActionArgNoise(arg)).join(", ")})`,
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
  seen: Set<string>,
  atomicRenderer: (value: string) => string = compactExpression
): RecursivePatternResult | null {
  const node = nodeById.get(nodeId);
  if (!node) {
    return {
      text: atomicRenderer(nodeId),
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
      ? { text: atomicRenderer(node.id), precedence: Number.MAX_SAFE_INTEGER, isAtomic: true }
      : null;
  }

  const nextSeen = new Set(seen);
  nextSeen.add(nodeId);
  const renderedArgs: Array<{ name: string; value: RenderedTemplateField }> = [];
  for (const input of node.inputs) {
    const child = recursivePatternLabel(ir, nodeById, incomingCounts, input, strategy, nextSeen, atomicRenderer);
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
      new Set(),
      typstAtomicExpression
    );
    if (recursive) {
      return recursive.text;
    }
  }

  const typstTemplate = findTypstTemplate(ir, node.dsl_type);
  if (typstTemplate) {
    const rendered = applyDisplayTemplate(
      typstTemplate,
      node.inputs.map((input) => typstAtomicExpression(input)),
      variantPrecedence(ir, node.dsl_type)
    );
    if (rendered) {
      return rendered;
    }
  }

  if (node.inputs.length === 0) {
    return typstAtomicExpression(node.id);
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
    incomingCounts,
    inlineConstraintAnnotationsByNode(ir)
  );
}

interface RecursiveActionResult {
  text: string;
  precedence: number;
  isAtomic: boolean;
}

function recursiveActionArgLabel(
  ir: PatternIr,
  strategy: RecursiveStrategy,
  effectByBinding: Map<string, string>,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>,
  arg: string,
  seen: Set<string>,
  atomicRenderer: (value: string) => string
): RecursiveActionResult | null {
  const trimmed = compactExpression(arg);
  if (effectByBinding.has(trimmed)) {
    const childEffectId = effectByBinding.get(trimmed);
    if (childEffectId) {
      const child = recursiveActionLabel(ir, strategy, effectByBinding, nodeById, incomingCounts, childEffectId, seen, atomicRenderer);
      if (child) {
        return child;
      }
    }
  }

  const inlineInsert = parseSemanticInsert(trimmed);
  if (inlineInsert) {
    const template = findPreferredTemplate(ir, inlineInsert.variantName);
    if (!template) {
      return null;
    }

    const renderedArgs = inlineInsert.args.map((childArg, index) => {
      const child = recursiveActionArgLabel(ir, strategy, effectByBinding, nodeById, incomingCounts, childArg, seen, atomicRenderer);
      if (!child) {
        return null;
      }
      return {
        name: template.fields[index],
        value: { text: child.text, precedence: child.precedence, isAtomic: child.isAtomic }
      };
    });

    if (renderedArgs.some((child) => child === null)) {
      return null;
    }

    const rendered = renderTemplateWithPrecedence(
      template,
      variantPrecedence(ir, inlineInsert.variantName),
      renderedArgs as Array<{ name: string; value: RenderedTemplateField }>
    );
    if (!rendered) {
      return null;
    }
    return {
      text: rendered,
      precedence: variantPrecedence(ir, inlineInsert.variantName),
      isAtomic: inlineInsert.args.length === 0,
    };
  }

  const patVar = trimmed.replace(/^(?:pat|matched)\./, "");
  if (nodeById.has(patVar)) {
    const child = recursivePatternLabel(ir, nodeById, incomingCounts, patVar, strategy, new Set(), atomicRenderer);
    if (child) {
      return child;
    }
    if (strategy === "tree-safe") {
      return null;
    }
  }

  return {
    text: atomicRenderer(trimmed),
    precedence: Number.MAX_SAFE_INTEGER,
    isAtomic: true,
  };
}

function recursiveActionLabel(
  ir: PatternIr,
  strategy: RecursiveStrategy,
  effectByBinding: Map<string, string>,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>,
  effectId: string,
  seen: Set<string>,
  atomicRenderer: (value: string) => string = displayAtomicExpression
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
    const child = recursiveActionArgLabel(ir, strategy, effectByBinding, nodeById, incomingCounts, arg, nextSeen, atomicRenderer);
    if (child) {
      return {
        name: template.fields[index],
        value: { text: child.text, precedence: child.precedence, isAtomic: child.isAtomic }
      };
    }
    return {
      name: template.fields[index],
      value: { text: atomicRenderer(arg), precedence: Number.MAX_SAFE_INTEGER, isAtomic: true }
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
  effectId: string,
  overrides?: ActionRenderOverrides
): string {
  const overrideLabel = overrides?.effectLabels?.[effectId];
  if (overrideLabel) {
    return overrideLabel;
  }
  const renderedSet = renderSetCall(ir, sourceText, displayAtomicExpression, findPreferredTemplate);
  if (renderedSet) {
    return renderedSet;
  }
  const parsed = parseSemanticInsert(sourceText);
  const semantic = parsed?.semantic ?? semanticInsertLabel(sourceText);
  if (labelStyle === "full") {
    return semantic;
  }
  if (labelStyle === "recursive") {
    const rendered = recursiveActionLabel(ir, strategy, effectByBinding, nodeById, incomingCounts, effectId, new Set(), displayAtomicExpression);
    if (rendered) {
      return rendered.text;
    }
  }
  if (parsed) {
    const template = findPreferredTemplate(ir, parsed.variantName);
    const rendered = template
      ? applyDisplayTemplate(
          template,
          parsed.args.map((arg) => displayAtomicExpression(arg)),
          variantPrecedence(ir, parsed.variantName)
        )
      : null;
    if (rendered) {
      return rendered;
    }
  }
  return compactExpression(semantic);
}

function actionEffectTypstSource(
  ir: PatternIr,
  sourceText: string,
  labelStyle: DotLabelStyle,
  strategy: RecursiveStrategy,
  effectByBinding: Map<string, string>,
  nodeById: Map<string, PatternNode>,
  incomingCounts: Map<string, number>,
  effectId: string
): string {
  const renderedSet = renderSetCall(ir, sourceText, typstAtomicExpression, findTypstTemplate);
  if (renderedSet) {
    return renderedSet;
  }
  const parsed = parseSemanticInsert(sourceText);
  if (!parsed) {
    return compactExpression(sourceText);
  }

  if (labelStyle === "recursive") {
    const rendered = recursiveActionLabel(ir, strategy, effectByBinding, nodeById, incomingCounts, effectId, new Set(), typstAtomicExpression);
    if (rendered) {
      return rendered.text;
    }
  }

  const template = findTypstTemplate(ir, parsed.variantName);
  const rendered = template
    ? applyDisplayTemplate(
        template,
        parsed.args.map((arg) => typstAtomicExpression(arg)),
        variantPrecedence(ir, parsed.variantName)
      )
    : null;
  if (rendered) {
    return rendered;
  }

  return actionEffectLabel(ir, sourceText, labelStyle, strategy, effectByBinding, nodeById, incomingCounts, effectId);
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
  incomingCounts: Map<string, number>,
  inlineAnnotations: Map<string, InlineConstraintAnnotation[]>
): string {
  const annotationSuffix = inlineAnnotationSuffix(inlineAnnotations, nodeId);
  if (labelStyle === "full") {
    return `${label}${annotationSuffix}`;
  }
  if (labelStyle === "recursive") {
    const rendered = recursivePatternLabel(ir, nodeById, incomingCounts, nodeId, strategy, new Set(), displayAtomicExpression);
    if (rendered) {
      return `${rendered.text}${annotationSuffix}`;
    }
  }
  const template = findPreferredTemplate(ir, dslType);
  const rendered = template ? applyDisplayTemplate(template, inputs.map((input) => compactExpression(input)), variantPrecedence(ir, dslType)) : null;
  if (rendered) {
    return `${rendered}${annotationSuffix}`;
  }
  return `${dslType}${annotationSuffix}`;
}

function inlineAnnotationSuffix(
  inlineAnnotations: Map<string, InlineConstraintAnnotation[]>,
  nodeId: string
): string {
  const annotations = inlineAnnotations.get(nodeId) ?? [];
  if (annotations.length === 0) {
    return "";
  }
  return `\n${annotations.map((entry) => entry.displayText).join("\n")}`;
}

export function constraintLabel(sourceText: string, resolvedText: string, labelStyle: DotLabelStyle): string {
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
  recursiveStrategy: RecursiveStrategy = "tree-safe",
  typstSizing: Record<string, TypstSizingInfo> = {},
  actionOverrides: ActionRenderOverrides = {}
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
  const inlineAnnotations = inlineConstraintAnnotationsByNode(ir);
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
        `label=${quote(nodeLabel(ir, node.label, node.dsl_type, node.inputs, labelStyle, recursiveStrategy, node.id, nodeById, incomingCounts, inlineAnnotations))}`,
        `shape=${node.kind === "query_leaf" ? "ellipse" : "box"}`
      ];
      applyTypstSizing(attrs, node.id, typstSizing);
      if (rootSet.has(node.id)) {
        attrs.push("penwidth=2");
        attrs.push(`color=${quote("#c26d00")}`);
      }
      lines.push(`  ${quote(node.id)} [${attrs.join(", ")}];`);
    }

    // Keep relation/base roots visible as first-class graph nodes even when no explicit PatternNode exists.
    for (const root of ir.roots) {
      if (nodeSet.has(root)) {
        continue;
      }
      const rootLabel = `${root}${inlineAnnotationSuffix(inlineAnnotations, root)}`;
      lines.push(
        `  ${quote(root)} [label=${quote(rootLabel)}, shape=ellipse, style="dashed,filled", fillcolor="#f3f0ea", color="#8d8477", penwidth=2, fontname="Helvetica"];`
      );
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
    const visibleActionEffects = ir.action_effects.filter((effect) =>
      !actionOverrides.visibleEffectIds || actionOverrides.visibleEffectIds.has(effect.id)
    );
    for (const effect of visibleActionEffects) {
      const id = `effect:${effect.id}`;
      const attrs = [
        `label=${quote(actionEffectLabel(ir, effect.source_text, labelStyle, recursiveStrategy, effectByBinding, nodeById, incomingCounts, effect.id, actionOverrides))}`,
        'shape=note',
        'fillcolor="#fff0e8"',
        'color="#a55d35"'
      ];
      applyTypstSizing(attrs, id, typstSizing);
      lines.push(`    ${quote(id)} [${attrs.join(", ")}];`);
      const targets = effect.referenced_pat_vars.filter((name) =>
        showPattern ? (nodeSet.has(name) || rootSet.has(name)) : actionAnchorVars.includes(name)
      );
      for (const target of targets) {
        lines.push(`    ${quote(id)} -> ${quote(target)} [style=dashed, color="#c47a4a"];`);
      }
      for (const actionVar of new Set(effect.referenced_action_vars)) {
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
  recursiveStrategy: RecursiveStrategy = "tree-safe",
  actionOverrides: ActionRenderOverrides = {}
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
      if (actionOverrides.visibleEffectIds && !actionOverrides.visibleEffectIds.has(effect.id)) {
        continue;
      }
      if (actionOverrides.effectLabels?.[effect.id]) {
        continue;
      }
      const parsed = parseSemanticInsert(effect.source_text);
      const renderedSet = renderSetCall(ir, effect.source_text, typstAtomicExpression, findTypstTemplate);
      if ((!parsed || !findTypstTemplate(ir, parsed.variantName)) && !renderedSet) {
        continue;
      }
      sources.push({
        targetId: `effect:${effect.id}`,
        source: actionEffectTypstSource(ir, effect.source_text, labelStyle, recursiveStrategy, effectByBinding, nodeById, incomingCounts, effect.id)
      });
    }
  }

  return sources.filter((entry) => entry.source.trim().length > 0 && (nodeSet.has(entry.targetId) || rootSet.has(entry.targetId) || entry.targetId.startsWith("effect:")));
}
