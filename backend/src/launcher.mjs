import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { API_VERSION } from './runtime-info.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const defaultInstallRoot = resolve(sourceDirectory, '..', '..');

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function publicState(state) {
  if (!state) return undefined;
  const { accessToken: _accessToken, ...safe } = state;
  return safe;
}

function stateConnection(paths, state) {
  if (!state || !Number.isInteger(Number(state.port))) return undefined;
  try {
    const url = new URL(state.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return undefined;
    if (Number(url.port) !== Number(state.port)) return undefined;
    return {
      port: Number(state.port),
      baseUrl: url.origin,
      accessToken: typeof state.accessToken === 'string' && state.accessToken ? state.accessToken : undefined
    };
  } catch {
    return undefined;
  }
}

async function writePrivateJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function portAvailable(port) {
  const probe = createNetServer();
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      probe.once('error', rejectPromise);
      probe.listen(port, '127.0.0.1', resolvePromise);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (probe.listening) await new Promise((resolvePromise) => probe.close(resolvePromise));
  }
}

async function availablePort(preferredPort, attempts = 50) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate > 65_535) break;
    if (await portAvailable(candidate)) return candidate;
  }
  const probe = createNetServer();
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  if (!port) throw new Error('系统没有可用的本机端口，后台无法启动。');
  return port;
}

export function launcherPaths({
  installRoot = process.env.CODE_RUNTIME_ANALYZER_INSTALL_ROOT || defaultInstallRoot,
  stateDirectory = process.env.CODE_RUNTIME_ANALYZER_STATE_DIR
    || resolve(process.env.LOCALAPPDATA || installRoot, 'CodeRuntimeAnalyzer'),
  port: requestedPort = Number(process.env.DIAGNOSTIC_PORT || 47831)
} = {}) {
  const port = Number.isInteger(Number(requestedPort)) && Number(requestedPort) > 0 && Number(requestedPort) <= 65_535
    ? Number(requestedPort)
    : 47831;
  return {
    installRoot,
    stateDirectory,
    stateFile: resolve(stateDirectory, 'service-state.json'),
    logFile: resolve(stateDirectory, 'backend.log'),
    dictionaryDirectory: resolve(stateDirectory, 'dictionaries'),
    serverModule: resolve(installRoot, 'backend', 'src', 'server.mjs'),
    nodePath: resolve(installRoot, 'runtime', 'node.exe'),
    port,
    baseUrl: `http://127.0.0.1:${port}`
  };
}

async function healthProbe(baseUrl, accessToken, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = accessToken ? { 'x-code-runtime-analyzer-token': accessToken } : undefined;
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal, headers });
    const text = await response.text();
    if (!response.ok) return { status: 'http-error', httpStatus: response.status, detail: text.slice(0, 500) };
    try {
      return { status: 'responded', health: JSON.parse(text) };
    } catch {
      return { status: 'invalid-response', detail: text.slice(0, 500) };
    }
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    return {
      status: error?.name === 'AbortError' ? 'timeout' : 'unreachable',
      code: code ? String(code) : undefined,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function health(baseUrl, accessToken, timeoutMs = 1_000) {
  const probe = await healthProbe(baseUrl, accessToken, timeoutMs);
  return probe.status === 'responded' ? probe.health : undefined;
}

async function rotateLog(logFile, maximumBytes = 2 * 1024 * 1024) {
  try {
    const current = await stat(logFile);
    if (current.size <= maximumBytes) return;
    const previous = `${logFile}.previous`;
    await rm(previous, { force: true });
    await rename(logFile, previous);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function startService(options = {}) {
  const preferredPaths = launcherPaths(options);
  const recordedState = await readJson(preferredPaths.stateFile);
  const recorded = stateConnection(preferredPaths, recordedState);
  if (recorded) {
    const recordedProbe = await healthProbe(recorded.baseUrl, recorded.accessToken);
    const current = recordedProbe.status === 'responded' ? recordedProbe.health : undefined;
    if (current?.product === 'code-runtime-analyzer' && current.apiVersion === API_VERSION
      && (!recordedState.instanceId || current.instanceId === recordedState.instanceId)) {
      return {
        status: 'already-running',
        ...preferredPaths,
        port: recorded.port,
        baseUrl: recorded.baseUrl,
        health: current,
        state: publicState(recordedState)
      };
    }
    if (current?.product === 'code-runtime-analyzer') {
      throw new Error(`已记录的后台版本不兼容（接口 ${current.apiVersion ?? '未知'}，当前需要 ${API_VERSION}）。请在后台控制中心点击“重新启动”。`);
    }
  }
  await rm(preferredPaths.stateFile, { force: true });
  const port = await availablePort(preferredPaths.port);
  const paths = { ...preferredPaths, port, baseUrl: `http://127.0.0.1:${port}` };
  await mkdir(paths.stateDirectory, { recursive: true });
  const packagedDictionaries = resolve(paths.installRoot, 'backend', 'dictionaries');
  const dictionaryDirectory = await exists(paths.dictionaryDirectory) ? paths.dictionaryDirectory : packagedDictionaries;
  const nodePath = await exists(paths.nodePath) ? paths.nodePath : process.execPath;
  if (!await exists(paths.serverModule)) throw new Error(`安装不完整：找不到 ${paths.serverModule}`);
  const instanceId = randomUUID();
  const accessToken = randomBytes(32).toString('base64url');
  await rotateLog(paths.logFile).catch(() => undefined);
  const logDescriptor = openSync(paths.logFile, 'a');
  let child;
  try {
    child = spawn(nodePath, [paths.serverModule], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logDescriptor, logDescriptor],
      cwd: paths.installRoot,
      env: {
        ...process.env,
        CODE_RUNTIME_ANALYZER_INSTALL_ROOT: paths.installRoot,
        CODE_RUNTIME_ANALYZER_STATE_DIR: paths.stateDirectory,
        CODE_RUNTIME_ANALYZER_DICTIONARY_DIR: dictionaryDirectory,
        CODE_RUNTIME_ANALYZER_INSTANCE_ID: instanceId,
        CODE_RUNTIME_ANALYZER_ACCESS_TOKEN: accessToken,
        DIAGNOSTIC_PORT: String(paths.port)
      }
    });
    child.unref();
  } finally {
    closeSync(logDescriptor);
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const started = await health(paths.baseUrl, accessToken, 500);
    if (started?.product === 'code-runtime-analyzer' && started.instanceId === instanceId) {
      const state = {
        pid: child.pid,
        instanceId,
        port: paths.port,
        baseUrl: paths.baseUrl,
        accessToken,
        installRoot: paths.installRoot,
        startedAt: new Date().toISOString()
      };
      await writePrivateJson(paths.stateFile, state);
      return { status: 'started', ...paths, health: started, pid: child.pid, state: publicState(state) };
    }
    await delay(250);
  }
  if (child?.pid) {
    try {
      process.kill(child.pid);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  throw new Error(`后台启动超过 10 秒。请查看日志：${paths.logFile}`);
}

export async function stopService(options = {}) {
  const preferredPaths = launcherPaths(options);
  const state = await readJson(preferredPaths.stateFile);
  const recorded = stateConnection(preferredPaths, state);
  if (!recorded) {
    await rm(preferredPaths.stateFile, { force: true });
    return { status: 'not-running', ...preferredPaths };
  }
  const paths = { ...preferredPaths, port: recorded.port, baseUrl: recorded.baseUrl };
  const current = await health(paths.baseUrl, recorded.accessToken);
  if (!current) {
    await rm(paths.stateFile, { force: true });
    return { status: 'not-running', ...paths };
  }
  if (current.product !== 'code-runtime-analyzer') {
    throw new Error(`拒绝停止端口 ${paths.port}：它不是 Code Runtime Analyzer 后台。`);
  }
  if (!state?.pid || !state.instanceId || current.instanceId !== state.instanceId) {
    throw new Error('拒绝停止后台：进程身份与安装记录不一致，避免误关其他程序。');
  }
  try {
    process.kill(Number(state.pid));
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!await health(paths.baseUrl, recorded.accessToken, 250)) break;
    await delay(250);
  }
  await rm(paths.stateFile, { force: true });
  return { status: 'stopped', ...paths };
}

export async function serviceStatus(options = {}) {
  const preferredPaths = launcherPaths(options);
  const state = await readJson(preferredPaths.stateFile);
  const recorded = stateConnection(preferredPaths, state);
  const paths = recorded
    ? { ...preferredPaths, port: recorded.port, baseUrl: recorded.baseUrl }
    : preferredPaths;
  return {
    ...paths,
    health: await health(paths.baseUrl, recorded?.accessToken),
    state: publicState(state)
  };
}

function replacePathPrefix(value, prefix, replacement) {
  if (!value || !prefix) return value;
  const normalizedValue = resolve(value);
  const normalizedPrefix = resolve(prefix);
  if (normalizedValue.toLocaleLowerCase() === normalizedPrefix.toLocaleLowerCase()) return replacement;
  if (!normalizedValue.toLocaleLowerCase().startsWith(`${normalizedPrefix.toLocaleLowerCase()}${sep}`)) return value;
  return `${replacement}${normalizedValue.slice(normalizedPrefix.length)}`;
}

function redactLocalPath(value) {
  if (!value) return value;
  let redacted = replacePathPrefix(value, process.env.LOCALAPPDATA, '%LOCALAPPDATA%');
  redacted = replacePathPrefix(redacted, process.env.USERPROFILE, '%USERPROFILE%');
  return redacted;
}

async function fileSummary(filePath) {
  try {
    const details = await stat(filePath);
    return { exists: true, size: details.size, modifiedAt: details.mtime.toISOString() };
  } catch {
    return { exists: false };
  }
}

export async function diagnoseService(options = {}) {
  const preferredPaths = launcherPaths(options);
  const state = await readJson(preferredPaths.stateFile);
  const recorded = stateConnection(preferredPaths, state);
  const paths = recorded
    ? { ...preferredPaths, port: recorded.port, baseUrl: recorded.baseUrl }
    : preferredPaths;
  await mkdir(paths.stateDirectory, { recursive: true });
  const [probe, runtime, server, log] = await Promise.all([
    healthProbe(paths.baseUrl, recorded?.accessToken, 2_000),
    fileSummary(paths.nodePath),
    fileSummary(paths.serverModule),
    fileSummary(paths.logFile)
  ]);
  const endpointStatus = probe.status !== 'responded' ? probe.status
    : probe.health?.product !== 'code-runtime-analyzer' ? 'port-conflict'
      : probe.health?.apiVersion !== API_VERSION ? 'version-mismatch' : 'ready';
  const checks = [
    {
      id: 'connection-record',
      status: recorded ? 'ready' : 'missing',
      explanation: recorded
        ? `已找到当前用户的真实后台地址（端口 ${recorded.port}）和本机访问凭据。`
        : '没有找到有效的本机连接记录；后台可能尚未启动，或记录被其他程序修改。'
    },
    {
      id: 'runtime',
      status: runtime.exists ? 'ready' : 'missing',
      explanation: runtime.exists ? '自带运行环境存在。' : '安装目录缺少自带运行环境，EXE 可能没有安装完整。'
    },
    {
      id: 'backend-files',
      status: server.exists ? 'ready' : 'missing',
      explanation: server.exists ? '后台程序文件存在。' : '安装目录缺少后台程序文件，需要重新安装 EXE。'
    },
    {
      id: 'endpoint',
      status: endpointStatus,
      explanation: endpointStatus === 'ready' ? '后台正在响应，而且接口版本匹配。'
        : endpointStatus === 'port-conflict' ? `端口 ${paths.port} 有响应，但不是 Code Runtime Analyzer。`
          : endpointStatus === 'version-mismatch' ? `插件与后台接口版本不一致；需要 ${API_VERSION}，当前为 ${probe.health?.apiVersion ?? '未知'}。`
            : endpointStatus === 'timeout' ? `后台地址 ${paths.baseUrl} 连接超时。`
              : endpointStatus === 'http-error' && probe.httpStatus === 401 ? '后台拒绝了本机访问凭据；请从后台控制中心重新启动后台。'
                : endpointStatus === 'invalid-response' || endpointStatus === 'http-error' ? `端口 ${paths.port} 返回了无法识别的内容。`
                : `后台地址 ${paths.baseUrl} 当前没有响应。`
    }
  ];
  return {
    product: 'code-runtime-analyzer',
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    overall: checks.every((check) => check.status === 'ready') ? 'ready' : 'needs-attention',
    environment: {
      platform: process.platform,
      architecture: process.arch,
      bundledNode: process.version
    },
    paths: {
      installRoot: redactLocalPath(paths.installRoot),
      stateDirectory: redactLocalPath(paths.stateDirectory),
      logFile: redactLocalPath(paths.logFile),
      serviceAddress: paths.baseUrl
    },
    checks,
    endpoint: probe,
    state: state ? {
      pid: state.pid,
      instanceId: state.instanceId,
      port: state.port,
      baseUrl: state.baseUrl,
      installRoot: redactLocalPath(state.installRoot),
      startedAt: state.startedAt
    } : undefined,
    files: { runtime, server, log }
  };
}

export async function exportDiagnosticReport(options = {}) {
  const paths = launcherPaths(options);
  const report = await diagnoseService(options);
  const reportFile = resolve(paths.stateDirectory, 'diagnostic-report.json');
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { status: 'exported', reportFile, report };
}

export async function restartService(options = {}) {
  await stopService(options);
  return startService(options);
}

function formatHumanResult(command, result) {
  const running = result.health?.product === 'code-runtime-analyzer';
  if (command === 'status') {
    return running
      ? [
        '后台状态：正在运行',
        `版本：${result.health.version ?? '未知'}`,
        `服务地址：${result.baseUrl}`,
        `进程号：${result.state?.pid ?? '未知'}`,
        `启动时间：${result.state?.startedAt ?? '未知'}`,
        `日志：${result.logFile}`
      ].join('\n')
      : [
        '后台状态：未运行',
        `预定服务地址：${result.baseUrl}`,
        `日志：${result.logFile}`
      ].join('\n');
  }
  if (command === 'start') {
    return result.status === 'already-running'
      ? `后台原本就在运行。\n服务地址：${result.baseUrl}`
      : `后台已经启动。\n服务地址：${result.baseUrl}\n日志：${result.logFile}`;
  }
  if (command === 'restart') return `后台已经重新启动。\n服务地址：${result.baseUrl}\n日志：${result.logFile}`;
  if (command === 'stop') {
    return result.status === 'not-running' ? '后台原本就没有运行。' : '后台已经停止。';
  }
  if (command === 'diagnose') {
    return [
      `诊断结果：${result.overall === 'ready' ? '可以正常使用' : '需要处理'}`,
      ...result.checks.map((check) => `${check.id}：${check.status}；${check.explanation}`),
      `后台地址：${result.paths.serviceAddress}`,
      `日志：${result.paths.logFile}`
    ].join('\n');
  }
  if (command === 'export-diagnostics') {
    return `诊断报告已经导出：\n${result.reportFile}`;
  }
  return JSON.stringify(result, null, 2);
}

function formatControlResult(command, result) {
  if (command === 'status') {
    return result.health?.product === 'code-runtime-analyzer'
      ? ['running', result.health.version ?? 'unknown', result.baseUrl, result.state?.pid ?? 'unknown', result.state?.startedAt ?? 'unknown'].join('|')
      : ['not-running', result.baseUrl].join('|');
  }
  if (command === 'open') return ['opened', result.baseUrl].join('|');
  if (command === 'export-diagnostics') return ['exported', result.reportFile].join('|');
  return [result.status ?? command, result.baseUrl ?? ''].join('|');
}

async function openWorkbench(options = {}) {
  const running = await startService(options);
  const state = await readJson(running.stateFile);
  const token = stateConnection(running, state)?.accessToken;
  const workbenchUrl = `${running.baseUrl}/workbench/${token ? `#access_token=${encodeURIComponent(token)}` : ''}`;
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '', workbenchUrl], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();
  return running;
}

async function printOpenCodeConfig(options = {}) {
  const running = await startService(options);
  const state = await readJson(running.stateFile);
  const accessToken = stateConnection(running, state)?.accessToken;
  const response = await fetch(`${running.baseUrl}/api/integrations/opencode-config`, {
    method: 'POST',
    headers: accessToken ? { 'x-code-runtime-analyzer-token': accessToken } : undefined
  });
  if (!response.ok) throw new Error(`读取 OpenCode 配置失败：${response.status}`);
  return response.json();
}

async function main() {
  const command = process.argv[2] || 'status';
  const humanReadable = process.argv.includes('--text');
  const controlReadable = process.argv.includes('--control');
  let result;
  if (command === 'start') result = await startService();
  else if (command === 'stop') result = await stopService();
  else if (command === 'restart') result = await restartService();
  else if (command === 'open') result = await openWorkbench();
  else if (command === 'diagnose') result = await diagnoseService();
  else if (command === 'export-diagnostics') result = await exportDiagnosticReport();
  else if (command === 'opencode-config') result = await printOpenCodeConfig();
  else if (command === 'status') result = await serviceStatus();
  if (!result) throw new Error(`未知命令：${command}。可用命令：start、stop、restart、open、status、diagnose、export-diagnostics、opencode-config。`);
  process.stdout.write(`${controlReadable
    ? formatControlResult(command, result)
    : humanReadable ? formatHumanResult(command, result) : JSON.stringify(result, null, 2)}\n`);
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`Code Runtime Analyzer 启动器失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
