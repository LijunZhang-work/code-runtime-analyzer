import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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

export function launcherPaths({
  installRoot = process.env.CODE_RUNTIME_ANALYZER_INSTALL_ROOT || defaultInstallRoot,
  stateDirectory = process.env.CODE_RUNTIME_ANALYZER_STATE_DIR
    || resolve(process.env.LOCALAPPDATA || installRoot, 'CodeRuntimeAnalyzer'),
  port = Number(process.env.DIAGNOSTIC_PORT || 47831)
} = {}) {
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

async function health(baseUrl, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) return undefined;
    return response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function startService(options = {}) {
  const paths = launcherPaths(options);
  const current = await health(paths.baseUrl);
  if (current?.product === 'code-runtime-analyzer' && current.apiVersion === API_VERSION) {
    return { status: 'already-running', ...paths, health: current };
  }
  if (current) throw new Error(`端口 ${paths.port} 已被不兼容的服务占用，请关闭该服务后重试。`);
  await mkdir(paths.stateDirectory, { recursive: true });
  const packagedDictionaries = resolve(paths.installRoot, 'backend', 'dictionaries');
  const dictionaryDirectory = await exists(paths.dictionaryDirectory) ? paths.dictionaryDirectory : packagedDictionaries;
  const nodePath = await exists(paths.nodePath) ? paths.nodePath : process.execPath;
  if (!await exists(paths.serverModule)) throw new Error(`安装不完整：找不到 ${paths.serverModule}`);
  const instanceId = randomUUID();
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
        DIAGNOSTIC_PORT: String(paths.port)
      }
    });
    child.unref();
  } finally {
    closeSync(logDescriptor);
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const started = await health(paths.baseUrl, 500);
    if (started?.product === 'code-runtime-analyzer' && started.instanceId === instanceId) {
      const state = {
        pid: child.pid,
        instanceId,
        port: paths.port,
        baseUrl: paths.baseUrl,
        installRoot: paths.installRoot,
        startedAt: new Date().toISOString()
      };
      await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      return { status: 'started', ...paths, health: started, pid: child.pid };
    }
    await delay(250);
  }
  if (child?.pid) process.kill(child.pid);
  throw new Error(`后台启动超过 10 秒。请查看日志：${paths.logFile}`);
}

export async function stopService(options = {}) {
  const paths = launcherPaths(options);
  const state = await readJson(paths.stateFile);
  const current = await health(paths.baseUrl);
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
    if (!await health(paths.baseUrl, 250)) break;
    await delay(250);
  }
  await rm(paths.stateFile, { force: true });
  return { status: 'stopped', ...paths };
}

export async function serviceStatus(options = {}) {
  const paths = launcherPaths(options);
  return { ...paths, health: await health(paths.baseUrl), state: await readJson(paths.stateFile) };
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
  return JSON.stringify(result, null, 2);
}

function formatControlResult(command, result) {
  if (command === 'status') {
    return result.health?.product === 'code-runtime-analyzer'
      ? ['running', result.health.version ?? 'unknown', result.baseUrl, result.state?.pid ?? 'unknown', result.state?.startedAt ?? 'unknown'].join('|')
      : ['not-running', result.baseUrl].join('|');
  }
  if (command === 'open') return ['opened', result.baseUrl].join('|');
  return [result.status ?? command, result.baseUrl ?? ''].join('|');
}

async function openWorkbench(options = {}) {
  const running = await startService(options);
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '', `${running.baseUrl}/workbench/`], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();
  return running;
}

async function printOpenCodeConfig(options = {}) {
  const running = await startService(options);
  const response = await fetch(`${running.baseUrl}/api/integrations/opencode-config`, { method: 'POST' });
  if (!response.ok) throw new Error(`读取 OpenCode 配置失败：${response.status}`);
  return response.json();
}

async function main() {
  const command = process.argv[2] || 'status';
  const humanReadable = process.argv.includes('--text');
  const controlReadable = process.argv.includes('--control');
  const result = command === 'start' ? await startService()
    : command === 'stop' ? await stopService()
      : command === 'restart' ? await restartService()
      : command === 'open' ? await openWorkbench()
        : command === 'opencode-config' ? await printOpenCodeConfig()
          : command === 'status' ? await serviceStatus()
            : undefined;
  if (!result) throw new Error(`未知命令：${command}。可用命令：start、stop、restart、open、status、opencode-config。`);
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
