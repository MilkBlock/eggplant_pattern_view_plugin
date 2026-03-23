import { spawn } from "child_process";
import { existsSync } from "fs";
import * as path from "path";

export interface RenderedTypstSnippet {
  svg: string;
  width: number;
  height: number;
}

const renderCache = new Map<string, Promise<RenderedTypstSnippet | null>>();
let missingTypstWarningShown = false;

export async function renderTypstSnippets(
  sources: Array<{ targetId: string; source: string }>
): Promise<Record<string, RenderedTypstSnippet>> {
  const entries = await Promise.all(
    sources.map(async ({ targetId, source }) => {
      const rendered = await renderTypstSnippet(source);
      return rendered ? [targetId, rendered] as const : null;
    })
  );

  return Object.fromEntries(entries.filter((entry): entry is readonly [string, RenderedTypstSnippet] => entry !== null));
}

async function renderTypstSnippet(source: string): Promise<RenderedTypstSnippet | null> {
  if (!renderCache.has(source)) {
    renderCache.set(source, renderTypstSnippetUncached(source));
  }
  return renderCache.get(source) ?? null;
}

async function renderTypstSnippetUncached(source: string): Promise<RenderedTypstSnippet | null> {
  try {
    const document = [
      "#set page(width: auto, height: auto, margin: 0pt)",
      "#set par(justify: false)",
      `#box(inset: (x: 1.2pt, y: 1.6pt))[$ ${normalizeTypstMathSource(source)} $]`
    ].join("\n");
    const stdout = await runTypst(document);
    return {
      svg: stdout,
      width: parseDimension(stdout, "width"),
      height: parseDimension(stdout, "height")
    };
  } catch (error) {
    warnTypstFailure(error);
    return null;
  }
}

function parseDimension(svg: string, attr: "width" | "height"): number {
  const match = svg.match(new RegExp(`${attr}="([0-9.]+)(?:pt)?"`));
  return match ? Number(match[1]) : 0;
}

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
