import type { MathViewModel, PatternIr } from "./ir";

function fallbackRuleName(ir: PatternIr): string {
  return `rule@${ir.scope.text_range.start}`;
}

export function buildMathViewModel(ir: PatternIr, _source?: string): MathViewModel {
  return ir.math_view ?? {
    rule_name: fallbackRuleName(ir),
    premises: [],
    side_conditions: [],
    derivations: [],
    conclusions: [],
    formula_source: {
      plain: 'frac(upright("no matched premise"), upright("no conclusion")) quad upright("if") quad upright("None")',
      colored: 'frac(upright("no matched premise"), upright("no conclusion")) quad upright("if") quad upright("None")',
    },
  };
}

export function buildMathViewTypstSource(model: MathViewModel, colorMode: "plain" | "colored" = "plain"): string {
  return colorMode === "colored" ? model.formula_source.colored : model.formula_source.plain;
}
