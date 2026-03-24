import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ActionRecoveryMode, ActionRecoveryPreviewMetadata, summarizeRuntimeActionSampleTrace } from "./actionRecovery";
import { collectTypstReplacementSources, DotLabelStyle, DotViewMode, patternIrToDotWithMode, RecursiveStrategy } from "./dot";
import { configureExtractorResolution, ExtractorError, runExtractor } from "./extractor";
import { PatternIr } from "./ir";
import { clearMetadataSourceCache, loadMetadataSources, mergeExternalMetadata, pickMetadataSourceFiles } from "./metadataSources";
import { PreviewPanel, RecoveryUiMode } from "./previewPanel";
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
  private currentLabelStyle: DotLabelStyle;
  private currentRecursiveStrategy: RecursiveStrategy;
  private currentRecoveryEnabled: boolean;
  private currentRecoveryMode: ActionRecoveryMode;
  private actionSampleTracePath: string;
  private metadataSourceFiles: string[];
  private metadataWatchers: vscode.Disposable[] = [];
  private metadataRefreshTimer: NodeJS.Timeout | undefined;
  private readonly callbacks: {
    onModeChange: (mode: DotViewMode) => Promise<void>;
    onLabelStyleChange: (labelStyle: DotLabelStyle) => Promise<void>;
    onRecursiveStrategyChange: (strategy: RecursiveStrategy) => Promise<void>;
    onRecoveryModeChange: (mode: RecoveryUiMode) => Promise<void>;
    onSelectTraceFile: (filePath?: string) => Promise<void>;
    onClearTraceFile: () => Promise<void>;
    onSelectMetadataSources: () => Promise<void>;
    onClearMetadataSources: () => Promise<void>;
    onRefresh: () => Promise<void>;
  };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.currentLabelStyle = configuredDefaultLabelStyle();
    this.currentRecursiveStrategy = configuredDefaultRecursiveStrategy();
    this.currentRecoveryEnabled = configuredRecoveryEnabled();
    this.currentRecoveryMode = configuredRecoveryMode();
    this.actionSampleTracePath = configuredActionSampleTracePath();
    this.metadataSourceFiles = context.workspaceState.get<string[]>(PreviewController.metadataSourceStateKey, []);
    this.callbacks = {
      onModeChange: async (mode) => {
        await this.showCurrentMode(mode);
      },
      onLabelStyleChange: async (labelStyle) => {
        await this.showCurrentLabelStyle(labelStyle);
      },
      onRecursiveStrategyChange: async (strategy) => {
        await this.showCurrentRecursiveStrategy(strategy);
      },
      onRecoveryModeChange: async (mode) => {
        await this.showCurrentRecoveryMode(mode);
      },
      onSelectTraceFile: async (filePath) => {
        await this.selectActionSampleTraceFile(filePath);
      },
      onClearTraceFile: async () => {
        await this.clearActionSampleTraceFile();
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
      await renderDot(this.panel(true), this.lastPreview.editor, this.lastPreview.ir, mode, this.labelStyle(), this.recursiveStrategy(), this.metadataSourceFiles, this.currentRecoveryConfig(), null);
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
      await renderDot(
        this.panel(true),
        this.lastPreview.editor,
        this.lastPreview.ir,
        this.currentMode(),
        labelStyle,
        this.currentRecursiveStrategy,
        this.metadataSourceFiles,
        this.currentRecoveryConfig(),
        null
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
      await renderDot(
        this.panel(true),
        this.lastPreview.editor,
        this.lastPreview.ir,
        this.currentMode(),
        this.currentLabelStyle,
        strategy,
        this.metadataSourceFiles,
        this.currentRecoveryConfig(),
        null
      );
    }
  }

  async showCurrentRecoveryMode(mode: RecoveryUiMode): Promise<void> {
    if (mode === "off") {
      this.currentRecoveryEnabled = false;
      await vscode.workspace.getConfiguration().update(
        "eggplantPattern.experimentalDynamicActionRecovery",
        false,
        vscode.ConfigurationTarget.Workspace
      );
    } else {
      this.currentRecoveryEnabled = true;
      this.currentRecoveryMode = mode;
      await vscode.workspace.getConfiguration().update(
        "eggplantPattern.experimentalDynamicActionRecovery",
        true,
        vscode.ConfigurationTarget.Workspace
      );
      await vscode.workspace.getConfiguration().update(
        "eggplantPattern.dynamicActionRecoveryMode",
        mode,
        vscode.ConfigurationTarget.Workspace
      );
    }

    if (this.lastPreview) {
      await renderDot(
        this.panel(true),
        this.lastPreview.editor,
        this.lastPreview.ir,
        this.currentMode(),
        this.currentLabelStyle,
        this.currentRecursiveStrategy,
        this.metadataSourceFiles,
        this.currentRecoveryConfig(),
        null
      );
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
      const extractedIr = await runExtractor(request.editor.document, offset);
      const externalMetadata = await loadMetadataSources(this.metadataSourceFiles);
      const ir = mergeExternalMetadata(extractedIr, externalMetadata);
      if (this.pending && this.pending.id > request.id) {
        return;
      }
      const mode = request.forcedMode ?? this.currentModeOverride ?? resolveDotViewMode(ir, offset);
      await renderDot(this.panel(!request.manual), request.editor, ir, mode, this.currentLabelStyle, this.currentRecursiveStrategy, this.metadataSourceFiles, this.currentRecoveryConfig(), null);
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

  private currentRecoveryConfig(): RecoveryConfig {
    return {
      enabled: this.currentRecoveryEnabled,
      mode: this.currentRecoveryMode,
      tracePath: this.actionSampleTracePath
    };
  }

  private currentMode(): DotViewMode {
    return this.currentModeOverride ?? PreviewPanel.current()?.snapshot()?.mode ?? "combined";
  }

  private async selectActionSampleTraceFile(selectedPath?: string): Promise<void> {
    let tracePath = selectedPath?.trim() ?? "";
    if (tracePath.length === 0) {
      const testDialog = (globalThis as { __eggplantPatternTraceSelectionDialog?: typeof vscode.window.showOpenDialog })
        .__eggplantPatternTraceSelectionDialog;
      const picked = await (testDialog ?? vscode.window.showOpenDialog)({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Select Action Trace",
        filters: {
          JSON: ["json"]
        }
      });
      if (!picked || picked.length === 0) {
        return;
      }
      tracePath = picked[0].fsPath;
    }

    const nextRecoveryMode = this.nextTraceEnabledRecoveryMode();
    this.currentRecoveryEnabled = true;
    this.currentRecoveryMode = nextRecoveryMode;
    this.actionSampleTracePath = tracePath;
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.actionSampleTracePath",
      this.actionSampleTracePath,
      vscode.ConfigurationTarget.Workspace
    );
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.experimentalDynamicActionRecovery",
      true,
      vscode.ConfigurationTarget.Workspace
    );
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.dynamicActionRecoveryMode",
      nextRecoveryMode,
      vscode.ConfigurationTarget.Workspace
    );

    await this.refreshRecoveryPreview();
  }

  private nextTraceEnabledRecoveryMode(): ActionRecoveryMode {
    return "sample";
  }

  private async clearActionSampleTraceFile(): Promise<void> {
    this.actionSampleTracePath = "";
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.actionSampleTracePath",
      "",
      vscode.ConfigurationTarget.Workspace
    );

    await this.refreshRecoveryPreview();
  }

  private async refreshRecoveryPreview(): Promise<void> {
    const editor = this.lastPreview?.editor ?? vscode.window.activeTextEditor;
    if (editor?.document.languageId === "rust") {
      await this.requestPreview(editor, true, true);
    }
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

  async handleConfigurationChange(event: vscode.ConfigurationChangeEvent): Promise<void> {
    if (
      !event.affectsConfiguration("eggplantPattern.experimentalDynamicActionRecovery") &&
      !event.affectsConfiguration("eggplantPattern.dynamicActionRecoveryMode") &&
      !event.affectsConfiguration("eggplantPattern.actionSampleTracePath")
    ) {
      return;
    }

    this.currentRecoveryEnabled = configuredRecoveryEnabled();
    this.currentRecoveryMode = configuredRecoveryMode();
    this.actionSampleTracePath = configuredActionSampleTracePath();

    if (this.lastPreview) {
      await this.requestPreview(this.lastPreview.editor, false, true);
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

function configuredRecoveryEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(
    "eggplantPattern.experimentalDynamicActionRecovery",
    false
  );
}

function configuredRecoveryMode(): ActionRecoveryMode {
  return vscode.workspace.getConfiguration().get<ActionRecoveryMode>(
    "eggplantPattern.dynamicActionRecoveryMode",
    "hybrid"
  );
}

function configuredActionSampleTracePath(): string {
  return vscode.workspace.getConfiguration().get<string>(
    "eggplantPattern.actionSampleTracePath",
    ""
  ).trim();
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
  labelStyle: DotLabelStyle,
  recursiveStrategy: RecursiveStrategy,
  metadataSourceFiles: string[],
  recoveryConfig: RecoveryConfig,
  notice: string | null
): Promise<void> {
  const recoveryMetadata = await loadActionRecoveryPreviewMetadata(ir, recoveryConfig);
  const actionOverrides = recoveryMetadata?.graphOverride
    ? {
        effectLabels: recoveryMetadata.graphOverride.effectLabels,
        visibleEffectIds: recoveryMetadata.graphOverride.visibleEffectIds
          ? new Set(recoveryMetadata.graphOverride.visibleEffectIds)
          : null
      }
    : {};
  const typstRenderings = await renderTypstSnippets(
    collectTypstReplacementSources(ir, mode, labelStyle, recursiveStrategy, actionOverrides)
  );
  const dot = patternIrToDotWithMode(ir, mode, labelStyle, recursiveStrategy, typstRenderings, actionOverrides);
  const svg = await dotToSvg(dot);
  const strategySuffix = labelStyle === "recursive" ? `, ${recursiveStrategy}` : "";
  await panel.render({
    title: `Eggplant Pattern (${modeLabel(mode)}, ${labelStyle}${strategySuffix}): ${editor.document.fileName.split("/").pop() ?? "Preview"}`,
    mode,
    labelStyle,
    recursiveStrategy,
    recoveryMode: recoveryConfig.enabled ? recoveryConfig.mode : "off",
    tracePath: recoveryConfig.tracePath,
    recoverySummary: recoveryMetadata?.summary ?? null,
    recoveryDiagnostics: recoveryMetadata?.diagnostics.map((entry) => entry.message) ?? [],
    fileName: editor.document.fileName.split("/").pop() ?? "Preview",
    dot,
    svg,
    typstRenderings,
    metadataSourceFiles,
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
    labelStyle: configuredDefaultLabelStyle(),
    recursiveStrategy: configuredDefaultRecursiveStrategy(),
    recoveryMode: configuredRecoveryEnabled() ? configuredRecoveryMode() : "off",
    tracePath: configuredActionSampleTracePath(),
    recoverySummary: null,
    recoveryDiagnostics: [],
    fileName: editor.document.fileName.split("/").pop() ?? "Preview",
    dot,
    svg,
    typstRenderings: {},
    metadataSourceFiles: [],
    notice: message
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

async function loadActionRecoveryPreviewMetadata(
  ir: PatternIr,
  recovery: RecoveryConfig
): Promise<ActionRecoveryPreviewMetadata | null> {
  if (!recovery.enabled) {
    return null;
  }

  if (recovery.mode === "static") {
    return {
      summary: "recovery=static",
      diagnostics: [],
      graphOverride: {
        effectLabels: {},
        visibleEffectIds: null
      }
    };
  }

  if (!recovery.tracePath) {
    return {
      summary: `recovery=${recovery.mode} | trace-missing`,
      graphOverride: {
        effectLabels: {},
        visibleEffectIds: null
      },
      diagnostics: [
        {
          severity: "warning",
          message: "trace path is empty",
          source_range: null
        }
      ]
    };
  }

  try {
    const raw = await fs.promises.readFile(recovery.tracePath, "utf8");
    const parsed = summarizeRuntimeActionSampleTrace(JSON.parse(raw), ir.action_effects, recovery.mode);
    if (parsed) {
      return parsed;
    }
    return {
      summary: `recovery=${recovery.mode} | trace-invalid`,
      graphOverride: {
        effectLabels: {},
        visibleEffectIds: null
      },
      diagnostics: [
        {
          severity: "warning",
          message: "trace file is not a valid action sample trace JSON",
          source_range: null
        }
      ]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      summary: `recovery=${recovery.mode} | trace-load-failed`,
      graphOverride: {
        effectLabels: {},
        visibleEffectIds: null
      },
      diagnostics: [
        {
          severity: "warning",
          message,
          source_range: null
        }
      ]
    };
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

interface RecoveryConfig {
  enabled: boolean;
  mode: ActionRecoveryMode;
  tracePath: string;
}

export function deactivate(): void {}
