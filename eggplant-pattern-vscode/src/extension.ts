import * as vscode from "vscode";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { buildTraceSourcePreview, resolveDynamicActionRecoveryPolicy, summarizeRuntimeActionSampleTrace } from "./actionRecovery";
import { collectTypstReplacementSources, compactConstraintLabel, DotLabelStyle, DotViewMode, inlineConstraintAnnotation, patternIrToDotWithMode, RecursiveStrategy } from "./dot";
import { configureExtractorResolution, ExtractorError, runExtractor } from "./extractor";
import { PatternIr } from "./ir";
import { clearMetadataSourceCache, discoverWorkspaceMetadataSourceFiles, loadMetadataSources, mergeExternalMetadata, pickMetadataSourceFiles } from "./metadataSources";
import {
  PreviewConstraintFilterMode,
  PreviewMetadataSourceEntry,
  PreviewMetadataSourceKind,
  PreviewMetadataSourcesView,
  PreviewPanel,
  PreviewSourceMode,
  RecoveryUiMode
} from "./previewPanel";
import { dotToSvg } from "./svg";
import { renderTypstSnippets } from "./typst";

interface GitDotMetadata {
  branch: string;
  commit: string;
}

export function activate(context: vscode.ExtensionContext): void {
  configureExtractorResolution(context.extensionPath);
  const controller = new PreviewController(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("eggplant-pattern.preview", async () => {
      const editor = controller.previewEditor();
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
  private temporaryFullLabelPreview = false;
  private currentRecursiveStrategy: RecursiveStrategy;
  private metadataSourceFiles: string[];
  private autoMetadataSourceFiles: string[] = [];
  private activeConstraintId: string | null = null;
  private constraintFilterMode: PreviewConstraintFilterMode = "all";
  private constraintFilterNodeId: string | null = null;
  private metadataWatchers: vscode.Disposable[] = [];
  private metadataRefreshTimer: NodeJS.Timeout | undefined;
  private typstOverridesByTargetId: Record<string, string> = {};
  private readonly callbacks: {
    onModeChange: (mode: DotViewMode) => Promise<void>;
    onSourceModeChange: (sourceMode: PreviewSourceMode) => Promise<void>;
    onLabelStyleChange: (labelStyle: DotLabelStyle) => Promise<void>;
    onRecursiveStrategyChange: (strategy: RecursiveStrategy) => Promise<void>;
    onRecoveryModeChange: (mode: RecoveryUiMode) => Promise<void>;
    onSelectTraceFile: () => Promise<void>;
    onClearTraceFile: () => Promise<void>;
    onSourceClick: (targetId: string) => Promise<void>;
    onConstraintFilterChange: (mode: PreviewConstraintFilterMode) => Promise<void>;
    onConstraintNodeDrilldown: (targetId: string) => Promise<void>;
    onConstraintClick: (constraintId: string) => Promise<void>;
    onConstraintOpen: (constraintId: string) => Promise<void>;
    onSelectMetadataSources: () => Promise<void>;
    onClearMetadataSources: () => Promise<void>;
    onCopyDot: (dot: string) => Promise<void>;
    onCopyTypst: (source: string) => Promise<void>;
    onSaveTypstEdit: (targetId: string, source: string) => Promise<void>;
    onClearTypstEdit: (targetId: string) => Promise<void>;
    onTemporaryFullPreviewChange: (active: boolean) => Promise<void>;
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
      onRecoveryModeChange: async (mode) => {
        await this.showCurrentRecoveryMode(mode);
      },
      onSelectTraceFile: async () => {
        await this.selectActionSampleTraceFile();
      },
      onClearTraceFile: async () => {
        await this.clearActionSampleTraceFile();
      },
      onSourceClick: async (targetId) => {
        await this.revealSourceTarget(targetId);
      },
      onConstraintFilterChange: async (mode: PreviewConstraintFilterMode) => {
        await this.setConstraintFilterMode(mode);
      },
      onConstraintNodeDrilldown: async (targetId: string) => {
        await this.drilldownConstraintNode(targetId);
      },
      onConstraintClick: async (constraintId) => {
        await this.selectConstraint(constraintId);
      },
      onConstraintOpen: async (constraintId) => {
        await this.openConstraint(constraintId);
      },
      onSelectMetadataSources: async () => {
        await this.selectMetadataSources();
      },
      onClearMetadataSources: async () => {
        await this.clearMetadataSources();
      },
      onCopyDot: async (dot: string) => {
        if (!dot) {
          return;
        }
        await vscode.env.clipboard.writeText(dot);
        void vscode.window.setStatusBarMessage("Eggplant Pattern: copied DOT", 1500);
      },
      onCopyTypst: async (source: string) => {
        if (!source) {
          return;
        }
        await vscode.env.clipboard.writeText(source);
        void vscode.window.setStatusBarMessage("Eggplant Pattern: copied Typst", 1500);
      },
      onSaveTypstEdit: async (targetId: string, source: string) => {
        if (!targetId || !this.lastPreview) {
          return;
        }
        const trimmed = source.trim();
        if (trimmed.length === 0) {
          delete this.typstOverridesByTargetId[targetId];
        } else {
          this.typstOverridesByTargetId[targetId] = trimmed;
        }
        await this.renderLastPreview(
          this.lastPreview.editor,
          this.lastPreview.ir,
          this.currentMode(),
          this.labelStyle(),
          this.currentRecursiveStrategy,
          true
        );
      },
      onClearTypstEdit: async (targetId: string) => {
        if (!targetId || !this.lastPreview) {
          return;
        }
        delete this.typstOverridesByTargetId[targetId];
        await this.renderLastPreview(
          this.lastPreview.editor,
          this.lastPreview.ir,
          this.currentMode(),
          this.labelStyle(),
          this.currentRecursiveStrategy,
          true
        );
      },
      onTemporaryFullPreviewChange: async (active: boolean) => {
        await this.setTemporaryFullPreview(active);
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

  previewEditor(): vscode.TextEditor | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      return activeEditor;
    }
    if (this.lastPreview?.editor.document.languageId === "rust") {
      return this.lastPreview.editor;
    }
    return vscode.window.visibleTextEditors.find((editor) => editor.document.languageId === "rust");
  }

  async requestPreview(editor: vscode.TextEditor, manual: boolean, preserveModeOverride: boolean): Promise<void> {
    if (!preserveModeOverride) {
      this.currentModeOverride = undefined;
    }
    this.typstOverridesByTargetId = {};
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
    this.activeConstraintId = null;
    this.constraintFilterMode = "all";
    this.constraintFilterNodeId = null;
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

    const editor = this.previewEditor();
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
    this.temporaryFullLabelPreview = false;
    this.activeConstraintId = null;
    this.constraintFilterMode = "all";
    this.constraintFilterNodeId = null;
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
    this.activeConstraintId = null;
    this.constraintFilterMode = "all";
    this.constraintFilterNodeId = null;
    if (this.lastPreview) {
      await this.renderLastPreview(
        this.lastPreview.editor,
        this.lastPreview.ir,
        this.currentMode(),
        this.labelStyle(),
        this.currentRecursiveStrategy,
        true
      );
    }
  }

  async showCurrentRecursiveStrategy(strategy: RecursiveStrategy): Promise<void> {
    this.currentRecursiveStrategy = strategy;
    this.activeConstraintId = null;
    this.constraintFilterMode = "all";
    this.constraintFilterNodeId = null;
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.defaultRecursiveStrategy",
      strategy,
      vscode.ConfigurationTarget.Workspace
    );

    if (this.lastPreview) {
      await this.renderLastPreview(this.lastPreview.editor, this.lastPreview.ir, this.currentMode(), this.labelStyle(), strategy, true);
    }
  }

  async showCurrentRecoveryMode(mode: RecoveryUiMode): Promise<void> {
    if (mode === "off") {
      await vscode.workspace.getConfiguration().update(
        "eggplantPattern.experimentalDynamicActionRecovery",
        false,
        vscode.ConfigurationTarget.Workspace
      );
    } else {
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
    await this.refreshCurrentPreview();
  }

  private async selectActionSampleTraceFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
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

    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.actionSampleTracePath",
      picked[0].fsPath,
      vscode.ConfigurationTarget.Workspace
    );
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.experimentalDynamicActionRecovery",
      true,
      vscode.ConfigurationTarget.Workspace
    );
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.dynamicActionRecoveryMode",
      "sample",
      vscode.ConfigurationTarget.Workspace
    );
    await this.refreshCurrentPreview();
  }

  private async clearActionSampleTraceFile(): Promise<void> {
    await vscode.workspace.getConfiguration().update(
      "eggplantPattern.actionSampleTracePath",
      "",
      vscode.ConfigurationTarget.Workspace
    );
    await this.refreshCurrentPreview();
  }

  private async refreshCurrentPreview(): Promise<void> {
    const editor = this.lastPreview?.editor ?? vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "rust") {
      return;
    }
    await this.requestPreview(editor, true, true);
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
      const source = request.editor.document.getText();
      let extractedIr: PatternIr;
      try {
        extractedIr = await runExtractor(request.editor.document, offset);
      } catch (error) {
        const retried = await tryRuleCallOffsetFallback(request.editor.document, source, offset, error);
        if (!retried) {
          throw error;
        }
        extractedIr = retried;
      }
      if (shouldRetryEmptyPatternFunctionOnRuleLine(extractedIr, source, offset)) {
        const retried = await tryRuleCallOffsetFallback(request.editor.document, source, offset);
        if (retried) {
          extractedIr = retried;
        }
      }
      const requiredMetadataIdentifiers = collectMetadataIdentifiers(extractedIr);
      const autoMetadataSourceFiles = await discoverWorkspaceMetadataSourceFiles(
        request.editor.document.uri.fsPath,
        this.metadataSourceFiles,
        requiredMetadataIdentifiers
      );
      this.autoMetadataSourceFiles = autoMetadataSourceFiles;
      const allMetadataSourceFiles = Array.from(new Set([
        ...autoMetadataSourceFiles,
        ...this.metadataSourceFiles
      ]));
      const externalMetadata = await loadMetadataSources(allMetadataSourceFiles);
      const ir = mergeExternalMetadata(extractedIr, externalMetadata);
      if (this.pending && this.pending.id > request.id) {
        return;
      }
      const mode = request.forcedMode ?? this.currentModeOverride ?? resolveDotViewMode(ir, offset);
      await this.renderLastPreview(
        request.editor,
        ir,
        mode,
        this.labelStyle(),
        this.currentRecursiveStrategy,
        !request.manual,
        allMetadataSourceFiles
      );
      this.lastPreview = {
        editor: request.editor,
        ir
      };
      this.lastAutoWarning = undefined;
    } catch (error) {
      if (this.pending && this.pending.id > request.id) {
        return;
      }

      if (error instanceof ExtractorError && error.kind === "unsupported_scope") {
        // Fail-open for unsupported scopes: keep current preview untouched and stay silent.
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
    if (this.temporaryFullLabelPreview && this.currentLabelStyle !== "full") {
      return "full";
    }
    return this.currentLabelStyle;
  }

  private recursiveStrategy(): RecursiveStrategy {
    return this.currentRecursiveStrategy;
  }

  private currentMode(): DotViewMode {
    return this.currentModeOverride ?? PreviewPanel.current()?.snapshot()?.mode ?? "combined";
  }

  private async setTemporaryFullPreview(active: boolean): Promise<void> {
    const nextActive = active && this.currentLabelStyle !== "full";
    if (this.temporaryFullLabelPreview === nextActive) {
      return;
    }
    this.temporaryFullLabelPreview = nextActive;
    if (!this.lastPreview) {
      return;
    }
    await this.renderLastPreview(
      this.lastPreview.editor,
      this.lastPreview.ir,
      this.currentMode(),
      this.labelStyle(),
      this.currentRecursiveStrategy,
      true
    );
  }

  private async renderLastPreview(
    editor: vscode.TextEditor,
    baseIr: PatternIr,
    mode: DotViewMode,
    labelStyle: DotLabelStyle,
    recursiveStrategy: RecursiveStrategy,
    preserveFocus: boolean,
    metadataSourceFiles: string[] = Array.from(new Set([
      ...this.autoMetadataSourceFiles,
      ...this.metadataSourceFiles
    ]))
  ): Promise<void> {
    const allConstraintEntries = buildConstraintEntries(baseIr);
    const constraintEntries = buildConstraintEntries(baseIr);
    const constraintFilterNodeId = this.constraintFilterNodeId;
    if (
      this.constraintFilterMode === "node-specific"
      && constraintFilterNodeId
      && !constraintEntries.some((constraint) => constraint.referencedNodeIds.includes(constraintFilterNodeId))
    ) {
      this.constraintFilterMode = "all";
      this.constraintFilterNodeId = null;
    }
    const visibleConstraints = filterConstraintEntries(
      constraintEntries,
      this.constraintFilterMode,
      this.constraintFilterNodeId
    );
    if (!visibleConstraints.some((constraint) => constraint.id === this.activeConstraintId)) {
      this.activeConstraintId = null;
    }
    const metadataSourcesView = buildMetadataSourcesView(
      editor.document.fileName,
      this.autoMetadataSourceFiles,
      this.metadataSourceFiles
    );
    const previewInput = await resolvePreviewInput(baseIr, this.currentSourceMode);
    if (previewInput.kind === "unavailable") {
      await renderTraceUnavailableNotice(
        this.panel(preserveFocus),
        editor,
        mode,
        this.currentSourceMode,
        labelStyle,
        this.currentLabelStyle,
        recursiveStrategy,
        metadataSourceFiles,
        metadataSourcesView,
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
      this.currentLabelStyle,
      recursiveStrategy,
      metadataSourceFiles,
      metadataSourcesView,
      allConstraintEntries,
      constraintEntries,
      this.constraintFilterMode,
      this.constraintFilterNodeId,
      this.activeConstraintId,
      previewInput.recoveryMetadata,
      previewInput.notice,
      this.typstOverridesByTargetId
    );
  }

  private async selectConstraint(constraintId: string): Promise<void> {
    if (!this.lastPreview) {
      return;
    }
    this.activeConstraintId = this.activeConstraintId === constraintId ? null : constraintId;
    await this.renderLastPreview(
      this.lastPreview.editor,
      this.lastPreview.ir,
      this.currentMode(),
      this.labelStyle(),
      this.currentRecursiveStrategy,
      true
    );
  }

  private async setConstraintFilterMode(mode: PreviewConstraintFilterMode): Promise<void> {
    if (mode === this.constraintFilterMode) {
      return;
    }
    this.constraintFilterMode = mode;
    if (mode === "all") {
      this.constraintFilterNodeId = null;
    }
    if (!this.lastPreview) {
      return;
    }
    await this.renderLastPreview(
      this.lastPreview.editor,
      this.lastPreview.ir,
      this.currentMode(),
      this.labelStyle(),
      this.currentRecursiveStrategy,
      true
    );
  }

  private async drilldownConstraintNode(targetId: string): Promise<void> {
    if (!this.lastPreview) {
      return;
    }
    const visibleConstraints = buildConstraintEntries(this.lastPreview.ir)
      .filter((constraint) => constraint.referencedNodeIds.includes(targetId));
    this.constraintFilterMode = "node-specific";
    this.constraintFilterNodeId = targetId;
    if (!visibleConstraints.some((constraint) => constraint.id === this.activeConstraintId)) {
      this.activeConstraintId = null;
    }
    await this.renderLastPreview(
      this.lastPreview.editor,
      this.lastPreview.ir,
      this.currentMode(),
      this.labelStyle(),
      this.currentRecursiveStrategy,
      true
    );
  }

  private async openConstraint(constraintId: string): Promise<void> {
    await this.revealSourceTarget(`constraint:${constraintId}`);
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

function collectMetadataIdentifiers(ir: PatternIr): Set<string> {
  const localVariantNames = new Set<string>();
  for (const template of ir.display_templates) {
    localVariantNames.add(template.variant_name);
  }
  for (const template of ir.typst_templates) {
    localVariantNames.add(template.variant_name);
  }
  for (const template of ir.precedence_templates) {
    localVariantNames.add(template.variant_name);
  }

  const identifiers = new Set<string>();
  for (const node of ir.nodes) {
    if (!localVariantNames.has(node.dsl_type)) {
      identifiers.add(node.dsl_type);
    }
  }
  for (const effect of ir.action_effects) {
    const match = effect.source_text.match(/insert_([A-Za-z0-9_]+)\(/);
    if (!match?.[1]) {
      continue;
    }
    const variantName = match[1]
      .split("_")
      .filter((part) => part.length > 0)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("");
    if (variantName && !localVariantNames.has(variantName)) {
      identifiers.add(variantName);
    }
  }
  return identifiers;
}

function withGitDotMetadata(dot: string, filePath: string): string {
  const git = resolveGitDotMetadata(filePath);
  const header = [
    `// git.branch: ${git.branch}`,
    `// git.commit: ${git.commit}`
  ].join("\n");
  return `${header}\n${dot}`;
}

function resolveGitDotMetadata(filePath: string): GitDotMetadata {
  const repoRoot = resolveGitRepoRoot(filePath);
  if (!repoRoot) {
    return {
      branch: "unknown",
      commit: "unknown"
    };
  }
  const branch = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
  const commit = runGit(repoRoot, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
  return { branch, commit };
}

function resolveGitRepoRoot(filePath: string): string | null {
  const candidatePath = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);
  return runGit(candidatePath, ["rev-parse", "--show-toplevel"]);
}

function runGit(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const text = result.stdout.trim();
  return text.length > 0 ? text : null;
}

function containsOffset(range: { start: number; end: number } | null, offset: number): boolean {
  return range !== null && offset >= range.start && offset <= range.end;
}

function shouldRetryEmptyPatternFunctionOnRuleLine(ir: PatternIr, source: string, offset: number): boolean {
  if (ir.scope.kind !== "pattern_function") {
    return false;
  }
  if (ir.roots.length > 0 || ir.nodes.length > 0 || ir.action_effects.length > 0 || ir.constraints.length > 0) {
    return false;
  }
  return isNearRuleCallText(source, offset);
}

async function tryRuleCallOffsetFallback(
  document: vscode.TextDocument,
  source: string,
  offset: number,
  error?: unknown
): Promise<PatternIr | null> {
  if (error instanceof ExtractorError && error.kind !== "unsupported_scope") {
    return null;
  }
  if (!isNearRuleCallText(source, offset)) {
    return null;
  }
  for (const retryOffset of ruleCallRetryOffsets(source, offset)) {
    try {
      return await runExtractor(document, retryOffset);
    } catch (retryError) {
      if (!(retryError instanceof ExtractorError) || retryError.kind !== "unsupported_scope") {
        throw retryError;
      }
    }
  }
  return null;
}

function isNearRuleCallText(source: string, offset: number): boolean {
  const start = Math.max(0, offset - 96);
  const end = Math.min(source.length, offset + 192);
  return /add_rule(?:_with_hook)?/.test(source.slice(start, end));
}

function ruleCallRetryOffsets(source: string, offset: number): number[] {
  const searchStart = Math.max(0, offset - 96);
  const searchEnd = Math.min(source.length, offset + 1024);
  const windowText = source.slice(searchStart, searchEnd);
  const retries: number[] = [];
  const patternClosureIndex = windowText.indexOf("||");
  if (patternClosureIndex !== -1) {
    retries.push(searchStart + patternClosureIndex);
  }
  const actionClosureMatch = windowText.match(/\|\s*[A-Za-z_][A-Za-z0-9_]*\s*,/);
  if (actionClosureMatch?.index !== undefined) {
    retries.push(searchStart + actionClosureMatch.index);
  }
  return Array.from(new Set(retries.filter((candidate) => candidate !== offset)));
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

function configuredRecoveryUiMode(): RecoveryUiMode {
  const enabled = vscode.workspace.getConfiguration().get<boolean>(
    "eggplantPattern.experimentalDynamicActionRecovery",
    false
  );
  if (!enabled) {
    return "off";
  }
  const mode = vscode.workspace.getConfiguration().get<string>(
    "eggplantPattern.dynamicActionRecoveryMode",
    "hybrid"
  );
  if (mode === "static" || mode === "sample" || mode === "hybrid") {
    return mode;
  }
  return "hybrid";
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
  sourceMode: PreviewSourceMode,
  effectiveLabelStyle: DotLabelStyle,
  selectedLabelStyle: DotLabelStyle,
  recursiveStrategy: RecursiveStrategy,
  metadataSourceFiles: string[],
  metadataSourcesView: PreviewMetadataSourcesView,
  allConstraints: ReturnType<typeof buildConstraintEntries>,
  constraints: ReturnType<typeof buildConstraintEntries>,
  constraintFilterMode: PreviewConstraintFilterMode,
  constraintFilterNodeId: string | null,
  activeConstraintId: string | null,
  recoveryMetadata: ReturnType<typeof summarizeRuntimeActionSampleTrace> | null,
  notice: string | null,
  typstOverridesByTargetId: Record<string, string>
): Promise<void> {
  const typstSources = Object.fromEntries(
    collectTypstReplacementSources(ir, mode, effectiveLabelStyle, recursiveStrategy)
      .map((entry) => [entry.targetId, entry.source] as const)
  );
  for (const [targetId, source] of Object.entries(typstOverridesByTargetId)) {
    if (source.trim().length > 0 && targetId in typstSources) {
      typstSources[targetId] = source.trim();
    }
  }
  const typstRenderings = await renderTypstSnippets(
    Object.entries(typstSources).map(([targetId, source]) => ({ targetId, source }))
  );
  const typstStatusByTargetId = Object.fromEntries(
    Object.keys(typstSources).map((targetId) => {
      const rendering = typstRenderings[targetId];
      if (!rendering) {
        return [targetId, "Typst: failed"];
      }
      return [targetId, rendering.mode === "math" ? "Typst: rendered" : "Typst: fallback text"];
    })
  );
  for (const targetId of collectSourceTargetIds(ir, mode)) {
    if (!(targetId in typstStatusByTargetId)) {
      typstStatusByTargetId[targetId] = "Typst: no source";
    }
  }
  const dot = withGitDotMetadata(
    patternIrToDotWithMode(ir, mode, effectiveLabelStyle, recursiveStrategy, typstRenderings),
    editor.document.fileName
  );
  const svg = await dotToSvg(dot);
  const strategySuffix = effectiveLabelStyle === "recursive" ? `, ${recursiveStrategy}` : "";
  const visibleConstraints = filterConstraintEntries(constraints, constraintFilterMode, constraintFilterNodeId);
  const activeConstraint = visibleConstraints.find((constraint) => constraint.id === activeConstraintId) ?? null;
  await panel.render({
    title: `Eggplant Pattern (${modeLabel(mode)}, ${sourceMode}, ${effectiveLabelStyle}${strategySuffix}): ${editor.document.fileName.split("/").pop() ?? "Preview"}`,
    mode,
    sourceMode,
    recoveryMode: configuredRecoveryUiMode(),
    tracePath: configuredActionSampleTracePath(),
    labelStyle: selectedLabelStyle,
    effectiveLabelStyle,
    recursiveStrategy,
    fileName: editor.document.fileName.split("/").pop() ?? "Preview",
    dot,
    svg,
    typstRenderings,
    typstSources,
    typstStatusByTargetId,
    sourceTargetIds: collectSourceTargetIds(ir, mode),
    allConstraints,
    constraints: visibleConstraints,
    constraintCountByNodeId: buildConstraintCountByNodeId(constraints),
    constraintFilterMode,
    constraintFilterNodeId,
    activeConstraintId: activeConstraint?.id ?? null,
    activeConstraintNodeIds: activeConstraint?.referencedNodeIds ?? [],
    metadataSourceFiles,
    metadataSourcesView,
    recoverySummary: recoveryMetadata?.summary ?? null,
    recoveryDiagnostics: recoveryMetadata?.diagnostics.map((entry) => entry.message) ?? [],
    sourceWarning: null,
    showSwitchToAst: false,
    notice
  });
}

async function renderNotice(panel: PreviewPanel, editor: vscode.TextEditor, message: string): Promise<void> {
  const labelStyle = configuredDefaultLabelStyle();
  const dot = withGitDotMetadata([
    "digraph EggplantPatternStatus {",
    "  graph [pad=0.3];",
    "  node [shape=note, style=\"rounded,filled\", fillcolor=\"#fff4de\", color=\"#b26a00\", fontname=\"Iosevka\"];",
    `  status [label=${JSON.stringify(message)}];`,
    "}"
  ].join("\n"), editor.document.fileName);
  const svg = await dotToSvg(dot);
  await panel.render({
    title: `Eggplant Pattern (${modeLabel("combined")}, ${labelStyle}): ${editor.document.fileName.split("/").pop() ?? "Preview"}`,
    mode: "combined",
    sourceMode: "ast",
    recoveryMode: configuredRecoveryUiMode(),
    tracePath: configuredActionSampleTracePath(),
    labelStyle,
    effectiveLabelStyle: labelStyle,
    recursiveStrategy: configuredDefaultRecursiveStrategy(),
    fileName: editor.document.fileName.split("/").pop() ?? "Preview",
    dot,
    svg,
    typstRenderings: {},
    typstSources: {},
    typstStatusByTargetId: {},
    sourceTargetIds: [],
    allConstraints: [],
    constraints: [],
    constraintCountByNodeId: {},
    constraintFilterMode: "all",
    constraintFilterNodeId: null,
    activeConstraintId: null,
    activeConstraintNodeIds: [],
    metadataSourceFiles: [],
    metadataSourcesView: {
      currentFile: editor.document.fileName,
      autoDiscovered: [],
      manual: [],
      effective: [editor.document.fileName],
      entries: [{ path: editor.document.fileName, kind: "current" }],
      effectiveEntries: [{ path: editor.document.fileName, kinds: ["current"] }]
    },
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
  effectiveLabelStyle: DotLabelStyle,
  selectedLabelStyle: DotLabelStyle,
  recursiveStrategy: RecursiveStrategy,
  metadataSourceFiles: string[],
  metadataSourcesView: PreviewMetadataSourcesView,
  message: string
): Promise<void> {
  const dot = withGitDotMetadata([
    "digraph EggplantPatternStatus {",
    "  graph [pad=0.3];",
    "  node [shape=note, style=\"rounded,filled\", fillcolor=\"#fff4de\", color=\"#b26a00\", fontname=\"Iosevka\"];",
    `  status [label=${JSON.stringify(message)}];`,
    "}"
  ].join("\n"), editor.document.fileName);
  const svg = await dotToSvg(dot);
  await panel.render({
    title: `Eggplant Pattern (${modeLabel(mode)}, ${sourceMode}, ${effectiveLabelStyle}${effectiveLabelStyle === "recursive" ? `, ${recursiveStrategy}` : ""}): ${editor.document.fileName.split("/").pop() ?? "Preview"}`,
    mode,
    sourceMode,
    recoveryMode: configuredRecoveryUiMode(),
    tracePath: configuredActionSampleTracePath(),
    labelStyle: selectedLabelStyle,
    effectiveLabelStyle,
    recursiveStrategy,
    fileName: editor.document.fileName.split("/").pop() ?? "Preview",
    dot,
    svg,
    typstRenderings: {},
    typstSources: {},
    typstStatusByTargetId: {},
    sourceTargetIds: [],
    allConstraints: [],
    constraints: buildConstraintEntries(irlessPatternIr()),
    constraintCountByNodeId: {},
    constraintFilterMode: "all",
    constraintFilterNodeId: null,
    activeConstraintId: null,
    activeConstraintNodeIds: [],
    metadataSourceFiles,
    metadataSourcesView,
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

function buildConstraintEntries(
  ir: PatternIr,
  options: { includeInlineHidden?: boolean } = {}
): Array<{ id: string; compactText: string; fullText: string; sourceText: string; referencedNodeIds: string[] }> {
  const nodeIds = new Set(ir.nodes.map((node) => node.id));
  const rootIds = new Set(ir.roots);
  return ir.constraints
    .filter((constraint) => options.includeInlineHidden || inlineConstraintAnnotation(constraint)?.hideInSidebar !== true)
    .map((constraint) => ({
      id: constraint.id,
      compactText: compactConstraintLabel(constraint.source_text, constraint.resolved_text),
      fullText: constraint.resolved_text,
      sourceText: constraint.source_text,
      referencedNodeIds: (() => {
        const referenced = constraint.referenced_vars.filter((name) => nodeIds.has(name) || rootIds.has(name));
        return referenced.length > 0 ? referenced : [...ir.roots];
      })()
    }));
}

function filterConstraintEntries(
  constraints: Array<{ id: string; compactText: string; fullText: string; sourceText: string; referencedNodeIds: string[] }>,
  mode: PreviewConstraintFilterMode,
  nodeId: string | null
): Array<{ id: string; compactText: string; fullText: string; sourceText: string; referencedNodeIds: string[] }> {
  if (mode !== "node-specific") {
    return constraints;
  }
  if (!nodeId) {
    return [];
  }
  return constraints.filter((constraint) => constraint.referencedNodeIds.includes(nodeId));
}

function buildConstraintCountByNodeId(
  constraints: Array<{ id: string; compactText: string; fullText: string; sourceText: string; referencedNodeIds: string[] }>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const constraint of constraints) {
    for (const nodeId of constraint.referencedNodeIds) {
      counts[nodeId] = (counts[nodeId] ?? 0) + 1;
    }
  }
  return counts;
}

function irlessPatternIr(): PatternIr {
  return {
    scope: {
      kind: "pattern_function",
      text_range: { start: 0, end: 0 },
      pattern_range: null,
      action_range: null
    },
    nodes: [],
    edges: [],
    roots: [],
    constraints: [],
    action_effects: [],
    seed_facts: [],
    display_templates: [],
    typst_templates: [],
    precedence_templates: [],
    diagnostics: []
  };
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

function buildMetadataSourcesView(
  currentFile: string,
  autoMetadataSourceFiles: string[],
  manualMetadataSourceFiles: string[]
): PreviewMetadataSourcesView {
  const autoDiscovered = Array.from(new Set(autoMetadataSourceFiles));
  const manual = Array.from(new Set(manualMetadataSourceFiles));
  const entries: PreviewMetadataSourceEntry[] = [
    { path: currentFile, kind: "current" },
    ...autoDiscovered.map((filePath) => ({ path: filePath, kind: "auto" as const })),
    ...manual.map((filePath) => ({ path: filePath, kind: "manual" as const }))
  ];
  const effectiveKinds = new Map<string, Set<PreviewMetadataSourceKind>>();
  for (const entry of entries) {
    const kinds = effectiveKinds.get(entry.path) ?? new Set<PreviewMetadataSourceKind>();
    kinds.add(entry.kind);
    effectiveKinds.set(entry.path, kinds);
  }
  const effectiveEntries = Array.from(effectiveKinds.entries()).map(([filePath, kinds]) => ({
    path: filePath,
    kinds: Array.from(kinds)
  }));
  const effective = effectiveEntries.map((entry) => entry.path);
  return {
    currentFile,
    autoDiscovered,
    manual,
    effective,
    entries,
    effectiveEntries
  };
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
