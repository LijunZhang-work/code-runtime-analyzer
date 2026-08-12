import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CsvStore } from './csv-store.mjs';
import { MappingStore } from './mapping-store.mjs';
import { EvidenceService } from './evidence-service.mjs';
import { createClangIndexService } from './clang-indexer.mjs';
import { buildCallGraph, invalidateCallGraph } from './call-graph-service.mjs';
import { importConfig } from './config-loader.mjs';
import { listDictionaries, loadDictionaryFolder } from './dictionary-service.mjs';
import { deleteProductModule, listProductModules, upsertProductModule } from './module-service.mjs';
import { IntegrationRegistry } from './integration-registry.mjs';
import { API_VERSION, DEFAULT_BACKEND_URL, PRODUCT_VERSION, opencodeConfigurations } from './runtime-info.mjs';
import { WebSessionBroker } from './web-session-broker.mjs';

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function requestAccessToken(request) {
  const direct = request.headers['x-code-runtime-analyzer-token'];
  if (typeof direct === 'string') return direct;
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined;
}

function tokenMatches(actual, expected) {
  if (!expected) return true;
  if (typeof actual !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2']
]);

function withinDirectory(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !path.includes(':'));
}

async function serveWorkbench(response, url, webDirectory) {
  const requestedPath = decodeURIComponent(url.pathname.replace(/^\/workbench\/?/, ''));
  const wanted = requestedPath && !requestedPath.endsWith('/') ? requestedPath : 'index.html';
  const candidate = resolve(webDirectory, wanted);
  if (!withinDirectory(webDirectory, candidate)) throw new Error('网页资源路径不合法');
  let filePath = candidate;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not_file');
  } catch {
    // The SPA only has one route today, but keeping this fallback lets future
    // module/function links survive a browser refresh.
    filePath = resolve(webDirectory, 'index.html');
  }
  const contents = await readFile(filePath);
  response.writeHead(200, {
    'content-type': MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    'cache-control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600'
  });
  response.end(contents);
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}

function uniformlyBounded(values, limit) {
  if (values.length <= limit) return values;
  if (limit <= 1) return values.slice(0, 1);
  const selected = [];
  let previousIndex = -1;
  for (let index = 0; index < limit; index += 1) {
    const valueIndex = Math.round(index * (values.length - 1) / (limit - 1));
    if (valueIndex === previousIndex) continue;
    selected.push(values[valueIndex]);
    previousIndex = valueIndex;
  }
  return selected;
}

export function createDiagnosticServer({
  csvStore = new CsvStore(),
  mappingStore = new MappingStore(),
  dictionaryDirectory,
  webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web-dist'),
  clangIndexService = createClangIndexService(),
  onWebOpen,
  webSessionId,
  webSessionBroker = new WebSessionBroker(),
  integrationRegistry = new IntegrationRegistry(),
  runtimeMode = 'standalone',
  instanceId = process.env.CODE_RUNTIME_ANALYZER_INSTANCE_ID,
  accessToken = process.env.CODE_RUNTIME_ANALYZER_ACCESS_TOKEN
} = {}) {
  const evidenceService = new EvidenceService(csvStore, mappingStore);
  let activeData;
  const requireActiveData = (body) => {
    // Standalone server tests and the legacy config-import API may preload a
    // store directly. The embedded extension always has activeData and is
    // therefore protected by the revision check below.
    if (!activeData) return;
    if (body.runRecordId !== activeData.runRecordId || body.dataRevision !== activeData.dataRevision) {
      throw new Error('当前数据已重新加载；请使用“历史诊断”面板的最新加载结果再试一次');
    }
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      // The HTML shell is public so a browser can load it. Every endpoint that
      // reads or changes local project data is protected by the per-launch token.
      if (request.method === 'GET' && (url.pathname === '/workbench' || url.pathname.startsWith('/workbench/'))) {
        return await serveWorkbench(response, url, webDirectory);
      }
      if (!tokenMatches(requestAccessToken(request), accessToken)) {
        return reply(response, 401, { error: 'unauthorized', message: '缺少或使用了已经失效的本机访问密钥。请从后台控制中心或编辑器重新打开。' });
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return reply(response, 200, {
          status: 'ok',
          product: 'code-runtime-analyzer',
          version: PRODUCT_VERSION,
          apiVersion: API_VERSION,
          runtimeMode,
          instanceId: instanceId || undefined,
          capabilities: ['history-replay', 'code-analysis', 'web-workbench', 'vscode-session', 'editor-semantic-rpc', 'mcp-shared-core']
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/web/sessions/register') {
        return reply(response, 201, webSessionBroker.register(await bodyOf(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/web/sessions/unregister') {
        const body = await bodyOf(request);
        return reply(response, 200, { removed: webSessionBroker.unregister(body.windowSessionId) });
      }
      if (request.method === 'POST' && url.pathname === '/api/web/sessions/poll') {
        const body = await bodyOf(request);
        if (typeof body.windowSessionId !== 'string' || body.windowSessionId === '') {
          throw new Error('窗口会话轮询缺少 windowSessionId');
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        try {
          const result = await webSessionBroker.poll(body.windowSessionId, {
            timeoutMs: body.timeoutMs,
            signal: controller.signal
          });
          if (response.destroyed) return;
          return reply(response, 200, result);
        } finally {
          request.off('aborted', abort);
          response.off('close', abort);
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/web/editor/semantic') {
        const body = await bodyOf(request);
        if (typeof body.windowSessionId !== 'string' || body.windowSessionId.trim() === '') {
          throw new Error('编辑器语义请求缺少 windowSessionId');
        }
        if (typeof body.operation !== 'string' || body.operation.trim() === '') {
          throw new Error('编辑器语义请求缺少 operation');
        }
        if (!Object.hasOwn(body, 'payload')) throw new Error('编辑器语义请求缺少 payload');
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        try {
          const result = await webSessionBroker.requestSemantic(body.windowSessionId, {
            operation: body.operation,
            payload: body.payload,
            timeoutMs: body.timeoutMs,
            signal: controller.signal
          });
          if (response.destroyed) return;
          if (result.status === 'ok' || result.status === 'noEvidence') return reply(response, 200, result);
          const statusCode = result.status === 'timeout' ? 504
            : result.status === 'queueFull' ? 429
              : result.status === 'unsupported' ? 501
                : result.status === 'notReady' ? 503
                  : result.status === 'error' ? 502
                    : result.status === 'invalid' ? 400 : 409;
          const fallbackMessage = result.status === 'unsupported'
            ? '当前编辑器语言服务不支持这项语义能力。'
            : result.status === 'notReady'
              ? '编辑器语言服务尚未就绪，请稍后重试。'
              : result.status === 'error'
                ? '编辑器语言服务处理请求失败。'
                : '编辑器语义请求未能完成。';
          return reply(response, statusCode, { ...result, error: result.message || fallbackMessage });
        } finally {
          request.off('aborted', abort);
          response.off('close', abort);
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/web/editor/semantic/respond') {
        const body = await bodyOf(request);
        if (typeof body.windowSessionId !== 'string' || body.windowSessionId.trim() === '') {
          throw new Error('编辑器语义响应缺少 windowSessionId');
        }
        if (typeof body.requestId !== 'string' || body.requestId.trim() === '') {
          throw new Error('编辑器语义响应缺少 requestId');
        }
        const result = webSessionBroker.respondSemantic(body.windowSessionId, body);
        if (result.status === 'accepted') return reply(response, 200, { accepted: true, requestId: result.requestId });
        const statusCode = result.status === 'invalid' ? 400 : 409;
        return reply(response, statusCode, { ...result, error: result.message });
      }
      if (request.method === 'POST' && url.pathname === '/api/web/open-in-vscode') {
        const body = await bodyOf(request);
        if (typeof body.filePath !== 'string' || body.filePath.trim() === '') {
          throw new Error('网页定位请求缺少 filePath');
        }
        const location = {
          filePath: body.filePath,
          workspaceRoot: typeof body.workspaceRoot === 'string' ? body.workspaceRoot : undefined,
          line: Number.isInteger(Number(body.line)) && Number(body.line) > 0 ? Number(body.line) : 1,
          column: Number.isInteger(Number(body.column)) && Number(body.column) > 0 ? Number(body.column) : 1
        };
        if (typeof onWebOpen === 'function' && typeof webSessionId === 'string') {
          if (body.windowSessionId !== webSessionId) {
            return reply(response, 403, {
              error: '此网页与当前编辑器窗口的绑定已失效。请关闭网页后从原编辑器窗口重新打开。'
            });
          }
          onWebOpen(location);
        } else if (!webSessionBroker.publish(body.windowSessionId, location)) {
          return reply(response, 409, {
            error: '此网页没有连接到当前编辑器窗口，或窗口会话已经结束。请从编辑器里的“打开网页工作台”重新进入。'
          });
        }
        return reply(response, 202, { accepted: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/integrations/register') {
        return reply(response, 201, integrationRegistry.register(await bodyOf(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/integrations/heartbeat') {
        const body = await bodyOf(request);
        return reply(response, 200, { active: integrationRegistry.heartbeat(body.clientId) });
      }
      if (request.method === 'POST' && url.pathname === '/api/integrations/unregister') {
        const body = await bodyOf(request);
        return reply(response, 200, { removed: integrationRegistry.unregister(body.clientId) });
      }
      if (request.method === 'POST' && url.pathname === '/api/integrations/status') {
        return reply(response, 200, {
          product: 'code-runtime-analyzer',
          version: PRODUCT_VERSION,
          apiVersion: API_VERSION,
          runtimeMode,
          vscodeWindows: webSessionBroker.summary(),
          aiClients: integrationRegistry.summary(),
          capabilities: ['编辑器代码内展示', 'Web 函数与模块工作台', 'OpenCode / AI MCP', '字段字典与 CSV 历史回放']
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/integrations/opencode-config') {
        const address = server.address();
        const baseUrl = address && typeof address !== 'string'
          ? `http://127.0.0.1:${address.port}`
          : DEFAULT_BACKEND_URL;
        return reply(response, 200, opencodeConfigurations(baseUrl, accessToken));
      }
      if (request.method === 'POST' && url.pathname === '/api/config/import') {
        const { configPath } = await bodyOf(request);
        return reply(response, 201, await importConfig(configPath, { csvStore, mappingStore }));
      }
      if (request.method === 'POST' && url.pathname === '/api/dictionaries/list') {
        return reply(response, 200, { dictionaries: await listDictionaries({ dictionaryDirectory }) });
      }
      if (request.method === 'POST' && url.pathname === '/api/dictionaries/load-folder') {
        const result = await loadDictionaryFolder(await bodyOf(request), {
          csvStore, mappingStore, dictionaryDirectory
        });
        activeData = { runRecordId: result.runRecordId, dataRevision: result.dataRevision };
        return reply(response, 201, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/product-modules/list') {
        return reply(response, 200, await listProductModules(await bodyOf(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/product-modules/upsert') {
        return reply(response, 200, await upsertProductModule(await bodyOf(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/product-modules/delete') {
        return reply(response, 200, await deleteProductModule(await bodyOf(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/evidence/field') {
        const body = await bodyOf(request);
        requireActiveData(body);
        return reply(response, 200, evidenceService.queryField(body));
      }
      if (request.method === 'POST' && url.pathname === '/api/evidence/instances') {
        const body = await bodyOf(request);
        requireActiveData(body);
        return reply(response, 200, evidenceService.queryInstances(body));
      }
      if (request.method === 'POST' && url.pathname === '/api/evidence/snapshot') {
        const body = await bodyOf(request);
        requireActiveData(body);
        return reply(response, 200, evidenceService.querySnapshot(body));
      }
      if (request.method === 'POST' && url.pathname === '/api/evidence/series') {
        const body = await bodyOf(request);
        requireActiveData(body);
        return reply(response, 200, evidenceService.querySeries(body));
      }
      if (request.method === 'POST' && url.pathname === '/api/runs/list') {
        const runs = mappingStore.listRuns().map((run) => ({
          ...run,
          sources: csvStore.describeSources(run.sourceIds)
        }));
        return reply(response, 200, { runs });
      }
      if (request.method === 'POST' && url.pathname === '/api/mappings/fields') {
        const body = await bodyOf(request);
        requireActiveData(body);
        const { runRecordId, module, typeName } = body;
        const fields = mappingStore.listFieldDescriptors(runRecordId, { module, typeName });
        return reply(response, 200, { runRecordId, fields });
      }
      if (request.method === 'POST' && url.pathname === '/api/data-quality') {
        const body = await bodyOf(request);
        requireActiveData(body);
        const { runRecordId } = body;
        const sources = mappingStore.sourceIdsForRun(runRecordId).map((sourceId) => csvStore.dataQuality(sourceId));
        return reply(response, 200, { runRecordId, sources });
      }
      if (request.method === 'POST' && url.pathname === '/api/replay/times') {
        const body = await bodyOf(request);
        requireActiveData(body);
        const { runRecordId, limit = 200 } = body;
        const pointLimit = Number.isFinite(Number(limit))
          ? Math.max(10, Math.min(200, Math.floor(Number(limit))))
          : 200;
        const sourceIds = mappingStore.sourceIdsForRun(runRecordId);
        const descriptions = csvStore.describeSources(sourceIds);
        const samples = sourceIds
          .flatMap((sourceId) => csvStore.listSamples(sourceId, { maxPoints: pointLimit }))
          .sort((left, right) => Date.parse(left.sampledTime) - Date.parse(right.sampledTime));
        const uniqueTimes = [...new Map(samples.map((sample) => [sample.requestedTime, sample])).values()];
        const times = uniformlyBounded(uniqueTimes, pointLimit);
        const totalRows = descriptions.reduce((total, source) => total + source.rowCount, 0);
        return reply(response, 200, {
          runRecordId,
          times,
          sampled: uniqueTimes.length > pointLimit || descriptions.some((source) => source.rowCount > pointLimit),
          returnedCount: times.length,
          totalRows
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/code/index') {
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        try {
          const result = await clangIndexService.indexFile({
            ...await bodyOf(request),
            signal: controller.signal
          });
          if (controller.signal.aborted || response.destroyed) return;
          return reply(response, 200, result);
        } finally {
          request.off('aborted', abort);
          response.off('close', abort);
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/web/call-graph') {
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        try {
          const result = await buildCallGraph({ ...await bodyOf(request), signal: controller.signal });
          if (controller.signal.aborted || response.destroyed) return;
          return reply(response, 200, result);
        } finally {
          request.off('aborted', abort);
          response.off('close', abort);
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/code/invalidate') {
        const body = await bodyOf(request);
        invalidateCallGraph(body);
        return reply(response, 200, clangIndexService.invalidate(body));
      }
      return reply(response, 404, { error: 'not_found' });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      return reply(response, 400, { error: error.message, ...(error.details ?? {}) });
    }
  });
  let disposePromise;
  server.closeDiagnosticServices = () => {
    disposePromise ??= clangIndexService.dispose();
    return disposePromise;
  };
  server.once('close', () => void server.closeDiagnosticServices());
  return server;
}

export function startDiagnosticServer({
  port = Number(process.env.DIAGNOSTIC_PORT ?? 47831),
  dictionaryDirectory = process.env.CODE_RUNTIME_ANALYZER_DICTIONARY_DIR,
  runtimeMode = 'standalone',
  instanceId = process.env.CODE_RUNTIME_ANALYZER_INSTANCE_ID,
  accessToken = process.env.CODE_RUNTIME_ANALYZER_ACCESS_TOKEN
} = {}) {
  const server = createDiagnosticServer({ dictionaryDirectory, runtimeMode, instanceId, accessToken });
  server.listen(port, '127.0.0.1', () => console.log(`Diagnostic backend listening at http://127.0.0.1:${port}`));
  return server;
}

const isEntrypoint = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) startDiagnosticServer();
