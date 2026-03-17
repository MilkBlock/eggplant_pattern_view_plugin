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
    lines.push(`  ${quote(id)} [label=${quote(constraint.label)}, shape=note, fillcolor=\"#eef3fb\", color=\"#4e6a85\"];`);
  }

  for (const constraint of ir.constraints) {
    const id = `constraint:${constraint.id}`;
    for (const root of ir.roots) {
      lines.push(`  ${quote(id)} -> ${quote(root)} [style=dashed, arrowhead=none, color=\"#7b8ea3\"];`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}
