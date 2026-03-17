import * as path from "path";
import * as vscode from "vscode";
import { spawn } from "child_process";
import { PatternIr } from "./ir";

function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function defaultExtractorPath(): string {
  const binaryName = process.platform === "win32"
    ? "eggplant-pattern-extractor.exe"
    : "eggplant-pattern-extractor";
  return path.join(
    repoRoot(),
    "..",
    "eggplant-pattern-extractor",
    "target",
    "debug",
    binaryName
  );
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
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `extractor exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as PatternIr);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(source, "utf8");
    child.stdin.end();
  });
}
