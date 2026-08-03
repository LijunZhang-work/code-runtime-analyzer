import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { closeTrendPanel, showTrendPanel } from './trend-panel';
import { DiagnosticsPanelController } from './diagnostics-panel';

type ReplaySelection = { runRecordId: string; dataRevision: string; requestedTime: string };
type DictionarySummary = {
  id?: string;
  dictionaryId?: string;
  name?: string;
  fileName: string;
  dataSources?: string[];
  fieldCount?: number;
  mappingDefinitionCount?: number;
};
type FolderLoadResult = {
  dictionaryId?: string;
  dictionaryName?: string;
  folderPath?: string;
  runRecordId: string;
  dataRevision: string;
  matchedFiles: string[];
  missingFiles: string[];
  unusedFiles: string[];
  importedMappings: number;
  sourceCount: number;
};
type DictionaryFolderState = Partial<FolderLoadResult> & {
  dictionaryId?: string;
  dictionaryName?: string;
  folderPath?: string;
};
type IndexedField = {
  functionName: string | null;
  symbolKind?: 'struct_field' | 'member' | 'global' | 'symbol' | string;
  memberName: string | null;
  variablePath: string | null;
  ownerType?: string | null;
  accessOwnerType?: string | null;
  declaringType?: string | null;
  valueType?: string | null;
  qualifiedName?: string | null;
  declarationFile?: string | null;
  definitionFile?: string | null;
  declarationLine?: number | null;
  definitionLine?: number | null;
  rootStorageKind?: string | null;
  variableDeclarationKind?: string | null;
  variableDeclarationType?: string | null;
  expression: string;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
};
type InstanceEvidence = {
  index: number | null;
  status?: string;
  message?: string;
  evidence: {
    value?: string;
    matchType: string;
    csvColumn?: string;
    sourceName?: string;
    sampledTime?: string;
    offsetMs?: number;
    reason?: string;
  };
};
type InstanceResult = { status: string; message?: string; instances: InstanceEvidence[] };
type SeriesPoint = { requestedTime: string; sampledTime: string; value?: string; matchType: string; offsetMs?: number; csvColumn: string; sourceName: string };
type SeriesStatistics = { pointCount: number; min: number | string | null; max: number | string | null; changeCount: number };
type SeriesInstance = {
  index: number | null;
  points: SeriesPoint[];
  statistics: SeriesStatistics;
  sampled?: boolean;
  totalPointCount?: number;
};
type FieldSeriesResult = { status: string; message?: string; codeField?: Record<string, unknown>; instances: SeriesInstance[] };
type MappingSummary = {
  mappingSource?: string;
  confidence?: string;
  instanceCount?: number;
  description?: string;
  mappingFile?: string;
  mappingFileRow?: number;
  definitionPath?: string;
  sourceOwnerType?: string;
  targetLabel?: string;
  allInstances?: boolean;
};
type HoverEvidence = {
  range: vscode.Range;
  expression: string;
  values: InstanceEvidence[];
  series?: FieldSeriesResult;
  mapping?: MappingSummary;
  statusMessage?: string;
};
type ReplayTime = { requestedTime: string; sampledTime: string; rowNumber: number; context: Record<string, string> };
type ReplayTimesResult = {
  times: ReplayTime[];
  sampled?: boolean;
  returnedCount?: number;
  totalRows?: number;
};
type ReplayTimeChoice = vscode.QuickPickItem & { requestedTime?: string; manual?: boolean };
type StructCodeFieldIdentity = {
  targetKind?: 'struct_field' | 'member';
  cppTarget?: string;
  typeName?: string;
  ownerType?: string;
  fieldName?: string;
  definitionPath?: string;
  module?: string;
  variablePath?: string;
  valueType?: string;
};
type GlobalCodeFieldIdentity = {
  targetKind: 'global' | 'symbol';
  cppTarget?: string;
  qualifiedName?: string;
  codeSymbol?: string;
  definitionPath?: string;
  module?: string;
  valueType?: string;
};
type CodeFieldIdentity = StructCodeFieldIdentity | GlobalCodeFieldIdentity;
type MappedField = {
  codeField: CodeFieldIdentity;
  instanceCount: number;
  mappingSource?: string;
  confidence?: string;
  description?: string;
  mappingFile?: string;
  mappingFileRow?: number;
  dictionaryFile?: string;
  dictionaryRow?: number;
  definitionPath?: string;
};
type FunctionCodeLensSummary = {
  functionName: string;
  line: number;
  mappedCount: number;
  dataCount: number;
  changedCount?: number;
  mappedFieldKeys: string[];
};
type IndexedResult = {
  fields: IndexedField[];
  analyzer?: string;
  performance?: {
    cacheHit?: boolean;
    totalMs?: number;
    clangdMs?: number;
    parsedFunctionCount?: number;
    semanticQueryCount?: number;
  };
};
type SnapshotResult = {
  status: string;
  runRecordId: string;
  dataRevision?: string;
  requestedTime: string;
  results: InstanceResult[];
};
type StructuralIndexCacheEntry = {
  key: string;
  documentUri: string;
  result: IndexedResult;
};
type DataQualitySource = {
  sourceId: string;
  sourceName: string;
  schema: { columns: string[]; timeColumn: string; timeFormat: string };
  rowCount: number;
  timeRange: { startTime: number | null; endTime: number | null };
  duplicateTimestampCount: number;
  nonMonotonicCount: number;
  medianIntervalMs: number | null;
  largeGapCount: number;
  largeGapThresholdMs: number | null;
};
type WebOpenLocation = {
  filePath: string;
  workspaceRoot?: string;
  line?: number;
  column?: number;
};

let selection: ReplaySelection | undefined;
let dictionaryFolder: DictionaryFolderState = {};
let embeddedBackend: Worker | undefined;
let embeddedBackendUrl: string | undefined;
let activeBackendUrl: string | undefined;
let backendWindowSessionId: string | undefined;
let backendConnectionMode: 'standalone' | 'embedded' | undefined;
let standaloneSessionAbort: AbortController | undefined;
let webLocationListener: ((location: WebOpenLocation) => void) | undefined;
let backendStartup: Promise<void> = Promise.resolve();
let backendStartupError: Error | undefined;
const REPLAY_STATE_KEY = 'replaySelection';
const DICTIONARY_FOLDER_STATE_KEY = 'dictionaryFolderSelection';
const COMPILE_COMMANDS_STATE_KEY = 'compileCommandsPathSelection';
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:47831';
const EXPECTED_BACKEND_API_VERSION = '0.10';
const hoverEvidence = new Map<string, HoverEvidence[]>();
const decoration = vscode.window.createTextEditorDecorationType({
  after: {
    margin: '0 0 0 1rem',
    color: new vscode.ThemeColor('editorInfo.foreground'),
    fontWeight: 'bold'
  }
});

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function settings() {
  return vscode.workspace.getConfiguration('cppCsvDiagnostics');
}

function backendUrl(): string {
  return (activeBackendUrl ?? settings().get<string>('backendUrl', DEFAULT_BACKEND_URL)).replace(/\/$/, '');
}

class BackendRequestError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
  }
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  await backendStartup;
  if (backendStartupError) throw backendStartupError;
  return fetchJsonAt<T>(backendUrl(), path, body, signal);
}

async function fetchJsonAt<T>(url: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new BackendRequestError(result.error ?? `后端请求失败：${response.status}`, result);
  return result;
}

type BackendHealth = { product?: string; apiVersion?: string; version?: string; runtimeMode?: string };

async function backendHealth(url: string, timeoutMs = 1000): Promise<BackendHealth | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json() as BackendHealth;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function compatibleBackend(health: BackendHealth | undefined): boolean {
  return health?.product === 'code-runtime-analyzer' && health.apiVersion === EXPECTED_BACKEND_API_VERSION;
}

function isDefaultBackendUrl(url: string): boolean {
  try {
    return new URL(url).href === new URL(DEFAULT_BACKEND_URL).href;
  } catch {
    return false;
  }
}

async function embeddedWorkerModulePath(context: vscode.ExtensionContext): Promise<string> {
  const packaged = context.asAbsolutePath(path.join('backend', 'src', 'worker-server.mjs'));
  const root = workspaceRoot();
  const development = root ? path.join(root, 'backend', 'src', 'worker-server.mjs') : undefined;
  const candidates = [...new Set([packaged, development].filter((candidate): candidate is string => Boolean(candidate)))];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(`扩展内未找到 backend/src/worker-server.mjs（已检查：${candidates.join('；')}）`);
}

async function startEmbeddedBackend(context: vscode.ExtensionContext): Promise<void> {
  const modulePath = await embeddedWorkerModulePath(context);
  const webSessionId = randomUUID();
  const worker = new Worker(pathToFileURL(modulePath), {
    workerData: { host: '127.0.0.1', port: 0, webSessionId }
  });
  try {
    const ready = await new Promise<{ host: string; port: number }>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('独立诊断后端启动超过 10 秒')), 10_000);
      const finish = <T>(callback: (value: T) => void, value: T) => {
        clearTimeout(timer);
        worker.off('error', onError);
        worker.off('exit', onExit);
        worker.off('message', onMessage);
        callback(value);
      };
      const onError = (error: Error) => finish(rejectPromise, error);
      const onExit = (code: number) => finish(rejectPromise, new Error(`独立诊断后端提前退出：${code}`));
      const onMessage = (message: { type?: string; host?: string; port?: number; message?: string }) => {
        if (message.type === 'error') finish(rejectPromise, new Error(message.message ?? '独立诊断后端启动失败'));
        if (message.type === 'ready' && message.host && message.port) {
          finish(resolvePromise, { host: message.host, port: message.port });
        }
      };
      worker.once('error', onError);
      worker.once('exit', onExit);
      worker.on('message', onMessage);
    });
    embeddedBackend = worker;
    embeddedBackendUrl = `http://${ready.host}:${ready.port}`;
    activeBackendUrl = embeddedBackendUrl;
    backendWindowSessionId = webSessionId;
    backendConnectionMode = 'embedded';
    worker.on('message', (message: { type?: string; location?: WebOpenLocation }) => {
      if (message.type === 'web-open-function' && message.location) webLocationListener?.(message.location);
    });
  } catch (error) {
    backendWindowSessionId = undefined;
    backendConnectionMode = undefined;
    activeBackendUrl = undefined;
    await worker.terminate();
    throw error;
  }
}

async function closeStandaloneSession(): Promise<void> {
  const controller = standaloneSessionAbort;
  const sessionId = backendConnectionMode === 'standalone' ? backendWindowSessionId : undefined;
  const url = backendConnectionMode === 'standalone' ? activeBackendUrl : undefined;
  standaloneSessionAbort = undefined;
  controller?.abort();
  if (url && sessionId) {
    await fetchJsonAt(url, '/api/web/sessions/unregister', { windowSessionId: sessionId }).catch(() => undefined);
  }
  if (backendConnectionMode === 'standalone') {
    activeBackendUrl = undefined;
    backendWindowSessionId = undefined;
    backendConnectionMode = undefined;
  }
}

async function connectStandaloneSession(url: string): Promise<void> {
  await closeStandaloneSession();
  const registered = await fetchJsonAt<{ windowSessionId: string }>(url, '/api/web/sessions/register', {
    clientName: 'VS Code 扩展',
    workspaceRoot: workspaceRoot()
  });
  activeBackendUrl = url;
  backendWindowSessionId = registered.windowSessionId;
  backendConnectionMode = 'standalone';
  const controller = new AbortController();
  standaloneSessionAbort = controller;
  void (async () => {
    while (!controller.signal.aborted && backendWindowSessionId === registered.windowSessionId) {
      try {
        const result = await fetchJsonAt<{ status: string; location?: WebOpenLocation }>(url, '/api/web/sessions/poll', {
          windowSessionId: registered.windowSessionId,
          timeoutMs: 20_000
        }, controller.signal);
        if (result.status === 'event' && result.location) webLocationListener?.(result.location);
        if (result.status === 'missing' || result.status === 'closed') break;
      } catch (error) {
        if (controller.signal.aborted) break;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000));
      }
    }
  })();
}

async function ensureBackendAvailable(context: vscode.ExtensionContext): Promise<void> {
  const configuredUrl = settings().get<string>('backendUrl', DEFAULT_BACKEND_URL).replace(/\/$/, '');
  const mode = settings().get<'auto' | 'standalone' | 'embedded'>('backendMode', 'auto');
  if (mode !== 'embedded') {
    const health = await backendHealth(configuredUrl);
    if (compatibleBackend(health)) {
      await connectStandaloneSession(configuredUrl);
      return;
    }
    if (health && !compatibleBackend(health)) {
      throw new Error(`已找到后台 ${configuredUrl}，但版本不兼容：需要 API ${EXPECTED_BACKEND_API_VERSION}，当前为 ${health.apiVersion ?? '未知'}。`);
    }
    if (mode === 'standalone' || !isDefaultBackendUrl(configuredUrl)) {
      throw new Error(`无法连接独立后台 ${configuredUrl}。请启动 Code Runtime Analyzer 后台，或把 backendMode 改为“自动”。`);
    }
  }
  if (embeddedBackendUrl && compatibleBackend(await backendHealth(embeddedBackendUrl))) {
    activeBackendUrl = embeddedBackendUrl;
    backendConnectionMode = 'embedded';
    return;
  }
  await startEmbeddedBackend(context);
  if (!embeddedBackendUrl || !compatibleBackend(await backendHealth(embeddedBackendUrl, 2000))) {
    throw new Error('扩展已尝试启动本地诊断后端，但健康检查仍未通过。');
  }
}

async function closeEmbeddedBackend(): Promise<void> {
  const worker = embeddedBackend;
  embeddedBackend = undefined;
  embeddedBackendUrl = undefined;
  if (backendConnectionMode === 'embedded') {
    activeBackendUrl = undefined;
    backendWindowSessionId = undefined;
    backendConnectionMode = undefined;
  }
  if (!worker) return;
  const stopped = new Promise<void>((resolvePromise) => {
    const done = () => resolvePromise();
    worker.once('exit', done);
    worker.on('message', (message: { type?: string }) => {
      if (message.type === 'stopped') done();
    });
  });
  worker.postMessage({ type: 'shutdown' });
  await Promise.race([stopped, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
  if (worker.threadId !== -1) await worker.terminate();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return (stat.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

function compileCommandsRank(uri: vscode.Uri): number {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = folder
    ? path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
    : vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  if (relativePath === 'compile_commands.json') return 0;
  if (relativePath.startsWith('build/')) return 1;
  return 2;
}

async function discoverCompileCommandsPath(context: vscode.ExtensionContext): Promise<string | undefined> {
  const configured = settings().get<string>('compileCommandsPath', '').trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : workspaceRoot() ? path.resolve(workspaceRoot()!, configured) : configured;
  }

  const remembered = context.workspaceState.get<string>(COMPILE_COMMANDS_STATE_KEY);
  if (remembered && await fileExists(remembered)) return remembered;
  if (remembered) await context.workspaceState.update(COMPILE_COMMANDS_STATE_KEY, undefined);

  const candidates = await vscode.workspace.findFiles(
    '**/compile_commands.json',
    '**/{node_modules,.git}/**',
    100
  );
  candidates.sort((left, right) => {
    const rankDifference = compileCommandsRank(left) - compileCommandsRank(right);
    if (rankDifference !== 0) return rankDifference;
    return vscode.workspace.asRelativePath(left, true).localeCompare(vscode.workspace.asRelativePath(right, true));
  });
  if (candidates.length === 0) return undefined;

  let selected = candidates[0];
  if (candidates.length > 1) {
    const items = candidates.map((uri) => ({
      label: vscode.workspace.asRelativePath(uri, true),
      description: compileCommandsRank(uri) === 0 ? '工作区根目录' : compileCommandsRank(uri) === 1 ? 'build 目录' : '其他目录',
      detail: uri.fsPath,
      uri
    }));
    const choice = await vscode.window.showQuickPick(items, {
      title: '选择 C/C++ 编译数据库',
      placeHolder: '找到多个 compile_commands.json，请选择当前工程使用的一个'
    });
    if (!choice) return undefined;
    selected = choice.uri;
  }

  await context.workspaceState.update(COMPILE_COMMANDS_STATE_KEY, selected.fsPath);
  return selected.fsPath;
}

function compactValues(values: InstanceEvidence[]): string {
  const lead = values.slice(0, 4).map((item) => `${instanceLabel(item.index)}:${item.evidence.matchType === 'none' ? '无数据' : item.evidence.value ?? '—'}`).join(' | ');
  return values.length > 4 ? `${lead} | … 共 ${values.length} 个` : lead;
}

function replayTimeDescription(time: ReplayTime): string {
  return Object.entries(time.context).map(([key, value]) => `${key}=${value}`).join(' · ');
}

function instanceLabel(index: number | null | undefined): string {
  return index === null || index === undefined ? '值' : `i=${index}`;
}

function mappedFieldIdentityKey(field: CodeFieldIdentity): string {
  const definitionPath = normalizedDefinitionPath(field.definitionPath);
  return isGlobalCodeField(field)
    ? `global\u0000${globalSymbol(field)}\u0000${definitionPath}`
    : `struct\u0000${normalizeCppType(structTarget(field).typeName)}\u0000${structTarget(field).fieldName}\u0000${definitionPath}`;
}

function isGlobalCodeField(field: CodeFieldIdentity): field is GlobalCodeFieldIdentity {
  return field.targetKind === 'global' || field.targetKind === 'symbol' || 'qualifiedName' in field || 'codeSymbol' in field;
}

function globalSymbol(field: GlobalCodeFieldIdentity): string {
  return field.cppTarget ?? field.qualifiedName ?? field.codeSymbol ?? '';
}

function structTarget(field: StructCodeFieldIdentity): { typeName: string; fieldName: string } {
  if (field.typeName && field.fieldName) return { typeName: field.typeName, fieldName: field.fieldName };
  const target = field.cppTarget ?? '';
  const separator = target.lastIndexOf('::');
  return separator > 0
    ? { typeName: target.slice(0, separator), fieldName: target.slice(separator + 2) }
    : { typeName: field.typeName ?? '', fieldName: field.fieldName ?? target };
}

function normalizeCppType(value: string | null | undefined): string {
  if (!value) return '';
  let normalized = value.trim().replace(/^(?:struct|class|union)\s+/, '');
  normalized = normalized.replace(/^(?:(?:const|volatile)\s+)+/, '');
  normalized = normalized.replace(/\s+(?:(?:const|volatile)\s*)+$/, '');
  normalized = normalized.replace(/\s*(?:&&|&|\*)\s*$/, '').trim();
  return normalized;
}

function normalizedDefinitionPath(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function comparableFilePath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function definitionFileMatches(indexed: IndexedField, mapped: MappedField): boolean {
  const definitionPath = normalizedDefinitionPath(mapped.codeField.definitionPath ?? mapped.definitionPath);
  if (!definitionPath) return true;
  if (!indexed.definitionFile || path.posix.isAbsolute(definitionPath) || /^[A-Za-z]:\//.test(definitionPath)) return false;

  const segments = definitionPath.split('/').filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return false;
  const actual = comparableFilePath(indexed.definitionFile);
  return Boolean(vscode.workspace.workspaceFolders?.some((folder) => {
    const expected = vscode.Uri.joinPath(folder.uri, ...segments).fsPath;
    return comparableFilePath(expected) === actual;
  }));
}

function codeFieldLabel(field: CodeFieldIdentity): string {
  return isGlobalCodeField(field)
    ? globalSymbol(field) || '未命名全局变量'
    : `${structTarget(field).typeName}::${structTarget(field).fieldName}`;
}

function codeFieldPathLabel(field: CodeFieldIdentity): string {
  return isGlobalCodeField(field)
    ? globalSymbol(field) || '未命名全局变量'
    : codeFieldLabel(field);
}

function fieldMatchesMapping(indexed: IndexedField, mapped: MappedField): boolean {
  const codeField = mapped.codeField;
  if (!definitionFileMatches(indexed, mapped)) return false;
  if (isGlobalCodeField(codeField)) {
    if (indexed.symbolKind !== 'global' && indexed.symbolKind !== 'symbol') return false;
    const indexedName = indexed.qualifiedName;
    return Boolean(indexedName && indexedName === globalSymbol(codeField));
  }
  const target = structTarget(codeField);
  if (!indexed.memberName || indexed.memberName !== target.fieldName) return false;
  const ownerType = normalizeCppType(indexed.declaringType ?? indexed.ownerType);
  const mappedType = normalizeCppType(target.typeName);
  if (!ownerType || !mappedType || ownerType !== mappedType) return false;
  const indexedValueType = normalizeCppType(indexed.valueType);
  const mappedValueType = normalizeCppType(codeField.valueType);
  return !(indexedValueType && mappedValueType && indexedValueType !== mappedValueType);
}

function chooseMappedField(indexed: IndexedField, mappedFields: MappedField[]): { mappedField?: MappedField; ambiguous: boolean } {
  const candidates = mappedFields.filter((mapped) => fieldMatchesMapping(indexed, mapped));
  return { mappedField: candidates.length === 1 ? candidates[0] : undefined, ambiguous: candidates.length > 1 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markdownText(value: unknown): string {
  return String(value).replace(/([\\`*_[\]{}()<>#+\-.!|])/g, '\\$1');
}

function inlineCode(value: unknown): string {
  return `\`${String(value).replace(/`/g, 'ˋ').replace(/[\r\n]+/g, ' ')}\``;
}

function functionCodeLensLine(document: vscode.TextDocument, functionName: string, fallbackLine: number): number {
  const pattern = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`);
  for (let line = fallbackLine; line >= Math.max(0, fallbackLine - 100); line -= 1) {
    if (pattern.test(document.lineAt(line).text)) return line;
  }
  return fallbackLine;
}

function neighboringPoints(instance: SeriesInstance | undefined, requestedTime: string | undefined): string | undefined {
  if (!instance || !requestedTime || instance.points.length === 0) return undefined;
  const target = Number(requestedTime);
  let currentIndex = instance.points.findIndex((point) => point.requestedTime === requestedTime);
  if (currentIndex < 0 && Number.isFinite(target)) {
    currentIndex = instance.points.reduce((best, point, index) => {
      const bestDistance = Math.abs(Number(instance.points[best].requestedTime) - target);
      return Math.abs(Number(point.requestedTime) - target) < bestDistance ? index : best;
    }, 0);
  }
  if (currentIndex < 0) return undefined;
  const previous = markdownText(instance.points[currentIndex - 1]?.value ?? '—');
  const current = markdownText(instance.points[currentIndex]?.value ?? '—');
  const next = markdownText(instance.points[currentIndex + 1]?.value ?? '—');
  return `${previous} → **${current}** → ${next}`;
}

function evidenceHoverMarkdown(items: HoverEvidence[]): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**时间点快照**　${inlineCode(selection?.requestedTime ?? '未选择')}\n\n`);
  for (const item of items) {
    markdown.appendMarkdown(`**${markdownText(item.expression)}**\n\n`);
    if (item.mapping) {
      markdown.appendMarkdown(`映射：${markdownText(item.mapping.mappingSource ?? '未知来源')} / ${markdownText(item.mapping.confidence ?? '未知置信度')}；实例 ${item.mapping.instanceCount ?? item.values.length}\n\n`);
      if (item.mapping.sourceOwnerType && item.mapping.targetLabel) {
        markdown.appendMarkdown(`类型对应：${inlineCode(item.mapping.sourceOwnerType)} → ${inlineCode(item.mapping.targetLabel)}\n\n`);
      }
      if (item.mapping.description) markdown.appendMarkdown(`说明：${markdownText(item.mapping.description)}\n\n`);
      if (item.mapping.mappingFile) {
        markdown.appendMarkdown(`字段字典：${inlineCode(item.mapping.mappingFile)}${item.mapping.mappingFileRow ? ` 第 ${item.mapping.mappingFileRow} 行` : ''}\n\n`);
      }
      if (item.mapping.definitionPath) {
        markdown.appendMarkdown(`C++ 定义：${inlineCode(item.mapping.definitionPath)}\n\n`);
      }
      if (item.mapping.allInstances) {
        markdown.appendMarkdown('> 这里展示该类型字段的全部实例快照；不把循环中的 `current/target` 冒充为某个确定下标。\n\n');
      }
    }
    if (item.statusMessage) markdown.appendMarkdown(`⚠ **${markdownText(item.statusMessage)}**\n\n`);
    if (item.values.length === 0) {
      markdown.appendMarkdown('- 暂无可展示的实例数据\n\n');
      continue;
    }
    for (const value of item.values) {
      const match = value.evidence.matchType === 'exact'
        ? '精确匹配'
        : value.evidence.matchType === 'nearest' ? '最近采样' : value.evidence.matchType === 'none' ? '无匹配数据' : value.evidence.matchType;
      const sampled = value.evidence.sampledTime ? `；采样 ${inlineCode(value.evidence.sampledTime)}` : '';
      const offset = value.evidence.offsetMs ? `；偏差 ${value.evidence.offsetMs} ms` : '';
      const seriesInstance = item.series?.instances.find((instance) => instance.index === value.index);
      const neighbors = neighboringPoints(seriesInstance, selection?.requestedTime);
      const statistics = seriesInstance?.statistics;
      const trend = neighbors ? `；前/当前/后：${neighbors}` : '';
      const stats = statistics ? `；范围 ${markdownText(statistics.min ?? '—')}～${markdownText(statistics.max ?? '—')}；变化 ${statistics.changeCount} 次` : '';
      const noData = value.evidence.matchType === 'none' ? `无数据（${value.evidence.reason ?? '所选时间没有匹配采样'}）` : value.evidence.value ?? '—';
      markdown.appendMarkdown(`- ${inlineCode(instanceLabel(value.index))} = **${markdownText(noData)}**；${match}${sampled}${offset}${trend}${stats}；${markdownText(value.evidence.sourceName ?? '未知来源')} / ${inlineCode(value.evidence.csvColumn ?? '未知列')}\n`);
    }
    markdown.appendMarkdown('\n');
  }
  return markdown;
}

async function mappedFieldsForRun(selection: ReplaySelection): Promise<MappedField[]> {
  const result = await postJson<{ fields: MappedField[] }>('/api/mappings/fields', selection);
  return result.fields;
}

async function seriesForField(selection: ReplaySelection, field: MappedField): Promise<FieldSeriesResult> {
  return postJson<FieldSeriesResult>('/api/evidence/series', {
    ...selection,
    codeField: field.codeField
  });
}

export function activate(context: vscode.ExtensionContext): void {
  // A prior session may remember the user's choices, but never resumes data
  // display automatically.  The user explicitly loads data and starts display
  // in each VS Code session.
  selection = undefined;
  dictionaryFolder = context.workspaceState.get<DictionaryFolderState>(DICTIONARY_FOLDER_STATE_KEY) ?? {};
  let displayEnabled = false;
  let loadingFolder = false;
  let editorRefreshTimer: NodeJS.Timeout | undefined;
  let refreshGeneration = 0;
  let activeRefreshController: AbortController | undefined;
  const codeLensSummaries = new Map<string, FunctionCodeLensSummary[]>();
  const structuralIndexCache = new Map<string, StructuralIndexCacheEntry>();
  const mappedFieldsCache = new Map<string, Promise<MappedField[]>>();
  const codeLensEmitter = new vscode.EventEmitter<void>();
  const output = vscode.window.createOutputChannel('C/C++ Historical Diagnostics');
  const qualityOutput = vscode.window.createOutputChannel('C/C++ Diagnostics - Data Quality');
  const diagnosticsPanel = new DiagnosticsPanelController();
  backendStartupError = undefined;
  backendStartup = ensureBackendAvailable(context).catch((error) => {
    backendStartupError = error instanceof Error ? error : new Error(String(error));
    output.appendLine(`诊断后端不可用：${backendStartupError.message}`);
    void vscode.window.showErrorMessage(`诊断后端不可用：${backendStartupError.message}`);
  });
  diagnosticsPanel.updateCurrent({
    dictionaryId: dictionaryFolder.dictionaryId,
    dictionaryName: dictionaryFolder.dictionaryName,
    folderPath: dictionaryFolder.folderPath,
    runRecordId: undefined,
    requestedTime: undefined,
    displayEnabled,
    status: '未启动展示',
    statusKind: 'idle'
  });
  // A restarted VS Code session intentionally has no loaded data. Do not show
  // an old file-match result as if the CSV folder had been loaded again.
  diagnosticsPanel.updateFolderSummary(undefined);
  output.appendLine(`扩展已激活（${context.extensionMode === vscode.ExtensionMode.Development ? '开发模式' : '安装模式'}）。`);
  context.subscriptions.push(output, qualityOutput, diagnosticsPanel, codeLensEmitter);
  context.subscriptions.push(decoration);

  function isPathInsideWorkspace(candidate: string, root: string): boolean {
    const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
    return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
  }

  async function openFunctionInThisWindow(location: WebOpenLocation): Promise<void> {
    const filePath = location.filePath?.trim();
    const root = workspaceRoot();
    if (!root || !filePath) {
      return void vscode.window.showWarningMessage('无法定位函数：请先打开对应的 C/C++ 工作区。');
    }
    const requestedRoot = location.workspaceRoot?.trim();
    const sameWorkspace = !requestedRoot || (process.platform === 'win32'
      ? path.resolve(requestedRoot).toLowerCase() === path.resolve(root).toLowerCase()
      : path.resolve(requestedRoot) === path.resolve(root));
    if (!sameWorkspace || !isPathInsideWorkspace(filePath, root)) {
      return void vscode.window.showWarningMessage('已拒绝网页定位请求：目标文件不在当前工作区内。');
    }
    const requestedLine = Number(location.line ?? 1);
    const requestedColumn = Number(location.column ?? 1);
    const line = Number.isInteger(requestedLine) && requestedLine > 0 ? requestedLine - 1 : 0;
    const column = Number.isInteger(requestedColumn) && requestedColumn > 0 ? requestedColumn - 1 : 0;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(filePath)));
      const safeLine = Math.min(line, Math.max(0, document.lineCount - 1));
      const safeColumn = Math.min(column, document.lineAt(safeLine).text.length);
      const position = new vscode.Position(safeLine, safeColumn);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`网页定位函数失败：${message}`);
      void vscode.window.showErrorMessage(`无法打开网页指定的代码位置：${message}`);
    }
  }

  async function openFunctionFromUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== '/open-function') return;
    const params = new URLSearchParams(uri.query);
    await openFunctionInThisWindow({
      filePath: params.get('filePath') ?? '',
      workspaceRoot: params.get('workspaceRoot') ?? undefined,
      line: Number(params.get('line') ?? '1'),
      column: Number(params.get('column') ?? '1')
    });
  }

  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri: (uri) => void openFunctionFromUri(uri)
  }));
  const receiveBoundWebLocation = (location: WebOpenLocation) => void openFunctionInThisWindow(location);
  webLocationListener = receiveBoundWebLocation;
  context.subscriptions.push({
    dispose() {
      if (webLocationListener === receiveBoundWebLocation) webLocationListener = undefined;
    }
  });

  function clearRenderedEvidence(): void {
    activeRefreshController?.abort();
    activeRefreshController = undefined;
    refreshGeneration += 1;
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(decoration, []);
    hoverEvidence.clear();
    codeLensSummaries.clear();
    codeLensEmitter.fire();
  }

  function clearDataCaches(): void {
    clearRenderedEvidence();
    mappedFieldsCache.clear();
  }

  async function clearAnalysisMemory(): Promise<void> {
    clearDataCaches();
    structuralIndexCache.clear();
    try {
      await postJson('/api/code/invalidate', {});
    } catch (error) {
      output.appendLine(`代码缓存清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function updateDisplayState(status?: string, statusKind: 'idle' | 'loading' | 'ready' | 'warning' | 'error' = 'idle'): void {
    diagnosticsPanel.updateCurrent({
      displayEnabled,
      status: status ?? (displayEnabled ? '正在展示当前可见文件' : '未启动展示'),
      statusKind
    });
  }

  async function cachedMappedFieldsForRun(currentSelection: ReplaySelection): Promise<MappedField[]> {
    const cacheKey = `${currentSelection.runRecordId}\u0000${currentSelection.dataRevision}`;
    let pending = mappedFieldsCache.get(cacheKey);
    if (!pending) {
      pending = mappedFieldsForRun(currentSelection).catch((error) => {
        mappedFieldsCache.delete(cacheKey);
        throw error;
      });
      mappedFieldsCache.set(cacheKey, pending);
    }
    return pending;
  }

  function rememberStructuralIndex(key: string, documentUri: string, result: IndexedResult): void {
    structuralIndexCache.delete(key);
    structuralIndexCache.set(key, { key, documentUri, result });
  }

  function releaseHiddenCodeCaches(): void {
    const visible = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));
    for (const [key, entry] of structuralIndexCache) {
      if (!visible.has(entry.documentUri)) structuralIndexCache.delete(key);
    }
  }

  function releaseHiddenPresentationCaches(): void {
    const visible = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));
    for (const key of hoverEvidence.keys()) if (!visible.has(key)) hoverEvidence.delete(key);
    for (const key of codeLensSummaries.keys()) if (!visible.has(key)) codeLensSummaries.delete(key);
    codeLensEmitter.fire();
  }

  function invalidateDocumentCache(documentUri: string): void {
    for (const [key, entry] of structuralIndexCache) {
      if (entry.documentUri === documentUri) structuralIndexCache.delete(key);
    }
  }

  function targetHintsFor(mappedFields: MappedField[]): { members: string[]; globals: string[] } {
    const members = new Set<string>();
    const globals = new Set<string>();
    for (const mapped of mappedFields) {
      if (isGlobalCodeField(mapped.codeField)) {
        const symbol = globalSymbol(mapped.codeField).split('::').at(-1);
        if (symbol) globals.add(symbol);
      } else {
        const fieldName = structTarget(mapped.codeField).fieldName;
        if (fieldName) members.add(fieldName);
      }
    }
    return { members: [...members].sort(), globals: [...globals].sort() };
  }

  async function compileCommandsFingerprint(filePath: string): Promise<string> {
    const info = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return `${filePath}\u0000${info.size}\u0000${info.mtime}`;
  }

  async function saveDictionaryFolderState(): Promise<void> {
    await context.workspaceState.update(DICTIONARY_FOLDER_STATE_KEY, dictionaryFolder);
  }

  async function loadSelectedDictionaryFolder(openDemoSource = false): Promise<void> {
    const root = workspaceRoot();
    if (!root) throw new Error('请先以工作区方式打开 C/C++ 项目目录。');
    if (!dictionaryFolder.dictionaryId || !dictionaryFolder.folderPath) return;
    clearDataCaches();
    loadingFolder = true;
    diagnosticsPanel.updateCurrent({
      dictionaryId: dictionaryFolder.dictionaryId,
      dictionaryName: dictionaryFolder.dictionaryName,
      folderPath: dictionaryFolder.folderPath,
      status: '正在匹配字典与 CSV 文件',
      statusKind: 'loading'
    });
    try {
      const previousSelection = selection;
      const selectedDictionaryName = dictionaryFolder.dictionaryName;
      const rawResult = await postJson<FolderLoadResult>('/api/dictionaries/load-folder', {
        dictionaryId: dictionaryFolder.dictionaryId,
        folderPath: dictionaryFolder.folderPath,
        workspaceRoot: root
      });
      const result = {
        ...rawResult,
        dictionaryId: rawResult.dictionaryId ?? dictionaryFolder.dictionaryId,
        folderPath: rawResult.folderPath ?? dictionaryFolder.folderPath
      };
      dictionaryFolder = { ...result, dictionaryName: result.dictionaryName ?? selectedDictionaryName };
      await saveDictionaryFolderState();
      diagnosticsPanel.updateFolderSummary({
        matchedFiles: result.matchedFiles,
        missingFiles: result.missingFiles,
        unusedFiles: result.unusedFiles,
        importedMappings: result.importedMappings,
        sourceCount: result.sourceCount
      });
      diagnosticsPanel.updateDataQuality(undefined);

      const replay = await postJson<ReplayTimesResult>('/api/replay/times', {
        runRecordId: result.runRecordId,
        dataRevision: result.dataRevision,
        limit: 200
      });
      const preservedTime = previousSelection?.runRecordId === result.runRecordId
        && previousSelection.dataRevision === result.dataRevision
        && (replay.sampled || replay.times.some((time) => time.requestedTime === previousSelection.requestedTime))
        ? previousSelection.requestedTime
        : undefined;
      selection = {
        runRecordId: result.runRecordId,
        dataRevision: result.dataRevision,
        requestedTime: preservedTime ?? replay.times[0]?.requestedTime ?? ''
      };
      await context.workspaceState.update(REPLAY_STATE_KEY, selection);
      diagnosticsPanel.updateCurrent({
        dictionaryId: result.dictionaryId,
        dictionaryName: dictionaryFolder.dictionaryName,
        folderPath: result.folderPath,
        runRecordId: result.runRecordId,
        requestedTime: selection.requestedTime,
        status: result.missingFiles.length > 0
          ? `已加载，但缺少 ${result.missingFiles.length} 个文件`
          : `已匹配 ${result.matchedFiles.length} 个 CSV 文件`,
        statusKind: result.missingFiles.length > 0 ? 'warning' : 'ready',
        statusDetail: `导入 ${result.importedMappings} 条映射；${result.sourceCount} 个数据来源；${result.unusedFiles.length} 个未使用文件`
      });
      output.appendLine(`字典加载成功：${result.dictionaryId}；文件夹 ${result.folderPath}；匹配 ${result.matchedFiles.length}；缺少 ${result.missingFiles.length}；未使用 ${result.unusedFiles.length}。`);

      if (openDemoSource) {
        const demoSource = vscode.Uri.joinPath(vscode.Uri.file(root), 'labs', '2048_csv_replay', 'src', 'replay_scenario.cpp');
        try {
          await vscode.workspace.fs.stat(demoSource);
          const document = await vscode.workspace.openTextDocument(demoSource);
          await vscode.window.showTextDocument(document);
        } catch {
          // The selected dictionary may be used in another repository without the bundled demo source.
        }
      }

      const editor = vscode.window.activeTextEditor;
      if (selection.requestedTime && editor && ['c', 'cpp'].includes(editor.document.languageId)) {
        await vscode.commands.executeCommand('cppCsvDiagnostics.refresh');
      } else if (replay.times.length === 0) {
        diagnosticsPanel.updateCurrent({ status: 'CSV 文件中没有可用时间点', statusKind: 'warning' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BackendRequestError) {
        const matchedFiles = Array.isArray(error.details.matchedFiles) ? error.details.matchedFiles.filter((item): item is string => typeof item === 'string') : [];
        const missingFiles = Array.isArray(error.details.missingFiles) ? error.details.missingFiles.filter((item): item is string => typeof item === 'string') : [];
        const unusedFiles = Array.isArray(error.details.unusedFiles) ? error.details.unusedFiles.filter((item): item is string => typeof item === 'string') : [];
        if (matchedFiles.length > 0 || missingFiles.length > 0 || unusedFiles.length > 0) {
          diagnosticsPanel.updateFolderSummary({ matchedFiles, missingFiles, unusedFiles, importedMappings: 0, sourceCount: 0 });
        }
      }
      diagnosticsPanel.updateCurrent({ status: '字典或 CSV 文件夹加载失败', statusKind: 'error', statusDetail: message });
      output.appendLine(`字典文件夹加载失败：${message}`);
      throw error;
    } finally {
      loadingFolder = false;
    }
  }

  context.subscriptions.push(vscode.languages.registerCodeLensProvider([
    { language: 'c', scheme: 'file' },
    { language: 'cpp', scheme: 'file' }
  ], {
    onDidChangeCodeLenses: codeLensEmitter.event,
    provideCodeLenses(document) {
      return (codeLensSummaries.get(document.uri.toString()) ?? []).flatMap((summary) => {
        const line = Math.max(0, Math.min(summary.line, document.lineCount - 1));
        const range = new vscode.Range(line, 0, line, 0);
        return [
          new vscode.CodeLens(range, {
            title: `$(history) ${summary.functionName}：关联 ${summary.mappedCount}｜有数据 ${summary.dataCount}`,
            command: 'cppCsvDiagnostics.selectReplay'
          }),
          new vscode.CodeLens(range, {
            title: '$(graph-line) 查看历史趋势',
            command: 'cppCsvDiagnostics.openTrend',
            arguments: [summary.mappedFieldKeys]
          })
        ];
      });
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.selectDictionary', async () => {
    try {
      const result = await postJson<{ dictionaries: DictionarySummary[] }>('/api/dictionaries/list', {});
      if (result.dictionaries.length === 0) return void vscode.window.showWarningMessage('后端没有可用的字段字典。');
      const choices = result.dictionaries.map((dictionary) => ({
        id: dictionary.id ?? dictionary.dictionaryId ?? '',
        name: dictionary.name ?? dictionary.id ?? dictionary.dictionaryId ?? dictionary.fileName,
        dictionary
      })).filter((item) => item.id).map((item) => {
        const fieldCount = item.dictionary.fieldCount ?? item.dictionary.mappingDefinitionCount;
        return {
          label: `$(book) ${item.name}`,
          description: item.id,
          detail: `${item.dictionary.fileName}${fieldCount === undefined ? '' : `；${fieldCount} 个字段`}${item.dictionary.dataSources?.length ? `；${item.dictionary.dataSources.length} 个数据来源` : ''}`,
          ...item
        };
      });
      const choice = await vscode.window.showQuickPick(choices, {
        title: '选择字段字典',
        placeHolder: dictionaryFolder.dictionaryId ? `当前：${dictionaryFolder.dictionaryName ?? dictionaryFolder.dictionaryId}` : '请选择与当前代码仓对应的字典'
      });
      if (!choice) return;
      const changed = dictionaryFolder.dictionaryId !== choice.id;
      if (changed) {
        displayEnabled = false;
        clearDataCaches();
      }
      dictionaryFolder = {
        dictionaryId: choice.id,
        dictionaryName: choice.name,
        folderPath: dictionaryFolder.folderPath
      };
      if (changed) {
        selection = undefined;
        await context.workspaceState.update(REPLAY_STATE_KEY, undefined);
        diagnosticsPanel.updateDataQuality(undefined);
        diagnosticsPanel.updateFolderSummary(undefined);
      }
      await saveDictionaryFolderState();
      diagnosticsPanel.updateCurrent({
        dictionaryId: choice.id,
        dictionaryName: choice.name,
        folderPath: dictionaryFolder.folderPath,
        runRecordId: selection?.runRecordId,
        requestedTime: selection?.requestedTime,
        displayEnabled,
        status: dictionaryFolder.folderPath ? '已选择字典，请点击“加载 / 重新加载字典”' : '已选择字典，请选择 CSV 文件夹',
        statusKind: 'idle'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnosticsPanel.updateCurrent({ status: '选择字段字典失败', statusKind: 'error', statusDetail: message });
      void vscode.window.showErrorMessage(`选择字段字典失败：${message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.selectDataFolder', async () => {
    const root = workspaceRoot();
    if (!root) return void vscode.window.showWarningMessage('请先打开一个 C/C++ 项目工作区。');
    const folders = await vscode.window.showOpenDialog({
      title: '选择包含运行 CSV 的文件夹',
      defaultUri: vscode.Uri.file(dictionaryFolder.folderPath ?? root),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '使用此 CSV 文件夹'
    });
    if (!folders?.[0]) return;
    displayEnabled = false;
    clearDataCaches();
    dictionaryFolder = {
      dictionaryId: dictionaryFolder.dictionaryId,
      dictionaryName: dictionaryFolder.dictionaryName,
      folderPath: folders[0].fsPath
    };
    selection = undefined;
    await Promise.all([
      saveDictionaryFolderState(),
      context.workspaceState.update(REPLAY_STATE_KEY, undefined)
    ]);
    diagnosticsPanel.updateDataQuality(undefined);
    diagnosticsPanel.updateFolderSummary(undefined);
    diagnosticsPanel.updateCurrent({
      dictionaryId: dictionaryFolder.dictionaryId,
      dictionaryName: dictionaryFolder.dictionaryName,
      folderPath: dictionaryFolder.folderPath,
      runRecordId: undefined,
      requestedTime: undefined,
      displayEnabled,
      status: dictionaryFolder.dictionaryId ? '已选择文件夹，请点击“加载 / 重新加载 CSV”' : '已选择文件夹，请选择字段字典',
      statusKind: 'idle'
    });
  }));

  async function reloadSelectedData(actionLabel: string): Promise<void> {
    if (!dictionaryFolder.dictionaryId || !dictionaryFolder.folderPath) {
      return void vscode.window.showWarningMessage('请先选择字段字典和 CSV 文件夹。');
    }
    displayEnabled = false;
    selection = undefined;
    await context.workspaceState.update(REPLAY_STATE_KEY, undefined);
    diagnosticsPanel.updateDataQuality(undefined);
    diagnosticsPanel.updateFolderSummary(undefined);
    await clearAnalysisMemory();
    updateDisplayState(`正在重新加载${actionLabel}`, 'loading');
    try {
      await loadSelectedDictionaryFolder();
      updateDisplayState(`${actionLabel}已加载；请点击“开始展示”`, 'ready');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateDisplayState(`${actionLabel}加载失败`, 'error');
      void vscode.window.showErrorMessage(`重新加载${actionLabel}失败：${message}`);
    }
  }

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.reloadDictionary', async () => {
    await reloadSelectedData('字典');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.reloadCsv', async () => {
    await reloadSelectedData('CSV');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.openWebWorkbench', async () => {
    const editor = vscode.window.activeTextEditor;
    const root = workspaceRoot();
    if (!root || !editor || !['c', 'cpp'].includes(editor.document.languageId)) {
      return void vscode.window.showWarningMessage('请先打开一个已保存的 C/C++ 源文件，再打开网页工作台。');
    }
    if (editor.document.isDirty) {
      return void vscode.window.showWarningMessage('请先保存当前 C/C++ 文件；网页调用链会严格按照磁盘文件和编译数据库分析。');
    }
    try {
      await backendStartup;
      if (backendStartupError) throw backendStartupError;
      if (!activeBackendUrl || !backendWindowSessionId) {
        return void vscode.window.showWarningMessage('当前后台还没有建立 VS Code 窗口会话，请重新加载窗口后再试。');
      }
      const compileCommandsPath = await discoverCompileCommandsPath(context);
      if (!compileCommandsPath) {
        return void vscode.window.showWarningMessage('未找到 compile_commands.json，无法确定当前文件的真实编译参数。');
      }
      const url = new URL(`${backendUrl()}/workbench/`);
      url.searchParams.set('workspaceRoot', root);
      url.searchParams.set('filePath', editor.document.uri.fsPath);
      url.searchParams.set('compileCommandsPath', compileCommandsPath);
      url.searchParams.set('focusLine', String(editor.selection.active.line + 1));
      url.searchParams.set('windowSessionId', backendWindowSessionId);
      if (dictionaryFolder.dictionaryId) url.searchParams.set('dictionaryId', dictionaryFolder.dictionaryId);
      if (dictionaryFolder.dictionaryName) url.searchParams.set('dictionaryName', dictionaryFolder.dictionaryName);
      if (selection?.runRecordId) url.searchParams.set('runRecordId', selection.runRecordId);
      if (selection?.dataRevision) url.searchParams.set('dataRevision', selection.dataRevision);
      if (selection?.requestedTime) url.searchParams.set('requestedTime', selection.requestedTime);
      await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`打开网页工作台失败：${message}`);
      void vscode.window.showErrorMessage(`打开网页工作台失败：${message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.toggleDisplay', async () => {
    if (displayEnabled) {
      displayEnabled = false;
      clearRenderedEvidence();
      closeTrendPanel();
      structuralIndexCache.clear();
      try {
        await postJson('/api/code/invalidate', {});
      } catch (error) {
        output.appendLine(`结束展示时释放代码缓存失败：${error instanceof Error ? error.message : String(error)}`);
      }
      updateDisplayState('已结束展示；字典和 CSV 仍保持已加载状态', 'idle');
      return;
    }
    if (!selection?.runRecordId || !selection.dataRevision || !selection.requestedTime) {
      return void vscode.window.showWarningMessage('请先选择字典和 CSV 文件夹，并点击“加载 / 重新加载字典”或“加载 / 重新加载 CSV”。');
    }
    displayEnabled = true;
    updateDisplayState('正在展示当前可见文件', 'loading');
    await vscode.commands.executeCommand('cppCsvDiagnostics.refresh');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.selectReplay', async () => {
    if (!selection?.runRecordId) {
      return void vscode.window.showWarningMessage('请先在右侧面板选择字段字典和 CSV 文件夹。');
    }
    const activeSelection = selection;
    let requestedTime: string | undefined;
    try {
      const result = await postJson<ReplayTimesResult>('/api/replay/times', { ...activeSelection, limit: 200 });
      const choices: ReplayTimeChoice[] = result.times.map((time, index) => ({
        label: `$(history) 时间点 ${index + 1}　${new Date(time.sampledTime).toLocaleString()}`,
        description: replayTimeDescription(time),
        detail: `原始时间：${time.requestedTime}；CSV 第 ${time.rowNumber} 行`,
        requestedTime: time.requestedTime
      }));
      if (result.sampled) {
        choices.push({
          label: `$(info) 数据量较大：这里均匀列出 ${result.returnedCount ?? result.times.length} 个代表时间点`,
          description: `CSV 共 ${result.totalRows ?? '很多'} 行；其他时间可手动输入`,
          kind: vscode.QuickPickItemKind.Separator
        });
      }
      choices.push({ label: '$(edit) 手动输入时间…', manual: true });
      const choice = await vscode.window.showQuickPick(choices, {
        title: '选择历史回放时间点',
        placeHolder: selection ? `当前：${selection.requestedTime}` : '请选择一个 CSV 采样时间'
      });
      if (!choice) return;
      requestedTime = choice.requestedTime;
      if (choice.manual) {
        requestedTime = await vscode.window.showInputBox({
          prompt: '故障时间（ISO-8601 或按日志配置的时间格式）',
          value: selection.requestedTime
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnosticsPanel.updateCurrent({ status: '读取回放时间点失败', statusKind: 'error', statusDetail: message });
      void vscode.window.showErrorMessage(`读取回放时间点失败：${message}`);
      return;
    }
    if (!requestedTime) return;
    clearRenderedEvidence();
    selection = { ...activeSelection, requestedTime };
    diagnosticsPanel.updateCurrent({
      runRecordId: activeSelection.runRecordId,
      requestedTime,
      status: '正在刷新所选时间点',
      statusKind: 'loading'
    });
    await context.workspaceState.update(REPLAY_STATE_KEY, selection);
    if (displayEnabled) await vscode.commands.executeCommand('cppCsvDiagnostics.refresh');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.load2048Demo', async () => {
    const root = workspaceRoot();
    if (!root) return void vscode.window.showErrorMessage('请先以工作区方式打开诊断项目目录。');
    const folderPath = vscode.Uri.joinPath(vscode.Uri.file(root), 'runs').fsPath;
    dictionaryFolder = { dictionaryId: '2048-demo', dictionaryName: '2048 演示', folderPath };
    await saveDictionaryFolderState();
    try {
      await reloadSelectedData('2048 演示');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnosticsPanel.updateCurrent({ status: '演示加载失败', statusKind: 'error', statusDetail: message });
      output.appendLine(`加载失败：${message}`);
      void vscode.window.showErrorMessage(`2048 演示加载失败：${message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.openTrend', async (mappedFieldKeys?: string[]) => {
    if (!displayEnabled) return void vscode.window.showWarningMessage('请先点击“开始展示”，再查看字段趋势。');
    if (!selection) return void vscode.window.showWarningMessage('请先选择运行记录和回放时间。');
    try {
      const allFields = await mappedFieldsForRun(selection);
      const fields = mappedFieldKeys && mappedFieldKeys.length > 0
        ? allFields.filter((field) => mappedFieldKeys.includes(mappedFieldIdentityKey(field.codeField)))
        : allFields;
      if (fields.length === 0) return void vscode.window.showWarningMessage('当前运行记录没有已确认的字段映射。');
      const choice = await vscode.window.showQuickPick(fields.map((field) => ({
        label: `$(graph-line) ${codeFieldPathLabel(field.codeField)}`,
        description: `${codeFieldLabel(field.codeField)} · ${field.instanceCount} 个实例 · ${field.mappingSource ?? '未知来源'} · ${field.confidence ?? '未知置信度'}`,
        detail: `${field.codeField.definitionPath ?? field.definitionPath ?? '定义位置未知'}${field.description ? `；${field.description}` : ''}`,
        field
      })), { title: '选择要查看的历史趋势字段' });
      if (!choice) return;
      const result = await seriesForField(selection, choice.field);
      if (result.status !== 'ok') return void vscode.window.showWarningMessage(result.message ?? '该字段没有可用趋势数据。');
      showTrendPanel(
        context.extensionUri,
        `${codeFieldPathLabel(choice.field.codeField)} 历史趋势`,
        codeFieldPathLabel(choice.field.codeField),
        result.instances.map((instance) => ({
          index: instance.index ?? 'value',
          label: instance.sampled
            ? `${instanceLabel(instance.index)}（抽样 ${instance.points.length}/${instance.totalPointCount ?? instance.statistics.pointCount}）`
            : instanceLabel(instance.index),
          statistics: instance.statistics,
          points: instance.points.map((point) => ({
            requestedTime: point.requestedTime,
            sampledTime: point.sampledTime,
            value: point.value ?? null,
            matchType: point.matchType,
            sourceName: point.sourceName,
            csvColumn: point.csvColumn
          }))
        }))
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`打开历史趋势失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.showDataQuality', async () => {
    if (!selection) return void vscode.window.showWarningMessage('请先选择运行记录。');
    try {
      const result = await postJson<{ sources: DataQualitySource[] }>('/api/data-quality', selection);
      qualityOutput.clear();
      qualityOutput.appendLine(`运行记录：${selection.runRecordId}`);
      qualityOutput.appendLine(`CSV 来源数量：${result.sources.length}`);
      for (const source of result.sources) {
        qualityOutput.appendLine('');
        qualityOutput.appendLine(`来源：${source.sourceName}（${source.sourceId}）`);
        qualityOutput.appendLine(`行数：${source.rowCount}；时间列：${source.schema.timeColumn}（${source.schema.timeFormat}）`);
        qualityOutput.appendLine(`范围：${source.timeRange.startTime === null ? '—' : new Date(source.timeRange.startTime).toLocaleString()} ～ ${source.timeRange.endTime === null ? '—' : new Date(source.timeRange.endTime).toLocaleString()}`);
        qualityOutput.appendLine(`重复时间：${source.duplicateTimestampCount}；非单调：${source.nonMonotonicCount}；大间隔：${source.largeGapCount}；中位采样间隔：${source.medianIntervalMs ?? '—'} ms`);
        qualityOutput.appendLine(`大间隔阈值：${source.largeGapThresholdMs ?? '—'} ms；列：${source.schema.columns.join(', ')}`);
      }
      qualityOutput.show(true);
      diagnosticsPanel.updateDataQuality({
        sourceCount: result.sources.length,
        totalRows: result.sources.reduce((total, source) => total + source.rowCount, 0),
        duplicateTimestampCount: result.sources.reduce((total, source) => total + source.duplicateTimestampCount, 0),
        nonMonotonicCount: result.sources.reduce((total, source) => total + source.nonMonotonicCount, 0),
        largeGapCount: result.sources.reduce((total, source) => total + source.largeGapCount, 0),
        medianIntervalMs: result.sources.length === 1 ? result.sources[0].medianIntervalMs : undefined,
        checkedAt: new Date().toISOString()
      });
      diagnosticsPanel.updateCurrent({ status: 'CSV 数据质量检查完成', statusKind: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnosticsPanel.updateCurrent({ status: 'CSV 数据质量检查失败', statusKind: 'error', statusDetail: message });
      void vscode.window.showErrorMessage(`数据质量检查失败：${message}`);
    }
  }));

  async function refreshEditor(editor: vscode.TextEditor): Promise<void> {
    if (!displayEnabled) return;
    if (!['c', 'cpp'].includes(editor.document.languageId)) return;
    if (!selection?.runRecordId) {
      diagnosticsPanel.updateCurrent({ status: '尚未加载字段字典和 CSV 文件夹', statusKind: 'warning' });
      return void vscode.window.showWarningMessage('请先在右侧面板选择字段字典和 CSV 文件夹。');
    }
    if (editor.document.isDirty) {
      const key = editor.document.uri.toString();
      editor.setDecorations(decoration, []);
      hoverEvidence.delete(key);
      codeLensSummaries.delete(key);
      codeLensEmitter.fire();
      diagnosticsPanel.updateCurrent({
        status: '代码有未保存修改',
        statusKind: 'warning',
        statusDetail: '为避免把磁盘旧位置贴到当前代码，保存后才会重新分析'
      });
      return;
    }
    const activeSelection = selection;
    activeRefreshController?.abort();
    const refreshController = new AbortController();
    activeRefreshController = refreshController;
    const generation = ++refreshGeneration;
    const documentVersion = editor.document.version;
    const documentUri = editor.document.uri.toString();
    const isStale = () => generation !== refreshGeneration
      || editor.document.version !== documentVersion
      || !displayEnabled
      || !vscode.window.visibleTextEditors.includes(editor)
      || selection?.runRecordId !== activeSelection.runRecordId
      || selection?.dataRevision !== activeSelection.dataRevision
      || selection?.requestedTime !== activeSelection.requestedTime;
    const compileCommands = await discoverCompileCommandsPath(context);
    if (isStale()) return;
    if (!compileCommands || !activeSelection.requestedTime) {
      diagnosticsPanel.updateCurrent({ status: '缺少编译数据库或回放时间', statusKind: 'error' });
      return void vscode.window.showErrorMessage('未找到或未选择 compile_commands.json，或者尚未选择回放时间。');
    }
    diagnosticsPanel.updateCurrent({
      runRecordId: activeSelection.runRecordId,
      requestedTime: activeSelection.requestedTime,
      status: '正在刷新历史值',
      statusKind: 'loading'
    });

    try {
      const configuredFunctionNames = settings().get<string[]>('functionNames', []);
      const clangdSetting = settings().get<string>('clangdPath', '').trim();
      const configuredClangdPath = clangdSetting && !path.isAbsolute(clangdSetting) && workspaceRoot()
        ? path.resolve(workspaceRoot()!, clangdSetting)
        : clangdSetting;
      const mappedFields = await cachedMappedFieldsForRun(activeSelection);
      if (isStale()) return;
      const targetHints = targetHintsFor(mappedFields);
      const compileFingerprint = await compileCommandsFingerprint(compileCommands);
      if (isStale()) return;
      const structuralKey = JSON.stringify({
        documentUri,
        documentVersion,
        compileFingerprint,
        configuredFunctionNames,
        configuredClangdPath,
        targetHints
      });
      let indexedResult = structuralIndexCache.get(structuralKey)?.result;
      const structuralCacheHit = Boolean(indexedResult);
      if (!indexedResult) {
        indexedResult = await postJson<IndexedResult>('/api/code/index', {
          compileCommandsPath: compileCommands,
          filePath: editor.document.uri.fsPath,
          targetHints,
          ...(configuredClangdPath ? { clangdPath: configuredClangdPath } : {}),
          ...(configuredFunctionNames.length > 0 ? { functionNames: configuredFunctionNames } : {})
        }, refreshController.signal);
        if (isStale()) return;
        rememberStructuralIndex(structuralKey, documentUri, indexedResult);
      }
      const indexedFields = indexedResult.fields;
      const resolvedFields = indexedFields.map((field) => ({ field, ...chooseMappedField(field, mappedFields) }));
      const uniqueMappedFields = new Map<string, MappedField>();
      for (const { mappedField } of resolvedFields) {
        if (!mappedField) continue;
        const key = mappedFieldIdentityKey(mappedField.codeField);
        if (!uniqueMappedFields.has(key)) uniqueMappedFields.set(key, mappedField);
      }
      const snapshotFields = [...uniqueMappedFields.values()];
      const snapshot = snapshotFields.length > 0
        ? await postJson<SnapshotResult>('/api/evidence/snapshot', {
            runRecordId: activeSelection.runRecordId,
            dataRevision: activeSelection.dataRevision,
            requestedTime: activeSelection.requestedTime,
            codeFields: snapshotFields.map((mappedField) => mappedField.codeField)
          }, refreshController.signal)
        : { status: 'ok', runRecordId: activeSelection.runRecordId, requestedTime: activeSelection.requestedTime, results: [] };
      if (isStale()) return;
      const evidenceResults = new Map<string, InstanceResult>();
      snapshotFields.forEach((mappedField, index) => {
        const result = snapshot.results[index];
        if (result) evidenceResults.set(mappedFieldIdentityKey(mappedField.codeField), result);
      });
      if (snapshot.results.length !== snapshotFields.length) {
        throw new Error(`批量快照返回数量不一致：请求 ${snapshotFields.length}，返回 ${snapshot.results.length}`);
      }

      const valuesByLine = new Map<number, string[]>();
      const evidenceByLine = new Map<number, HoverEvidence[]>();
      const localHoverEvidence: HoverEvidence[] = [];
      const summariesByFunction = new Map<string, FunctionCodeLensSummary>();
      const summaryFieldsByFunction = new Map<string, Set<string>>();
      const lineDisplayKeys = new Map<number, Set<string>>();
      let displayedFieldCount = 0;
      let dataFieldCount = 0;
      let ambiguousFieldCount = 0;
      for (const { field, mappedField, ambiguous } of resolvedFields) {
        const range = new vscode.Range(field.range.start.line - 1, field.range.start.column - 1, field.range.end.line - 1, field.range.end.column - 1);
        const line = field.range.start.line - 1;
        const sourceLabel = field.memberName ?? field.qualifiedName ?? field.expression;
        if (ambiguous) {
          ambiguousFieldCount += 1;
          const lineValues = valuesByLine.get(line) ?? [];
          lineValues.push(`${sourceLabel}: 映射有歧义`);
          valuesByLine.set(line, lineValues);
          const fieldEvidence: HoverEvidence = {
            range,
            expression: field.expression,
            values: [],
            statusMessage: '同一 C++ 类型字段或全局符号对应多条字典规则，扩展拒绝猜测，请修正字段字典'
          };
          localHoverEvidence.push(fieldEvidence);
          const lineEvidence = evidenceByLine.get(line) ?? [];
          lineEvidence.push(fieldEvidence);
          evidenceByLine.set(line, lineEvidence);
          continue;
        }
        if (!mappedField) continue;
        const key = mappedFieldIdentityKey(mappedField.codeField);
        const instances = evidenceResults.get(key);
        if (!instances) continue;
        const hasData = instances.status === 'ok' && instances.instances.some((item) => item.evidence.matchType !== 'none');
        const statusMessage = instances.status !== 'ok'
          ? instances.message ?? `查询状态：${instances.status}`
          : hasData ? undefined : '所选时间没有匹配的 CSV 采样';
        const lineValues = valuesByLine.get(line) ?? [];
        const displayedOnLine = lineDisplayKeys.get(line) ?? new Set<string>();
        if (!displayedOnLine.has(key)) {
          lineValues.push(hasData
            ? `${sourceLabel}: ${compactValues(instances.instances)}`
            : `${sourceLabel}: 无数据（${statusMessage}）`);
          displayedOnLine.add(key);
          lineDisplayKeys.set(line, displayedOnLine);
        }
        valuesByLine.set(line, lineValues);
        displayedFieldCount += 1;
        if (hasData) dataFieldCount += 1;
        const fieldEvidence: HoverEvidence = {
          range,
          expression: field.expression,
          values: instances.instances,
          mapping: {
            mappingSource: mappedField.mappingSource,
            confidence: mappedField.confidence,
            instanceCount: mappedField.instanceCount,
            description: mappedField.description,
            mappingFile: mappedField.dictionaryFile ?? mappedField.mappingFile,
            mappingFileRow: mappedField.dictionaryRow ?? mappedField.mappingFileRow,
            definitionPath: mappedField.codeField.definitionPath ?? mappedField.definitionPath,
            sourceOwnerType: field.ownerType ?? undefined,
            targetLabel: codeFieldLabel(mappedField.codeField),
            allInstances: mappedField.instanceCount > 1
          },
          statusMessage
        };
        localHoverEvidence.push(fieldEvidence);
        const lineEvidence = evidenceByLine.get(line) ?? [];
        lineEvidence.push(fieldEvidence);
        evidenceByLine.set(line, lineEvidence);

        const functionName = field.functionName ?? '全局';
        const functionSummary = summariesByFunction.get(functionName) ?? {
          functionName,
          line: functionCodeLensLine(editor.document, functionName, line),
          mappedCount: 0,
          dataCount: 0,
          mappedFieldKeys: []
        };
        functionSummary.line = Math.min(functionSummary.line, functionCodeLensLine(editor.document, functionName, line));
        const summaryFields = summaryFieldsByFunction.get(functionName) ?? new Set<string>();
        const identityKey = mappedFieldIdentityKey(mappedField.codeField);
        if (!summaryFields.has(identityKey)) {
          summaryFields.add(identityKey);
          functionSummary.mappedCount += 1;
          if (hasData) functionSummary.dataCount += 1;
          functionSummary.mappedFieldKeys.push(identityKey);
        }
        summaryFieldsByFunction.set(functionName, summaryFields);
        summariesByFunction.set(functionName, functionSummary);
      }
      if (isStale()) return;
      const options: vscode.DecorationOptions[] = [...valuesByLine.entries()].map(([line, values]) => {
        const lineEnd = editor.document.lineAt(line).range.end;
        return {
          range: new vscode.Range(lineEnd, lineEnd),
          hoverMessage: evidenceHoverMarkdown(evidenceByLine.get(line) ?? []),
          renderOptions: { after: { contentText: `  时间点快照｜${values.join(' ｜ ')}` } }
        };
      });
      editor.setDecorations(decoration, options);
      hoverEvidence.set(editor.document.uri.toString(), localHoverEvidence);
      codeLensSummaries.set(editor.document.uri.toString(), [...summariesByFunction.values()]);
      codeLensEmitter.fire();
      diagnosticsPanel.updateCurrent({
        runRecordId: activeSelection.runRecordId,
        requestedTime: activeSelection.requestedTime,
        status: displayedFieldCount > 0
          ? `${dataFieldCount}/${displayedFieldCount} 个字段有数据`
          : '当前文件没有可匹配字段',
        statusKind: displayedFieldCount > 0 && ambiguousFieldCount === 0 ? 'ready' : 'warning',
        statusDetail: `运行 ${activeSelection.runRecordId}；回放时间 ${activeSelection.requestedTime}；歧义 ${ambiguousFieldCount}；代码结构${structuralCacheHit || indexedResult.performance?.cacheHit ? '已缓存' : `冷分析 ${Math.round(indexedResult.performance?.totalMs ?? 0)}ms`}`
      });
      output.appendLine(`刷新成功：${activeSelection.requestedTime}，发现 ${displayedFieldCount} 个映射字段，${dataFieldCount} 个有数据，${ambiguousFieldCount} 个有歧义；代码结构缓存=${structuralCacheHit || indexedResult.performance?.cacheHit === true}。`);
    } catch (error) {
      if (isStale()) return;
      editor.setDecorations(decoration, []);
      hoverEvidence.delete(editor.document.uri.toString());
      codeLensSummaries.delete(editor.document.uri.toString());
      codeLensEmitter.fire();
      const message = error instanceof Error ? error.message : String(error);
      diagnosticsPanel.updateCurrent({ status: '历史回放失败', statusKind: 'error', statusDetail: message });
      output.appendLine(`刷新失败：${message}`);
      void vscode.window.showErrorMessage(`历史回放失败：${message}`);
    }
  }

  async function refreshVisibleEditors(): Promise<void> {
    const editors = [...new Map(vscode.window.visibleTextEditors
      .filter((editor) => ['c', 'cpp'].includes(editor.document.languageId))
      .map((editor) => [editor.document.uri.toString(), editor])).values()];
    if (editors.length === 0) {
      diagnosticsPanel.updateCurrent({ status: '没有可展示的 C/C++ 文件', statusKind: 'warning' });
      return;
    }
    for (const editor of editors) {
      if (!displayEnabled) return;
      await refreshEditor(editor);
    }
  }

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.refresh', async () => {
    if (!displayEnabled) {
      return void vscode.window.showInformationMessage('当前未启动展示。请在右侧“历史诊断”面板点击“开始展示”。');
    }
    await refreshVisibleEditors();
  }));

  context.subscriptions.push(vscode.languages.registerHoverProvider([
    { language: 'c', scheme: 'file' },
    { language: 'cpp', scheme: 'file' }
  ], {
    provideHover(document, position) {
      const evidence = hoverEvidence.get(document.uri.toString()) ?? [];
      const directItems = evidence.filter((item) => item.range.contains(position));
      const lineEnd = document.lineAt(position.line).range.end;
      const lineEndItems = position.character >= lineEnd.character
        ? evidence.filter((item) => item.range.start.line === position.line)
        : [];
      const items = directItems.length > 0 ? directItems : lineEndItems;
      if (items.length === 0) return undefined;
      return new vscode.Hover(evidenceHoverMarkdown(items), directItems[0]?.range ?? new vscode.Range(lineEnd, lineEnd));
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!['c', 'cpp'].includes(event.document.languageId)) return;
    const key = event.document.uri.toString();
    activeRefreshController?.abort();
    activeRefreshController = undefined;
    refreshGeneration += 1;
    invalidateDocumentCache(key);
    hoverEvidence.delete(key);
    codeLensSummaries.delete(key);
    codeLensEmitter.fire();
    const visibleEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === key);
    if (visibleEditor) {
      visibleEditor.setDecorations(decoration, []);
      diagnosticsPanel.updateCurrent({
        status: '代码已修改，保存后重新计算',
        statusKind: 'warning',
        statusDetail: '保存文件后会重新计算历史值位置'
      });
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (!['c', 'cpp'].includes(document.languageId)) return;
    invalidateDocumentCache(document.uri.toString());
    void (async () => {
      try {
        await postJson('/api/code/invalidate', { filePath: document.uri.fsPath });
      } catch (error) {
        output.appendLine(`代码索引缓存失效失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (displayEnabled && vscode.window.visibleTextEditors.some((editor) => editor.document === document) && selection) {
        await vscode.commands.executeCommand('cppCsvDiagnostics.refresh');
      }
    })();
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    activeRefreshController?.abort();
    activeRefreshController = undefined;
    refreshGeneration += 1;
    if (!displayEnabled || !editor || !selection || loadingFolder || !['c', 'cpp'].includes(editor.document.languageId)) return;
    if (editorRefreshTimer) clearTimeout(editorRefreshTimer);
    editorRefreshTimer = setTimeout(() => {
      void vscode.commands.executeCommand('cppCsvDiagnostics.refresh');
    }, 150);
  }));

  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    releaseHiddenCodeCaches();
    releaseHiddenPresentationCaches();
    if (displayEnabled && selection && !loadingFolder) {
      void vscode.commands.executeCommand('cppCsvDiagnostics.refresh');
    }
  }));

  setTimeout(() => {
    void vscode.commands.executeCommand('workbench.view.extension.cppCsvDiagnostics');
  }, 300);
}

export async function deactivate(): Promise<void> {
  await closeStandaloneSession();
  await closeEmbeddedBackend();
}
