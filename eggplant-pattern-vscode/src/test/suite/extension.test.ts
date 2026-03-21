import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { setup, suite, suiteSetup, suiteTeardown, test } from "mocha";
import { resolveExtractorPath } from "../../extractor";
import { dispatchPreviewPanelTestMessage, getPreviewPanelTestState } from "../../previewPanel";

const EXTENSION_ID = "MilkBlock.eggplant-pattern-vscode";
const FIXTURE_DIR = path.resolve(__dirname, "../../../test-fixtures/workspace");
const RUST_FIXTURE = path.join(FIXTURE_DIR, "pattern_samples.rs");
const TEXT_FIXTURE = path.join(FIXTURE_DIR, "notes.txt");
const EXTRACTOR_PATH = path.resolve(__dirname, "../../../../", "eggplant-pattern-extractor", "target", "debug", process.platform === "win32" ? "eggplant-pattern-extractor.exe" : "eggplant-pattern-extractor");
const BUNDLED_EXTRACTOR_PATH = path.resolve(__dirname, "../../../bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "eggplant-pattern-extractor.exe" : "eggplant-pattern-extractor");

const warningMessages: string[] = [];
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
    await activateExtension();
  });

  suiteTeardown(async () => {
    (vscode.window.showWarningMessage as typeof vscode.window.showWarningMessage) = originalWarning;
    await vscode.workspace.getConfiguration().update("eggplantPattern.extractorPath", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.debounceMs", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultDotView", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultLabelStyle", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultLabelStyle", undefined, vscode.ConfigurationTarget.Workspace);
  });

  setup(async () => {
    warningMessages.length = 0;
    await vscode.workspace.getConfiguration().update("eggplantPattern.autoPreview", false, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultDotView", "auto", vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultLabelStyle", "compact", vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultLabelStyle", "compact", vscode.ConfigurationTarget.Workspace);
  });

  test("manual preview renders add_rule closure scope", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "let p = Add::query");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState();
    assert.match(preview.title, /pattern\.dot/);
    assert.equal(preview.labelStyle, "compact");
    assert.match(preview.dot, /digraph EggplantPattern/);
    assert.match(preview.dot, /"p" -> "l"/);
    assert.match(preview.svg, /<svg/);
  });

  test("manual preview from action code defaults to action.dot", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.union(pat.p, op_value)");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState((state) => state.mode === "action");
    assert.match(preview.title, /action\.dot/);
    assert.match(preview.dot, /cluster_actions/);
    assert.equal(/"p" -> "l"/.test(preview.dot), false);
  });

  test("manual preview from add_rule token defaults to combined dot", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "MyTx::add_rule");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState((state) => state.mode === "combined");
    assert.match(preview.title, /action \+ pattern\.dot/);
    assert.match(preview.dot, /cluster_actions/);
    assert.match(preview.dot, /"p" -> "l"/);
  });

  test("manual mode commands re-render the current preview", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "MyTx::add_rule");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await vscode.commands.executeCommand("eggplant-pattern.showActionDot");
    let preview = await waitForPreviewState((state) => state.mode === "action");
    assert.match(preview.title, /action\.dot/);
    assert.equal(/"p" -> "l"/.test(preview.dot), false);

    await vscode.commands.executeCommand("eggplant-pattern.showPatternDot");
    preview = await waitForPreviewState((state) => state.mode === "pattern");
    assert.match(preview.title, /pattern\.dot/);
    assert.equal(/cluster_actions/.test(preview.dot), false);

    await vscode.commands.executeCommand("eggplant-pattern.showCombinedDot");
    preview = await waitForPreviewState((state) => state.mode === "combined");
    assert.match(preview.title, /action \+ pattern\.dot/);
  });

  test("manual preview renders standalone pattern function scope", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "let q = Mul::query");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState();
    assert.match(preview.dot, /"q" -> "lhs"/);
    assert.match(preview.dot, /"q" -> "rhs"/);
  });

  test("manual preview on non-pattern rust scope renders diagnostic notice", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "println!(\"not a pattern");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState();
    assert.match(preview.dot, /No supported eggplant pattern scope found under the cursor/);
    assert.equal(warningMessages.length, 1);
  });

  test("manual preview on non-rust file does not invoke extractor", async () => {
    await openEditor(TEXT_FIXTURE);

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    assert.equal(warningMessages[0], "Eggplant pattern preview only runs for Rust files.");
  });

  test("auto preview coalesces rapid cursor updates into a single render", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await vscode.workspace.getConfiguration().update("eggplantPattern.autoPreview", true, vscode.ConfigurationTarget.Global);

    placeCursor(editor, "let l = Const::query");
    placeCursor(editor, "let r = Const::query");
    placeCursor(editor, "let p = Add::query");

    const preview = await waitForPreviewState();
    assert.match(preview.dot, /"p" -> "r"/);
  });

  test("auto preview keeps editor focus while updating the panel", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await vscode.workspace.getConfiguration().update("eggplantPattern.autoPreview", true, vscode.ConfigurationTarget.Global);

    placeCursor(editor, "let p = Add::query");
    await waitForPreviewState();
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), editor.document.uri.toString());

    placeCursor(editor, "ctx.union(pat.p, op_value)");
    await waitForPreviewState((state) => state.mode === "action");
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), editor.document.uri.toString());
  });

  test("dropdown message switches the panel mode", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "MyTx::add_rule");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeMode", mode: "action" });

    const preview = await waitForPreviewState((state) => state.mode === "action");
    assert.match(preview.title, /action\.dot/);
    assert.equal(/"p" -> "l"/.test(preview.dot), false);
  });

  test("detail dropdown switches between compact and full labels", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.union(pat.p, op_value)");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    let preview = await waitForPreviewState();
    assert.equal(preview.labelStyle, "compact");
    assert.match(preview.dot, /union\(p, op_value\)/);

    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "full" });
    preview = await waitForPreviewState((state) => state.labelStyle === "full");
    assert.match(preview.title, /full/);
    assert.match(preview.dot, /ctx\.union\(pat\.p, op_value\)/);
  });

  test("extractor resolution prefers bundled binary by default", async () => {
    assert.ok(fs.existsSync(BUNDLED_EXTRACTOR_PATH), `Expected bundled extractor at ${BUNDLED_EXTRACTOR_PATH}`);
    await vscode.workspace.getConfiguration().update("eggplantPattern.extractorPath", "", vscode.ConfigurationTarget.Global);
    assert.equal(resolveExtractorPath(), BUNDLED_EXTRACTOR_PATH);
  });
});

async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Expected extension ${EXTENSION_ID} to be available`);
  await extension.activate();
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

async function waitForPreviewState(predicate?: (state: NonNullable<ReturnType<typeof getPreviewPanelTestState>>) => boolean) {
  await waitFor(() => {
    const state = getPreviewPanelTestState();
    if (!state) {
      return false;
    }
    return predicate ? predicate(state) : true;
  });
  const state = getPreviewPanelTestState();
  assert.ok(state, "Expected preview panel state");
  return state;
}
