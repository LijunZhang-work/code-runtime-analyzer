import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { indexFile } from '../src/clang-indexer.mjs';

const workspace = resolve(import.meta.dirname, '../..');

test('Clang index finds array-member expressions in the replay writer', { skip: process.platform !== 'win32' }, async () => {
  const result = await indexFile({
    compileCommandsPath: `${workspace}/build/2048_csv_replay-current-mingw/compile_commands.json`,
    // VS Code commonly normalizes a Windows drive letter to lower-case while
    // CMake preserves upper-case in compile_commands.json.
    filePath: `${workspace}/labs/2048_csv_replay/src/replay_scenario.cpp`.toLowerCase(),
    functionName: 'write_snapshot'
  });
  const valueAccess = result.fields.find((field) => field.expression === 'tiles[index].value');
  assert.equal(valueAccess.memberName, 'value');
  assert.equal(valueAccess.variablePath, 'tiles');
  assert.equal(valueAccess.indexExpression, 'index');
  assert.equal(valueAccess.kind, 'clang_semantic_fact');
  assert.equal(valueAccess.symbolKind, 'struct_field');
  assert.equal(valueAccess.ownerType, 'Game::tile_t');
  assert.equal(valueAccess.accessOwnerType, 'Game::tile_t');
  assert.equal(valueAccess.declaringType, 'Game::tile_t');
  assert.equal(valueAccess.valueType, 'unsigned long long');
  assert.equal(valueAccess.qualifiedName, 'Game::tile_t::value');
  assert.equal(valueAccess.qualifiedNameSource, 'field_declaration');
  assert.equal(valueAccess.definitionFile,
    resolve(workspace, 'labs/2048_csv_replay/include/tile.hpp'));
  assert.equal(valueAccess.declarationFile, valueAccess.definitionFile);
  // The optimized clangd path reports the canonical FieldDecl line.  This is
  // the location the dictionary actually identifies, rather than the opening
  // line of the enclosing record.
  assert.equal(valueAccess.definitionLine, 6);
  assert.equal(valueAccess.declarationLine, 6);
  assert.equal(valueAccess.variableDeclarationKind, 'VarDecl');
  assert.match(valueAccess.variableDeclarationType, /vector<(?:Game::)?tile_t/);
  assert.equal(valueAccess.rootStorageKind, 'local');
});

test('Clang index batches exact functions and parses concatenated main AST roots', { skip: process.platform !== 'win32' }, async () => {
  const result = await indexFile({
    compileCommandsPath: `${workspace}/build/2048_csv_replay-current-mingw/compile_commands.json`,
    filePath: `${workspace}/labs/2048_csv_replay/src/replay_scenario.cpp`,
    functionNames: ['apply_move', 'main', 'apply_move']
  });

  assert.deepEqual(result.functionNames, ['apply_move', 'main']);
  assert.ok(result.fields.some((field) => field.functionName === 'main'));
  assert.ok(result.fields.every((field) => ['apply_move', 'main'].includes(field.functionName)));

  const current = result.fields.find((field) => field.expression === 'current.value');
  assert.equal(current.ownerType, 'Game::tile_t');
  assert.equal(current.variablePath, 'current');
  assert.equal(current.variableDeclarationKind, 'VarDecl');
  assert.equal(current.variableDeclarationType, 'tile_t &');
  assert.equal(current.rootStorageKind, 'local');

  const target = result.fields.find((field) => field.expression === 'target.blocked');
  assert.equal(target.ownerType, 'Game::tile_t');
  assert.equal(target.variablePath, 'target');
  assert.equal(target.qualifiedName, 'Game::tile_t::blocked');

  const board = result.fields.find((field) => field.functionName === 'apply_move' && field.expression === 'board.moved');
  assert.equal(board.ownerType, 'Game::GameBoard');
  assert.equal(board.variablePath, 'board');
  assert.equal(board.variableDeclarationKind, 'ParmVarDecl');
  assert.equal(board.variableDeclarationType, 'GameBoard &');
  assert.equal(board.rootStorageKind, 'parameter');
});

test('Clang index discovers current-file function candidates without dumping the full AST', { skip: process.platform !== 'win32' }, async () => {
  const result = await indexFile({
    compileCommandsPath: `${workspace}/build/2048_csv_replay-current-mingw/compile_commands.json`,
    filePath: `${workspace}/labs/2048_csv_replay/src/replay_scenario.cpp`
  });

  assert.deepEqual(result.functionNames, ['set_board', 'write_header', 'write_snapshot', 'apply_move', 'main']);
  for (const functionName of result.functionNames) {
    assert.ok(result.fields.some((field) => field.functionName === functionName), `expected facts for ${functionName}`);
  }
});

test('Clang index reports independent globals but not locals or member bases as globals', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clang-indexer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'globals.cpp');
  const objectPath = join(directory, 'globals.obj');
  const compileCommandsPath = join(directory, 'compile_commands.json');
  const fixture = [
    'namespace demo {',
    '  static int global_count = 7;',
    '  struct Base { int inherited; };',
    '  struct Derived : Base {};',
    '  using Alias = Derived;',
    '}',
    'struct Item { int value; };',
    'int inspect(Item& item, demo::Alias* derived) {',
    '  int local = 1;',
    '  return demo::global_count + local + item.value + derived->inherited;',
    '}',
    ''
  ].join('\n');
  await writeFile(sourcePath, fixture, 'utf8');

  const replayDatabase = JSON.parse(await readFile(
    `${workspace}/build/2048_csv_replay-current-mingw/compile_commands.json`, 'utf8'
  ));
  const compiler = replayDatabase[0].command.match(/^(?:"([^"]+)"|(\S+))/)?.slice(1).find(Boolean);
  assert.ok(compiler);
  await writeFile(compileCommandsPath, JSON.stringify([{
    directory,
    command: `"${compiler}" -c "${sourcePath}" -o "${objectPath}"`,
    file: sourcePath,
    output: objectPath
  }]), 'utf8');

  const result = await indexFile({ compileCommandsPath, filePath: sourcePath, functionName: 'inspect' });
  const globals = result.fields.filter((field) => field.symbolKind === 'global');
  assert.equal(globals.length, 1);
  assert.equal(globals[0].name, 'global_count');
  assert.equal(globals[0].qualifiedName, 'demo::global_count');
  assert.equal(globals[0].valueType, 'int');
  assert.equal(globals[0].rootStorageKind, 'global');
  assert.equal(globals[0].definitionFile, sourcePath);
  assert.equal(globals[0].declarationFile, sourcePath);
  assert.equal(globals[0].internalLinkage, true);
  assert.equal(globals[0].storageClass, 'static');
  assert.ok(!globals.some((field) => field.name === 'local' || field.name === 'item'));

  const member = result.fields.find((field) => field.expression === 'item.value');
  assert.equal(member.symbolKind, 'struct_field');
  assert.equal(member.ownerType, 'Item');
  assert.equal(member.variablePath, 'item');
  assert.equal(member.rootStorageKind, 'parameter');
  assert.equal(member.definitionFile, sourcePath);

  const inherited = result.fields.find((field) => field.expression === 'derived->inherited');
  // Clang inserts the standards-required derived-to-base conversion before
  // the MemberExpr, so the semantic access owner is already the canonical
  // declaring base rather than the source-spelled Alias pointer type.
  assert.equal(inherited.accessOwnerType, 'demo::Base');
  assert.equal(inherited.ownerType, 'demo::Base');
  assert.equal(inherited.declaringType, 'demo::Base');
  assert.equal(inherited.qualifiedName, 'demo::Base::inherited');
  assert.equal(inherited.qualifiedNameSource, 'field_declaration');
  assert.equal(inherited.definitionFile, sourcePath);
  assert.equal(inherited.declarationFile, sourcePath);
});
