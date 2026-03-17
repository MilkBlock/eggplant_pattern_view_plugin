import * as vscode from "vscode";
import { patternIrToDot } from "./dot";
import { ExtractorError, runExtractor } from "./extractor";
import { PatternIr } from "./ir";

const GRAPHVIZ_PREVIEW_COMMAND = "graphviz-interactive-preview.preview.beside";

export function activate(context: vscode.ExtensionContext): void {
  const controller = new PreviewController();

  context.subscriptions.push(
    vscode.commands.registerCommand("eggplant-pattern.preview", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("Open a Rust editor to preview an eggplant pattern.");
        return;
      }
      if (editor.document.languageId !== "rust") {
        void vscode.window.showWarningMessage("Eggplant pattern preview only runs for Rust files.");
        return;
      }
      await controller.requestPreview(editor, true);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      controller.scheduleRefresh(event.textEditor);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document.uri.toString() === editor.document.uri.toString()) {
        controller.scheduleRefresh(editor);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      controller.scheduleRefresh(editor);
    })
  );
}

class PreviewController {
  private refreshTimer: NodeJS.Timeout | undefined;
  private running = false;
  private pending: PreviewRequest | undefined;
  private nextRequestId = 0;

  scheduleRefresh(editor?: vscode.TextEditor): void {
    const activeEditor = editor ?? vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.languageId !== "rust") {
      return;
    }
    if (!vscode.workspace.getConfiguration().get<boolean>("eggplantPattern.autoPreview", true)) {
      return;
    }

    const debounceMs = vscode.workspace.getConfiguration().get<number>("eggplantPattern.debounceMs", 200);
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      void this.requestPreview(activeEditor, false);
    }, debounceMs);
  }

  async requestPreview(editor: vscode.TextEditor, manual: boolean): Promise<void> {
    this.pending = {
      editor,
      manual,
      id: ++this.nextRequestId
    };

    if (!this.running) {
      await this.drainQueue();
    }
  }

  private async drainQueue(): Promise<void> {
    this.running = true;

    try {
      while (this.pending) {
        const request = this.pending;
        this.pending = undefined;
        await this.runRequest(request);
      }
    } finally {
      this.running = false;
    }
  }

  private async runRequest(request: PreviewRequest): Promise<void> {
    try {
      const offset = request.editor.document.offsetAt(request.editor.selection.active);
      const ir = await runExtractor(request.editor.document, offset);
      if (this.pending && this.pending.id > request.id) {
        return;
      }
      await renderDot(request.editor, ir);
    } catch (error) {
      if (this.pending && this.pending.id > request.id) {
        return;
      }

      const message = formatPreviewError(error);
      await renderNotice(request.editor, message);
      if (request.manual) {
        void vscode.window.showWarningMessage(`Eggplant pattern preview failed: ${message}`);
      }
    }
  }
}

async function renderDot(editor: vscode.TextEditor, ir: PatternIr): Promise<void> {
  const dot = patternIrToDot(ir);
  await showPreview(editor, dot);
}

async function renderNotice(editor: vscode.TextEditor, message: string): Promise<void> {
  const dot = [
    "digraph EggplantPatternStatus {",
    "  graph [pad=0.3];",
    "  node [shape=note, style=\"rounded,filled\", fillcolor=\"#fff4de\", color=\"#b26a00\", fontname=\"Helvetica\"];",
    `  status [label=${JSON.stringify(message)}];`,
    "}"
  ].join("\n");
  await showPreview(editor, dot);
}

async function showPreview(editor: vscode.TextEditor, content: string): Promise<void> {
  const title = `Eggplant Pattern: ${editor.document.fileName.split("/").pop() ?? "Preview"}`;
  await vscode.commands.executeCommand(GRAPHVIZ_PREVIEW_COMMAND, {
    document: editor.document,
    uri: editor.document.uri,
    content,
    title,
    allowMultiplePanels: false
  });
}

function formatPreviewError(error: unknown): string {
  if (error instanceof ExtractorError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

interface PreviewRequest {
  editor: vscode.TextEditor;
  manual: boolean;
  id: number;
}

export function deactivate(): void {}
