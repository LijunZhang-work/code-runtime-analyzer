import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClangIndexService } from '../backend/src/clang-indexer.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const projectRoot = resolve(argument('project', '.'));
const compileCommandsPath = resolve(argument('compile-commands', 'compile_commands.json'));
const requestedFile = argument('file');
const functionName = argument('function');
const clangdPath = argument('clangd', process.env.CLANGD_TEST_PATH);
const reportPath = resolve(argument('report', 'build/real-project-performance.json'));
const maxColdMilliseconds = Number(argument('max-cold-ms', '30000'));
const maxWarmMilliseconds = Number(argument('max-warm-ms', '1000'));
const maxMemoryMegabytes = Number(argument('max-memory-mb', '1200'));
if (!requestedFile || !functionName || !clangdPath) {
  throw new Error('用法：--project <目录> --compile-commands <文件> --file <当前文件> --function <函数名> --clangd <clangd>');
}
const filePath = resolve(projectRoot, requestedFile);

async function countCodeFiles(directory) {
  let count = 0;
  const pending = [directory];
  const extensions = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'build' || entry.name.startsWith('cmake-build-')) continue;
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) count += 1;
    }
  }
  return count;
}

function processWorkingSet(pid) {
  const command = `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true
  });
  return result.status === 0 ? Number(result.stdout.trim()) : 0;
}

JSON.parse(await readFile(compileCommandsPath, 'utf8'));
const projectFiles = await countCodeFiles(projectRoot);
const service = createClangIndexService();
let report;
try {
  const request = { compileCommandsPath, filePath, functionName, clangdPath };
  const coldStarted = performance.now();
  const cold = await service.indexFile(request);
  const coldMilliseconds = performance.now() - coldStarted;
  const warmStarted = performance.now();
  const warm = await service.indexFile(request);
  const warmMilliseconds = performance.now() - warmStarted;
  const sessions = [...service.sessions.values()];
  const documents = sessions.reduce((sum, wrapper) => sum + (wrapper.session?.documents?.size ?? 0), 0);
  const clangdMemory = sessions.reduce((sum, wrapper) => {
    const pid = wrapper.session?.process?.pid;
    return sum + (Number.isInteger(pid) ? processWorkingSet(pid) : 0);
  }, 0);
  const workingSetMegabytes = Math.round((process.memoryUsage().rss + clangdMemory) / 1024 / 1024);
  const failures = [];
  if (coldMilliseconds > maxColdMilliseconds) failures.push(`首次分析 ${Math.round(coldMilliseconds)}ms > ${maxColdMilliseconds}ms`);
  if (warmMilliseconds > maxWarmMilliseconds) failures.push(`缓存分析 ${Math.round(warmMilliseconds)}ms > ${maxWarmMilliseconds}ms`);
  if (workingSetMegabytes > maxMemoryMegabytes) failures.push(`内存 ${workingSetMegabytes}MB > ${maxMemoryMegabytes}MB`);
  if (documents > 1 || service.cache.size > 1) failures.push(`当前文件以外产生了缓存：documents=${documents}, cache=${service.cache.size}`);
  if (warm.performance?.cacheHit !== true) failures.push('重复分析没有命中缓存');
  if (!cold.functionNames?.includes(functionName)) failures.push(`没有在当前文件中确认目标函数：${functionName}`);
  report = {
    reportVersion: 1,
    createdAt: new Date().toISOString(),
    projectRoot,
    projectFiles,
    compileCommandsPath,
    currentFile: filePath,
    functionName,
    coldMilliseconds: Math.round(coldMilliseconds),
    warmMilliseconds: Math.round(warmMilliseconds),
    workingSetMegabytes,
    openDocuments: documents,
    cacheEntries: service.cache.size,
    fields: cold.fields.length,
    functions: cold.functionNames,
    passed: failures.length === 0,
    failures
  };
} finally {
  await service.dispose();
}
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
