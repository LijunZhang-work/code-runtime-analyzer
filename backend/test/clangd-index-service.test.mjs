import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClangIndexService } from '../src/clang-indexer.mjs';

const workspace = resolve(import.meta.dirname, '../..');
const clangdPath = process.env.CLANGD_TEST_PATH;

async function bundledCompiler() {
  const database = JSON.parse(await readFile(
    `${workspace}/build/2048_csv_replay-current-mingw/compile_commands.json`, 'utf8'
  ));
  return database[0].command.match(/^(?:"([^"]+)"|(\S+))/)?.slice(1).find(Boolean);
}

test('Clangd index parses once and serves an unchanged structural result from cache', {
  skip: process.platform !== 'win32'
}, async () => {
  const service = createClangIndexService();
  try {
    const request = {
      compileCommandsPath: `${workspace}/build/2048_csv_replay-current-mingw/compile_commands.json`,
      filePath: `${workspace}/labs/2048_csv_replay/src/replay_scenario.cpp`,
      clangdPath,
      targetHints: { members: ['value', 'blocked', 'score'], globals: [] }
    };
    const cold = await service.indexFile(request);
    const warm = await service.indexFile(request);
    assert.equal(cold.analyzer, 'clangd-ast');
    assert.equal(cold.performance.cacheHit, false);
    assert.equal(cold.performance.clangProcessCount, 1);
    assert.equal(warm.performance.cacheHit, true);
    assert.equal(warm.performance.clangProcessCount, 0);
    assert.deepEqual(warm.fields, cold.fields);
  } finally {
    await service.dispose();
  }
});

test('Clangd index supports arguments entries and covers methods with UTF-8 before the access', {
  skip: process.platform !== 'win32'
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clangd-index-'));
  const service = createClangIndexService();
  try {
    const compiler = await bundledCompiler();
    assert.ok(compiler);
    const sourcePath = join(directory, 'student.cpp');
    const databasePath = join(directory, 'compile_commands.json');
    await writeFile(sourcePath, [
      'namespace school {',
      'struct Student { int age; int read() const; };',
      'int Student::read() const {',
      '  // 中文和 emoji 🙂 不得让后面的范围错位',
      '  return age;',
      '}',
      '}',
      ''
    ].join('\n'), 'utf8');
    await writeFile(databasePath, JSON.stringify([{
      directory,
      arguments: [compiler, '-c', sourcePath, '-o', join(directory, 'student.obj')],
      file: sourcePath
    }]), 'utf8');
    const result = await service.indexFile({
      compileCommandsPath: databasePath,
      filePath: sourcePath,
      clangdPath,
      targetHints: { members: ['age'], globals: [] }
    });
    const age = result.fields.find((field) => field.memberName === 'age');
    assert.ok(age, JSON.stringify(result, null, 2));
    assert.equal(age.functionName, 'read');
    assert.equal(age.qualifiedName, 'school::Student::age');
    assert.equal(age.expression, 'age');
    assert.deepEqual(age.range, {
      start: { line: 5, column: 10 },
      end: { line: 5, column: 13 }
    });
    assert.equal(age.rootStorageKind, 'this');
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Clangd index refuses to guess when one source has multiple compile contexts', {
  skip: process.platform !== 'win32'
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clangd-context-'));
  const service = createClangIndexService();
  try {
    const compiler = await bundledCompiler();
    assert.ok(compiler);
    const sourcePath = join(directory, 'product.cpp');
    const databasePath = join(directory, 'compile_commands.json');
    await writeFile(sourcePath, 'int product() { return 1; }\n', 'utf8');
    await writeFile(databasePath, JSON.stringify([
      { directory, arguments: [compiler, '-DPRODUCT_A', '-c', sourcePath], file: sourcePath },
      { directory, arguments: [compiler, '-DPRODUCT_B', '-c', sourcePath], file: sourcePath }
    ]), 'utf8');
    await assert.rejects(
      service.indexFile({ compileCommandsPath: databasePath, filePath: sourcePath, clangdPath }),
      (error) => error?.details?.code === 'compile_context_ambiguous'
        && error.details.candidateCount === 2
    );
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
