import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(repositoryRoot, 'labs', '2048_csv_replay');
const buildDirectory = resolve(repositoryRoot, 'build', '2048_csv_replay-current-mingw');
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

async function resolveTool(environmentName, pathNames, bundledNames) {
  const configured = process.env[environmentName]?.trim();
  if (configured) {
    const fullPath = resolve(configured);
    if (!await exists(fullPath)) throw new Error(`${environmentName} 指向不存在的文件：${fullPath}`);
    return fullPath;
  }
  for (const name of pathNames) {
    const found = fromPath(name);
    if (found) return found;
  }
  return findUnder(toolsDirectory, new Set(bundledNames.map((name) => name.toLowerCase())));
}

const cmake = await resolveTool('CMAKE_PATH', ['cmake'], ['cmake.exe', 'cmake']);
const compiler = await resolveTool('CLANGXX_PATH', ['clang++'], ['clang++.exe', 'clang++']);
if (!cmake) throw new Error('测试需要 CMake。GitHub runner 已自带；本机可设置 CMAKE_PATH。');
if (!compiler) throw new Error('测试需要 clang++。GitHub runner 已自带；本机可设置 CLANGXX_PATH。');

let generator;
let makeProgram;
const ninja = await resolveTool('NINJA_PATH', ['ninja'], ['ninja.exe', 'ninja']);
if (ninja) {
  generator = 'Ninja';
  makeProgram = ninja;
} else if (isWindows) {
  const compilerDirectory = dirname(compiler);
  const neighboringMake = resolve(compilerDirectory, 'mingw32-make.exe');
  makeProgram = await exists(neighboringMake)
    ? neighboringMake
    : await resolveTool('MINGW32_MAKE_PATH', ['mingw32-make'], ['mingw32-make.exe']);
  if (!makeProgram) throw new Error('Windows 测试需要 Ninja 或 mingw32-make。可设置 NINJA_PATH 或 MINGW32_MAKE_PATH。');
  generator = 'MinGW Makefiles';
} else {
  generator = 'Unix Makefiles';
}

const argumentsList = [
  '-S', sourceDirectory,
  '-B', buildDirectory,
  '-G', generator,
  '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
  `-DCMAKE_CXX_COMPILER=${compiler}`
];
if (makeProgram) argumentsList.push(`-DCMAKE_MAKE_PROGRAM=${makeProgram}`);

const result = spawnSync(cmake, argumentsList, {
  cwd: repositoryRoot,
  encoding: 'utf8',
  windowsHide: true,
  stdio: 'inherit'
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`CMake 测试夹具生成失败，退出码 ${result.status}`);

const compileCommandsPath = resolve(buildDirectory, 'compile_commands.json');
if (!await exists(compileCommandsPath)) {
  throw new Error(`CMake 没有生成 ${compileCommandsPath}；请使用支持 compile_commands.json 的生成器。`);
}
process.stdout.write(`Prepared Clang test fixture with ${basename(cmake)}, ${basename(compiler)} and ${generator}.\n`);
