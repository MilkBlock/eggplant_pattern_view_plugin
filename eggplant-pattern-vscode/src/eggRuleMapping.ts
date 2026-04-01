export function collectRuleCallOffsets(source: string): number[] {
  return Array.from(source.matchAll(/add_rule(?:_with_hook)?\s*\(/g)).map((match) => match.index ?? 0);
}

export function countEggRuleFormsBeforeOffset(source: string, offset: number): number {
  const clampedOffset = Math.max(0, Math.min(source.length, offset));
  return Array.from(source.matchAll(/\((?:rewrite|birewrite|rule)\b/g))
    .filter((match) => (match.index ?? Number.POSITIVE_INFINITY) <= clampedOffset)
    .length;
}

export function resolveEggPreviewOffset(eggSource: string, eggOffset: number, generatedRust: string): number {
  const ruleCallOffsets = collectRuleCallOffsets(generatedRust);
  if (ruleCallOffsets.length === 0) {
    throw new Error("Generated Rust does not contain any add_rule scopes yet.");
  }
  if (ruleCallOffsets.length === 1) {
    return ruleCallOffsets[0];
  }
  const eggRuleOrdinal = Math.max(0, countEggRuleFormsBeforeOffset(eggSource, eggOffset) - 1);
  return ruleCallOffsets[Math.min(eggRuleOrdinal, ruleCallOffsets.length - 1)];
}
