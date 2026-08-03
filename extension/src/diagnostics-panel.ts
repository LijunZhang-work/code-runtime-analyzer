import * as vscode from 'vscode';

export const DEFAULT_DIAGNOSTICS_VIEW_ID = 'cppCsvDiagnostics.diagnosticsPanel';

export type DiagnosticsStatusKind = 'idle' | 'loading' | 'ready' | 'warning' | 'error';

export interface DiagnosticsCurrentState {
  dictionaryId?: string;
  dictionaryName?: string;
  folderPath?: string;
  runRecordId?: string;
  requestedTime?: string;
  status?: string;
  statusKind?: DiagnosticsStatusKind;
  statusDetail?: string;
  displayEnabled?: boolean;
}

export interface DiagnosticsFolderSummary {
  matchedFiles: readonly string[];
  missingFiles: readonly string[];
  unusedFiles: readonly string[];
  importedMappings: number;
  sourceCount: number;
}

export interface DiagnosticsDataQualitySummary {
  sourceCount: number;
  totalRows?: number;
  duplicateTimestampCount: number;
  nonMonotonicCount: number;
  largeGapCount: number;
  medianIntervalMs?: number | null;
  checkedAt?: string;
}

type GroupId = 'current' | 'files' | 'actions' | 'quality';

export type DiagnosticsTreeNode =
  | {
    kind: 'group';
    id: GroupId;
    label: string;
    icon: string;
    collapsibleState: vscode.TreeItemCollapsibleState;
  }
  | {
    kind: 'item';
    id: string;
    label: string;
    description?: string;
    tooltip?: string;
    icon: string;
    command?: vscode.Command;
    contextValue?: string;
  };

const commandItems: readonly DiagnosticsTreeNode[] = [
  commandNode('open-web-workbench', '打开网页工作台', 'globe', 'cppCsvDiagnostics.openWebWorkbench'),
  commandNode('select-dictionary', '选择字段字典', 'book', 'cppCsvDiagnostics.selectDictionary'),
  commandNode('reload-dictionary', '加载 / 重新加载字典', 'sync', 'cppCsvDiagnostics.reloadDictionary'),
  commandNode('select-folder', '选择 CSV 文件夹', 'folder-opened', 'cppCsvDiagnostics.selectDataFolder'),
  commandNode('reload-csv', '加载 / 重新加载 CSV', 'sync', 'cppCsvDiagnostics.reloadCsv'),
  commandNode('select-time', '选择回放时间', 'history', 'cppCsvDiagnostics.selectReplay'),
  commandNode('open-trend', '打开字段趋势', 'graph-line', 'cppCsvDiagnostics.openTrend'),
  commandNode('show-quality', '查看 CSV 数据质量', 'checklist', 'cppCsvDiagnostics.showDataQuality')
];

/**
 * Owns the native diagnostics TreeView and its current presentation state.
 * The view's location (including Secondary Sidebar) is configured by the
 * matching view contribution in package.json.
 */
export class DiagnosticsPanelController implements vscode.TreeDataProvider<DiagnosticsTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<DiagnosticsTreeNode | undefined>();
  private current: DiagnosticsCurrentState = { status: '就绪', statusKind: 'idle' };
  private folderSummary: DiagnosticsFolderSummary | undefined;
  private quality: DiagnosticsDataQualitySummary | undefined;
  private disposed = false;

  readonly onDidChangeTreeData = this.changeEmitter.event;
  readonly view: vscode.TreeView<DiagnosticsTreeNode>;

  constructor(viewId: string = DEFAULT_DIAGNOSTICS_VIEW_ID) {
    this.view = vscode.window.createTreeView(viewId, {
      treeDataProvider: this,
      showCollapseAll: false
    });
  }

  updateCurrent(update: Partial<DiagnosticsCurrentState>): void {
    this.current = {
      ...this.current,
      ...update,
      ...(update.status !== undefined && update.statusDetail === undefined
        ? { statusDetail: undefined }
        : {})
    };
    this.refresh();
  }

  updateDataQuality(summary: DiagnosticsDataQualitySummary | undefined): void {
    this.quality = summary;
    this.refresh();
  }

  updateFolderSummary(summary: DiagnosticsFolderSummary | undefined): void {
    this.folderSummary = summary;
    this.refresh();
  }

  refresh(node?: DiagnosticsTreeNode): void {
    if (!this.disposed) this.changeEmitter.fire(node);
  }

  getTreeItem(node: DiagnosticsTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.kind === 'group' ? node.collapsibleState : vscode.TreeItemCollapsibleState.None
    );
    item.id = `cppCsvDiagnostics.panel.${node.id}`;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.kind === 'group') {
      item.contextValue = `cppCsvDiagnostics.${node.id}Group`;
      return item;
    }
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.command = node.command;
    item.contextValue = node.contextValue ?? 'cppCsvDiagnostics.panelItem';
    return item;
  }

  getChildren(node?: DiagnosticsTreeNode): DiagnosticsTreeNode[] {
    if (!node) return this.rootGroups();
    if (node.kind !== 'group') return [];
    switch (node.id) {
      case 'current': return this.currentItems();
      case 'files': return this.folderItems();
      case 'actions': return [
        commandNode(
          'toggle-display',
          this.current.displayEnabled ? '结束展示' : '开始展示',
          this.current.displayEnabled ? 'debug-stop' : 'play',
          'cppCsvDiagnostics.toggleDisplay'
        ),
        ...commandItems
      ];
      case 'quality': return this.qualityItems();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view.dispose();
    this.changeEmitter.dispose();
  }

  private rootGroups(): DiagnosticsTreeNode[] {
    return [
      {
        kind: 'group',
        id: 'files',
        label: 'CSV 文件匹配',
        icon: this.folderSummary && this.folderSummary.missingFiles.length > 0 ? 'warning' : 'files',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded
      },
      {
        kind: 'group',
        id: 'current',
        label: '当前诊断',
        icon: 'pulse',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded
      },
      {
        kind: 'group',
        id: 'actions',
        label: '快捷操作',
        icon: 'tools',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded
      },
      {
        kind: 'group',
        id: 'quality',
        label: '数据质量摘要',
        icon: this.qualityIcon(),
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded
      }
    ];
  }

  private currentItems(): DiagnosticsTreeNode[] {
    const statusKind = this.current.statusKind ?? 'idle';
    const requestedTime = this.current.requestedTime;
    return [
      {
        kind: 'item',
        id: 'current-display',
        label: this.current.displayEnabled ? '展示状态' : '展示状态',
        description: this.current.displayEnabled ? '已启动' : '已结束',
        tooltip: this.current.displayEnabled
          ? '正在为当前可见的 C/C++ 文件展示历史值。点击结束展示会立即隐藏行尾数据、Hover、CodeLens 和趋势。'
          : '当前不展示任何历史数据。先加载字典和 CSV，再点击开始展示。',
        icon: this.current.displayEnabled ? 'play-circle' : 'debug-stop',
        command: command('cppCsvDiagnostics.toggleDisplay', this.current.displayEnabled ? '结束展示' : '开始展示')
      },
      {
        kind: 'item',
        id: 'current-dictionary',
        label: '字段字典',
        description: this.current.dictionaryName || this.current.dictionaryId || '未选择',
        tooltip: this.current.dictionaryId
          ? `当前字典：${this.current.dictionaryName ?? this.current.dictionaryId}（${this.current.dictionaryId}）\n点击可选择其他字典`
          : '尚未选择字段字典，点击开始选择',
        icon: 'book',
        command: command('cppCsvDiagnostics.selectDictionary', '选择字段字典')
      },
      {
        kind: 'item',
        id: 'current-folder',
        label: 'CSV 文件夹',
        description: this.current.folderPath ? compactPath(this.current.folderPath) : '未选择',
        tooltip: this.current.folderPath
          ? `${this.current.folderPath}\n点击可选择其他 CSV 文件夹`
          : '尚未选择 CSV 文件夹，点击开始选择',
        icon: 'folder',
        command: command('cppCsvDiagnostics.selectDataFolder', '选择 CSV 文件夹')
      },
      {
        kind: 'item',
        id: 'current-run',
        label: '运行记录',
        description: this.current.runRecordId || '尚未加载',
        tooltip: this.current.runRecordId ? `当前运行记录：${this.current.runRecordId}` : '选择字典和 CSV 文件夹后自动生成',
        icon: 'database'
      },
      {
        kind: 'item',
        id: 'current-time',
        label: '回放时间',
        description: requestedTime ? formatRequestedTime(requestedTime) : '未选择',
        tooltip: requestedTime
          ? `原始时间：${requestedTime}\n点击可选择其他回放时间`
          : '尚未选择回放时间，点击开始选择',
        icon: 'history',
        command: command('cppCsvDiagnostics.selectReplay', '选择回放时间')
      },
      {
        kind: 'item',
        id: 'current-status',
        label: '状态',
        description: this.current.status || '就绪',
        tooltip: this.current.statusDetail || this.current.status || '就绪',
        icon: statusIcon(statusKind),
        command: command('cppCsvDiagnostics.refresh', '刷新历史值'),
        contextValue: `cppCsvDiagnostics.status.${statusKind}`
      }
    ];
  }

  private folderItems(): DiagnosticsTreeNode[] {
    const summary = this.folderSummary;
    if (!summary) {
      return [{
        kind: 'item',
        id: 'files-empty',
        label: '尚未匹配文件',
        description: '先选择字典和文件夹',
        tooltip: '工具会按字段字典中的 CSV 来源要求匹配所选文件夹',
        icon: 'question',
        command: command('cppCsvDiagnostics.selectDataFolder', '选择 CSV 文件夹')
      }];
    }
    const rows: DiagnosticsTreeNode[] = [
      valueNode('files-matched', '已匹配文件', String(summary.matchedFiles.length), 'pass-filled'),
      valueNode('files-missing', '缺少文件', String(summary.missingFiles.length), summary.missingFiles.length > 0 ? 'error' : 'pass'),
      valueNode('files-unused', '未使用文件', String(summary.unusedFiles.length), summary.unusedFiles.length > 0 ? 'info' : 'pass'),
      valueNode('files-sources', '已导入来源', String(summary.sourceCount), 'database'),
      valueNode('files-mappings', '字段映射', String(summary.importedMappings), 'symbol-field')
    ];
    for (const [index, file] of summary.missingFiles.slice(0, 5).entries()) {
      rows.push(valueNode(`files-missing-${index}`, `缺少：${file}`, '', 'error'));
    }
    for (const [index, file] of summary.unusedFiles.slice(0, 5).entries()) {
      rows.push(valueNode(`files-unused-${index}`, `未使用：${file}`, '', 'circle-outline'));
    }
    if (summary.missingFiles.length > 5 || summary.unusedFiles.length > 5) {
      rows.push(valueNode('files-more', '其余文件', '请查看加载提示', 'ellipsis'));
    }
    return rows;
  }

  private qualityItems(): DiagnosticsTreeNode[] {
    const quality = this.quality;
    if (!quality) {
      return [{
        kind: 'item',
        id: 'quality-empty',
        label: '尚未检查',
        description: '点击运行检查',
        tooltip: '检查当前运行记录关联 CSV 的时间、重复值和采样间隔',
        icon: 'question',
        command: command('cppCsvDiagnostics.showDataQuality', '查看 CSV 数据质量')
      }];
    }

    const issues = quality.duplicateTimestampCount + quality.nonMonotonicCount + quality.largeGapCount;
    const rows: DiagnosticsTreeNode[] = [
      valueNode('quality-sources', 'CSV 来源', String(quality.sourceCount), 'files'),
      valueNode('quality-rows', '总行数', quality.totalRows === undefined ? '—' : String(quality.totalRows), 'list-ordered'),
      valueNode('quality-duplicates', '重复时间', String(quality.duplicateTimestampCount), quality.duplicateTimestampCount > 0 ? 'warning' : 'pass'),
      valueNode('quality-order', '非单调时间', String(quality.nonMonotonicCount), quality.nonMonotonicCount > 0 ? 'warning' : 'pass'),
      valueNode('quality-gaps', '大采样间隔', String(quality.largeGapCount), quality.largeGapCount > 0 ? 'warning' : 'pass')
    ];
    if (quality.medianIntervalMs !== undefined) {
      rows.push(valueNode(
        'quality-median',
        '中位采样间隔',
        quality.medianIntervalMs === null ? '—' : `${quality.medianIntervalMs} ms`,
        'clock'
      ));
    }
    rows.push({
      kind: 'item',
      id: 'quality-open',
      label: issues > 0 ? `重新检查（${issues} 项异常）` : '重新检查（未发现时间异常）',
      description: quality.checkedAt ? `检查于 ${formatRequestedTime(quality.checkedAt)}` : undefined,
      tooltip: '重新检查当前运行记录的 CSV 数据质量',
      icon: issues > 0 ? 'warning' : 'pass-filled',
      command: command('cppCsvDiagnostics.showDataQuality', '查看 CSV 数据质量')
    });
    return rows;
  }

  private qualityIcon(): string {
    if (!this.quality) return 'checklist';
    return this.quality.duplicateTimestampCount + this.quality.nonMonotonicCount + this.quality.largeGapCount > 0
      ? 'warning'
      : 'pass-filled';
  }
}

function commandNode(id: string, label: string, icon: string, commandId: string): DiagnosticsTreeNode {
  return {
    kind: 'item',
    id: `action-${id}`,
    label,
    icon,
    command: command(commandId, label),
    contextValue: 'cppCsvDiagnostics.action'
  };
}

function valueNode(id: string, label: string, description: string, icon: string): DiagnosticsTreeNode {
  return { kind: 'item', id, label, description, icon };
}

function command(commandId: string, title: string): vscode.Command {
  return { command: commandId, title };
}

function statusIcon(kind: DiagnosticsStatusKind): string {
  switch (kind) {
    case 'loading': return 'sync';
    case 'ready': return 'pass-filled';
    case 'warning': return 'warning';
    case 'error': return 'error';
    default: return 'circle-outline';
  }
}

function formatRequestedTime(value: string): string {
  const text = value.trim();
  let timestamp: number;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    timestamp = Number(text);
    if (Math.abs(timestamp) < 100_000_000_000) timestamp *= 1000;
  } else {
    timestamp = Date.parse(text);
  }
  if (!Number.isFinite(timestamp)) return value;
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function compactPath(value: string): string {
  const parts = value.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || value;
}
