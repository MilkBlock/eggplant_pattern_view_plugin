import { spawn } from "child_process";
import { existsSync } from "fs";
import * as path from "path";
import {
  RenderedTypstSnippet,
  TypstSnippetRenderer,
  normalizeTypstMathSource,
  renderTypstSnippetsWithRenderer
} from "./shared/typstCore";

export { normalizeTypstMathSource } from "./shared/typstCore";

const renderCache = new Map<string, Promise<RenderedTypstSnippet | null>>();
let missingTypstWarningShown = false;

export async function renderTypstSnippets(
  sources: Array<{ targetId: string; source: string }>
): Promise<Record<string, RenderedTypstSnippet>> {
  return renderTypstSnippetsWithRenderer(
    sources,
    cliTypstRenderer,
    renderCache,
    (error) => {
      warnTypstFailure(error);
    }
  );
}

const cliTypstRenderer: TypstSnippetRenderer = {
  render(document: string): Promise<string> {
    return runTypst(document);
  }
};

function runTypst(document: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveTypstExecutable(), ["compile", "-", "-", "--format", "svg"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `typst exited with code ${code}`));
    });

    child.stdin.end(document);
  });
}

function resolveTypstExecutable(): string {
  const configuredPath = configuredTypstPath();
  if (configuredPath) {
    return configuredPath;
  }

  const envPath = process.env.EGGPLANT_PATTERN_TYPST_PATH?.trim();
  if (envPath) {
    return envPath;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const wingetAlias = path.join(localAppData, "Microsoft", "WinGet", "Links", "typst.exe");
    if (existsSync(wingetAlias)) {
      return wingetAlias;
    }
  }

  return "typst";
}

function configuredTypstPath(): string {
  try {
    // Keep this module testable outside the VS Code extension host.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require("vscode") as typeof import("vscode");
    const value = vscode.workspace.getConfiguration().get<string>("eggplantPattern.typstPath", "").trim();
    return value || "";
  } catch {
    return "";
  }
}

function warnTypstFailure(error: unknown): void {
  if (missingTypstWarningShown) {
    return;
  }
  missingTypstWarningShown = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Eggplant pattern typst rendering disabled: ${message}`);
}
