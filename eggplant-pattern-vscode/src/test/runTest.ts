import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const testWorkspace = path.resolve(extensionDevelopmentPath, "test-fixtures", "workspace");
    const baseTempDir = path.join(os.tmpdir(), "eggplant-vscode-test");
    const userDataDir = path.join(baseTempDir, "user-data");
    const extensionsDir = path.join(baseTempDir, "extensions");

    execFileSync("code", [
      "--extensions-dir",
      extensionsDir,
      "--install-extension",
      "tintinweb.graphviz-interactive-preview",
      "--force"
    ], {
      stdio: "inherit"
    });

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

void main();
