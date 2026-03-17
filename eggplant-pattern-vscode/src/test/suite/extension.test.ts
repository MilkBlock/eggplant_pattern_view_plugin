import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { setup, suite, suiteSetup, suiteTeardown, test } from "mocha";

const EXTENSION_ID = "local.eggplant-pattern-vscode";
const MOCK_PREVIEW_COMMAND = "eggplant-pattern.test.preview";
const FAILING_PREVIEW_COMMAND = "eggplant-pattern.test.preview.fail";
const DEFAULT_PREVIEW_COMMAND = "graphviz-interactive-preview.preview.beside";
const FIXTURE_DIR = path.resolve(__dirname, "../../../test-fixtures/workspace");
const RUST_FIXTURE = path.join(FIXTURE_DIR, "pattern_samples.rs");
const TEXT_FIXTURE = path.join(FIXTURE_DIR, "notes.txt");
const EXTRACTOR_PATH = path.resolve(__dirname, "../../../../", "eggplant-pattern-extractor", "target", "debug", process.platform === "win32" ? "eggplant-pattern-extractor.exe" : "eggplant-pattern-extractor");

interface PreviewCall {
  title: string;
  content: string;
  allowMultiplePanels: boolean;
}

const previewCalls: PreviewCall[] = [];
const warningMessages: string[] = [];
const commandRegistrations = new Map<string, vscode.Disposable>();
let originalWarning: typeof vscode.window.showWarningMessage;

suite("eggplant pattern extension", () => {
  suiteSetup(async () => {
    originalWarning = vscode.window.showWarningMessage;
    (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = ((message: string) => {
      warningMessages.push(message);
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showWarningMessage;

    await vscode.workspace.getConfiguration().update("eggplantPattern.extractorPath", EXTRACTOR_PATH, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.debounceMs", 10, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.previewCommand", MOCK_PREVIEW_COMMAND, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("setContext", "eggplantPattern.test", true);

    await activateExtension();
    await registerMockPreviewCommand(MOCK_PREVIEW_COMMAND, false);
    await registerMockPreviewCommand(FAILING_PREVIEW_COMMAND, true);
  });

  suiteTeardown(async () => {
    (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = originalWarning;
    await vscode.workspace.getConfiguration().update("eggplantPattern.extractorPath", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.debounceMs", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.previewCommand", undefined, vscode.ConfigurationTarget.Global);
  });

  setup(async () => {
    previewCalls.length = 0;
    warningMessages.length = 0;
    await vscode.workspace.getConfiguration().update("eggplantPattern.autoPreview", false, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.previewCommand", MOCK_PREVIEW_COMMAND, vscode.ConfigurationTarget.Global);
  });

  test("manual preview renders add_rule closure scope", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    resetObservations();
    placeCursor(editor, "let p = Add::query");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    assert.equal(previewCalls.length, 1);
    assert.equal(previewCalls[0].allowMultiplePanels, false);
    assert.match(previewCalls[0].content, /digraph EggplantPattern/);
    assert.match(previewCalls[0].content, /"p" -> "l"/);
  });

  test.skip("manual preview smoke test works with installed graphviz preview command", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await vscode.workspace.getConfiguration().update("eggplantPattern.previewCommand", DEFAULT_PREVIEW_COMMAND, vscode.ConfigurationTarget.Global);
    resetObservations();
    placeCursor(editor, "let p = Add::query");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    assert.equal(warningMessages.length, 0);
  });

  test("manual preview renders standalone pattern function scope", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    resetObservations();
    placeCursor(editor, "let q = Mul::query");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    assert.equal(previewCalls.length, 1);
    assert.match(previewCalls[0].content, /"q" -> "lhs"/);
    assert.match(previewCalls[0].content, /"q" -> "rhs"/);
  });

  test("manual preview on non-pattern rust scope renders diagnostic notice", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    resetObservations();
    placeCursor(editor, "println!(\"not a pattern");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    assert.equal(previewCalls.length, 1);
    assert.match(previewCalls[0].content, /No supported eggplant pattern scope found under the cursor/);
    assert.equal(warningMessages.length, 1);
  });

  test("manual preview on non-rust file does not invoke extractor", async () => {
    await openEditor(TEXT_FIXTURE);
    resetObservations();

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    assert.equal(previewCalls.length, 0);
    assert.equal(warningMessages[0], "Eggplant pattern preview only runs for Rust files.");
  });

  test("auto preview coalesces rapid cursor updates into a single render", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await vscode.workspace.getConfiguration().update("eggplantPattern.autoPreview", true, vscode.ConfigurationTarget.Global);
    resetObservations();

    placeCursor(editor, "let l = Const::query");
    placeCursor(editor, "let r = Const::query");
    placeCursor(editor, "let p = Add::query");

    await waitFor(() => previewCalls.length >= 1);

    assert.equal(previewCalls.length, 1);
    assert.match(previewCalls[0].content, /"p" -> "r"/);
  });

  test("manual preview still warns when preview command fails", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await vscode.workspace.getConfiguration().update("eggplantPattern.previewCommand", FAILING_PREVIEW_COMMAND, vscode.ConfigurationTarget.Global);
    resetObservations();
    placeCursor(editor, "let p = Add::query");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    assert.equal(previewCalls.length, 0);
    assert.equal(warningMessages.length, 1);
    assert.match(warningMessages[0], /Mock preview failure/);
  });
});

async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Expected extension ${EXTENSION_ID} to be available`);
  await extension.activate();
}

async function registerMockPreviewCommand(commandId: string, shouldFail: boolean): Promise<void> {
  const existing = commandRegistrations.get(commandId);
  existing?.dispose();
  commandRegistrations.set(commandId, vscode.commands.registerCommand(commandId, (payload: PreviewCall) => {
    if (shouldFail) {
      throw new Error("Mock preview failure");
    }
    previewCalls.push(payload);
  }));
}

async function openEditor(filePath: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(filePath);
  return vscode.window.showTextDocument(document);
}

function placeCursor(editor: vscode.TextEditor, needle: string): void {
  const offset = editor.document.getText().indexOf(needle);
  assert.notEqual(offset, -1, `Needle not found: ${needle}`);
  const position = editor.document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function resetObservations(): void {
  previewCalls.length = 0;
  warningMessages.length = 0;
}
