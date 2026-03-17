import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { downloadAndUnzipVSCode, runTests, TestRunFailedError } from "@vscode/test-electron";

const GRAPHVIZ_EXTENSION_ID = "tintinweb.graphviz-interactive-preview";
const VSCODE_TEST_VERSION = "1.111.0";
const MAX_RUN_ATTEMPTS = 3;
const RUN_GRAPHVIZ_SMOKE_TEST = process.env.EGGPLANT_RUN_GRAPHVIZ_SMOKE_TEST === "1";
const KEEP_TEMP_PROFILE_ON_FAILURE = process.env.EGGPLANT_VSCODE_TEST_KEEP_TMP === "1";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const testWorkspace = path.resolve(extensionDevelopmentPath, "test-fixtures", "workspace");
    const vscodeCacheDir = path.join(extensionDevelopmentPath, ".vscode-test");
    const vscodeExecutablePath = await resolveVSCodeExecutable(vscodeCacheDir);

    await runExtensionHostTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      testWorkspace,
      vscodeExecutablePath
    });
  } catch (error) {
    console.error("Failed to run VSCode extension tests:", error);
    process.exit(1);
  }
}

async function runExtensionHostTests(options: {
  extensionDevelopmentPath: string;
  extensionTestsPath: string;
  testWorkspace: string;
  vscodeExecutablePath: string;
}): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RUN_ATTEMPTS; attempt += 1) {
    const baseTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eggplant-vscode-test-"));
    const userDataDir = path.join(baseTempDir, "user-data");
    const extensionsDir = path.join(baseTempDir, "extensions");
    let succeeded = false;

    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(extensionsDir, { recursive: true });
      if (RUN_GRAPHVIZ_SMOKE_TEST) {
        ensureGraphvizExtensionAvailable(userDataDir, extensionsDir);
      }

      await runTests({
        vscodeExecutablePath: options.vscodeExecutablePath,
        extensionDevelopmentPath: options.extensionDevelopmentPath,
        extensionTestsPath: options.extensionTestsPath,
        extensionTestsEnv: {
          EGGPLANT_RUN_GRAPHVIZ_SMOKE_TEST: RUN_GRAPHVIZ_SMOKE_TEST ? "1" : "0"
        },
        launchArgs: [
          options.testWorkspace,
          `--user-data-dir=${userDataDir}`,
          `--extensions-dir=${extensionsDir}`
        ]
      });
      succeeded = true;
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableTestRunFailure(error) || attempt === MAX_RUN_ATTEMPTS) {
        throw error;
      }

      console.warn(`VSCode extension-host run aborted with SIGABRT on attempt ${attempt}; retrying with a fresh temp profile.`);
    } finally {
      if (succeeded || !KEEP_TEMP_PROFILE_ON_FAILURE) {
        fs.rmSync(baseTempDir, { force: true, recursive: true });
      } else {
        console.warn(`Keeping VSCode test profile for inspection: ${baseTempDir}`);
      }
    }
  }

  throw lastError;
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

function isRetryableTestRunFailure(error: unknown): boolean {
  return error instanceof TestRunFailedError && error.signal === "SIGABRT";
}

void main();
