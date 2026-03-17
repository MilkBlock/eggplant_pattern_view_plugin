import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { spawn } from "child_process";
import { PatternIr } from "./ir";

function extensionRoot(): string {
  return path.resolve(__dirname, "..");
}

function repoRoot(): string {
  return path.resolve(extensionRoot(), "..");
}

function defaultExtractorPath(): string {
  const binaryName = process.platform === "win32"
    ? "eggplant-pattern-extractor.exe"
    : "eggplant-pattern-extractor";
  return path.join(
    repoRoot(),
    "eggplant-pattern-extractor",
    "target",
    "debug",
    binaryName
  );
}

export class ExtractorError extends Error {
  readonly kind: "missing_binary" | "unsupported_scope" | "process_error" | "invalid_json";

  constructor(kind: ExtractorError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export function resolveExtractorPath(): string {
  const configured = vscode.workspace.getConfiguration().get<string>("eggplantPattern.extractorPath", "");
  if (configured.trim() !== "") {
    return configured.trim();
  }
  return defaultExtractorPath();
}

export async function runExtractor(document: vscode.TextDocument, offset: number): Promise<PatternIr> {
  const extractorPath = resolveExtractorPath();
  const source = document.getText();
  await ensureExtractorAvailable(extractorPath);

  return new Promise<PatternIr>((resolve, reject) => {
    const child = spawn(extractorPath, ["--offset", String(offset)], {
      cwd: repoRoot(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(new ExtractorError("process_error", formatSpawnError(extractorPath, error)));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(classifyExtractorFailure(code, stderr));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as PatternIr);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new ExtractorError("invalid_json", `Extractor returned invalid JSON: ${message}`));
      }
    });

    child.stdin.write(source, "utf8");
    child.stdin.end();
  });
}

async function ensureExtractorAvailable(extractorPath: string): Promise<void> {
  try {
    await fs.promises.access(extractorPath, fs.constants.F_OK);
  } catch {
    throw new ExtractorError(
      "missing_binary",
      `Extractor binary not found at ${extractorPath}. Build it with \`cargo build\` in eggplant-pattern-extractor or set eggplantPattern.extractorPath.`
    );
  }
}

function formatSpawnError(extractorPath: string, error: Error): string {
  const anyError = error as NodeJS.ErrnoException;
  if (anyError.code === "ENOENT") {
    return `Extractor binary not found at ${extractorPath}. Build it with \`cargo build\` in eggplant-pattern-extractor or set eggplantPattern.extractorPath.`;
  }
  return anyError.message;
}

function classifyExtractorFailure(code: number | null, stderr: string): ExtractorError {
  const message = stderr.trim() || `extractor exited with code ${code ?? "unknown"}`;
  if (message.includes("no supported pattern scope found at cursor")) {
    return new ExtractorError(
      "unsupported_scope",
      "No supported eggplant pattern scope found under the cursor."
    );
  }
  return new ExtractorError("process_error", message);
}
