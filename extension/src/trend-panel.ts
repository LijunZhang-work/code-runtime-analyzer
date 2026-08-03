import * as crypto from 'crypto';
import * as vscode from 'vscode';

export type TrendValue = number | string | boolean | null;

export interface TrendPoint {
  requestedTime: string | number;
  value: TrendValue;
  sampledTime?: string | number;
  matchType?: string;
  sourceName?: string;
  csvColumn?: string;
}

export interface TrendStatistics {
  pointCount: number;
  min: TrendValue;
  max: TrendValue;
  changeCount: number;
}

export interface TrendSeries {
  index: string | number;
  label?: string;
  points: readonly TrendPoint[];
  statistics?: TrendStatistics;
}

export type TrendSeriesPayload = readonly TrendSeries[];

let trendPanel: vscode.WebviewPanel | undefined;

/** Closes the transient trend view when historical presentation is stopped. */
export function closeTrendPanel(): void {
  trendPanel?.dispose();
  trendPanel = undefined;
}

/**
 * Opens the field trend view, or refreshes the existing view when it is open.
 */
export function showTrendPanel(
  extensionUri: vscode.Uri,
  title: string,
  field: string,
  series: TrendSeriesPayload
): vscode.WebviewPanel {
  if (trendPanel) {
    trendPanel.title = cleanPanelTitle(title);
    trendPanel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    trendPanel = vscode.window.createWebviewPanel(
      'cppCsvDiagnostics.trend',
      cleanPanelTitle(title),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );
    trendPanel.onDidDispose(() => {
      trendPanel = undefined;
    });
  }

  trendPanel.webview.html = trendHtml(trendPanel.webview, title, field, series);
  return trendPanel;
}

function cleanPanelTitle(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned || '字段历史趋势';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function trendHtml(
  webview: vscode.Webview,
  title: string,
  field: string,
  series: TrendSeriesPayload
): string {
  const nonce = crypto.randomBytes(18).toString('base64');
  const payload = safeJson({ field, series });

  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    header { display: flex; gap: 16px; align-items: end; justify-content: space-between; flex-wrap: wrap; }
    h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
    .field { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
    label { display: grid; gap: 5px; color: var(--vscode-descriptionForeground); }
    select {
      min-width: 180px;
      padding: 6px 26px 6px 8px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
    }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(100px, 1fr)); gap: 10px; margin: 18px 0 12px; }
    .stat { padding: 10px 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); }
    .stat-label { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .stat-value { margin-top: 4px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
    .chart-wrap { position: relative; min-height: 300px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
    svg { display: block; width: 100%; height: 320px; overflow: visible; }
    .axis { stroke: var(--vscode-descriptionForeground); stroke-width: 1; opacity: .55; }
    .grid { stroke: var(--vscode-descriptionForeground); stroke-width: 1; opacity: .18; }
    .line { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
    .dot { fill: var(--vscode-charts-blue); stroke: var(--vscode-editorWidget-background); stroke-width: 2; }
    .axis-label { fill: var(--vscode-descriptionForeground); font-size: 11px; }
    .empty { display: none; position: absolute; inset: 0; place-items: center; color: var(--vscode-descriptionForeground); }
    .empty.visible { display: grid; }
    h2 { margin: 22px 0 8px; font-size: 15px; }
    .table-wrap { overflow: auto; border: 1px solid var(--vscode-widget-border); }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { padding: 7px 9px; text-align: left; border-bottom: 1px solid var(--vscode-widget-border); white-space: nowrap; }
    th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .value-cell { font-family: var(--vscode-editor-font-family); font-weight: 600; }
    @media (max-width: 620px) { .stats { grid-template-columns: repeat(2, 1fr); } body { padding: 12px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="field">字段：${escapeHtml(field)}</div>
    </div>
    <label>结构体实例 / tile
      <select id="series-select" aria-label="选择结构体实例"></select>
    </label>
  </header>

  <section class="stats" aria-label="趋势统计">
    <div class="stat"><div class="stat-label">数据点</div><div class="stat-value" id="point-count">—</div></div>
    <div class="stat"><div class="stat-label">最小值</div><div class="stat-value" id="minimum">—</div></div>
    <div class="stat"><div class="stat-label">最大值</div><div class="stat-value" id="maximum">—</div></div>
    <div class="stat"><div class="stat-label">变化次数</div><div class="stat-value" id="change-count">—</div></div>
  </section>

  <div class="chart-wrap">
    <svg id="chart" viewBox="0 0 900 320" role="img" aria-label="字段随请求时间变化的折线图"></svg>
    <div id="chart-empty" class="empty">当前实例没有可绘制的数值点</div>
  </div>

  <h2>采样点</h2>
  <div class="table-wrap">
    <table>
      <thead><tr><th>请求时间</th><th>采样时间</th><th>值</th><th>匹配</th><th>CSV 来源 / 列</th></tr></thead>
      <tbody id="point-rows"></tbody>
    </table>
  </div>

  <script id="trend-payload" type="application/json" nonce="${nonce}">${payload}</script>
  <script nonce="${nonce}">
    (() => {
      'use strict';
      const payloadElement = document.getElementById('trend-payload');
      const payload = JSON.parse(payloadElement.textContent || '{"series":[]}');
      const series = Array.isArray(payload.series) ? payload.series : [];
      const select = document.getElementById('series-select');
      const svg = document.getElementById('chart');
      const empty = document.getElementById('chart-empty');
      const rows = document.getElementById('point-rows');
      const ns = 'http://www.w3.org/2000/svg';

      const display = (value) => value === null || value === undefined || value === '' ? '—' : String(value);
      const numeric = (value) => {
        if (value === true || value === 'true') return 1;
        if (value === false || value === 'false') return 0;
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string' || value.trim() === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const timeNumber = (value) => {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const text = String(value ?? '').trim();
        if (/^-?\\d+(?:\\.\\d+)?$/.test(text)) {
          const number = Number(text);
          if (Number.isFinite(number)) return number;
        }
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const formatTime = (value) => {
        const number = timeNumber(value);
        if (number === null) return display(value);
        const epoch = Math.abs(number) < 100000000000 ? number * 1000 : number;
        const date = new Date(epoch);
        return Number.isNaN(date.valueOf()) ? display(value) : date.toLocaleString();
      };
      const addSvg = (name, attributes, text) => {
        const element = document.createElementNS(ns, name);
        for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value));
        if (text !== undefined) element.textContent = text;
        svg.appendChild(element);
        return element;
      };
      const addCell = (row, value, className) => {
        const cell = document.createElement('td');
        cell.textContent = display(value);
        if (className) cell.className = className;
        row.appendChild(cell);
      };

      series.forEach((item, position) => {
        const option = document.createElement('option');
        option.value = String(position);
        option.textContent = item.label ? String(item.label) : 'tile / index ' + display(item.index);
        select.appendChild(option);
      });
      if (series.length === 0) {
        const option = document.createElement('option');
        option.textContent = '无可用实例';
        select.appendChild(option);
        select.disabled = true;
      }

      function renderTable(points) {
        rows.replaceChildren();
        points.forEach((point) => {
          const row = document.createElement('tr');
          addCell(row, formatTime(point.requestedTime));
          addCell(row, point.sampledTime === undefined ? '—' : formatTime(point.sampledTime));
          addCell(row, point.value, 'value-cell');
          addCell(row, point.matchType);
          const source = [point.sourceName, point.csvColumn].filter(Boolean).join(' / ');
          addCell(row, source);
          rows.appendChild(row);
        });
      }

      function render() {
        const selected = series[Number(select.value) || 0];
        const sourcePoints = selected && Array.isArray(selected.points) ? selected.points : [];
        const points = sourcePoints.map((point, order) => ({ ...point, order, time: timeNumber(point.requestedTime) }));
        if (points.every((point) => point.time !== null)) {
          points.sort((left, right) => left.time - right.time || left.order - right.order);
        }
        renderTable(points);

        const suppliedStatistics = selected && selected.statistics && typeof selected.statistics === 'object'
          ? selected.statistics
          : null;
        document.getElementById('point-count').textContent = suppliedStatistics && Number.isFinite(suppliedStatistics.pointCount)
          ? String(suppliedStatistics.pointCount)
          : String(points.length);
        const values = points.map((point) => numeric(point.value)).filter((value) => value !== null);
        const calculatedMinimum = values.reduce((minimum, value) => minimum === null || value < minimum ? value : minimum, null);
        const calculatedMaximum = values.reduce((maximum, value) => maximum === null || value > maximum ? value : maximum, null);
        document.getElementById('minimum').textContent = suppliedStatistics && Object.prototype.hasOwnProperty.call(suppliedStatistics, 'min')
          ? display(suppliedStatistics.min)
          : display(calculatedMinimum);
        document.getElementById('maximum').textContent = suppliedStatistics && Object.prototype.hasOwnProperty.call(suppliedStatistics, 'max')
          ? display(suppliedStatistics.max)
          : display(calculatedMaximum);
        let changes = 0;
        for (let index = 1; index < points.length; index += 1) {
          if (String(points[index - 1].value) !== String(points[index].value)) changes += 1;
        }
        document.getElementById('change-count').textContent = suppliedStatistics && Number.isFinite(suppliedStatistics.changeCount)
          ? String(suppliedStatistics.changeCount)
          : String(changes);

        svg.replaceChildren();
        const plotted = points.map((point, order) => ({ point, order, value: numeric(point.value) })).filter((item) => item.value !== null);
        empty.classList.toggle('visible', plotted.length === 0);
        if (plotted.length === 0) return;

        const width = 900;
        const height = 320;
        const margin = { left: 64, right: 24, top: 24, bottom: 52 };
        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        const numericTimes = plotted.map((item) => item.point.time);
        const useTimes = numericTimes.every((time) => time !== null);
        let xMin = useTimes ? numericTimes.reduce((minimum, time) => time < minimum ? time : minimum, numericTimes[0]) : 0;
        let xMax = useTimes ? numericTimes.reduce((maximum, time) => time > maximum ? time : maximum, numericTimes[0]) : Math.max(plotted.length - 1, 1);
        if (xMin === xMax) xMax = xMin + 1;
        let yMin = plotted.reduce((minimum, item) => item.value < minimum ? item.value : minimum, plotted[0].value);
        let yMax = plotted.reduce((maximum, item) => item.value > maximum ? item.value : maximum, plotted[0].value);
        if (yMin === yMax) { const padding = Math.abs(yMin) * .1 || 1; yMin -= padding; yMax += padding; }
        const x = (item, position) => margin.left + (((useTimes ? item.point.time : position) - xMin) / (xMax - xMin)) * plotWidth;
        const y = (value) => margin.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;

        for (let tick = 0; tick <= 4; tick += 1) {
          const py = margin.top + (plotHeight * tick / 4);
          const tickValue = yMax - ((yMax - yMin) * tick / 4);
          addSvg('line', { x1: margin.left, y1: py, x2: width - margin.right, y2: py, class: 'grid' });
          addSvg('text', { x: margin.left - 9, y: py + 4, 'text-anchor': 'end', class: 'axis-label' }, Number(tickValue.toPrecision(5)).toString());
        }
        addSvg('line', { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, class: 'axis' });
        addSvg('line', { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, class: 'axis' });

        const positions = plotted.map((item, position) => [x(item, position), y(item.value)]);
        addSvg('polyline', { points: positions.map((position) => position.join(',')).join(' '), class: 'line' });
        plotted.forEach((item, position) => {
          const dot = addSvg('circle', { cx: positions[position][0], cy: positions[position][1], r: 4.5, class: 'dot' });
          const tooltip = document.createElementNS(ns, 'title');
          tooltip.textContent = formatTime(item.point.requestedTime) + ' · ' + display(item.point.value);
          dot.appendChild(tooltip);
        });
        const first = plotted[0].point.requestedTime;
        const last = plotted[plotted.length - 1].point.requestedTime;
        addSvg('text', { x: margin.left, y: height - 20, 'text-anchor': 'start', class: 'axis-label' }, formatTime(first));
        addSvg('text', { x: width - margin.right, y: height - 20, 'text-anchor': 'end', class: 'axis-label' }, formatTime(last));
        addSvg('text', { x: width / 2, y: height - 4, 'text-anchor': 'middle', class: 'axis-label' }, 'requestedTime');
      }

      select.addEventListener('change', render);
      render();
    })();
  </script>
</body>
</html>`;
}
