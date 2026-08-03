import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(repositoryRoot, 'labs', '2048_csv_replay', 'src', 'replay_scenario.cpp');
const includeDirectory = resolve(repositoryRoot, 'labs', '2048_csv_replay', 'include');
const buildDirectory = resolve(repositoryRoot, 'build', '2048_csv_replay-current-mingw');
const compileCommandsPath = resolve(buildDirectory, 'compile_commands.json');
const objectPath = resolve(buildDirectory, process.platform === 'win32' ? 'replay_scenario.obj' : 'replay_scenario.o');
const toolsDirectory = resolve(repositoryRoot, 'tools');
const isWindows = process.platform === 'win32';

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fromPath(command) {
  const locator = isWindows ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

async function findUnder(directory, wantedNames, depth = 0) {
  if (depth > 6 || !await exists(directory)) return undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && wantedNames.has(entry.name.toLowerCase())) return resolve(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findUnder(resolve(directory, entry.name), wantedNames, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function findCompiler() {
  const configured = process.env.CLANGXX_PATH?.trim();
  if (configured) {
    const fullPath = resolve(configured);
    if (!await exists(fullPath)) throw new Error(`CLANGXX_PATH 指向不存在的文件：${fullPath}`);
    return fullPath;
  }
  const pathCompiler = fromPath(isWindows ? 'clang++.exe' : 'clang++');
  if (pathCompiler) return pathCompiler;
  if (isWindows) {
    const commonPaths = [
      'C:\\Program Files\\LLVM\\bin\\clang++.exe',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\Llvm\\x64\\bin\\clang++.exe',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\VC\\Tools\\Llvm\\x64\\bin\\clang++.exe',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\Llvm\\x64\\bin\\clang++.exe'
    ];
    for (const candidate of commonPaths) if (await exists(candidate)) return candidate;
  }
  return findUnder(toolsDirectory, new Set(isWindows ? ['clang++.exe'] : ['clang++']));
}

function quote(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

const compiler = await findCompiler();
if (!compiler) {
  throw new Error('测试需要 clang++。请安装 LLVM，或通过 CLANGXX_PATH 指定 clang++；普通用户安装本工具不需要它。');
}

await mkdir(buildDirectory, { recursive: true });
const command = [
  quote(compiler),
  '-std=c++17',
  `-I${quote(includeDirectory)}`,
  '-c', quote(sourcePath),
  '-o', quote(objectPath)
].join(' ');
await writeFile(compileCommandsPath, `${JSON.stringify([{
  directory: buildDirectory,
  command,
  file: sourcePath,
  output: objectPath
}], null, 2)}\n`, 'utf8');

process.stdout.write(`Prepared self-contained Clang test fixture with ${compiler}.\n`);
