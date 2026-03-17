import * as vscode from "vscode";
import { patternIrToDot } from "./dot";
import { runExtractor } from "./extractor";
import { PatternIr } from "./ir";

const GRAPHVIZ_PREVIEW_COMMAND = "graphviz-interactive-preview.preview.beside";

export function activate(context: vscode.ExtensionContext): void {
  let refreshTimer: NodeJS.Timeout | undefined;

  const triggerRefresh = (editor?: vscode.TextEditor): void => {
    const activeEditor = editor ?? vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.languageId !== "rust") {
      return;
    }
    if (!vscode.workspace.getConfiguration().get<boolean>("eggplantPattern.autoPreview", true)) {
      return;
    }
    const debounceMs = vscode.workspace.getConfiguration().get<number>("eggplantPattern.debounceMs", 200);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      void previewEditor(activeEditor);
    }, debounceMs);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("eggplant-pattern.preview", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await previewEditor(editor, true);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      triggerRefresh(event.textEditor);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document.uri.toString() === editor.document.uri.toString()) {
        triggerRefresh(editor);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      triggerRefresh(editor);
    })
  );
}

async function previewEditor(editor: vscode.TextEditor, manual = false): Promise<void> {
  try {
    const offset = editor.document.offsetAt(editor.selection.active);
    const ir = await runExtractor(editor.document, offset);
    await renderDot(editor, ir);
  } catch (error) {
    if (manual) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`Eggplant pattern preview failed: ${message}`);
    }
  }
}

async function renderDot(editor: vscode.TextEditor, ir: PatternIr): Promise<void> {
  const dot = patternIrToDot(ir);
  const title = `Eggplant Pattern: ${editor.document.fileName.split("/").pop() ?? "Preview"}`;
  await vscode.commands.executeCommand(GRAPHVIZ_PREVIEW_COMMAND, {
    document: editor.document,
    uri: editor.document.uri,
    content: dot,
    title,
    allowMultiplePanels: false
  });
}

export function deactivate(): void {}
