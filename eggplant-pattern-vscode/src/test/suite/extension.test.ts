import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { setup, suite, suiteSetup, suiteTeardown, test } from "mocha";
import { resolveExtractorPath } from "../../extractor";
import {
  clearPreviewPanelTestState,
  dispatchPreviewPanelTestMessage,
  getPreviewPanelTestState,
} from "../../previewPanel";

const EXTENSION_ID = "MilkBlock.eggplant-pattern-vscode";
const FIXTURE_DIR = path.resolve(__dirname, "../../../test-fixtures/workspace");
const RUST_FIXTURE = path.join(FIXTURE_DIR, "pattern_samples.rs");
const CROSS_FILE_METADATA_FIXTURE = path.join(FIXTURE_DIR, "cross_file_metadata_usage.rs");
const ROOT_TYPST_FIXTURE = path.join(FIXTURE_DIR, "pattern_typst_root_failure.rs");
const TEXT_FIXTURE = path.join(FIXTURE_DIR, "notes.txt");
const TRACE_FIXTURE = path.join(FIXTURE_DIR, "tmp_action_sample_trace.json");
const MATH_MICROBENCHMARK_FIXTURE = "/Users/mineralsteins/Repos/egg_related/eggplant_backup/benches/runners/eggplant_rewrite/math_microbenchmark.rs";
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
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultRecursiveStrategy", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultRecursiveStrategy", undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration().update("eggplantPattern.experimentalDynamicActionRecovery", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.dynamicActionRecoveryMode", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.actionSampleTracePath", undefined, vscode.ConfigurationTarget.Global);
    try {
      await fs.promises.unlink(TRACE_FIXTURE);
    } catch {}
  });

  setup(async () => {
    warningMessages.length = 0;
    await clearPreviewPanelTestState();
    await dispatchPreviewPanelTestMessage({ type: "changeSourceMode", sourceMode: "ast" });
    await vscode.workspace.getConfiguration().update("eggplantPattern.autoPreview", false, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultDotView", "auto", vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultLabelStyle", "recursive", vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultLabelStyle", "recursive", vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultRecursiveStrategy", "dag-expand", vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.defaultRecursiveStrategy", "dag-expand", vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration().update("eggplantPattern.experimentalDynamicActionRecovery", false, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.dynamicActionRecoveryMode", "hybrid", vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update("eggplantPattern.actionSampleTracePath", "", vscode.ConfigurationTarget.Global);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await clearPreviewPanelTestState();
  });

  test("manual preview renders add_rule closure scope", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "let p = Add::query");

    const baselineRenderNonce = currentPreviewRenderNonce();
    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState(undefined, { minRenderNonce: baselineRenderNonce + 1 });
    assert.match(preview.title, /pattern\.dot/);
    assert.equal(preview.sourceMode, "ast");
    assert.equal(preview.labelStyle, "recursive");
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

    const baselineRenderNonce = currentPreviewRenderNonce();
    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState(undefined, { minRenderNonce: baselineRenderNonce + 1 });
    assert.match(preview.dot, /"q" -> "lhs"/);
    assert.match(preview.dot, /"q" -> "rhs"/);
  });

  test("manual preview on non-pattern rust scope is silent fail-open", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "println!(\"not a pattern");

    const baselineRenderNonce = currentPreviewRenderNonce();
    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(currentPreviewRenderNonce(), baselineRenderNonce);
    assert.equal(getPreviewPanelTestState(), undefined);
    assert.equal(warningMessages.length, 0);
  });

  test("manual preview on non-rust file does not invoke extractor", async () => {
    await openEditor(TEXT_FIXTURE);

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    assert.equal(warningMessages[0], "Eggplant pattern preview only runs for Rust files.");
  });

  test("auto preview coalesces rapid cursor updates into a single render", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await updateSettingAndWait("eggplantPattern.autoPreview", true);

    const baselineRenderNonce = currentPreviewRenderNonce();
    placeCursor(editor, "let l = Const::query");
    placeCursor(editor, "let r = Const::query");
    placeCursor(editor, "let p = Add::query");

    const preview = await waitForPreviewState(undefined, { minRenderNonce: baselineRenderNonce + 1 });
    assert.match(preview.dot, /"p" -> "r"/);
  });

  test("auto preview keeps editor focus while updating the panel", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await updateSettingAndWait("eggplantPattern.autoPreview", true);

    let baselineRenderNonce = currentPreviewRenderNonce();
    placeCursor(editor, "let p = Add::query");
    await waitForPreviewState(undefined, { minRenderNonce: baselineRenderNonce + 1 });
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), editor.document.uri.toString());

    baselineRenderNonce = currentPreviewRenderNonce();
    placeCursor(editor, "ctx.union(pat.p, op_value)");
    await waitForPreviewState((state) => state.mode === "action", { minRenderNonce: baselineRenderNonce + 1 });
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

  test("manual dot mode survives auto refresh at the same cursor position", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await updateSettingAndWait("eggplantPattern.autoPreview", true);
    placeCursor(editor, "ctx.union(pat.p, op_value)");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeMode", mode: "combined" });
    await waitForPreviewState((state) => state.mode === "combined");

    placeCursor(editor, "ctx.insert_m_integral(pat.f, pat.x)");

    const preview = await waitForPreviewState((state) => state.mode === "combined");
    assert.match(preview.title, /action \+ pattern\.dot/);
    assert.match(preview.dot, /cluster_actions/);
    assert.match(preview.dot, /"diff" -> "x"|\"diff\" -> \"f\"|\"p\" -> \"l\"/);
  });

  test("detail dropdown switches between compact and full labels", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.union(pat.p, op_value)");

    let baselineRenderNonce = currentPreviewRenderNonce();
    await vscode.commands.executeCommand("eggplant-pattern.preview");
    let preview = await waitForPreviewState(
      (state) => state.mode === "action" && /union\(p, op_value\)/.test(state.dot),
      { minRenderNonce: baselineRenderNonce + 1 }
    );
    assert.equal(preview.labelStyle, "recursive");
    assert.match(preview.dot, /union\(p, op_value\)/);

    baselineRenderNonce = preview.renderNonce ?? 0;
    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "full" });
    preview = await waitForPreviewState(
      (state) => state.labelStyle === "full",
      { minRenderNonce: baselineRenderNonce + 1 }
    );
    assert.match(preview.title, /full/);
    assert.match(preview.dot, /ctx\.union\(pat\.p, op_value\)/);
  });

  test("detail dropdown switches to recursive labels", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.insert_m_integral(pat.f, pat.x)");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "recursive" });

    const preview = await waitForPreviewState((state) => state.labelStyle === "recursive");
    assert.match(preview.title, /recursive, dag-expand/);
    assert.equal(preview.recursiveStrategy, "dag-expand");
  });

  test("source dropdown switches between AST and Trace while reusing detail controls", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.union(pat.p, op_value)");

    const sourceText = editor.document.getText();
    const start = sourceText.indexOf("ctx.union(pat.p, op_value)");
    const end = start + "ctx.union(pat.p, op_value)".length;
    const trace = {
      version: 1,
      events: [
        {
          Union: {
            event_id: "evt_0",
            effect_id: `effect@${start}:${end}`,
            lhs_debug: "pat.p",
            rhs_debug: "op_value"
          }
        }
      ]
    };
    await fs.promises.writeFile(TRACE_FIXTURE, JSON.stringify(trace, null, 2), "utf8");
    await updateSettingAndWait("eggplantPattern.actionSampleTracePath", TRACE_FIXTURE);

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await waitForPreviewState((state) => state.sourceMode === "ast");

    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "recursive" });
    await dispatchPreviewPanelTestMessage({ type: "changeSourceMode", sourceMode: "trace" });

    const preview = await waitForPreviewState(
      (state) => state.sourceMode === "trace" && state.labelStyle === "recursive"
    );
    assert.equal(preview.sourceMode, "trace");
    assert.equal(preview.labelStyle, "recursive");
    assert.equal(preview.recursiveStrategy, "dag-expand");
    assert.match(preview.recoverySummary ?? "", /source=trace/);
  });

  test("preview prefers typst templates when available", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.insert_m_integral(pat.f, pat.x)");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState((state) => state.mode === "action");
    assert.match(preview.dot, /f \/ x/);
    assert.ok(preview.typstRenderings["effect:effect_0"]);
  });

  test("compact preview replaces math_microbenchmark root nodes with typst svg", async () => {
    const editor = await openEditor(MATH_MICROBENCHMARK_FIXTURE);
    placeCursor(editor, "let mul = MMul::query(&a, &add);");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "compact" });

    const preview = await waitForPreviewState((state) => state.mode === "pattern" && state.labelStyle === "compact");
    assert.ok(preview.typstRenderings["add"]);
    assert.ok(preview.typstRenderings["mul"]);
    assert.match(preview.dot, /"mul" \[label="a \* add".*width=.*height=/);
  });

  test("compact preview keeps typst root rendering when a pattern leaf has a multi-letter name", async () => {
    const editor = await openEditor(ROOT_TYPST_FIXTURE);
    placeCursor(editor, "let integ = MIntegral::query(&one, &x);");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeMode", mode: "pattern" });
    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "compact" });

    const preview = await waitForPreviewState((state) => state.mode === "pattern" && state.labelStyle === "compact");
    assert.ok(preview.typstRenderings["integ"]);
    assert.match(preview.dot, /"integ" \[label="integral one quad d x".*width=.*height=/);
  });

  test("preview auto-discovers cross-file DSL metadata sources from the workspace", async () => {
    const editor = await openEditor(CROSS_FILE_METADATA_FIXTURE);
    placeCursor(editor, "let integ = SharedIntegral::query(&one, &x);");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeMode", mode: "pattern" });
    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "compact" });

    const preview = await waitForPreviewState((state) =>
      state.mode === "pattern"
      && state.labelStyle === "compact"
      && state.typstRenderings["integ"] !== undefined
    );
    assert.ok(preview.metadataSourceFiles.some((filePath) => filePath.endsWith("cross_file_metadata_defs.rs")));
    assert.equal(preview.metadataSourcesView.currentFile, editor.document.fileName);
    assert.ok(preview.metadataSourcesView.autoDiscovered.some((filePath) => filePath.endsWith("cross_file_metadata_defs.rs")));
    assert.deepEqual(preview.metadataSourcesView.manual, []);
    assert.ok(preview.metadataSourcesView.entries.some((entry) => entry.kind === "current" && entry.path === editor.document.fileName));
    assert.ok(preview.metadataSourcesView.entries.some((entry) => entry.kind === "auto" && entry.path.endsWith("cross_file_metadata_defs.rs")));
    assert.ok(preview.metadataSourcesView.effective.includes(editor.document.fileName));
    assert.ok(preview.metadataSourcesView.effective.some((filePath) => filePath.endsWith("cross_file_metadata_defs.rs")));
    assert.ok(preview.metadataSourcesView.effectiveEntries.some((entry) =>
      entry.path.endsWith("cross_file_metadata_defs.rs") && entry.kinds.includes("auto")
    ));
    assert.ok(preview.typstRenderings["integ"]);
    assert.match(preview.dot, /"integ" \[label="integral one quad d x".*width=.*height=/);
  });

  test("preview exposes effective metadata source viewer payload with current file", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "let p = Add::query");

    await vscode.commands.executeCommand("eggplant-pattern.preview");

    const preview = await waitForPreviewState((state) => state.mode === "pattern");
    assert.equal(preview.metadataSourcesView.currentFile, editor.document.fileName);
    assert.deepEqual(preview.metadataSourcesView.autoDiscovered, []);
    assert.deepEqual(preview.metadataSourcesView.manual, []);
    assert.deepEqual(preview.metadataSourcesView.effective, [editor.document.fileName]);
    assert.deepEqual(preview.metadataSourcesView.entries, [{ path: editor.document.fileName, kind: "current" }]);
    assert.deepEqual(preview.metadataSourcesView.effectiveEntries, [{ path: editor.document.fileName, kinds: ["current"] }]);
  });

  test("panel can clear external metadata source selections", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "let p = Add::query");

    let baselineRenderNonce = currentPreviewRenderNonce();
    await vscode.commands.executeCommand("eggplant-pattern.preview");
    let preview = await waitForPreviewState(undefined, { minRenderNonce: baselineRenderNonce + 1 });
    const baselineMetadataSourceFiles = [...preview.metadataSourceFiles];

    baselineRenderNonce = preview.renderNonce ?? 0;
    await dispatchPreviewPanelTestMessage({ type: "clearMetadataSources" });
    preview = await waitForPreviewState(undefined, { minRenderNonce: baselineRenderNonce + 1 });
    assert.deepEqual(preview.metadataSourceFiles, baselineMetadataSourceFiles);
  });

  test("recursive strategy dropdown switches between tree-safe and dag-expand", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.insert_m_integral(pat.f, pat.x)");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "recursive" });
    await dispatchPreviewPanelTestMessage({ type: "changeRecursiveStrategy", recursiveStrategy: "dag-expand" });

    const preview = await waitForPreviewState((state) => state.labelStyle === "recursive" && state.recursiveStrategy === "dag-expand");
    assert.match(preview.title, /recursive, dag-expand/);
  });

  test("auto preview keeps detail and recursive strategy across scope changes", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    await updateSettingAndWait("eggplantPattern.autoPreview", true);

    placeCursor(editor, "ctx.insert_m_integral(pat.f, pat.x)");
    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeLabelStyle", labelStyle: "recursive" });
    await dispatchPreviewPanelTestMessage({ type: "changeRecursiveStrategy", recursiveStrategy: "dag-expand" });
    await waitForPreviewState((state) => state.labelStyle === "recursive" && state.recursiveStrategy === "dag-expand");

    placeCursor(editor, "let p = Add::query");

    const preview = await waitForPreviewState(
      (state) => state.mode === "pattern" && state.labelStyle === "recursive" && state.recursiveStrategy === "dag-expand"
    );
    assert.match(preview.title, /recursive, dag-expand/);
  });

  test("preview node clicks reveal source ranges for pattern and action", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "MyTx::add_rule");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    let preview = await waitForPreviewState((state) => state.mode === "combined");
    assert.ok(preview.sourceTargetIds.includes("p"));
    assert.ok(preview.sourceTargetIds.includes("effect:effect_1"));
    assert.equal(/constraint:constraint_0/.test(preview.dot), false);
    assert.ok(preview.constraints.some((constraint) => constraint.id === "constraint_0"));

    await dispatchPreviewPanelTestMessage({ type: "clickSource", targetId: "p" });
    assert.equal(selectedText(editor), "let p = Add::query(&l, &r);");

    await dispatchPreviewPanelTestMessage({ type: "clickSource", targetId: "effect:effect_1" });
    assert.equal(selectedText(editor), "ctx.union(pat.p, op_value)");
  });

  test("constraint list click highlights referenced nodes and double click reveals source range", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "demo_assert_block");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    let preview = await waitForPreviewState((state) => state.mode === "combined" && state.constraints.length > 0);
    assert.equal(preview.activeConstraintId, null);
    assert.equal(preview.constraints[0].compactText, "l == r");
    assert.deepEqual(preview.constraintCountByNodeId, { l: 1, r: 1 });

    await dispatchPreviewPanelTestMessage({ type: "clickConstraint", constraintId: "constraint_0" });
    preview = await waitForPreviewState((state) => state.activeConstraintId === "constraint_0");
    assert.deepEqual(preview.activeConstraintNodeIds, ["l", "r"]);
    assert.deepEqual(
      preview.constraints.find((constraint) => constraint.id === "constraint_0")?.referencedNodeIds,
      ["l", "r"]
    );

    await dispatchPreviewPanelTestMessage({ type: "openConstraint", constraintId: "constraint_0" });
    assert.equal(selectedText(editor), "l_r_eq");
  });

  test("node drilldown switches the constraints panel into node-specific mode", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "demo_assert_block");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    let preview = await waitForPreviewState((state) => state.mode === "combined" && state.constraints.length > 0);
    assert.equal(preview.constraintFilterMode, "all");
    assert.equal(preview.constraintFilterNodeId, null);

    await dispatchPreviewPanelTestMessage({ type: "drilldownConstraintNode", targetId: "l" });
    preview = await waitForPreviewState((state) =>
      state.constraintFilterMode === "node-specific" && state.constraintFilterNodeId === "l"
    );
    assert.equal(preview.constraints.length, 1);
    assert.equal(preview.constraints[0].id, "constraint_0");

    await dispatchPreviewPanelTestMessage({ type: "changeConstraintFilter", constraintFilterMode: "all" });
    preview = await waitForPreviewState((state) => state.constraintFilterMode === "all");
    assert.equal(preview.constraintFilterNodeId, null);
    assert.ok(preview.constraints.some((constraint) => constraint.id === "constraint_0"));
  });

  test("node-specific filter stays selected with an empty state before a node is chosen", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "demo_assert_block");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    let preview = await waitForPreviewState((state) => state.mode === "combined" && state.constraints.length > 0);
    assert.equal(preview.constraintFilterMode, "all");

    await dispatchPreviewPanelTestMessage({ type: "changeConstraintFilter", constraintFilterMode: "node-specific" });
    preview = await waitForPreviewState((state) => state.constraintFilterMode === "node-specific");
    assert.equal(preview.constraintFilterNodeId, null);
    assert.deepEqual(preview.constraints, []);
  });

  test("trace source surfaces sampled action recovery summary and diagnostics", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.union(pat.p, op_value)");

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    const firstPreview = await waitForPreviewState((state) => state.mode === "action");
    const baselineRenderNonce = firstPreview.renderNonce ?? 0;
    const sourceText = editor.document.getText();
    const start = sourceText.indexOf("ctx.union(pat.p, op_value)");
    assert.notEqual(start, -1);
    const end = start + "ctx.union(pat.p, op_value)".length;
    const trace = {
      version: 1,
      events: [
        {
          Union: {
            event_id: "evt_0",
            effect_id: `effect@${start}:${end}`,
            lhs_debug: "pat.p",
            rhs_debug: "op_value"
          }
        },
        {
          DynamicUnknown: {
            event_id: "evt_1",
            effect_id: `effect@${start}:${end}`,
            reason: "branch not sampled"
          }
        }
      ]
    };
    await fs.promises.writeFile(TRACE_FIXTURE, JSON.stringify(trace, null, 2), "utf8");

    await updateSettingAndWait("eggplantPattern.experimentalDynamicActionRecovery", true);
    await updateSettingAndWait("eggplantPattern.dynamicActionRecoveryMode", "sample");
    await updateSettingAndWait("eggplantPattern.actionSampleTracePath", TRACE_FIXTURE);

    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeSourceMode", sourceMode: "trace" });
    const preview = await waitForPreviewState(
      (state) =>
        (state.renderNonce ?? 0) > baselineRenderNonce &&
        state.sourceMode === "trace" &&
        state.recoverySummary === "source=trace | events=2 | matched=2 | dynamic-unknown=1"
    );
    assert.equal(preview.recoverySummary, "source=trace | events=2 | matched=2 | dynamic-unknown=1");
    assert.equal(preview.recoveryDiagnostics.length, 1);
    assert.match(preview.recoveryDiagnostics[0], /dynamic-unknown at evt_1: branch not sampled/);
  });

  test("trace source stays selected and warns when trace input is unavailable", async () => {
    const editor = await openEditor(RUST_FIXTURE);
    placeCursor(editor, "ctx.union(pat.p, op_value)");

    await updateSettingAndWait("eggplantPattern.actionSampleTracePath", "");
    await vscode.commands.executeCommand("eggplant-pattern.preview");
    await dispatchPreviewPanelTestMessage({ type: "changeSourceMode", sourceMode: "trace" });

    const preview = await waitForPreviewState(
      (state) =>
        state.sourceMode === "trace" &&
        state.recoverySummary === "trace-unavailable" &&
        typeof state.sourceWarning === "string" &&
        state.sourceWarning.includes("trace-unavailable")
    );
    assert.equal(preview.sourceMode, "trace");
    assert.equal(preview.showSwitchToAst, true);
    assert.match(preview.sourceWarning ?? "", /trace-unavailable/);
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
  if (editor.selection.active.isEqual(position)) {
    const reset = new vscode.Position(0, 0);
    editor.selection = new vscode.Selection(reset, reset);
  }
  editor.selection = new vscode.Selection(position, position);
}

function selectedText(editor: vscode.TextEditor): string {
  return editor.document.getText(editor.selection);
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

async function waitForPreviewState(
  predicate?: (state: NonNullable<ReturnType<typeof getPreviewPanelTestState>>) => boolean,
  options?: { minRenderNonce?: number }
) {
  await waitFor(() => {
    const state = getPreviewPanelTestState();
    if (!state) {
      return false;
    }
    if ((state.renderNonce ?? 0) < (options?.minRenderNonce ?? 0)) {
      return false;
    }
    return predicate ? predicate(state) : true;
  });
  const state = getPreviewPanelTestState();
  assert.ok(state, "Expected preview panel state");
  return state;
}

function currentPreviewRenderNonce(): number {
  return getPreviewPanelTestState()?.renderNonce ?? 0;
}

async function updateSettingAndWait<T>(key: string, value: T): Promise<void> {
  await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
  await waitFor(() => vscode.workspace.getConfiguration().get<T>(key) === value);
}
