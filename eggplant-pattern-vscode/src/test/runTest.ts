import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const GRAPHVIZ_EXTENSION_ID = "tintinweb.graphviz-interactive-preview";
const VSCODE_TEST_VERSION = "1.111.0";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const testWorkspace = path.resolve(extensionDevelopmentPath, "test-fixtures", "workspace");
    const baseTempDir = path.join(os.tmpdir(), "eggplant-vscode-test");
    const userDataDir = path.join(baseTempDir, "user-data");
    const extensionsDir = path.join(baseTempDir, "extensions");
    const vscodeCacheDir = path.join(extensionDevelopmentPath, ".vscode-test");
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    ensureGraphvizExtensionAvailable(userDataDir, extensionsDir);
    const vscodeExecutablePath = await resolveVSCodeExecutable(vscodeCacheDir);

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        testWorkspace,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`
      ]
    });
  } catch (error) {
    console.error("Failed to run VSCode extension tests:", error);
    process.exit(1);
  }
}

async function resolveVSCodeExecutable(vscodeCacheDir: string): Promise<string> {
  const cachedExecutable = findCachedVSCodeExecutable(vscodeCacheDir);
  if (cachedExecutable) {
    return cachedExecutable;
  }

  return downloadAndUnzipVSCode({
    version: VSCODE_TEST_VERSION,
    cachePath: vscodeCacheDir
  });
}

function ensureGraphvizExtensionAvailable(userDataDir: string, extensionsDir: string): void {
  const existingLocalInstall = findLocalGraphvizExtension();
  if (existingLocalInstall) {
    const destination = path.join(extensionsDir, path.basename(existingLocalInstall));
    fs.cpSync(existingLocalInstall, destination, { recursive: true, force: true });
    return;
  }

  execFileSync("code", [
    `--user-data-dir=${userDataDir}`,
    "--extensions-dir",
    extensionsDir,
    "--install-extension",
    GRAPHVIZ_EXTENSION_ID,
    "--force"
  ], {
    stdio: "inherit"
  });
}

function findLocalGraphvizExtension(): string | undefined {
  const extensionsRoot = path.join(os.homedir(), ".vscode", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return undefined;
  }

  const candidates = fs.readdirSync(extensionsRoot)
    .filter((entry) => entry.startsWith(`${GRAPHVIZ_EXTENSION_ID}-`))
    .sort()
    .reverse();

  const selected = candidates[0];
  return selected ? path.join(extensionsRoot, selected) : undefined;
}

function findCachedVSCodeExecutable(vscodeCacheDir: string): string | undefined {
  if (!fs.existsSync(vscodeCacheDir)) {
    return undefined;
  }

  const candidates = fs.readdirSync(vscodeCacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("vscode-"))
    .map((entry) => path.join(vscodeCacheDir, entry.name))
    .sort()
    .reverse();

  for (const candidate of candidates) {
    const executablePath = path.join(candidate, vscodeExecutableRelativePath());
    if (fs.existsSync(executablePath)) {
      return executablePath;
    }
  }

  return undefined;
}

function vscodeExecutableRelativePath(): string {
  if (process.platform === "win32") {
    return "Code.exe";
  }

  if (process.platform === "darwin") {
    return path.join("Visual Studio Code.app", "Contents", "MacOS", "Electron");
  }

  return "code";
}

void main();
