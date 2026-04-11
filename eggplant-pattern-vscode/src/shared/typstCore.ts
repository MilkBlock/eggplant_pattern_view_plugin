export type TypstRenderMode = "math" | "text-fallback";

export interface RenderedTypstSnippet {
  svg: string;
  width: number;
  height: number;
  mode: TypstRenderMode;
}

export interface TypstSnippetRenderer {
  render(document: string): Promise<string>;
}

export function normalizeTypstMathSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function buildTypstMathDocument(source: string): string {
  return [
    "#set page(width: auto, height: auto, margin: 0pt)",
    "#set par(justify: false)",
    `#box(inset: (x: 1.2pt, y: 1.6pt))[$ ${normalizeTypstMathSource(source)} $]`
  ].join("\n");
}

export function displayTextFallbackSource(source: string): string {
  let current = source;
  while (true) {
    const next = current
      .replace(/#text\(fill: rgb\("#[0-9A-Fa-f]{6}"\)\)\[([^\[\]]+)\]/g, "$1")
      .replace(/upright\("((?:\\.|[^"])*)"\)/g, "$1");
    if (next === current) {
      return next;
    }
    current = next;
  }
}

export function buildTypstTextDocument(source: string): string {
  return [
    "#set page(width: auto, height: auto, margin: 0pt)",
    "#set par(justify: false)",
    `#box(inset: (x: 1.2pt, y: 1.6pt))[#(${JSON.stringify(displayTextFallbackSource(source))})]`
  ].join("\n");
}

export function parseTypstSvgDimension(svg: string, attr: "width" | "height"): number {
  const match = svg.match(new RegExp(`${attr}="([0-9.]+)(?:pt)?"`));
  return match ? Number(match[1]) : 0;
}

export async function renderTypstSnippetWithRenderer(
  source: string,
  renderer: TypstSnippetRenderer
): Promise<RenderedTypstSnippet> {
  try {
    const svg = await renderer.render(buildTypstMathDocument(source));
    return {
      svg,
      width: parseTypstSvgDimension(svg, "width"),
      height: parseTypstSvgDimension(svg, "height"),
      mode: "math"
    };
  } catch {
    const svg = await renderer.render(buildTypstTextDocument(source));
    return {
      svg,
      width: parseTypstSvgDimension(svg, "width"),
      height: parseTypstSvgDimension(svg, "height"),
      mode: "text-fallback"
    };
  }
}

export async function renderTypstSnippetsWithRenderer(
  sources: Array<{ targetId: string; source: string }>,
  renderer: TypstSnippetRenderer,
  cache: Map<string, Promise<RenderedTypstSnippet | null>>,
  onFailure?: (error: unknown) => void
): Promise<Record<string, RenderedTypstSnippet>> {
  const entries = await Promise.all(
    sources.map(async ({ targetId, source }) => {
      if (!cache.has(source)) {
        cache.set(
          source,
          renderTypstSnippetWithRenderer(source, renderer).catch((error) => {
            onFailure?.(error);
            return null;
          })
        );
      }
      const rendered = await cache.get(source);
      return rendered ? [targetId, rendered] as const : null;
    })
  );

  return Object.fromEntries(entries.filter((entry): entry is readonly [string, RenderedTypstSnippet] => entry !== null));
}
