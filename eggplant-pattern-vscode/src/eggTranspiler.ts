import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

let configuredExtensionPath: string | undefined;
let transpilerModulePromise: Promise<TranspilerModule> | undefined;
const dynamicImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<TranspilerModule>;

type TranspilerModule = {
  initSync?: (input: { module: BufferSource | WebAssembly.Module } | BufferSource | WebAssembly.Module) => unknown;
  default?: (input?: { module_or_path: BufferSource | WebAssembly.Module | Promise<BufferSource | WebAssembly.Module> }) => Promise<unknown>;
  transpile_egg_to_eggplant: (source: string) => string;
};

export class EggTranspilerError extends Error {
  readonly kind: "missing_vendor" | "transpile_failed";

  constructor(kind: EggTranspilerError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export function configureTranspilerResolution(extensionPath: string): void {
  configuredExtensionPath = extensionPath;
}

function extensionRoot(): string {
  if (configuredExtensionPath) {
    return configuredExtensionPath;
  }
  return path.resolve(__dirname, "..");
}

async function loadTranspilerModule(): Promise<TranspilerModule> {
  if (!transpilerModulePromise) {
    transpilerModulePromise = (async () => {
      const vendorDir = path.join(extensionRoot(), "vendor", "transpiler-wasm");
      const modulePath = path.join(vendorDir, "eggplant_transpiler_wasm_wrapper.js");
      const wasmPath = path.join(vendorDir, "eggplant_transpiler_wasm_wrapper_bg.wasm");
      try {
        await fs.promises.access(modulePath, fs.constants.F_OK);
        await fs.promises.access(wasmPath, fs.constants.F_OK);
      } catch {
        throw new EggTranspilerError(
          "missing_vendor",
          `Transpiler wasm bundle not found under ${vendorDir}.`
        );
      }

      const transpilerModule = await dynamicImport(pathToFileURL(modulePath).href);
      const wasmBytes = await fs.promises.readFile(wasmPath);
      if (typeof transpilerModule.initSync === "function") {
        transpilerModule.initSync({ module: wasmBytes });
      } else if (typeof transpilerModule.default === "function") {
        await transpilerModule.default({ module_or_path: wasmBytes });
      }
      return transpilerModule;
    })();
  }

  return transpilerModulePromise;
}

export async function transpileEggSource(source: string): Promise<string> {
  try {
    const transpiler = await loadTranspilerModule();
    return transpiler.transpile_egg_to_eggplant(source);
  } catch (error) {
    if (error instanceof EggTranspilerError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new EggTranspilerError("transpile_failed", message);
  }
}
