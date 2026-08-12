import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const opencvRoot = resolve(repositoryRoot, 'build', 'real-benchmark', 'opencv');
const buildRoot = resolve(repositoryRoot, 'build', 'real-benchmark', 'opencv-local-build');
const generatedInclude = resolve(buildRoot, 'include');
const targetFile = resolve(opencvRoot, 'modules', 'core', 'src', 'algorithm.cpp');

async function exists(filePath) { try { await access(filePath); return true; } catch { return false; } }
async function findUnder(directory, name, depth = 0) {
  if (depth > 7 || !await exists(directory)) return undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  const direct = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === name);
  if (direct) return resolve(directory, direct.name);
  for (const entry of entries) if (entry.isDirectory()) {
    const found = await findUnder(resolve(directory, entry.name), name, depth + 1);
    if (found) return found;
  }
}
function fromPath(name) {
  const found = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
  return found.status === 0 ? found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined;
}

if (!await exists(targetFile)) throw new Error(`请先把 OpenCV 4.13.0 放到：${opencvRoot}`);
const compiler = process.env.CLANGXX_PATH?.trim() || fromPath('clang++.exe')
  || await findUnder(resolve(repositoryRoot, 'tools'), 'clang++.exe');
if (!compiler) throw new Error('找不到 clang++.exe');
const clangd = process.env.CLANGD_TEST_PATH?.trim() || resolve(dirname(compiler), 'clangd.exe');
if (!await exists(clangd)) throw new Error('找不到 clangd.exe');

await mkdir(resolve(generatedInclude, 'opencv2'), { recursive: true });
await writeFile(resolve(generatedInclude, 'opencv2', 'cvconfig.h'), '#pragma once\n#define HAVE_WIN32UI 1\n', 'utf8');
await writeFile(resolve(generatedInclude, 'opencv2', 'opencv_modules.hpp'), '#pragma once\n#define HAVE_OPENCV_CORE\n', 'utf8');
const includePaths = [
  generatedInclude,
  resolve(opencvRoot, 'include'),
  resolve(opencvRoot, 'modules', 'core', 'include'),
  resolve(opencvRoot, 'modules', 'core', 'src')
];
const databasePath = resolve(buildRoot, 'compile_commands.json');
await writeFile(databasePath, `${JSON.stringify([{
  directory: buildRoot,
  arguments: [compiler, '-std=c++17', ...includePaths.map((path) => `-I${path}`), '-D_WIN32', '-DWIN32', '-c', targetFile, '-o', resolve(buildRoot, 'algorithm.o')],
  file: targetFile,
  output: resolve(buildRoot, 'algorithm.o')
}], null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ opencvRoot, databasePath, targetFile, compiler, clangd }, null, 2)}\n`);
