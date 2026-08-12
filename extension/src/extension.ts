import * as vscode from 'vscode';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { closeTrendPanel, showTrendPanel } from './trend-panel';
import { DiagnosticsPanelController } from './diagnostics-panel';
import {
  buildEditorCallGraph,
  indexMappedFieldsWithEditor,
  probeEditorCapabilities,
  type EditorCapabilityProbe,
  type SemanticCapability,
  type SemanticState
} from './editor-semantic';
import {
  CompatibilityReportController,
  type CompatibilityItem,
  type CompatibilityItemState,
  type CompatibilityReport
} from './compatibility-report';

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
type WebSemanticRequest = {
  requestId: string;
  operation: string;
  payload: unknown;
};

let selection: ReplaySelection | undefined;
let dictionaryFolder: DictionaryFolderState = {};
let embeddedBackend: Worker | undefined;
let embeddedBackendUrl: string | undefined;
let activeBackendUrl: string | undefined;
let activeBackendAccessToken: string | undefined;
let backendWindowSessionId: string | undefined;
let backendConnectionMode: 'standalone' | 'embedded' | undefined;
let standaloneSessionAbort: AbortController | undefined;
let webLocationListener: ((location: WebOpenLocation) => void) | undefined;
let webSemanticRequestListener: ((request: WebSemanticRequest) => void) | undefined;
let backendStartup: Promise<void> = Promise.resolve();
let backendStartupError: Error | undefined;
let retryBackendConnection: (() => Promise<void>) | undefined;
const REPLAY_STATE_KEY = 'replaySelection';
const DICTIONARY_FOLDER_STATE_KEY = 'dictionaryFolderSelection';
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

function workspaceRoot(uri?: vscode.Uri): string | undefined {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  return (target ? vscode.workspace.getWorkspaceFolder(target) : undefined)?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
  if (backendStartupError && retryBackendConnection) await retryBackendConnection();
  if (backendStartupError) throw backendStartupError;
  return fetchJsonAt<T>(backendUrl(), path, body, signal);
}

async function fetchJsonAt<T>(url: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const accessToken = url === activeBackendUrl ? activeBackendAccessToken : undefined;
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { 'x-code-runtime-analyzer-token': accessToken } : {})
    },
    body: JSON.stringify(body),
    signal
  });
  const result = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new BackendRequestError(result.message ?? result.error ?? `后端请求失败：${response.status}`, { ...result, httpStatus: response.status });
  return result;
}

type BackendHealth = { product?: string; apiVersion?: string; version?: string; runtimeMode?: string };
type BackendHealthProbe = {
  health?: BackendHealth;
  issue?: 'timeout' | 'unreachable' | 'http-error' | 'invalid-response';
  detail?: string;
  code?: string;
  httpStatus?: number;
};

async function probeBackendHealth(url: string, timeoutMs = 1000, accessToken?: string): Promise<BackendHealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, {
      signal: controller.signal,
      headers: accessToken ? { 'x-code-runtime-analyzer-token': accessToken } : undefined
    });
    const text = await response.text();
    if (!response.ok) return { issue: 'http-error', httpStatus: response.status, detail: text.slice(0, 500) };
    try {
      return { health: JSON.parse(text) as BackendHealth };
    } catch {
      return { issue: 'invalid-response', detail: text.slice(0, 500) };
    }
  } catch (error) {
    const code = (error as Error & { cause?: { code?: string }; code?: string }).cause?.code
      ?? (error as Error & { code?: string }).code;
    return {
      issue: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
      code
    };
  } finally {
    clearTimeout(timer);
  }
}

async function backendHealth(url: string, timeoutMs = 1000, accessToken?: string): Promise<BackendHealth | undefined> {
  return (await probeBackendHealth(url, timeoutMs, accessToken)).health;
}

type StandaloneConnection = { baseUrl: string; accessToken?: string };

async function standaloneConnection(): Promise<StandaloneConnection | undefined> {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(
      process.env.LOCALAPPDATA, 'CodeRuntimeAnalyzer', 'service-state.json'
    )));
    const state = JSON.parse(new TextDecoder().decode(bytes)) as { baseUrl?: unknown; port?: unknown; accessToken?: unknown };
    if (typeof state.baseUrl !== 'string') return undefined;
    const url = new URL(state.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return undefined;
    if (Number(url.port) !== Number(state.port)) return undefined;
    return {
      baseUrl: url.origin,
      accessToken: typeof state.accessToken === 'string' && state.accessToken ? state.accessToken : undefined
    };
  } catch {
    return undefined;
  }
}

async function standaloneBackendInstalled(): Promise<boolean> {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return false;
  return fileExists(path.join(
    process.env.LOCALAPPDATA,
    'Programs',
    'CodeRuntimeAnalyzer',
    'backend',
    'src',
    'launcher.mjs'
  ));
}

function standaloneConnectionMessage(url: string, probe: BackendHealthProbe, installed: boolean): string {
  if (!installed && isDefaultBackendUrl(url)) {
    return '这台电脑没有检测到独立后台。普通用户把后台模式改为“自动”即可；需要 Web 或 OpenCode 时，请单独安装同一版本的后台 EXE。';
  }
  if (probe.issue === 'timeout') return `独立后台 ${url} 连接超时。可能被安全软件拦截，请在后台控制中心导出诊断报告。`;
  if (probe.issue === 'http-error' && probe.httpStatus === 401) return '已经找到独立后台，但当前用户保存的本机访问密钥已经失效。请在后台控制中心点击“重新启动”，然后在扩展中重新检测。';
  if (probe.issue === 'http-error') return `地址 ${url} 返回 HTTP ${probe.httpStatus ?? '错误'}，不是可用的后台健康接口。`;
  if (probe.issue === 'invalid-response') return `端口 ${url} 有响应，但内容不是 Code Runtime Analyzer 后台；可能被其他程序占用。`;
  return `独立后台已经安装，但 ${url} 当前没有响应${probe.code ? `（${probe.code}）` : ''}。请从开始菜单打开后台控制中心并选择“启动后台”或“导出诊断报告”。`;
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
  const worker = new Worker(pathToFileURL(modulePath), {
    workerData: { host: '127.0.0.1', port: 0 }
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
    worker.on('message', (message: { type?: string; location?: WebOpenLocation }) => {
      if (message.type === 'web-open-function' && message.location) webLocationListener?.(message.location);
    });
    await connectBackendSession(embeddedBackendUrl, 'embedded');
  } catch (error) {
    backendWindowSessionId = undefined;
    backendConnectionMode = undefined;
    activeBackendUrl = undefined;
    activeBackendAccessToken = undefined;
    await worker.terminate();
    throw error;
  }
}

async function closeStandaloneSession(): Promise<void> {
  const controller = standaloneSessionAbort;
  const sessionId = backendWindowSessionId;
  const url = activeBackendUrl;
  const accessToken = activeBackendAccessToken;
  standaloneSessionAbort = undefined;
  controller?.abort();
  if (url && sessionId) {
    activeBackendAccessToken = accessToken;
    await fetchJsonAt(url, '/api/web/sessions/unregister', { windowSessionId: sessionId }).catch(() => undefined);
  }
  activeBackendUrl = undefined;
  activeBackendAccessToken = undefined;
  backendWindowSessionId = undefined;
  backendConnectionMode = undefined;
}

async function connectBackendSession(url: string, mode: 'standalone' | 'embedded', accessToken?: string): Promise<void> {
  await closeStandaloneSession();
  activeBackendUrl = url;
  activeBackendAccessToken = accessToken;
  let registered: { windowSessionId: string };
  try {
    registered = await fetchJsonAt<{ windowSessionId: string }>(url, '/api/web/sessions/register', {
      clientName: '编辑器连接插件',
      workspaceRoot: workspaceRoot(),
      capabilities: {
        semanticBridge: true,
        operations: ['callHierarchy'],
        revealLocation: true,
        lineDecorations: true
      },
      environment: {
        appName: vscode.env.appName,
        appVersion: vscode.version,
        appHost: vscode.env.appHost,
        uriScheme: vscode.env.uriScheme
      }
    });
  } catch (error) {
    activeBackendUrl = undefined;
    activeBackendAccessToken = undefined;
    throw error;
  }
  backendWindowSessionId = registered.windowSessionId;
  backendConnectionMode = mode;
  const controller = new AbortController();
  standaloneSessionAbort = controller;
  void (async () => {
    while (!controller.signal.aborted && backendWindowSessionId === registered.windowSessionId) {
      try {
        const result = await fetchJsonAt<{
          status: string;
          location?: WebOpenLocation;
          requestId?: string;
          operation?: string;
          payload?: unknown;
        }>(url, '/api/web/sessions/poll', {
          windowSessionId: registered.windowSessionId,
          timeoutMs: 20_000
        }, controller.signal);
        if (result.status === 'event' && result.location) webLocationListener?.(result.location);
        if (result.status === 'semanticRequest' && result.requestId && result.operation) {
          webSemanticRequestListener?.({
            requestId: result.requestId,
            operation: result.operation,
            payload: result.payload
          });
        }
        if (result.status === 'missing' || result.status === 'closed') {
          if (backendWindowSessionId === registered.windowSessionId) {
            backendWindowSessionId = undefined;
            activeBackendUrl = undefined;
            activeBackendAccessToken = undefined;
            backendConnectionMode = undefined;
            backendStartupError = new Error('后台已经重启或当前窗口会话已失效，请重新检测后自动连接。');
          }
          if (standaloneSessionAbort === controller) standaloneSessionAbort = undefined;
          break;
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        if (error instanceof BackendRequestError && error.details.httpStatus === 401) {
          if (backendWindowSessionId === registered.windowSessionId) {
            backendWindowSessionId = undefined;
            activeBackendUrl = undefined;
            activeBackendAccessToken = undefined;
            backendConnectionMode = undefined;
            backendStartupError = new Error('后台已经重新启动，本机访问密钥已更新；请重新检测后自动连接。');
          }
          break;
        }
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000));
      }
    }
  })();
}

async function ensureBackendAvailable(context: vscode.ExtensionContext): Promise<void> {
  const configuredUrl = settings().get<string>('backendUrl', DEFAULT_BACKEND_URL).replace(/\/$/, '');
  const mode = settings().get<'auto' | 'standalone' | 'embedded'>('backendMode', 'auto');
  if (mode !== 'embedded') {
    const discovered = isDefaultBackendUrl(configuredUrl) ? await standaloneConnection() : undefined;
    const connection = discovered ?? { baseUrl: configuredUrl, accessToken: undefined };
    const probe = await probeBackendHealth(connection.baseUrl, 1000, connection.accessToken);
    const health = probe.health;
    if (compatibleBackend(health)) {
      await connectBackendSession(connection.baseUrl, 'standalone', connection.accessToken);
      return;
    }
    if (health && !compatibleBackend(health)) {
      throw new Error(`已找到后台 ${connection.baseUrl}，但版本不兼容：需要 API ${EXPECTED_BACKEND_API_VERSION}，当前为 ${health.apiVersion ?? '未知'}。`);
    }
    if (mode === 'standalone' || !isDefaultBackendUrl(configuredUrl)) {
      throw new Error(standaloneConnectionMessage(connection.baseUrl, probe, await standaloneBackendInstalled()));
    }
  }
  if (embeddedBackendUrl && compatibleBackend(await backendHealth(embeddedBackendUrl))) {
    if (!backendWindowSessionId || activeBackendUrl !== embeddedBackendUrl) {
      await connectBackendSession(embeddedBackendUrl, 'embedded');
    }
    return;
  }
  await startEmbeddedBackend(context);
  if (!embeddedBackendUrl || !backendWindowSessionId || activeBackendUrl !== embeddedBackendUrl) {
    throw new Error('扩展自带后台已经启动，但没有建立当前编辑器窗口的连接。请打开“编辑器兼容性详细解释”查看真实原因。');
  }
}

async function closeEmbeddedBackend(): Promise<void> {
  const worker = embeddedBackend;
  embeddedBackend = undefined;
  embeddedBackendUrl = undefined;
  if (backendConnectionMode === 'embedded') {
    activeBackendUrl = undefined;
    activeBackendAccessToken = undefined;
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
  const compatibilityReport = new CompatibilityReportController();
  let compatibilityTimer: NodeJS.Timeout | undefined;
  let compatibilityGeneration = 0;
  function beginBackendConnection(showNotification: boolean): Promise<void> {
    backendStartupError = undefined;
    const attempt = ensureBackendAvailable(context).catch((error) => {
      backendStartupError = error instanceof Error ? error : new Error(String(error));
      output.appendLine(`诊断后端不可用：${backendStartupError.message}`);
      if (showNotification) void vscode.window.showErrorMessage(`诊断后端不可用：${backendStartupError.message}`);
    });
    backendStartup = attempt;
    return attempt;
  }
  retryBackendConnection = () => beginBackendConnection(false);
  backendStartup = beginBackendConnection(false);
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
  context.subscriptions.push(output, qualityOutput, diagnosticsPanel, compatibilityReport, codeLensEmitter);
  context.subscriptions.push(decoration);

  function isPathInsideWorkspace(candidate: string, root: string): boolean {
    const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
    return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
  }

  async function openFunctionInThisWindow(location: WebOpenLocation): Promise<void> {
    const filePath = location.filePath?.trim();
    const root = filePath ? workspaceRoot(vscode.Uri.file(filePath)) : workspaceRoot();
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

  async function answerSemanticRequest(request: WebSemanticRequest): Promise<void> {
    const sessionId = backendWindowSessionId;
    const url = activeBackendUrl;
    if (!sessionId || !url) return;
    let response: {
      status: 'ok' | 'noEvidence' | 'unsupported' | 'notReady' | 'error';
      result?: unknown;
      error?: string;
    };
    try {
      if (request.operation !== 'callHierarchy') {
        response = {
          status: 'unsupported',
          error: `当前编辑器连接插件暂不支持语义操作：${request.operation}`
        };
      } else {
        const payload = request.payload && typeof request.payload === 'object'
          ? request.payload as Record<string, unknown>
          : {};
        const filePath = typeof payload.filePath === 'string' ? payload.filePath.trim() : '';
        const targetUri = filePath ? vscode.Uri.file(filePath) : undefined;
        const root = workspaceRoot(targetUri);
        if (!filePath || !root || !isPathInsideWorkspace(filePath, root)) {
          throw new Error('调用关系请求的目标文件不在当前编辑器工作区内。');
        }
        const graph = await buildEditorCallGraph({
          filePath,
          line: Number(payload.line ?? 1),
          column: Number(payload.column ?? 1),
          documentVersion: payload.documentVersion === undefined ? undefined : Number(payload.documentVersion)
        });
        const status = graph.semanticStatus === 'available' ? 'ok'
          : graph.semanticStatus === 'noEvidence' ? 'noEvidence'
            : graph.semanticStatus === 'unsupported' ? 'unsupported'
              : graph.semanticStatus === 'notReady' || graph.semanticStatus === 'timeout' ? 'notReady' : 'error';
        response = status === 'error' || status === 'unsupported' || status === 'notReady'
          ? { status, error: graph.statusDetail }
          : { status, result: graph };
      }
    } catch (error) {
      response = {
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
    }
    try {
      await fetchJsonAt(url, '/api/web/editor/semantic/respond', {
        windowSessionId: sessionId,
        requestId: request.requestId,
        ...response
      });
    } catch (error) {
      output.appendLine(`返回编辑器语义结果失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const receiveSemanticRequest = (request: WebSemanticRequest) => void answerSemanticRequest(request);
  webSemanticRequestListener = receiveSemanticRequest;
  context.subscriptions.push({
    dispose() {
      if (webSemanticRequestListener === receiveSemanticRequest) webSemanticRequestListener = undefined;
    }
  });

  function compatibilityEnvironment(): CompatibilityReport['environment'] {
    return {
      appName: vscode.env.appName,
      appVersion: vscode.version,
      appHost: vscode.env.appHost,
      uriScheme: vscode.env.uriScheme
    };
  }

  function semanticCompatibilityItem(
    id: string,
    label: string,
    capability: SemanticCapability,
    meaning: string,
    nextStep: string
  ): CompatibilityItem {
    const state: CompatibilityItemState = capability.state === 'available' ? 'ready'
      : capability.state === 'unsupported' ? 'unsupported'
        : capability.state === 'failed' ? 'error'
          : capability.state === 'notReady' || capability.state === 'timeout' ? 'waiting' : 'partial';
    return {
      id,
      label,
      state,
      short: capability.summary,
      meaning,
      observed: capability.detail,
      nextStep: state === 'ready' ? '不需要设置，可以直接使用。' : nextStep,
      technical: capability.technical
    };
  }

  function waitingCompatibilityReport(): CompatibilityReport {
    const backendReady = Boolean(activeBackendUrl && backendWindowSessionId && !backendStartupError);
    const editor = vscode.window.activeTextEditor;
    const cppReady = Boolean(editor && ['c', 'cpp'].includes(editor.document.languageId));
    const items: CompatibilityItem[] = [
      {
        id: 'backend',
        label: '后台服务',
        state: backendReady ? 'ready' : backendStartupError ? 'error' : 'waiting',
        short: backendReady ? '已经连接' : backendStartupError ? '连接失败' : '正在连接',
        meaning: '后台负责在网页和当前编辑器窗口之间转发请求。',
        observed: backendReady
          ? '连接插件已经获得当前窗口会话，网页可以安全地回到这个窗口。'
          : backendStartupError?.message ?? '连接插件正在等待本机后台响应。',
        nextStep: backendReady ? '不需要设置。' : '启动“Code Runtime Analyzer”后台后点击“重新检测”。',
        technical: backendStartupError?.message
      },
      {
        id: 'project',
        label: '当前代码文件',
        state: cppReady ? 'ready' : 'waiting',
        short: cppReady ? '已经识别' : '等待打开',
        meaning: '实际的类型和函数能力必须在一个真实 C/C++ 文件中检测。',
        observed: cppReady ? `当前文件语言为 ${editor?.document.languageId.toUpperCase()}。` : '当前没有激活的 .c 或 .cpp 文件。',
        nextStep: cppReady ? '不需要设置。' : '请在这个编辑器窗口中打开代码仓，再打开一个 .c 或 .cpp 文件。'
      },
      {
        id: 'navigation', label: '代码定位', state: 'waiting', short: '等待实际测试',
        meaning: '网页点击函数后，工具能否回到当前窗口的正确代码位置。',
        observed: '打开 C/C++ 文件后会自动测试。', nextStep: '打开一个包含函数的 C/C++ 文件。'
      },
      {
        id: 'types', label: '字段类型识别', state: 'waiting', short: '等待实际测试',
        meaning: '历史值只有在编辑器确认字段定义和类型后才会展示。',
        observed: '打开 C/C++ 文件后会自动测试。', nextStep: '把光标放到一个变量或字段上，然后重新检测。'
      },
      {
        id: 'calls', label: '函数调用关系', state: 'waiting', short: '等待实际测试',
        meaning: '网页能否查看当前函数的直接调用者和被调用函数。',
        observed: '打开 C/C++ 文件后会自动测试。', nextStep: '把光标放到函数名或函数体内，然后重新检测。'
      },
      {
        id: 'right-report', label: '详细检测面板', state: 'ready', short: '在代码右边打开',
        meaning: '即使当前编辑器把树形入口放在左侧，详细解释也会在代码区域右边打开。',
        observed: '连接插件使用编辑器的相邻编辑区显示详细检测结果，不依赖右侧栏贡献点。',
        nextStep: '点击“查看详细解释”即可。'
      }
    ];
    return {
      overall: backendStartupError ? 'error' : 'waiting',
      headline: backendStartupError ? '当前还不能使用' : cppReady ? '正在检查编辑器能力' : '等待打开 C/C++ 文件',
      summary: backendStartupError
        ? '后台连接没有建立。下面已经写明原因和下一步，不需要你判断技术版本。'
        : cppReady ? '正在用当前文件实际测试代码定位、类型和调用关系。' : '连接插件已经启动；打开真实代码文件后会自动继续。',
      items,
      checkedAt: new Date().toISOString(),
      environment: compatibilityEnvironment()
    };
  }

  async function runCompatibilityCheck(showReport = false): Promise<CompatibilityReport> {
    const generation = ++compatibilityGeneration;
    const waiting = waitingCompatibilityReport();
    compatibilityReport.update(waiting);
    diagnosticsPanel.updateCompatibility(waiting);
    await Promise.race([
      backendStartup,
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 8_000))
    ]);
    if (backendStartupError) {
      await Promise.race([
        beginBackendConnection(false),
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 8_000))
      ]);
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['c', 'cpp'].includes(editor.document.languageId)) {
      const result = waitingCompatibilityReport();
      if (generation === compatibilityGeneration) {
        compatibilityReport.update(result);
        diagnosticsPanel.updateCompatibility(result);
        if (showReport) compatibilityReport.show();
      }
      return result;
    }
    let probe: EditorCapabilityProbe;
    try {
      probe = await probeEditorCapabilities(editor.document, editor.selection.active);
    } catch (error) {
      const failed: SemanticCapability = {
        state: 'failed',
        summary: '检测请求失败',
        detail: '当前编辑器没有完成代码能力检测。可以复制诊断信息继续排查。',
        technical: error instanceof Error ? error.message : String(error)
      };
      probe = {
        documentSymbols: failed,
        definition: failed,
        typeDefinition: failed,
        references: failed,
        callHierarchy: failed,
        inlayHints: failed
      };
    }
    const backendReady = Boolean(activeBackendUrl && backendWindowSessionId && !backendStartupError);
    const typeCompatibility: CompatibilityItem = probe.typeDefinition.state === 'available'
      && probe.definition.state === 'available'
      && probe.documentSymbols.state === 'available'
      ? semanticCompatibilityItem(
          'types', '字段类型识别', probe.typeDefinition,
          '历史值展示前，工具能否取得字段定义位置和所属类型的明确证据。',
          '把光标放到一个变量或结构体字段上，再点击“重新检测”。'
        )
      : probe.definition.state === 'available' || probe.typeDefinition.state === 'available'
        ? {
            id: 'types', label: '字段类型识别', state: 'partial', short: '类型证据还不完整',
            meaning: '历史值展示前，工具必须同时确认字段定义位置和所属类型。',
            observed: `定义定位：${probe.definition.detail} 类型定义：${probe.typeDefinition.detail} 代码结构：${probe.documentSymbols.detail} 这三类证据没有同时通过，因此不会把其中一项成功冒充成“类型已确认”。`,
            nextStep: '把光标放到一个结构体字段或有明确类型的变量上，再点击“重新检测”。',
            technical: probe.typeDefinition.technical
          }
        : semanticCompatibilityItem(
            'types', '字段类型识别', probe.typeDefinition.state === 'noEvidence' ? probe.definition : probe.typeDefinition,
            '历史值展示前，工具能否取得字段定义位置和所属类型的明确证据。',
            '把光标放到一个变量或结构体字段上，再点击“重新检测”。'
          );
    const items: CompatibilityItem[] = [
      {
        id: 'backend', label: '后台服务', state: backendReady ? 'ready' : 'error',
        short: backendReady ? '已经连接' : '连接失败',
        meaning: '后台负责把网页请求准确送回打开网页的这个编辑器窗口。',
        observed: backendReady ? '已经建立当前窗口专属会话。' : backendStartupError?.message ?? '没有建立窗口会话。',
        nextStep: backendReady ? '不需要设置。' : '启动本机后台，然后点击“重新检测”。',
        technical: backendStartupError?.message
      },
      {
        id: 'project', label: '当前代码文件', state: 'ready', short: '已经识别',
        meaning: '检测必须基于用户当前真正打开的 C/C++ 文件。',
        observed: `已经在当前编辑器中读取 ${editor.document.languageId.toUpperCase()} 文件，文档版本 ${editor.document.version}。`,
        nextStep: '不需要设置。'
      },
      semanticCompatibilityItem(
        'navigation', '代码定位', probe.definition,
        '网页点击一个函数后，能否回到当前编辑器窗口并定位到定义。',
        '把光标放到一个函数名或变量名上，然后点击“重新检测”。'
      ),
      typeCompatibility,
      semanticCompatibilityItem(
        'references', '代码引用查询', probe.references,
        '工具能否询问当前符号在代码中的引用位置。',
        '把光标放到一个有引用的函数或变量上，再点击“重新检测”。'
      ),
      semanticCompatibilityItem(
        'calls', '函数调用关系', probe.callHierarchy,
        '网页能否展示当前函数的直接调用者和被调用函数。',
        '把光标放到函数名或函数体内，等待代码索引完成后重新检测。'
      ),
      {
        id: 'right-report', label: '详细检测面板', state: 'ready', short: '在代码右边打开',
        meaning: '即使定制编辑器不支持真正的右侧栏，详细解释也不会挤进左侧资源管理器。',
        observed: '详细报告使用相邻编辑区打开，这是当前编辑器已经提供的稳定能力。',
        nextStep: '点击“查看详细解释”即可。'
      }
    ];
    const semanticItems = items.filter((item) => ['navigation', 'types', 'references', 'calls'].includes(item.id));
    const overall: CompatibilityItemState = !backendReady ? 'error'
      : semanticItems.every((item) => item.state === 'ready') ? 'ready'
        : semanticItems.some((item) => item.state === 'ready') ? 'partial'
          : semanticItems.some((item) => item.state === 'error') ? 'error'
            : semanticItems.some((item) => item.state === 'unsupported') ? 'unsupported' : 'waiting';
    const result: CompatibilityReport = {
      overall,
      headline: overall === 'ready' ? '可以正常使用'
        : overall === 'partial' ? '可以使用部分功能'
          : overall === 'error' ? '能力检测失败'
            : overall === 'unsupported' ? '当前缺少必要代码能力' : '编辑器能力尚未确认',
      summary: overall === 'ready'
        ? '后台、代码定位、类型证据和函数调用关系均已通过实际请求检测。'
        : overall === 'partial'
          ? '已经有部分能力可用；暂不可用的项目不会阻止其他功能，下面写明了各自原因。'
          : overall === 'error'
            ? '后台或编辑器语言能力检测失败。下面保留了真实原因和下一步。'
            : overall === 'unsupported'
              ? '当前编辑器明确没有提供必要能力。下面会说明受影响的功能。'
              : '当前文件没有返回足够证据，可能仍在索引。换一个有定义和调用关系的函数后重新检测。',
      items,
      checkedAt: new Date().toISOString(),
      environment: compatibilityEnvironment()
    };
    if (generation === compatibilityGeneration) {
      compatibilityReport.update(result);
      diagnosticsPanel.updateCompatibility(result);
      output.appendLine(`编辑器兼容性检测：${result.headline}。`);
      if (showReport) compatibilityReport.show();
    }
    return result;
  }

  function scheduleCompatibilityCheck(delayMs = 500): void {
    if (compatibilityTimer) clearTimeout(compatibilityTimer);
    compatibilityTimer = setTimeout(() => { void runCompatibilityCheck(false); }, delayMs);
  }

  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.runCompatibilityCheck', async () => {
    await runCompatibilityCheck(true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.showCompatibilityReport', async () => {
    if (!compatibilityReport.current()) await runCompatibilityCheck(false);
    compatibilityReport.show();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cppCsvDiagnostics.copyCompatibilityReport', async () => {
    if (!compatibilityReport.current()) await runCompatibilityCheck(false);
    await compatibilityReport.copy();
    void vscode.window.showInformationMessage('兼容性诊断信息已经复制。默认不包含源码、CSV、字典内容或完整业务路径。');
  }));

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
    const root = workspaceRoot(editor?.document.uri);
    if (!root || !editor || !['c', 'cpp'].includes(editor.document.languageId)) {
      return void vscode.window.showWarningMessage('请先在当前编辑器窗口中打开一个 C/C++ 源文件，再打开网页工作台。');
    }
    try {
      await backendStartup;
      if (backendStartupError) await beginBackendConnection(false);
      if (backendStartupError) throw backendStartupError;
      if (!activeBackendUrl || !backendWindowSessionId) {
        return void vscode.window.showWarningMessage('当前后台还没有绑定这个编辑器窗口。请先运行“编辑器兼容性检测”，然后重试。');
      }
      const url = new URL(`${backendUrl()}/workbench/`);
      url.searchParams.set('workspaceRoot', root);
      url.searchParams.set('filePath', editor.document.uri.fsPath);
      url.searchParams.set('focusLine', String(editor.selection.active.line + 1));
      url.searchParams.set('focusColumn', String(editor.selection.active.character + 1));
      url.searchParams.set('documentVersion', String(editor.document.version));
      url.searchParams.set('windowSessionId', backendWindowSessionId);
      if (dictionaryFolder.dictionaryId) url.searchParams.set('dictionaryId', dictionaryFolder.dictionaryId);
      if (dictionaryFolder.dictionaryName) url.searchParams.set('dictionaryName', dictionaryFolder.dictionaryName);
      if (selection?.runRecordId) url.searchParams.set('runRecordId', selection.runRecordId);
      if (selection?.dataRevision) url.searchParams.set('dataRevision', selection.dataRevision);
      if (selection?.requestedTime) url.searchParams.set('requestedTime', selection.requestedTime);
      if (activeBackendAccessToken) {
        url.hash = new URLSearchParams({ access_token: activeBackendAccessToken }).toString();
      }
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
      return void vscode.window.showWarningMessage('请先在“历史诊断”面板选择字段字典和 CSV 文件夹。');
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
      return void vscode.window.showWarningMessage('请先在“历史诊断”面板选择字段字典和 CSV 文件夹。');
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
    if (!activeSelection.requestedTime) {
      diagnosticsPanel.updateCurrent({ status: '尚未选择回放时间', statusKind: 'warning' });
      return;
    }
    diagnosticsPanel.updateCurrent({
      runRecordId: activeSelection.runRecordId,
      requestedTime: activeSelection.requestedTime,
      status: '正在刷新历史值',
      statusKind: 'loading'
    });

    try {
      const mappedFields = await cachedMappedFieldsForRun(activeSelection);
      if (isStale()) return;
      const structuralKey = JSON.stringify({
        analyzer: 'editor-language-service-v1',
        documentUri,
        documentVersion,
        mappedFields: mappedFields.map((field) => mappedFieldIdentityKey(field.codeField)).sort()
      });
      let indexedResult = structuralIndexCache.get(structuralKey)?.result;
      const structuralCacheHit = Boolean(indexedResult);
      if (!indexedResult) {
        indexedResult = await indexMappedFieldsWithEditor(editor.document, mappedFields, {
          signal: refreshController.signal,
          maxCandidates: 240
        });
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
        statusDetail: `运行 ${activeSelection.runRecordId}；回放时间 ${activeSelection.requestedTime}；歧义 ${ambiguousFieldCount}；编辑器语义${structuralCacheHit ? '已缓存' : `查询 ${Math.round(indexedResult.performance?.totalMs ?? 0)}ms`}`
      });
      output.appendLine(`刷新成功：${activeSelection.requestedTime}，发现 ${displayedFieldCount} 个映射字段，${dataFieldCount} 个有数据，${ambiguousFieldCount} 个有歧义；编辑器语义缓存=${structuralCacheHit}。`);
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
      return void vscode.window.showInformationMessage('当前未启动展示。请在“历史诊断”面板点击“开始展示”。');
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
        status: '代码已修改，正在等待输入结束后重新确认',
        statusKind: 'warning',
        statusDetail: '在线编辑器语义使用当前未保存内容；停止输入后会自动重新确认，旧结果已经隐藏'
      });
      if (displayEnabled && selection && !loadingFolder) {
        if (editorRefreshTimer) clearTimeout(editorRefreshTimer);
        editorRefreshTimer = setTimeout(() => {
          void vscode.commands.executeCommand('cppCsvDiagnostics.refresh');
        }, 650);
      }
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
    scheduleCompatibilityCheck(450);
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
    scheduleCompatibilityCheck(650);
  }));

  context.subscriptions.push({
    dispose() {
      if (editorRefreshTimer) clearTimeout(editorRefreshTimer);
      if (compatibilityTimer) clearTimeout(compatibilityTimer);
      compatibilityGeneration += 1;
    }
  });

  setTimeout(() => {
    void vscode.commands.executeCommand('workbench.view.extension.cppCsvDiagnostics');
    scheduleCompatibilityCheck(250);
  }, 300);
}

export async function deactivate(): Promise<void> {
  retryBackendConnection = undefined;
  await closeStandaloneSession();
  await closeEmbeddedBackend();
}
