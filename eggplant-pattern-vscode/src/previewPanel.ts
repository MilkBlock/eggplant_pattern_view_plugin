import * as vscode from "vscode";
import { DotLabelStyle, DotViewMode } from "./dot";

export interface PreviewPanelState {
  title: string;
  mode: DotViewMode;
  labelStyle: DotLabelStyle;
  fileName: string;
  dot: string;
  svg: string;
  notice: string | null;
}

interface PreviewPanelCallbacks {
  onModeChange(mode: DotViewMode): Promise<void>;
  onLabelStyleChange(labelStyle: DotLabelStyle): Promise<void>;
  onRefresh(): Promise<void>;
}

type IncomingMessage =
  | { type: "changeMode"; mode: DotViewMode }
  | { type: "changeLabelStyle"; labelStyle: DotLabelStyle }
  | { type: "refresh" };

let currentPanel: PreviewPanel | undefined;

export class PreviewPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private lastState: PreviewPanelState | undefined;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly callbacks: PreviewPanelCallbacks
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "eggplantPattern.previewPanel",
      "Eggplant Pattern Preview",
      vscode.ViewColumn.Beside,
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

  static createOrShow(extensionUri: vscode.Uri, callbacks: PreviewPanelCallbacks): PreviewPanel {
    if (currentPanel) {
      currentPanel.reveal();
      return currentPanel;
    }

    currentPanel = new PreviewPanel(extensionUri, callbacks);
    return currentPanel;
  }

  static current(): PreviewPanel | undefined {
    return currentPanel;
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  async render(state: PreviewPanelState): Promise<void> {
    this.lastState = state;
    this.panel.title = state.title;
    await this.panel.webview.postMessage({
      type: "render",
      payload: state
    });
  }

  snapshot(): PreviewPanelState | undefined {
    return this.lastState;
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
        grid-template-rows: auto auto 1fr;
        height: 100vh;
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
      }
      .graph svg {
        max-width: none;
        height: auto;
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
        </select>
        <button id="refresh" type="button">Refresh</button>
      </div>
      <div class="meta" id="meta">No preview yet.</div>
      <div class="graph" id="graph"></div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const mode = document.getElementById("mode");
      const labelStyle = document.getElementById("labelStyle");
      const refresh = document.getElementById("refresh");
      const meta = document.getElementById("meta");
      const graph = document.getElementById("graph");

      mode.addEventListener("change", () => {
        vscode.postMessage({ type: "changeMode", mode: mode.value });
      });

      labelStyle.addEventListener("change", () => {
        vscode.postMessage({ type: "changeLabelStyle", labelStyle: labelStyle.value });
      });

      refresh.addEventListener("click", () => {
        vscode.postMessage({ type: "refresh" });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type !== "render") {
          return;
        }

        const payload = message.payload;
        mode.value = payload.mode;
        labelStyle.value = payload.labelStyle;
        meta.textContent = payload.notice || payload.fileName + " | " + payload.mode + " | " + payload.labelStyle;
        graph.innerHTML = payload.svg;
      });
    </script>
  </body>
</html>`;
  }
}

export function getPreviewPanelTestState(): PreviewPanelState | undefined {
  return currentPanel?.snapshot();
}

export async function dispatchPreviewPanelTestMessage(
  message: { type: "changeMode"; mode: DotViewMode } | { type: "changeLabelStyle"; labelStyle: DotLabelStyle } | { type: "refresh" }
): Promise<void> {
  await currentPanel?.dispatchTestMessage(message);
}
