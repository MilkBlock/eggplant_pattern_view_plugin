import * as vscode from "vscode";
import { DotLabelStyle, DotViewMode, RecursiveStrategy } from "./dot";
import { RenderedTypstSnippet } from "./typst";

export type PreviewSourceMode = "ast" | "trace";
export type PreviewConstraintFilterMode = "all" | "node-specific";

export type PreviewMetadataSourceKind = "current" | "auto" | "manual";

export interface PreviewMetadataSourceEntry {
  path: string;
  kind: PreviewMetadataSourceKind;
}

export interface PreviewMetadataEffectiveSourceEntry {
  path: string;
  kinds: PreviewMetadataSourceKind[];
}

export interface PreviewMetadataSourcesView {
  currentFile: string;
  autoDiscovered: string[];
  manual: string[];
  effective: string[];
  entries: PreviewMetadataSourceEntry[];
  effectiveEntries: PreviewMetadataEffectiveSourceEntry[];
}

export interface PreviewConstraintEntry {
  id: string;
  compactText: string;
  fullText: string;
  referencedNodeIds: string[];
}

export interface PreviewPanelState {
  renderNonce?: number;
  title: string;
  mode: DotViewMode;
  sourceMode: PreviewSourceMode;
  labelStyle: DotLabelStyle;
  recursiveStrategy: RecursiveStrategy;
  fileName: string;
  dot: string;
  svg: string;
  typstRenderings: Record<string, RenderedTypstSnippet>;
  sourceTargetIds: string[];
  constraints: PreviewConstraintEntry[];
  constraintCountByNodeId: Record<string, number>;
  constraintFilterMode: PreviewConstraintFilterMode;
  constraintFilterNodeId: string | null;
  activeConstraintId: string | null;
  activeConstraintNodeIds: string[];
  metadataSourceFiles: string[];
  metadataSourcesView: PreviewMetadataSourcesView;
  recoverySummary: string | null;
  recoveryDiagnostics: string[];
  sourceWarning: string | null;
  showSwitchToAst: boolean;
  notice: string | null;
}

interface PreviewPanelCallbacks {
  onModeChange(mode: DotViewMode): Promise<void>;
  onSourceModeChange(sourceMode: PreviewSourceMode): Promise<void>;
  onLabelStyleChange(labelStyle: DotLabelStyle): Promise<void>;
  onRecursiveStrategyChange(strategy: RecursiveStrategy): Promise<void>;
  onSourceClick(targetId: string): Promise<void>;
  onConstraintFilterChange(mode: PreviewConstraintFilterMode): Promise<void>;
  onConstraintNodeDrilldown(targetId: string): Promise<void>;
  onConstraintClick(constraintId: string): Promise<void>;
  onConstraintOpen(constraintId: string): Promise<void>;
  onSelectMetadataSources(): Promise<void>;
  onClearMetadataSources(): Promise<void>;
  onRefresh(): Promise<void>;
}

type IncomingMessage =
  | { type: "changeMode"; mode: DotViewMode }
  | { type: "changeSourceMode"; sourceMode: PreviewSourceMode }
  | { type: "changeLabelStyle"; labelStyle: DotLabelStyle }
  | { type: "changeRecursiveStrategy"; recursiveStrategy: RecursiveStrategy }
  | { type: "clickSource"; targetId: string }
  | { type: "changeConstraintFilter"; constraintFilterMode: PreviewConstraintFilterMode }
  | { type: "drilldownConstraintNode"; targetId: string }
  | { type: "clickConstraint"; constraintId: string }
  | { type: "openConstraint"; constraintId: string }
  | { type: "selectMetadataSources" }
  | { type: "clearMetadataSources" }
  | { type: "refresh" };

let currentPanel: PreviewPanel | undefined;

export class PreviewPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private lastState: PreviewPanelState | undefined;
  private renderNonce = 0;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly callbacks: PreviewPanelCallbacks,
    preserveFocus: boolean
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "eggplantPattern.previewPanel",
      "Eggplant Pattern Preview",
      {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.disposables.push(
      this.panel.onDidDispose(() => {
        currentPanel = undefined;
        this.dispose();
      }),
      this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => {
        void this.handleMessage(message);
      })
    );
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    callbacks: PreviewPanelCallbacks,
    preserveFocus: boolean
  ): PreviewPanel {
    if (currentPanel) {
      currentPanel.reveal(preserveFocus);
      return currentPanel;
    }

    currentPanel = new PreviewPanel(extensionUri, callbacks, preserveFocus);
    return currentPanel;
  }

  static current(): PreviewPanel | undefined {
    return currentPanel;
  }

  reveal(preserveFocus = false): void {
    this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
  }

  async render(state: PreviewPanelState): Promise<void> {
    const nextState = {
      ...state,
      renderNonce: ++this.renderNonce
    };
    this.lastState = nextState;
    this.panel.title = nextState.title;
    await this.panel.webview.postMessage({
      type: "render",
      payload: nextState
    });
  }

  snapshot(): PreviewPanelState | undefined {
    return this.lastState;
  }

  clearSnapshot(): void {
    this.lastState = undefined;
  }

  async dispatchTestMessage(message: IncomingMessage): Promise<void> {
    await this.handleMessage(message);
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case "changeMode":
        await this.callbacks.onModeChange(message.mode);
        return;
      case "changeLabelStyle":
        await this.callbacks.onLabelStyleChange(message.labelStyle);
        return;
      case "changeSourceMode":
        await this.callbacks.onSourceModeChange(message.sourceMode);
        return;
      case "changeRecursiveStrategy":
        await this.callbacks.onRecursiveStrategyChange(message.recursiveStrategy);
        return;
      case "clickSource":
        await this.callbacks.onSourceClick(message.targetId);
        return;
      case "changeConstraintFilter":
        await this.callbacks.onConstraintFilterChange(message.constraintFilterMode);
        return;
      case "drilldownConstraintNode":
        await this.callbacks.onConstraintNodeDrilldown(message.targetId);
        return;
      case "clickConstraint":
        await this.callbacks.onConstraintClick(message.constraintId);
        return;
      case "openConstraint":
        await this.callbacks.onConstraintOpen(message.constraintId);
        return;
      case "selectMetadataSources":
        await this.callbacks.onSelectMetadataSources();
        return;
      case "clearMetadataSources":
        await this.callbacks.onClearMetadataSources();
        return;
      case "refresh":
        await this.callbacks.onRefresh();
        return;
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Eggplant Pattern Preview</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --muted: var(--vscode-descriptionForeground);
        --panel: color-mix(in srgb, var(--bg) 92%, var(--fg) 8%);
        --border: var(--vscode-panel-border);
        --button: var(--vscode-button-background);
        --button-fg: var(--vscode-button-foreground);
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font-family: var(--vscode-font-family);
      }
      .shell {
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        height: 100vh;
      }
      .content {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 320px;
        min-height: 0;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        background: var(--panel);
      }
      .toolbar label {
        font-size: 12px;
        color: var(--muted);
      }
      select, button {
        font: inherit;
        border: 1px solid var(--border);
        background: var(--vscode-dropdown-background);
        color: var(--fg);
        padding: 4px 8px;
      }
      button {
        cursor: pointer;
        background: var(--button);
        color: var(--button-fg);
      }
      .meta {
        padding: 8px 12px;
        border-bottom: 1px solid var(--border);
        color: var(--muted);
        font-size: 12px;
      }
      .graph {
        overflow: auto;
        padding: 12px;
        min-width: 0;
      }
      .graph[data-draggable="true"] {
        cursor: grab;
      }
      .graph[data-dragging="true"] {
        cursor: grabbing;
        user-select: none;
      }
      .metadata-viewer {
        padding: 12px;
        border-bottom: 1px solid var(--border);
        background: color-mix(in srgb, var(--panel) 72%, var(--bg) 28%);
      }
      .metadata-viewer[hidden] {
        display: none;
      }
      .metadata-viewer-header {
        margin: 0 0 8px;
        font-size: 12px;
        color: var(--muted);
      }
      .metadata-viewer-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .metadata-section {
        border: 1px solid var(--border);
        background: var(--bg);
        padding: 10px;
      }
      .metadata-section h3 {
        margin: 0 0 8px;
        font-size: 12px;
      }
      .metadata-list {
        margin: 0;
        padding-left: 18px;
        font-size: 12px;
      }
      .metadata-list li {
        margin: 0 0 4px;
        word-break: break-all;
      }
      .metadata-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .metadata-kind {
        flex: none;
        min-width: 52px;
        padding: 1px 6px;
        border: 1px solid var(--border);
        background: var(--panel);
        font-size: 11px;
        line-height: 1.4;
        text-transform: lowercase;
      }
      .metadata-path {
        flex: 1;
        user-select: text;
        cursor: text;
      }
      .metadata-empty {
        font-size: 12px;
        color: var(--muted);
      }
      .graph svg {
        max-width: none;
        height: auto;
        user-select: none;
        -webkit-user-select: none;
      }
      .graph svg * {
        user-select: none;
        -webkit-user-select: none;
      }
      .constraints-panel {
        border-left: 1px solid var(--border);
        background: color-mix(in srgb, var(--panel) 78%, var(--bg) 22%);
        min-width: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
      }
      .constraints-header {
        padding: 10px 12px 8px;
        border-bottom: 1px solid var(--border);
      }
      .constraints-header h3 {
        margin: 0;
        font-size: 12px;
      }
      .constraints-header p {
        margin: 6px 0 0;
        font-size: 12px;
        color: var(--muted);
      }
      .constraints-toolbar {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .constraints-toolbar label {
        font-size: 12px;
        color: var(--muted);
      }
      .constraints-toolbar select {
        flex: 1;
        min-width: 0;
      }
      .constraints-list {
        overflow: auto;
        padding: 8px 10px;
      }
      .constraint-item {
        padding: 8px 10px;
        border: 1px solid var(--border);
        background: var(--bg);
        cursor: pointer;
        user-select: none;
      }
      .constraint-item + .constraint-item {
        margin-top: 8px;
      }
      .constraint-item[data-active="true"] {
        border-color: #c26d00;
        box-shadow: inset 0 0 0 1px #c26d00;
      }
      .constraint-label {
        margin: 0;
        font-size: 12px;
        line-height: 1.4;
        user-select: text;
        cursor: text;
        word-break: break-word;
      }
      .constraint-id {
        margin: 0 0 6px;
        font-size: 11px;
        color: var(--muted);
      }
      .constraint-meta {
        margin: 6px 0 0;
        font-size: 11px;
        color: var(--muted);
      }
      .constraint-selection {
        border-top: 1px solid var(--border);
        padding: 10px 12px;
      }
      .constraint-selection h4 {
        margin: 0 0 8px;
        font-size: 12px;
      }
      .constraint-selection p {
        margin: 0;
        font-size: 12px;
        color: var(--muted);
      }
      .constraint-node-list {
        margin: 0;
        padding-left: 18px;
        font-size: 12px;
      }
      .constraint-node-list li + li {
        margin-top: 4px;
      }
      .footer {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-top: 1px solid var(--border);
        background: var(--panel);
      }
      .footer label {
        font-size: 12px;
        color: var(--muted);
      }
      .warning {
        flex: 1;
        min-width: 0;
        color: #d08a00;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="toolbar">
        <label for="mode">DOT view</label>
        <select id="mode">
          <option value="pattern">pattern.dot</option>
          <option value="action">action.dot</option>
          <option value="combined">action + pattern.dot</option>
        </select>
        <label for="labelStyle">Detail</label>
        <select id="labelStyle">
          <option value="compact">compact</option>
          <option value="full">full</option>
          <option value="recursive">recursive</option>
        </select>
        <label for="recursiveStrategy">Recursive strategy</label>
        <select id="recursiveStrategy">
          <option value="tree-safe">tree-safe</option>
          <option value="dag-expand">dag-expand</option>
        </select>
        <button id="metadataSources" type="button">Meta Sources</button>
        <button id="showCurrentMetadataSources" type="button">Show Current Meta Sources</button>
        <button id="clearMetadataSources" type="button">Clear Sources</button>
        <button id="refresh" type="button">Refresh</button>
      </div>
      <div class="meta" id="meta">No preview yet.</div>
      <div class="metadata-viewer" id="metadataViewer" hidden>
        <p class="metadata-viewer-header" id="metadataViewerHeader">Effective source set: 0</p>
        <div class="metadata-viewer-grid">
          <section class="metadata-section">
            <h3>Current File</h3>
            <ul class="metadata-list" id="metadataCurrentFile"></ul>
          </section>
          <section class="metadata-section">
            <h3>Auto-discovered</h3>
            <ul class="metadata-list" id="metadataAutoDiscovered"></ul>
          </section>
          <section class="metadata-section">
            <h3>Manual</h3>
            <ul class="metadata-list" id="metadataManual"></ul>
          </section>
          <section class="metadata-section">
            <h3>Effective Source Set</h3>
            <ul class="metadata-list" id="metadataEffective"></ul>
          </section>
        </div>
      </div>
      <div class="content">
        <div class="graph" id="graph"></div>
        <aside class="constraints-panel">
          <div class="constraints-header">
            <h3>Constraints</h3>
            <p>Single click highlights involved nodes. Double click jumps to the constraint definition. Double click a graph node to drill into its related constraints.</p>
            <div class="constraints-toolbar">
              <label for="constraintFilter">Filter</label>
              <select id="constraintFilter">
                <option value="all">All Constraints</option>
                <option value="node-specific">Node-Specific Constraints</option>
              </select>
            </div>
          </div>
          <div class="constraints-list" id="constraintsList"></div>
          <div class="constraint-selection">
            <h4>Referenced Nodes</h4>
            <ul class="constraint-node-list" id="constraintNodeList"></ul>
            <p id="constraintSelectionEmpty">Select a constraint to inspect its nodes.</p>
          </div>
        </aside>
      </div>
      <div class="footer">
        <label for="sourceMode">Source</label>
        <select id="sourceMode">
          <option value="ast">AST</option>
          <option value="trace">Trace</option>
        </select>
        <div class="warning" id="sourceWarning"></div>
        <button id="switchToAst" type="button" hidden>Switch to AST</button>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const mode = document.getElementById("mode");
      const labelStyle = document.getElementById("labelStyle");
      const sourceMode = document.getElementById("sourceMode");
      const recursiveStrategy = document.getElementById("recursiveStrategy");
      const refresh = document.getElementById("refresh");
      const metadataSources = document.getElementById("metadataSources");
      const showCurrentMetadataSources = document.getElementById("showCurrentMetadataSources");
      const clearMetadataSources = document.getElementById("clearMetadataSources");
      const metadataViewer = document.getElementById("metadataViewer");
      const metadataViewerHeader = document.getElementById("metadataViewerHeader");
      const metadataCurrentFile = document.getElementById("metadataCurrentFile");
      const metadataAutoDiscovered = document.getElementById("metadataAutoDiscovered");
      const metadataManual = document.getElementById("metadataManual");
      const metadataEffective = document.getElementById("metadataEffective");
      const sourceWarning = document.getElementById("sourceWarning");
      const switchToAst = document.getElementById("switchToAst");
      const meta = document.getElementById("meta");
      const graph = document.getElementById("graph");
      const constraintsList = document.getElementById("constraintsList");
      const constraintFilter = document.getElementById("constraintFilter");
      const constraintNodeList = document.getElementById("constraintNodeList");
      const constraintSelectionEmpty = document.getElementById("constraintSelectionEmpty");
      const sourceTargetIds = new Set();
      let metadataViewerVisible = false;
      let suppressGraphClicksUntil = 0;
      let pendingSourceClickTimeout = null;
      const sourceClickDelayMs = 400;
      let lastRenderedSvgMarkup = "";
      graph.dataset.draggable = "false";
      graph.dataset.dragging = "false";

      const syncRecursiveStrategyState = () => {
        recursiveStrategy.disabled = labelStyle.value !== "recursive";
      };

      const setMetadataViewerVisible = (visible) => {
        metadataViewerVisible = visible;
        metadataViewer.hidden = !visible;
        showCurrentMetadataSources.textContent = visible ? "Hide Current Meta Sources" : "Show Current Meta Sources";
      };

      const renderMetadataList = (element, items) => {
        element.innerHTML = "";
        if (!items || items.length === 0) {
          const empty = document.createElement("li");
          empty.className = "metadata-empty";
          empty.textContent = "None";
          element.appendChild(empty);
          return;
        }

        for (const item of items) {
          const li = document.createElement("li");
          li.textContent = item;
          element.appendChild(li);
        }
      };

      const renderMetadataEntries = (element, entries) => {
        element.innerHTML = "";
        if (!entries || entries.length === 0) {
          const empty = document.createElement("li");
          empty.className = "metadata-empty";
          empty.textContent = "None";
          element.appendChild(empty);
          return;
        }

        for (const entry of entries) {
          const li = document.createElement("li");
          const row = document.createElement("div");
          row.className = "metadata-item";
          const kind = document.createElement("span");
          kind.className = "metadata-kind";
          kind.textContent = entry.kind;
          const path = document.createElement("span");
          path.className = "metadata-path";
          path.textContent = entry.path;
          row.appendChild(kind);
          row.appendChild(path);
          li.appendChild(row);
          element.appendChild(li);
        }
      };

      const parseSvgDimension = (svgMarkup, attr) => {
        const match = svgMarkup.match(new RegExp(attr + '="([0-9.]+)(?:pt)?"'));
        return match ? Number(match[1]) : 0;
      };

      const constraintHighlightColor = "#c26d00";
      const constraintHighlightArtifactAttr = "data-constraint-highlight-artifact";
      const constraintCountBadgeAttr = "data-constraint-count-badge";

      const encodeSvgDataUri = (svgMarkup) => {
        return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgMarkup)));
      };

      const findNodeShape = (nodeGroup) => {
        return Array.from(nodeGroup.children).find((child) => {
          return child.tagName !== "title" && child.tagName !== "text" && child.tagName !== "image";
        });
      };

      const clearConstraintHighlightArtifacts = (nodeGroup) => {
        for (const artifact of Array.from(nodeGroup.querySelectorAll("[" + constraintHighlightArtifactAttr + '="true"]'))) {
          artifact.remove();
        }
      };

      const clearConstraintCountBadges = (nodeGroup) => {
        for (const artifact of Array.from(nodeGroup.querySelectorAll("[" + constraintCountBadgeAttr + '="true"]'))) {
          artifact.remove();
        }
      };

      const createConstraintHighlightHalo = (shape) => {
        const halo = shape.cloneNode(true);
        halo.setAttribute(constraintHighlightArtifactAttr, "true");
        halo.setAttribute("fill", "none");
        halo.setAttribute("stroke", constraintHighlightColor);
        halo.setAttribute("stroke-width", "7");
        halo.setAttribute("stroke-opacity", "0.28");
        halo.setAttribute("pointer-events", "none");
        halo.setAttribute("vector-effect", "non-scaling-stroke");
        return halo;
      };

      const createConstraintHighlightRing = (bbox) => {
        const ring = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        const padding = 6;
        ring.setAttribute(constraintHighlightArtifactAttr, "true");
        ring.setAttribute("x", String(bbox.x - padding));
        ring.setAttribute("y", String(bbox.y - padding));
        ring.setAttribute("width", String(bbox.width + padding * 2));
        ring.setAttribute("height", String(bbox.height + padding * 2));
        ring.setAttribute("rx", "10");
        ring.setAttribute("ry", "10");
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", constraintHighlightColor);
        ring.setAttribute("stroke-width", "3");
        ring.setAttribute("pointer-events", "none");
        ring.setAttribute("vector-effect", "non-scaling-stroke");
        return ring;
      };

      const createConstraintCountBadge = (bbox, count) => {
        const badge = document.createElementNS("http://www.w3.org/2000/svg", "g");
        badge.setAttribute(constraintCountBadgeAttr, "true");
        badge.setAttribute("pointer-events", "none");

        const label = "C" + String(count);
        const width = Math.max(24, 10 + label.length * 7);
        const height = 16;
        const x = bbox.x + bbox.width - width * 0.5;
        const y = bbox.y - height * 0.35;

        const bubble = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        bubble.setAttribute("x", String(x));
        bubble.setAttribute("y", String(y));
        bubble.setAttribute("width", String(width));
        bubble.setAttribute("height", String(height));
        bubble.setAttribute("rx", "8");
        bubble.setAttribute("ry", "8");
        bubble.setAttribute("fill", "color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-editor-foreground) 18%)");
        bubble.setAttribute("fill-opacity", "0.92");
        bubble.setAttribute("stroke", "color-mix(in srgb, var(--vscode-editor-foreground) 24%, var(--vscode-editor-background) 76%)");
        bubble.setAttribute("stroke-width", "1");

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", String(x + width / 2));
        text.setAttribute("y", String(y + height / 2 + 3.5));
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("font-size", "10");
        text.setAttribute("fill", "var(--vscode-editor-foreground)");
        text.textContent = label;

        badge.appendChild(bubble);
        badge.appendChild(text);
        return badge;
      };

      const applyTypstRenderings = (root, typstRenderings) => {
        const nodeGroups = Array.from(root.querySelectorAll("g.node"));
        for (const [targetId, rendered] of Object.entries(typstRenderings || {})) {
          const nodeGroup = nodeGroups.find((group) => group.querySelector("title")?.textContent === targetId);
          if (!nodeGroup) {
            continue;
          }

          const shape = findNodeShape(nodeGroup);
          if (!shape) {
            continue;
          }

          for (const textNode of Array.from(nodeGroup.querySelectorAll("text"))) {
            textNode.remove();
          }

          const bbox = shape.getBBox();
          const formulaWidth = rendered.width || parseSvgDimension(rendered.svg, "width");
          const formulaHeight = rendered.height || parseSvgDimension(rendered.svg, "height");
          if (!formulaWidth || !formulaHeight) {
            continue;
          }

          const maxWidth = bbox.width * 0.92;
          const maxHeight = bbox.height * 0.86;
          const scale = Math.min(maxWidth / formulaWidth, maxHeight / formulaHeight);
          const width = formulaWidth * scale;
          const height = formulaHeight * scale;
          const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
          image.setAttribute("href", encodeSvgDataUri(rendered.svg));
          image.setAttribute("x", String(bbox.x + (bbox.width - width) / 2));
          image.setAttribute("y", String(bbox.y + (bbox.height - height) / 2));
          image.setAttribute("width", String(width));
          image.setAttribute("height", String(height));
          image.setAttribute("data-typst-rendering", "true");
          image.setAttribute("pointer-events", "none");
          nodeGroup.appendChild(image);
        }
      };

      const applyConstraintCountBadges = (root, countsByNodeId) => {
        for (const nodeGroup of Array.from(root.querySelectorAll("g.node"))) {
          clearConstraintCountBadges(nodeGroup);
          const targetId = nodeGroup.querySelector("title")?.textContent;
          const count = targetId ? countsByNodeId?.[targetId] ?? 0 : 0;
          if (!count) {
            continue;
          }
          const shape = findNodeShape(nodeGroup);
          if (!shape) {
            continue;
          }
          nodeGroup.appendChild(createConstraintCountBadge(shape.getBBox(), count));
        }
      };

      const clearPendingSourceClick = () => {
        if (pendingSourceClickTimeout) {
          clearTimeout(pendingSourceClickTimeout);
          pendingSourceClickTimeout = null;
        }
      };

      const getEventNodeGroup = (event) => {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        for (const candidate of path) {
          if (candidate instanceof Element && candidate.matches("g.node")) {
            return candidate;
          }
        }
        if (event.target instanceof Element) {
          return event.target.closest("g.node");
        }
        if (event.target instanceof Node) {
          return event.target.parentElement?.closest("g.node") || null;
        }
        return null;
      };

      const bindSourceClicks = (root) => {
        for (const nodeGroup of Array.from(root.querySelectorAll("g.node"))) {
          const targetId = nodeGroup.querySelector("title")?.textContent;
          if (!targetId || !sourceTargetIds.has(targetId)) {
            nodeGroup.style.cursor = "";
            continue;
          }
          nodeGroup.style.cursor = "pointer";
        }

        root.addEventListener("mousedown", (event) => {
          const nodeGroup = getEventNodeGroup(event);
          const targetId = nodeGroup?.querySelector("title")?.textContent;
          if (!targetId || !sourceTargetIds.has(targetId)) {
            return;
          }
          event.preventDefault();
        }, true);

        root.addEventListener("click", (event) => {
          const nodeGroup = getEventNodeGroup(event);
          const targetId = nodeGroup?.querySelector("title")?.textContent;
          if (!targetId || !sourceTargetIds.has(targetId)) {
            return;
          }
          if (event.detail !== 1) {
            return;
          }
          clearPendingSourceClick();
          pendingSourceClickTimeout = setTimeout(() => {
            pendingSourceClickTimeout = null;
            vscode.postMessage({ type: "clickSource", targetId });
          }, sourceClickDelayMs);
        });

        root.addEventListener("dblclick", (event) => {
          const nodeGroup = getEventNodeGroup(event);
          const targetId = nodeGroup?.querySelector("title")?.textContent;
          if (!targetId || !sourceTargetIds.has(targetId) || targetId.includes(":")) {
            return;
          }
          clearPendingSourceClick();
          vscode.postMessage({ type: "drilldownConstraintNode", targetId });
          event.preventDefault();
          event.stopPropagation();
        });
      };

      const bindGraphDragging = (container, root) => {
        container.dataset.draggable = "true";

        root.addEventListener("click", (event) => {
          if (Date.now() < suppressGraphClicksUntil) {
            event.preventDefault();
            event.stopPropagation();
          }
        }, true);

        if (container.dataset.dragBound === "true") {
          return;
        }
        container.dataset.dragBound = "true";
        let dragState = null;
        const dragThreshold = 4;

        container.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) {
            return;
          }
          dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startScrollLeft: container.scrollLeft,
            startScrollTop: container.scrollTop,
            moved: false
          };
          container.setPointerCapture(event.pointerId);
        });

        container.addEventListener("pointermove", (event) => {
          if (!dragState || dragState.pointerId !== event.pointerId) {
            return;
          }
          const deltaX = event.clientX - dragState.startX;
          const deltaY = event.clientY - dragState.startY;
          if (!dragState.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
            dragState.moved = true;
            container.dataset.dragging = "true";
          }
          if (!dragState.moved) {
            return;
          }
          container.scrollLeft = dragState.startScrollLeft - deltaX;
          container.scrollTop = dragState.startScrollTop - deltaY;
          event.preventDefault();
        });

        const finishDrag = (event) => {
          if (!dragState || dragState.pointerId !== event.pointerId) {
            return;
          }
          const didMove = dragState.moved;
          dragState = null;
          container.dataset.dragging = "false";
          if (container.hasPointerCapture(event.pointerId)) {
            container.releasePointerCapture(event.pointerId);
          }
          if (didMove) {
            suppressGraphClicksUntil = Date.now() + 150;
          }
        };

        container.addEventListener("pointerup", finishDrag);
        container.addEventListener("pointercancel", finishDrag);
      };

      const setConstraintNodeList = (nodeIds) => {
        constraintNodeList.innerHTML = "";
        if (!nodeIds || nodeIds.length === 0) {
          constraintSelectionEmpty.hidden = false;
          return;
        }
        constraintSelectionEmpty.hidden = true;
        for (const nodeId of nodeIds) {
          const item = document.createElement("li");
          item.textContent = nodeId;
          constraintNodeList.appendChild(item);
        }
      };

      const renderConstraints = (
        constraints,
        activeConstraintId,
        activeConstraintNodeIds,
        constraintFilterMode,
        constraintFilterNodeId
      ) => {
        constraintsList.innerHTML = "";
        constraintFilter.value = constraintFilterMode || "all";
        if (!constraints || constraints.length === 0) {
          const empty = document.createElement("p");
          empty.className = "metadata-empty";
          empty.textContent = constraintFilterMode === "node-specific"
            ? constraintFilterNodeId
              ? "No constraints reference node " + constraintFilterNodeId + "."
              : "Double click a graph node to inspect its related constraints."
            : "No constraints in this scope.";
          constraintsList.appendChild(empty);
          setConstraintNodeList([]);
          return;
        }

        for (const constraint of constraints) {
          const item = document.createElement("div");
          item.className = "constraint-item";
          item.dataset.active = String(constraint.id === activeConstraintId);
          const idLine = document.createElement("p");
          idLine.className = "constraint-id";
          idLine.textContent = constraint.id;
          const label = document.createElement("p");
          label.className = "constraint-label";
          label.textContent = constraint.compactText;
          item.title = constraint.fullText;
          const metaLine = document.createElement("p");
          metaLine.className = "constraint-meta";
          metaLine.textContent = constraint.referencedNodeIds.length > 0
            ? "nodes: " + constraint.referencedNodeIds.join(", ")
            : "nodes: none";
          item.appendChild(idLine);
          item.appendChild(label);
          item.appendChild(metaLine);
          item.addEventListener("click", () => {
            vscode.postMessage({ type: "clickConstraint", constraintId: constraint.id });
          });
          item.addEventListener("dblclick", () => {
            vscode.postMessage({ type: "openConstraint", constraintId: constraint.id });
          });
          constraintsList.appendChild(item);
        }

        setConstraintNodeList(activeConstraintNodeIds || []);
      };

      const applyConstraintHighlights = (root, highlightedNodeIds) => {
        const highlights = new Set(highlightedNodeIds || []);
        for (const nodeGroup of Array.from(root.querySelectorAll("g.node"))) {
          const targetId = nodeGroup.querySelector("title")?.textContent;
          const isHighlighted = targetId && highlights.has(targetId);
          clearConstraintHighlightArtifacts(nodeGroup);
          const shape = findNodeShape(nodeGroup);
          const typstImage = nodeGroup.querySelector('image[data-typst-rendering="true"]');
          if (isHighlighted && shape) {
            nodeGroup.appendChild(createConstraintHighlightHalo(shape));
            if (typstImage) {
              nodeGroup.appendChild(createConstraintHighlightRing(shape.getBBox()));
            }
          }
          for (const child of Array.from(nodeGroup.children)) {
            if (
              child.tagName === "title"
              || child.tagName === "image"
              || child.getAttribute?.(constraintCountBadgeAttr) === "true"
            ) {
              continue;
            }
            if (isHighlighted) {
              child.setAttribute("stroke", constraintHighlightColor);
              child.setAttribute("stroke-width", "2.5");
              if (child.tagName === "text") {
                child.setAttribute("fill", constraintHighlightColor);
              }
            }
          }
        }
      };

      mode.addEventListener("change", () => {
        vscode.postMessage({ type: "changeMode", mode: mode.value });
      });

      labelStyle.addEventListener("change", () => {
        vscode.postMessage({ type: "changeLabelStyle", labelStyle: labelStyle.value });
        syncRecursiveStrategyState();
      });

      sourceMode.addEventListener("change", () => {
        vscode.postMessage({ type: "changeSourceMode", sourceMode: sourceMode.value });
      });

      constraintFilter.addEventListener("change", () => {
        vscode.postMessage({ type: "changeConstraintFilter", constraintFilterMode: constraintFilter.value });
      });

      recursiveStrategy.addEventListener("change", () => {
        vscode.postMessage({ type: "changeRecursiveStrategy", recursiveStrategy: recursiveStrategy.value });
      });

      refresh.addEventListener("click", () => {
        vscode.postMessage({ type: "refresh" });
      });

      metadataSources.addEventListener("click", () => {
        vscode.postMessage({ type: "selectMetadataSources" });
      });

      showCurrentMetadataSources.addEventListener("click", () => {
        setMetadataViewerVisible(!metadataViewerVisible);
      });

      clearMetadataSources.addEventListener("click", () => {
        vscode.postMessage({ type: "clearMetadataSources" });
      });

      switchToAst.addEventListener("click", () => {
        vscode.postMessage({ type: "changeSourceMode", sourceMode: "ast" });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type !== "render") {
          return;
        }

        const payload = message.payload;
        mode.value = payload.mode;
        labelStyle.value = payload.labelStyle;
        sourceMode.value = payload.sourceMode;
        recursiveStrategy.value = payload.recursiveStrategy;
        syncRecursiveStrategyState();
        sourceTargetIds.clear();
        for (const targetId of payload.sourceTargetIds || []) {
          sourceTargetIds.add(targetId);
        }
        const metadataSourcesView = payload.metadataSourcesView || {
          currentFile: payload.fileName,
          autoDiscovered: [],
          manual: [],
          effective: [],
          entries: [],
          effectiveEntries: []
        };
        metadataViewerHeader.textContent = "Effective source set: " + metadataSourcesView.effective.length;
        renderMetadataEntries(
          metadataCurrentFile,
          (metadataSourcesView.entries || []).filter((entry) => entry.kind === "current")
        );
        renderMetadataEntries(
          metadataAutoDiscovered,
          (metadataSourcesView.entries || []).filter((entry) => entry.kind === "auto")
        );
        renderMetadataEntries(
          metadataManual,
          (metadataSourcesView.entries || []).filter((entry) => entry.kind === "manual")
        );
        renderMetadataEntries(
          metadataEffective,
          (metadataSourcesView.effectiveEntries || []).map((entry) => ({
            path: entry.path,
            kind: entry.kinds.join("+")
          }))
        );
        const sourceSummary = payload.metadataSourceFiles.length > 0
          ? " | meta sources: " + payload.metadataSourceFiles.length
          : "";
        const recoverySummary = payload.recoverySummary ? " | " + payload.recoverySummary : "";
        const recoveryDiagnostics = (payload.recoveryDiagnostics || []).length > 0
          ? " | diag: " + payload.recoveryDiagnostics.join(" ; ")
          : "";
        meta.textContent = payload.notice || payload.fileName + " | " + payload.mode + " | source=" + payload.sourceMode + " | " + payload.labelStyle + (payload.labelStyle === "recursive" ? " | " + payload.recursiveStrategy : "") + sourceSummary + recoverySummary + recoveryDiagnostics;
        renderConstraints(
          payload.constraints || [],
          payload.activeConstraintId,
          payload.activeConstraintNodeIds || [],
          payload.constraintFilterMode || "all",
          payload.constraintFilterNodeId || null
        );
        sourceWarning.textContent = payload.sourceWarning || "";
        switchToAst.hidden = !payload.showSwitchToAst;
        const svgChanged = payload.svg !== lastRenderedSvgMarkup;
        let rootSvg = graph.querySelector("svg");
        if (svgChanged) {
          graph.innerHTML = payload.svg;
          lastRenderedSvgMarkup = payload.svg;
          rootSvg = graph.querySelector("svg");
        }
        if (rootSvg) {
          if (svgChanged || rootSvg.dataset.boundSvg !== "true") {
            applyTypstRenderings(rootSvg, payload.typstRenderings);
            bindSourceClicks(rootSvg);
            bindGraphDragging(graph, rootSvg);
            rootSvg.dataset.boundSvg = "true";
          }
          applyConstraintCountBadges(rootSvg, payload.constraintCountByNodeId || {});
          applyConstraintHighlights(rootSvg, payload.activeConstraintNodeIds || []);
        }
      });

      syncRecursiveStrategyState();
      setMetadataViewerVisible(false);
    </script>
  </body>
</html>`;
  }
}

export function getPreviewPanelTestState(): PreviewPanelState | undefined {
  return currentPanel?.snapshot();
}

export async function clearPreviewPanelTestState(): Promise<void> {
  if (!currentPanel) {
    return;
  }
  currentPanel.clearSnapshot();
}

export async function dispatchPreviewPanelTestMessage(
  message:
    | { type: "changeMode"; mode: DotViewMode }
    | { type: "changeSourceMode"; sourceMode: PreviewSourceMode }
    | { type: "changeLabelStyle"; labelStyle: DotLabelStyle }
    | { type: "changeRecursiveStrategy"; recursiveStrategy: RecursiveStrategy }
    | { type: "clickSource"; targetId: string }
    | { type: "changeConstraintFilter"; constraintFilterMode: PreviewConstraintFilterMode }
    | { type: "drilldownConstraintNode"; targetId: string }
    | { type: "clickConstraint"; constraintId: string }
    | { type: "openConstraint"; constraintId: string }
    | { type: "selectMetadataSources" }
    | { type: "clearMetadataSources" }
    | { type: "refresh" }
): Promise<void> {
  await currentPanel?.dispatchTestMessage(message);
}
