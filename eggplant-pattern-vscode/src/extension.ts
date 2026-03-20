import * as vscode from "vscode";
import { DotViewMode, patternIrToDotWithMode } from "./dot";
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
    vscode.commands.registerCommand("eggplant-pattern.selectDotView", async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: "pattern.dot", mode: "pattern" as DotViewMode },
          { label: "action.dot", mode: "action" as DotViewMode },
          { label: "action + pattern.dot", mode: "combined" as DotViewMode }
        ],
        { placeHolder: "Select DOT view mode for the current preview" }
      );
      if (picked) {
        await controller.showCurrentMode(picked.mode);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("eggplant-pattern.showPatternDot", async () => {
      await controller.showCurrentMode("pattern");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("eggplant-pattern.showActionDot", async () => {
      await controller.showCurrentMode("action");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("eggplant-pattern.showCombinedDot", async () => {
      await controller.showCurrentMode("combined");
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
  private lastAutoWarning: string | undefined;
  private lastPreview: LastPreview | undefined;

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
      id: ++this.nextRequestId,
      forcedMode: undefined
    };

    if (!this.running) {
      await this.drainQueue();
    }
  }

  async showCurrentMode(mode: DotViewMode): Promise<void> {
    if (this.lastPreview) {
      await renderDot(this.lastPreview.editor, this.lastPreview.ir, mode);
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open a Rust editor to preview an eggplant pattern.");
      return;
    }
    if (editor.document.languageId !== "rust") {
      void vscode.window.showWarningMessage("Eggplant pattern preview only runs for Rust files.");
      return;
    }

    this.pending = {
      editor,
      manual: true,
      id: ++this.nextRequestId,
      forcedMode: mode
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
      const mode = request.forcedMode ?? resolveDotViewMode(ir, offset);
      await renderDot(request.editor, ir, mode);
      this.lastPreview = {
        editor: request.editor,
        ir
      };
      this.lastAutoWarning = undefined;
    } catch (error) {
      if (this.pending && this.pending.id > request.id) {
        return;
      }

      const message = formatPreviewError(error);
      const suppressRepeatedAutoWarning = !request.manual && message === this.lastAutoWarning;
      const renderedNotice = await tryRenderNotice(request.editor, message);
      if (!suppressRepeatedAutoWarning && (request.manual || !renderedNotice)) {
        if (!request.manual) {
          this.lastAutoWarning = message;
        }
        void vscode.window.showWarningMessage(`Eggplant pattern preview failed: ${message}`);
      }
    }
  }
}

function containsOffset(range: { start: number; end: number } | null, offset: number): boolean {
  return range !== null && offset >= range.start && offset <= range.end;
}

function configuredDefaultDotView(): DotViewMode | "auto" {
  return vscode.workspace.getConfiguration().get<DotViewMode | "auto">(
    "eggplantPattern.defaultDotView",
    "auto"
  );
}

function resolveDotViewMode(ir: PatternIr, offset: number): DotViewMode {
  const configured = configuredDefaultDotView();
  if (configured !== "auto") {
    return configured;
  }
  if (ir.scope.kind === "pattern_function") {
    return "pattern";
  }
  if (containsOffset(ir.scope.action_range, offset)) {
    return "action";
  }
  if (containsOffset(ir.scope.pattern_range, offset)) {
    return "pattern";
  }
  return "combined";
}

async function renderDot(editor: vscode.TextEditor, ir: PatternIr, mode: DotViewMode): Promise<void> {
  const dot = patternIrToDotWithMode(ir, mode);
  await showPreview(editor, dot, mode);
}

async function renderNotice(editor: vscode.TextEditor, message: string): Promise<void> {
  const dot = [
    "digraph EggplantPatternStatus {",
    "  graph [pad=0.3];",
    "  node [shape=note, style=\"rounded,filled\", fillcolor=\"#fff4de\", color=\"#b26a00\", fontname=\"Helvetica\"];",
    `  status [label=${JSON.stringify(message)}];`,
    "}"
  ].join("\n");
  await showPreview(editor, dot, "combined");
}

async function tryRenderNotice(editor: vscode.TextEditor, message: string): Promise<boolean> {
  try {
    await renderNotice(editor, message);
    return true;
  } catch (error) {
    console.error("Eggplant pattern preview notice failed:", error);
    return false;
  }
}

function modeLabel(mode: DotViewMode): string {
  switch (mode) {
    case "pattern":
      return "pattern.dot";
    case "action":
      return "action.dot";
    case "combined":
      return "action + pattern.dot";
  }
}

async function showPreview(editor: vscode.TextEditor, content: string, mode: DotViewMode): Promise<void> {
  const previewCommand = vscode.workspace.getConfiguration().get<string>(
    "eggplantPattern.previewCommand",
    GRAPHVIZ_PREVIEW_COMMAND
  );
  const title = `Eggplant Pattern (${modeLabel(mode)}): ${editor.document.fileName.split("/").pop() ?? "Preview"}`;
  try {
    await vscode.commands.executeCommand(previewCommand, {
      document: editor.document,
      uri: editor.document.uri,
      content,
      title,
      allowMultiplePanels: false
    });
  } catch (error) {
    if (await isMissingCommandError(previewCommand)) {
      throw new PreviewHostUnavailableError(previewCommand);
    }
    throw error;
  }
}

function formatPreviewError(error: unknown): string {
  if (error instanceof PreviewHostUnavailableError) {
    return error.message;
  }
  if (error instanceof ExtractorError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

class PreviewHostUnavailableError extends Error {
  constructor(commandId: string) {
    const installHint = commandId === GRAPHVIZ_PREVIEW_COMMAND
      ? "Install the tintinweb.graphviz-interactive-preview VSCode extension or set eggplantPattern.previewCommand to a different preview command."
      : `Register or configure a different preview command than '${commandId}'.`;
    super(`Preview command '${commandId}' is unavailable. ${installHint}`);
  }
}

async function isMissingCommandError(commandId: string): Promise<boolean> {
  const availableCommands = await vscode.commands.getCommands(true);
  return !availableCommands.includes(commandId);
}

interface PreviewRequest {
  editor: vscode.TextEditor;
  manual: boolean;
  id: number;
  forcedMode: DotViewMode | undefined;
}

interface LastPreview {
  editor: vscode.TextEditor;
  ir: PatternIr;
}

export function deactivate(): void {}
