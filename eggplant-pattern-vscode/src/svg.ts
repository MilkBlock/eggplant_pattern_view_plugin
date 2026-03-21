import { instance } from "@viz-js/viz";

let vizPromise: Promise<Awaited<ReturnType<typeof instance>>> | undefined;

async function viz() {
  if (!vizPromise) {
    vizPromise = instance();
  }
  return vizPromise;
}

export async function dotToSvg(dot: string): Promise<string> {
  const renderer = await viz();
  return renderer.renderString(dot, {
    format: "svg",
    engine: "dot"
  });
}
