type VizModule = typeof import("@viz-js/viz");
// Use the vendored CJS runtime in packaged extensions so VSIX installs don't
// depend on node_modules dependency detection. Keep the package dependency for
// development and future vendor refreshes.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { instance } = require("../vendor/viz.cjs") as VizModule;

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
