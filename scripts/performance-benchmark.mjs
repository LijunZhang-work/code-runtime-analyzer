import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createClangIndexService } from '../backend/src/clang-indexer.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const benchmarkRoot = resolve(repositoryRoot, 'build', 'performance-benchmark');
const budgets = JSON.parse(await readFile(resolve(repositoryRoot, 'performance-budgets.json'), 'utf8'));
const gate = process.argv.includes('--gate');

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function fromPath(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8', windowsHide: true });
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    : undefined;
}

async function findUnder(directory, wanted, depth = 0) {
  if (depth > 7 || !await exists(directory)) return undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  const direct = entries.find((entry) => entry.isFile() && wanted.has(entry.name.toLowerCase()));
  if (direct) return resolve(directory, direct.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findUnder(resolve(directory, entry.name), wanted, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function tools() {
  const compiler = process.env.CLANGXX_PATH?.trim()
    || fromPath(process.platform === 'win32' ? 'clang++.exe' : 'clang++')
    || await findUnder(resolve(repositoryRoot, 'tools'), new Set(process.platform === 'win32' ? ['clang++.exe'] : ['clang++']));
  if (!compiler) throw new Error('性能测试找不到 clang++。请设置 CLANGXX_PATH。');
  const sibling = resolve(dirname(compiler), process.platform === 'win32' ? 'clangd.exe' : 'clangd');
  const clangd = process.env.CLANGD_TEST_PATH?.trim()
    || (await exists(sibling) ? sibling : fromPath(process.platform === 'win32' ? 'clangd.exe' : 'clangd'));
  if (!clangd) throw new Error('性能测试找不到 clangd。请设置 CLANGD_TEST_PATH。');
  return { compiler: resolve(compiler), clangd: resolve(clangd) };
}

async function writeInBatches(items, writer, batchSize = 250) {
  for (let start = 0; start < items.length; start += batchSize) {
    await Promise.all(items.slice(start, start + batchSize).map(writer));
  }
}

async function prepareFixture(name, projectFiles, compiler) {
  const root = resolve(benchmarkRoot, name);
  const sourceDirectory = resolve(root, 'src');
  const includeDirectory = resolve(root, 'include');
  const buildDirectory = resolve(root, 'build');
  await rm(root, { recursive: true, force: true });
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(includeDirectory, { recursive: true });
  await mkdir(buildDirectory, { recursive: true });
  await writeFile(resolve(includeDirectory, 'model.hpp'), [
    '#pragma once',
    'namespace benchmark {',
    'struct Model { int value; int quality; };',
    '}',
    ''
  ].join('\n'), 'utf8');

  const indexes = Array.from({ length: projectFiles }, (_, index) => index);
  await writeInBatches(indexes, async (index) => {
    const filePath = resolve(sourceDirectory, `unit_${String(index).padStart(5, '0')}.cpp`);
    const content = index === 0
      ? '#include "model.hpp"\nint global_value = 7;\nint inspect(benchmark::Model& item) { return item.value + item.quality + global_value; }\n'
      : `#include "model.hpp"\nint unit_${index}(benchmark::Model& item) { return item.value + ${index}; }\n`;
    await writeFile(filePath, content, 'utf8');
  });

  const database = indexes.map((index) => {
    const filePath = resolve(sourceDirectory, `unit_${String(index).padStart(5, '0')}.cpp`);
    return {
      directory: buildDirectory,
      arguments: [compiler, '-std=c++17', `-I${includeDirectory}`, '-c', filePath, '-o', resolve(buildDirectory, `unit_${index}.o`)],
      file: filePath,
      output: resolve(buildDirectory, `unit_${index}.o`)
    };
  });
  const databasePath = resolve(buildDirectory, 'compile_commands.json');
  await writeFile(databasePath, `${JSON.stringify(database)}\n`, 'utf8');
  return { root, databasePath, targetFile: resolve(sourceDirectory, 'unit_00000.cpp') };
}

function clangdPids(service) {
  return [...service.sessions.values()]
    .map((wrapper) => wrapper.session?.process?.pid)
    .filter((pid) => Number.isInteger(pid));
}

function processWorkingSet(pid) {
  if (process.platform === 'win32') {
    const command = `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true
    });
    return result.status === 0 ? Number(result.stdout.trim()) : 0;
  }
  try {
    const result = spawnSync('sh', ['-c', `awk '/VmRSS/ { print $2 * 1024 }' /proc/${pid}/status`], { encoding: 'utf8' });
    return result.status === 0 ? Number(result.stdout.trim()) : 0;
  } catch {
    return 0;
  }
}

function openDocumentCount(service) {
  return [...service.sessions.values()]
    .reduce((sum, wrapper) => sum + (wrapper.session?.documents?.size ?? 0), 0);
}

async function measureTier(name, budget, clangTools) {
  const fixtureStarted = performance.now();
  const fixture = await prepareFixture(name, budget.projectFiles, clangTools.compiler);
  const fixtureMilliseconds = performance.now() - fixtureStarted;
  const service = createClangIndexService({ maxOpenDocuments: 4, maxSessions: 2 });
  try {
    const request = {
      compileCommandsPath: fixture.databasePath,
      filePath: fixture.targetFile,
      functionName: 'inspect',
      clangdPath: clangTools.clangd,
      targetHints: { members: ['value', 'quality'], globals: ['global_value'] }
    };
    const coldStarted = performance.now();
    const cold = await service.indexFile(request);
    const coldMilliseconds = performance.now() - coldStarted;
    const warmStarted = performance.now();
    const warm = await service.indexFile(request);
    const warmMilliseconds = performance.now() - warmStarted;
    const pids = clangdPids(service);
    const workingSetBytes = process.memoryUsage().rss + pids.reduce((sum, pid) => sum + processWorkingSet(pid), 0);
    const documents = openDocumentCount(service);
    const result = {
      name,
      projectFiles: budget.projectFiles,
      fixtureMilliseconds: Math.round(fixtureMilliseconds),
      coldMilliseconds: Math.round(coldMilliseconds),
      warmMilliseconds: Math.round(warmMilliseconds),
      workingSetMegabytes: Math.round(workingSetBytes / 1024 / 1024),
      openDocuments: documents,
      cacheEntries: service.cache.size,
      fields: cold.fields.length,
      analyzer: cold.analyzer,
      cacheHit: warm.performance?.cacheHit === true,
      passed: true,
      failures: []
    };
    if (coldMilliseconds > budget.coldMilliseconds) result.failures.push(`首次分析 ${Math.round(coldMilliseconds)}ms > ${budget.coldMilliseconds}ms`);
    if (warmMilliseconds > budget.warmMilliseconds) result.failures.push(`缓存分析 ${Math.round(warmMilliseconds)}ms > ${budget.warmMilliseconds}ms`);
    if (result.workingSetMegabytes > budget.workingSetMegabytes) result.failures.push(`内存 ${result.workingSetMegabytes}MB > ${budget.workingSetMegabytes}MB`);
    if (documents > 1) result.failures.push(`只打开一个文件却保留了 ${documents} 个 clangd 文档`);
    if (service.cache.size > 1) result.failures.push(`只分析一个文件却产生了 ${service.cache.size} 个代码缓存`);
    if (!result.cacheHit) result.failures.push('第二次分析没有命中缓存');
    if (!cold.fields.some((field) => field.memberName === 'value')) result.failures.push('没有识别目标结构体字段');
    result.passed = result.failures.length === 0;
    return result;
  } finally {
    await service.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
}

const clangTools = await tools();
await mkdir(benchmarkRoot, { recursive: true });
const results = [];
for (const [name, budget] of Object.entries(budgets)) {
  process.stdout.write(`正在测试 ${name}（${budget.projectFiles} 个代码文件）……\n`);
  const result = await measureTier(name, budget, clangTools);
  results.push(result);
  process.stdout.write(`  首次 ${result.coldMilliseconds}ms；缓存 ${result.warmMilliseconds}ms；内存 ${result.workingSetMegabytes}MB；当前文件缓存 ${result.cacheEntries}\n`);
}
const report = {
  reportVersion: 1,
  createdAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  compiler: clangTools.compiler,
  clangd: clangTools.clangd,
  results,
  passed: results.every((result) => result.passed)
};
const reportPath = resolve(benchmarkRoot, 'latest.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (!report.passed) {
  for (const result of results.filter((item) => !item.passed)) {
    process.stderr.write(`${result.name} 性能门禁失败：${result.failures.join('；')}\n`);
  }
  if (gate) process.exitCode = 1;
}
process.stdout.write(`${report.passed ? '性能门禁通过' : '性能门禁发现问题'}。报告：${reportPath}\n`);
