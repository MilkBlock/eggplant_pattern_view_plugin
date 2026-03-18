import { PatternIr } from "./ir";

function quote(value: string): string {
  return JSON.stringify(value);
}

export function patternIrToDot(ir: PatternIr): string {
  const lines: string[] = [
    "digraph EggplantPattern {",
    "  rankdir=TB;",
    "  graph [pad=0.3, nodesep=0.5, ranksep=0.6];",
    "  node [shape=box, style=\"rounded,filled\", fillcolor=\"#f8f5ec\", color=\"#6b5b3e\", fontname=\"Helvetica\"];",
    "  edge [color=\"#7a7468\"];"
  ];

  const rootSet = new Set(ir.roots);
  const nodeSet = new Set(ir.nodes.map((node) => node.id));

  for (const node of ir.nodes) {
    const attrs: string[] = [
      `label=${quote(node.label)}`,
      `shape=${node.kind === "query_leaf" ? "ellipse" : "box"}`
    ];
    if (rootSet.has(node.id)) {
      attrs.push("penwidth=2");
      attrs.push(`color=${quote("#c26d00")}`);
    }
    lines.push(`  ${quote(node.id)} [${attrs.join(", ")}];`);
  }

  for (const edge of ir.edges) {
    lines.push(`  ${quote(edge.from)} -> ${quote(edge.to)} [label=${quote(String(edge.index))}];`);
  }

  for (const constraint of ir.constraints) {
    const id = `constraint:${constraint.id}`;
    lines.push(`  ${quote(id)} [label=${quote(constraint.resolved_text)}, shape=note, fillcolor=\"#eef3fb\", color=\"#4e6a85\"];`);
  }

  for (const constraint of ir.constraints) {
    const id = `constraint:${constraint.id}`;
    const targets = constraint.referenced_vars.filter((name) => nodeSet.has(name) || rootSet.has(name));
    const attachmentTargets = targets.length > 0 ? targets : ir.roots;
    for (const target of attachmentTargets) {
      lines.push(`  ${quote(id)} -> ${quote(target)} [style=dashed, arrowhead=none, color=\"#7b8ea3\"];`);
    }
  }

  if (ir.action_effects.length > 0) {
    lines.push("  subgraph cluster_actions {");
    lines.push(`    label=${quote("Action Effects")};`);
    lines.push("    color=\"#a55d35\";");
    lines.push("    style=rounded;");
    for (const effect of ir.action_effects) {
      const id = `effect:${effect.id}`;
      lines.push(`    ${quote(id)} [label=${quote(effect.source_text)}, shape=note, fillcolor=\"#fff0e8\", color=\"#a55d35\"];`);
      const targets = effect.referenced_pat_vars.filter((name) => nodeSet.has(name) || rootSet.has(name));
      for (const target of targets) {
        lines.push(`    ${quote(id)} -> ${quote(target)} [style=dashed, color=\"#c47a4a\"];`);
      }
    }
    lines.push("  }");
  }

  if (ir.seed_facts.length > 0) {
    lines.push("  subgraph cluster_seed_facts {");
    lines.push(`    label=${quote("Seed Facts")};`);
    lines.push("    color=\"#4a7d63\";");
    lines.push("    style=rounded;");
    for (const fact of ir.seed_facts) {
      const id = `seed:${fact.id}`;
      lines.push(`    ${quote(id)} [label=${quote(fact.source_text)}, shape=note, fillcolor=\"#ebf7ef\", color=\"#4a7d63\"];`);
    }
    lines.push("  }");
  }

  lines.push("}");
  return lines.join("\n");
}
