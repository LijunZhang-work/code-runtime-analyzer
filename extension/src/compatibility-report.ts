import * as vscode from 'vscode';

export type CompatibilityItemState = 'ready' | 'partial' | 'waiting' | 'unsupported' | 'error';

export type CompatibilityItem = {
  id: string;
  label: string;
  state: CompatibilityItemState;
  short: string;
  meaning: string;
  observed: string;
  nextStep: string;
  technical?: string;
};

export type CompatibilityReport = {
  overall: CompatibilityItemState;
  headline: string;
  summary: string;
  items: CompatibilityItem[];
  checkedAt: string;
  environment?: {
    appName?: string;
    appVersion?: string;
    appHost?: string;
    uriScheme?: string;
  };
};

export class CompatibilityReportController implements vscode.Disposable {
  private report: CompatibilityReport | undefined;
  private panel: vscode.WebviewPanel | undefined;

  update(report: CompatibilityReport): void {
    this.report = report;
    if (this.panel) this.panel.webview.html = reportHtml(report);
  }

  current(): CompatibilityReport | undefined {
    return this.report;
  }

  show(): void {
    if (!this.report) return;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'cppCsvDiagnostics.compatibilityReport',
        '编辑器兼容性检测',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: false, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => { this.panel = undefined; });
    }
    this.panel.webview.html = reportHtml(this.report);
    this.panel.reveal(vscode.ViewColumn.Beside, false);
  }

  async copy(): Promise<void> {
    if (!this.report) return;
    await vscode.env.clipboard.writeText(reportText(this.report));
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

export function reportText(report: CompatibilityReport): string {
  const lines = [
    `编辑器兼容性检测：${report.headline}`,
    report.summary,
    `检测时间：${new Date(report.checkedAt).toLocaleString()}`,
    ''
  ];
  for (const item of report.items) {
    lines.push(
      `${item.label}：${stateLabel(item.state)} · ${item.short}`,
      `这是什么意思：${item.meaning}`,
      `系统检查到什么：${item.observed}`,
      `下一步：${item.nextStep}`,
      ...(item.technical ? [`技术详情：${item.technical}`] : []),
      ''
    );
  }
  lines.push(
    '环境信息（仅用于兼容排查，不参与功能判断）：',
    `编辑器显示名称：${report.environment?.appName ?? '未知'}`,
    `编辑器报告版本：${report.environment?.appVersion ?? '未知'}`,
    `运行宿主：${report.environment?.appHost ?? '未知'}`,
    `链接协议：${report.environment?.uriScheme ?? '未知'}`
  );
  return lines.join('\n');
}

function reportHtml(report: CompatibilityReport): string {
  const cards = report.items.map((item) => `
    <article class="card card--${item.state}">
      <div class="card__head">
        <div><span>${escapeHtml(item.label)}</span><h2>${escapeHtml(item.short)}</h2></div>
        <em>${escapeHtml(stateLabel(item.state))}</em>
      </div>
      <dl>
        <div><dt>这是什么意思</dt><dd>${escapeHtml(item.meaning)}</dd></div>
        <div><dt>系统检查到什么</dt><dd>${escapeHtml(item.observed)}</dd></div>
        <div><dt>你现在怎么做</dt><dd>${escapeHtml(item.nextStep)}</dd></div>
      </dl>
      ${item.technical ? `<details><summary>技术详情（排查时再看）</summary><code>${escapeHtml(item.technical)}</code></details>` : ''}
    </article>`).join('');
  return `<!doctype html>
  <html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:28px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:14px/1.65 var(--vscode-font-family)}
    main{max-width:920px;margin:0 auto}.hero{padding:26px 28px;border:1px solid var(--vscode-widget-border);border-radius:18px;background:var(--vscode-sideBar-background);box-shadow:0 12px 30px rgba(0,0,0,.08)}
    .eyebrow{margin:0 0 6px;color:var(--vscode-descriptionForeground);font-size:12px;letter-spacing:.08em}.hero h1{margin:0;font-size:26px}.hero p{margin:9px 0 0;color:var(--vscode-descriptionForeground)}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:16px}.card{padding:18px;border:1px solid var(--vscode-widget-border);border-radius:15px;background:var(--vscode-sideBar-background)}
    .card__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.card__head span{font-size:12px;color:var(--vscode-descriptionForeground)}.card h2{margin:2px 0 0;font-size:17px}.card em{padding:3px 9px;border-radius:999px;font-size:12px;font-style:normal;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
    .card--ready{border-color:color-mix(in srgb,var(--vscode-testing-iconPassed) 50%,var(--vscode-widget-border))}.card--partial,.card--waiting{border-color:color-mix(in srgb,var(--vscode-editorWarning-foreground) 50%,var(--vscode-widget-border))}.card--error,.card--unsupported{border-color:color-mix(in srgb,var(--vscode-editorError-foreground) 50%,var(--vscode-widget-border))}
    dl{margin:15px 0 0}dl div+div{margin-top:12px}dt{font-weight:700}dd{margin:2px 0 0;color:var(--vscode-descriptionForeground)}details{margin-top:14px;border-top:1px solid var(--vscode-widget-border);padding-top:10px}summary{cursor:pointer}code{display:block;margin-top:8px;white-space:pre-wrap;word-break:break-word;color:var(--vscode-descriptionForeground)}
    footer{margin-top:18px;color:var(--vscode-descriptionForeground);font-size:12px}
  </style></head><body><main>
    <section class="hero"><p class="eyebrow">自动检测结论</p><h1>${escapeHtml(report.headline)}</h1><p>${escapeHtml(report.summary)}</p></section>
    <section class="grid">${cards}</section>
    <footer>检测于 ${escapeHtml(new Date(report.checkedAt).toLocaleString())}。编辑器名称和版本只用于排查，不参与功能判断；未复制源码、CSV、字典内容或完整业务路径。</footer>
  </main></body></html>`;
}

function stateLabel(state: CompatibilityItemState): string {
  switch (state) {
    case 'ready': return '可以使用';
    case 'partial': return '部分可用';
    case 'waiting': return '等待操作';
    case 'unsupported': return '当前不支持';
    case 'error': return '检测失败';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}
