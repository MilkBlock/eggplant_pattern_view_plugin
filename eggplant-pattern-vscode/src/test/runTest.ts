import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { runTests } from "@vscode/test-electron";

const GRAPHVIZ_EXTENSION_ID = "tintinweb.graphviz-interactive-preview";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const testWorkspace = path.resolve(extensionDevelopmentPath, "test-fixtures", "workspace");
    const baseTempDir = path.join(os.tmpdir(), "eggplant-vscode-test");
    const userDataDir = path.join(baseTempDir, "user-data");
    const extensionsDir = path.join(baseTempDir, "extensions");
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    ensureGraphvizExtensionAvailable(userDataDir, extensionsDir);

    await runTests({
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

void main();
