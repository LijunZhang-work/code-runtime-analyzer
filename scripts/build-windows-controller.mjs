import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repositoryRoot, 'installer', 'controller', 'backend-control.cpp');
const outputDirectory = resolve(repositoryRoot, 'build', 'controller');
const output = resolve(outputDirectory, 'backend-control.exe');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fromPath(command) {
  const result = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

async function findUnder(directory, wantedName, depth = 0) {
  if (depth > 7 || !await exists(directory)) return undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  const direct = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === wantedName);
  if (direct) return resolve(directory, direct.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findUnder(resolve(directory, entry.name), wantedName, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function findCompiler() {
  if (process.env.CLANGXX_PATH?.trim()) {
    const configured = resolve(process.env.CLANGXX_PATH.trim());
    if (!await exists(configured)) throw new Error(`CLANGXX_PATH 指向不存在的文件：${configured}`);
    return configured;
  }
  return fromPath('clang++.exe')
    ?? await findUnder(resolve(repositoryRoot, 'tools'), 'clang++.exe');
}

if (process.platform !== 'win32') throw new Error('原生后台控制中心目前只在 Windows 上构建。');
const compiler = await findCompiler();
if (!compiler) {
  throw new Error('构建 Windows 后台控制中心需要 clang++.exe。请设置 CLANGXX_PATH，或先运行测试工具链准备步骤。');
}

await mkdir(outputDirectory, { recursive: true });
const argumentsList = [
  '-std=c++17',
  '-O2',
  '-municode',
  '-mwindows',
  '-static',
  '-static-libgcc',
  '-static-libstdc++',
  source,
  '-o', output,
  '-lcomctl32',
  '-lshell32',
  '-lole32',
  '-luuid'
];
const built = spawnSync(compiler, argumentsList, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
if (built.status !== 0) {
  throw new Error(`原生后台控制中心编译失败：\n${built.stdout}\n${built.stderr}`);
}
if (!await exists(output)) throw new Error(`编译器没有生成后台控制中心：${output}`);
process.stdout.write(`Built native Windows control center: ${output}\n`);
