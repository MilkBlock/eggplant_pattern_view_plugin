import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { buildTraceSourcePreview, resolveDynamicActionRecoveryPolicy, summarizeRuntimeActionSampleTrace } from "./actionRecovery";
import { collectTypstReplacementSources, DotLabelStyle, DotViewMode, patternIrToDotWithMode, RecursiveStrategy } from "./dot";
import { configureExtractorResolution, ExtractorError, runExtractor } from "./extractor";
import { PatternIr } from "./ir";
import { clearMetadataSourceCache, loadMetadataSources, mergeExternalMetadata, pickMetadataSourceFiles } from "./metadataSources";
import { PreviewPanel, PreviewSourceMode } from "./previewPanel";
import { dotToSvg } from "./svg";
import { renderTypstSnippets } from "./typst";

export function activate(context: vscode.ExtensionContext): void {
  configureExtractorResolution(context.extensionPath);
  const controller = new PreviewController(context);

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
      await controller.requestPreview(editor, true, false);
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

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      void controller.handleConfigurationChange(event);
    })
  );
}

class PreviewController {
  private static readonly metadataSourceStateKey = "eggplantPattern.metadataSourceFiles";
  private refreshTimer: NodeJS.Timeout | undefined;
  private running = false;
  private pending: PreviewRequest | undefined;
  private nextRequestId = 0;
  private lastAutoWarning: string | undefined;
  private lastPreview: LastPreview | undefined;
  private currentModeOverride: DotViewMode | undefined;
  private currentSourceMode: PreviewSourceMode = "ast";
  private currentLabelStyle: DotLabelStyle;
  private currentRecursiveStrategy: RecursiveStrategy;
  private metadataSourceFiles: string[];
  private metadataWatchers: vscode.Disposable[] = [];
  private metadataRefreshTimer: NodeJS.Timeout | undefined;
  private readonly callbacks: {
    onModeChange: (mode: DotViewMode) => Promise<void>;
    onSourceModeChange: (sourceMode: PreviewSourceMode) => Promise<void>;
    onLabelStyleChange: (labelStyle: DotLabelStyle) => Promise<void>;
    onRecursiveStrategyChange: (strategy: RecursiveStrategy) => Promise<void>;
    onSourceClick: (targetId: string) => Promise<void>;
    onSelectMetadataSources: () => Promise<void>;
    onClearMetadataSources: () => Promise<void>;
    onRefresh: () => Promise<void>;
  };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.currentLabelStyle = configuredDefaultLabelStyle();
    this.currentRecursiveStrategy = configuredDefaultRecursiveStrategy();
    this.metadataSourceFiles = context.workspaceState.get<string[]>(PreviewController.metadataSourceStateKey, []);
    this.callbacks = {
      onModeChange: async (mode) => {
        await this.showCurrentMode(mode);
      },
      onLabelStyleChange: async (labelStyle) => {
        await this.showCurrentLabelStyle(labelStyle);
      },
      onSourceModeChange: async (sourceMode) => {
        await this.showCurrentSourceMode(sourceMode);
      },
      onRecursiveStrategyChange: async (strategy) => {
        await this.showCurrentRecursiveStrategy(strategy);
      },
      onSourceClick: async (targetId) => {
        await this.revealSourceTarget(targetId);
      },
      onSelectMetadataSources: async () => {
        await this.selectMetadataSources();
      },
      onClearMetadataSources: async () => {
        await this.clearMetadataSources();
      },
      onRefresh: async () => {
        const editor = this.lastPreview?.editor ?? vscode.window.activeTextEditor;
        if (editor) {
          await this.requestPreview(editor, true, true);
        }
      }
    };
    this.resetMetadataWatchers();
  }

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
      void this.requestPreview(activeEditor, false, true);
    }, debounceMs);
  }

  async requestPreview(editor: vscode.TextEditor, manual: boolean, preserveModeOverride: boolean): Promise<void> {
    if (!preserveModeOverride) {
      this.currentModeOverride = undefined;
    }
    this.panel(!manual);
    this.pending = {
      editor,
      manual,
      id: ++this.nextRequestId,
      forcedMode: preserveModeOverride ? this.currentModeOverride : undefined
    };

    if (!this.running) {
      await this.drainQueue();
    }
  }

  async showCurrentMode(mode: DotViewMode): Promise<void> {
    this.currentModeOverride = mode;
    if (this.lastPreview) {
      await this.renderLastPreview(
        this.lastPreview.editor,
        this.lastPreview.ir,
        mode,
        this.labelStyle(),
        this.recursiveStrategy(),
        true
      );
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

  async showCurrentLabelStyle(labelStyle: DotLabelStyle): Promise<void> {
    this.currentLabelStyle = labelStyle;
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.defaultLabelStyle",
      labelStyle,
      vscode.ConfigurationTarget.Workspace
    );

    if (this.lastPreview) {
      await this.renderLastPreview(this.lastPreview.editor, this.lastPreview.ir, this.currentMode(), labelStyle, this.currentRecursiveStrategy, true);
    }
  }

  async showCurrentSourceMode(sourceMode: PreviewSourceMode): Promise<void> {
    this.currentSourceMode = sourceMode;
    if (this.lastPreview) {
      await this.renderLastPreview(
        this.lastPreview.editor,
        this.lastPreview.ir,
        this.currentMode(),
        this.currentLabelStyle,
        this.currentRecursiveStrategy,
        true
      );
    }
  }

  async showCurrentRecursiveStrategy(strategy: RecursiveStrategy): Promise<void> {
    this.currentRecursiveStrategy = strategy;
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.defaultRecursiveStrategy",
      strategy,
      vscode.ConfigurationTarget.Workspace
    );

    if (this.lastPreview) {
      await this.renderLastPreview(this.lastPreview.editor, this.lastPreview.ir, this.currentMode(), this.currentLabelStyle, strategy, true);
    }
  }

  async handleConfigurationChange(event: vscode.ConfigurationChangeEvent): Promise<void> {
    if (
      !event.affectsConfiguration("eggplantPattern.experimentalDynamicActionRecovery") &&
      !event.affectsConfiguration("eggplantPattern.dynamicActionRecoveryMode") &&
      !event.affectsConfiguration("eggplantPattern.actionSampleTracePath")
    ) {
      return;
    }

    if (!PreviewPanel.current()) {
      return;
    }

    const editor = this.lastPreview?.editor ?? vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "rust") {
      return;
    }

    await this.requestPreview(editor, false, true);
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
      const extractedIr = await runExtractor(request.editor.document, offset);
      const externalMetadata = await loadMetadataSources(this.metadataSourceFiles);
      const ir = mergeExternalMetadata(extractedIr, externalMetadata);
      if (this.pending && this.pending.id > request.id) {
        return;
      }
      const mode = request.forcedMode ?? this.currentModeOverride ?? resolveDotViewMode(ir, offset);
      await this.renderLastPreview(request.editor, ir, mode, this.currentLabelStyle, this.currentRecursiveStrategy, !request.manual);
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
      const renderedNotice = await tryRenderNotice(this.panel(!request.manual), request.editor, message);
      if (!suppressRepeatedAutoWarning && (request.manual || !renderedNotice)) {
        if (!request.manual) {
          this.lastAutoWarning = message;
        }
        void vscode.window.showWarningMessage(`Eggplant pattern preview failed: ${message}`);
      }
    }
  }

  private panel(preserveFocus: boolean): PreviewPanel {
    return PreviewPanel.createOrShow(this.context.extensionUri, this.callbacks, preserveFocus);
  }

  private labelStyle(): DotLabelStyle {
    return this.currentLabelStyle;
  }

  private recursiveStrategy(): RecursiveStrategy {
    return this.currentRecursiveStrategy;
  }

  private currentMode(): DotViewMode {
    return this.currentModeOverride ?? PreviewPanel.current()?.snapshot()?.mode ?? "combined";
  }

  private async renderLastPreview(
    editor: vscode.TextEditor,
    baseIr: PatternIr,
    mode: DotViewMode,
    labelStyle: DotLabelStyle,
    recursiveStrategy: RecursiveStrategy,
    preserveFocus: boolean
  ): Promise<void> {
    const previewInput = await resolvePreviewInput(baseIr, this.currentSourceMode);
    if (previewInput.kind === "unavailable") {
      await renderTraceUnavailableNotice(
        this.panel(preserveFocus),
        editor,
        mode,
        this.currentSourceMode,
        labelStyle,
        recursiveStrategy,
        this.metadataSourceFiles,
        previewInput.message
      );
      return;
    }

    await renderDot(
      this.panel(preserveFocus),
      editor,
      previewInput.ir,
      mode,
      this.currentSourceMode,
      labelStyle,
      recursiveStrategy,
      this.metadataSourceFiles,
      previewInput.recoveryMetadata,
      previewInput.notice
    );
  }

  private async selectMetadataSources(): Promise<void> {
    const selected = await pickMetadataSourceFiles();
    if (!selected) {
      return;
    }
    this.metadataSourceFiles = Array.from(new Set(selected));
    await this.context.workspaceState.update(PreviewController.metadataSourceStateKey, this.metadataSourceFiles);
    clearMetadataSourceCache();
    this.resetMetadataWatchers();
    if (this.lastPreview) {
      await this.requestPreview(this.lastPreview.editor, true, true);
    }
  }

  private async clearMetadataSources(): Promise<void> {
    this.metadataSourceFiles = [];
    await this.context.workspaceState.update(PreviewController.metadataSourceStateKey, this.metadataSourceFiles);
    clearMetadataSourceCache();
    this.resetMetadataWatchers();
    if (this.lastPreview) {
      await this.requestPreview(this.lastPreview.editor, true, true);
    }
  }

  private async revealSourceTarget(targetId: string): Promise<void> {
    const preview = this.lastPreview;
    if (!preview) {
      return;
    }

    const span = resolveSourceSpan(preview.ir, targetId);
    if (!span) {
      return;
    }

    const document = preview.editor.document;
    const editor = await vscode.window.showTextDocument(document, preview.editor.viewColumn);
    const start = document.positionAt(span.start);
    const end = document.positionAt(span.end);
    const range = new vscode.Range(start, end);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private resetMetadataWatchers(): void {
    for (const watcher of this.metadataWatchers) {
      watcher.dispose();
    }
    this.metadataWatchers = [];

    for (const filePath of this.metadataSourceFiles) {
      const pattern = new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath));
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onChange = () => {
        clearMetadataSourceCache([filePath]);
        this.scheduleMetadataSourceRefresh();
      };
      this.metadataWatchers.push(
        watcher,
        watcher.onDidChange(onChange),
        watcher.onDidCreate(onChange),
        watcher.onDidDelete(onChange)
      );
    }
  }

  private scheduleMetadataSourceRefresh(): void {
    if (!this.lastPreview) {
      return;
    }
    const debounceMs = vscode.workspace.getConfiguration().get<number>("eggplantPattern.debounceMs", 200);
    if (this.metadataRefreshTimer) {
      clearTimeout(this.metadataRefreshTimer);
    }
    this.metadataRefreshTimer = setTimeout(() => {
      const editor = this.lastPreview?.editor;
      if (editor) {
        void this.requestPreview(editor, false, true);
      }
    }, debounceMs);
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

function configuredDefaultLabelStyle(): DotLabelStyle {
  return vscode.workspace.getConfiguration().get<DotLabelStyle>(
    "eggplantPattern.defaultLabelStyle",
    "recursive"
  );
}

function configuredDefaultRecursiveStrategy(): RecursiveStrategy {
  return vscode.workspace.getConfiguration().get<RecursiveStrategy>(
    "eggplantPattern.defaultRecursiveStrategy",
    "dag-expand"
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

async function renderDot(
  panel: PreviewPanel,
  editor: vscode.TextEditor,
  ir: PatternIr,
  mode: DotViewMode,
  sourceMode: PreviewSourceMode,
  labelStyle: DotLabelStyle,
  recursiveStrategy: RecursiveStrategy,
  metadataSourceFiles: string[],
  recoveryMetadata: ReturnType<typeof summarizeRuntimeActionSampleTrace> | null,
  notice: string | null
): Promise<void> {
  const typstRenderings = await renderTypstSnippets(
    collectTypstReplacementSources(ir, mode, labelStyle, recursiveStrategy)
  );
  const dot = patternIrToDotWithMode(ir, mode, labelStyle, recursiveStrategy, typstRenderings);
  const svg = await dotToSvg(dot);
  const strategySuffix = labelStyle === "recursive" ? `, ${recursiveStrategy}` : "";
  await panel.render({
    title: `Eggplant Pattern (${modeLabel(mode)}, ${sourceMode}, ${labelStyle}${strategySuffix}): ${editor.document.fileName.split("/").pop() ?? "Preview"}`,
    mode,
    sourceMode,
    labelStyle,
    recursiveStrategy,
    fileName: editor.document.fileName.split("/").pop() ?? "Preview",
    dot,
    svg,
    typstRenderings,
    sourceTargetIds: collectSourceTargetIds(ir, mode),
    metadataSourceFiles,
    recoverySummary: recoveryMetadata?.summary ?? null,
    recoveryDiagnostics: recoveryMetadata?.diagnostics.map((entry) => entry.message) ?? [],
    sourceWarning: null,
    showSwitchToAst: false,
    notice
  });
}

async function renderNotice(panel: PreviewPanel, editor: vscode.TextEditor, message: string): Promise<void> {
  const dot = [
    "digraph EggplantPatternStatus {",
    "  graph [pad=0.3];",
    "  node [shape=note, style=\"rounded,filled\", fillcolor=\"#fff4de\", color=\"#b26a00\", fontname=\"Helvetica\"];",
    `  status [label=${JSON.stringify(message)}];`,
    "}"
  ].join("\n");
  const svg = await dotToSvg(dot);
  await panel.render({
    title: `Eggplant Pattern (${modeLabel("combined")}, ${configuredDefaultLabelStyle()}): ${editor.document.fileName.split("/").pop() ?? "Preview"}`,
    mode: "combined",
    sourceMode: "ast",
    labelStyle: configuredDefaultLabelStyle(),
    recursiveStrategy: configuredDefaultRecursiveStrategy(),
    fileName: editor.document.fileName.split("/").pop() ?? "Preview",
    dot,
    svg,
    typstRenderings: {},
    sourceTargetIds: [],
    metadataSourceFiles: [],
    recoverySummary: null,
    recoveryDiagnostics: [],
    sourceWarning: null,
    showSwitchToAst: false,
    notice: message
  });
}

async function renderTraceUnavailableNotice(
  panel: PreviewPanel,
  editor: vscode.TextEditor,
  mode: DotViewMode,
  sourceMode: PreviewSourceMode,
  labelStyle: DotLabelStyle,
  recursiveStrategy: RecursiveStrategy,
  metadataSourceFiles: string[],
  message: string
): Promise<void> {
  const dot = [
    "digraph EggplantPatternStatus {",
    "  graph [pad=0.3];",
    "  node [shape=note, style=\"rounded,filled\", fillcolor=\"#fff4de\", color=\"#b26a00\", fontname=\"Helvetica\"];",
    `  status [label=${JSON.stringify(message)}];`,
    "}"
  ].join("\n");
  const svg = await dotToSvg(dot);
  await panel.render({
    title: `Eggplant Pattern (${modeLabel(mode)}, ${sourceMode}, ${labelStyle}${labelStyle === "recursive" ? `, ${recursiveStrategy}` : ""}): ${editor.document.fileName.split("/").pop() ?? "Preview"}`,
    mode,
    sourceMode,
    labelStyle,
    recursiveStrategy,
    fileName: editor.document.fileName.split("/").pop() ?? "Preview",
    dot,
    svg,
    typstRenderings: {},
    sourceTargetIds: [],
    metadataSourceFiles,
    recoverySummary: "trace-unavailable",
    recoveryDiagnostics: [message],
    sourceWarning: message,
    showSwitchToAst: true,
    notice: null
  });
}

async function tryRenderNotice(panel: PreviewPanel, editor: vscode.TextEditor, message: string): Promise<boolean> {
  try {
    await renderNotice(panel, editor, message);
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
  forcedMode: DotViewMode | undefined;
}

interface LastPreview {
  editor: vscode.TextEditor;
  ir: PatternIr;
}

function collectSourceTargetIds(ir: PatternIr, mode: DotViewMode): string[] {
  const targetIds: string[] = [];
  if (mode === "pattern" || mode === "combined") {
    for (const node of ir.nodes) {
      targetIds.push(node.id);
    }
    for (const constraint of ir.constraints) {
      targetIds.push(`constraint:${constraint.id}`);
    }
  }
  if (mode === "action" || mode === "combined") {
    for (const effect of ir.action_effects) {
      targetIds.push(`effect:${effect.id}`);
    }
    for (const fact of ir.seed_facts) {
      targetIds.push(`seed:${fact.id}`);
    }
  }
  return targetIds;
}

function resolveSourceSpan(ir: PatternIr, targetId: string): { start: number; end: number } | null {
  const node = ir.nodes.find((entry) => entry.id === targetId);
  if (node) {
    return node.range;
  }
  if (targetId.startsWith("constraint:")) {
    return ir.constraints.find((entry) => `constraint:${entry.id}` === targetId)?.range ?? null;
  }
  if (targetId.startsWith("effect:")) {
    return ir.action_effects.find((entry) => `effect:${entry.id}` === targetId)?.range ?? null;
  }
  if (targetId.startsWith("seed:")) {
    return ir.seed_facts.find((entry) => `seed:${entry.id}` === targetId)?.range ?? null;
  }
  return null;
}

async function loadActionRecoveryPreviewMetadata(
  ir: PatternIr
): Promise<ReturnType<typeof summarizeRuntimeActionSampleTrace> | null> {
  const policy = resolveDynamicActionRecoveryPolicy({
    enabled: vscode.workspace.getConfiguration().get<boolean>("eggplantPattern.experimentalDynamicActionRecovery", false),
    mode: vscode.workspace.getConfiguration().get<string>("eggplantPattern.dynamicActionRecoveryMode", "hybrid")
  });
  if (!policy.enabled || policy.mode === "static") {
    return null;
  }

  const tracePath = vscode.workspace.getConfiguration().get<string>("eggplantPattern.actionSampleTracePath", "").trim();
  if (tracePath.length === 0) {
    return null;
  }

  try {
    const raw = await fs.promises.readFile(tracePath, "utf8");
    return summarizeRuntimeActionSampleTrace(JSON.parse(raw), ir.action_effects);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      summary: "recovery=sample | trace-load-failed",
      diagnostics: [
        {
          severity: "warning",
          message: `sample trace load failed: ${message}`,
          source_range: null
        }
      ]
    };
  }
}

type PreviewInput =
  | {
      kind: "ready";
      ir: PatternIr;
      recoveryMetadata: ReturnType<typeof summarizeRuntimeActionSampleTrace> | null;
      notice: string | null;
    }
  | {
      kind: "unavailable";
      message: string;
    };

async function resolvePreviewInput(
  ir: PatternIr,
  sourceMode: PreviewSourceMode
): Promise<PreviewInput> {
  if (sourceMode === "ast") {
    return {
      kind: "ready",
      ir,
      recoveryMetadata: null,
      notice: null
    };
  }

  const tracePath = vscode.workspace.getConfiguration().get<string>("eggplantPattern.actionSampleTracePath", "").trim();
  if (tracePath.length === 0) {
    return {
      kind: "unavailable",
      message: "trace-unavailable: set eggplantPattern.actionSampleTracePath"
    };
  }

  try {
    const raw = await fs.promises.readFile(tracePath, "utf8");
    const tracePreview = buildTraceSourcePreview(JSON.parse(raw), ir.action_effects);
    if (!tracePreview) {
      return {
        kind: "unavailable",
        message: "trace-unavailable: trace payload is invalid"
      };
    }
    return {
      kind: "ready",
      ir: {
        ...ir,
        action_effects: tracePreview.actionEffects
      },
      recoveryMetadata: {
        summary: tracePreview.summary,
        diagnostics: tracePreview.diagnostics
      },
      notice: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "unavailable",
      message: `trace-unavailable: ${message}`
    };
  }
}

export function deactivate(): void {}
