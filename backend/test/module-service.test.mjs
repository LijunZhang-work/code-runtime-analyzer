import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteProductModule, listProductModules, upsertProductModule } from '../src/module-service.mjs';

test('product modules are stored inside the code repository and keep relative function paths', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'cpp-csv-modules-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const empty = await listProductModules({ workspaceRoot });
  assert.equal(empty.storagePath, '.cpp-csv-diagnostics/product-modules.json');
  assert.deepEqual(empty.modules, []);

  const saved = await upsertProductModule({
    workspaceRoot,
    module: {
      name: '棋盘移动计算',
      description: '根据当前棋盘状态完成一次移动。',
      functions: [{ functionName: 'apply_move', relativePath: 'src/replay_scenario.cpp', line: 55 }]
    }
  });
  assert.equal(saved.modules.length, 1);
  assert.equal(saved.module.functions[0].relativePath, 'src/replay_scenario.cpp');

  const text = await readFile(join(workspaceRoot, '.cpp-csv-diagnostics', 'product-modules.json'), 'utf8');
  assert.match(text, /棋盘移动计算/);
  const deleted = await deleteProductModule({ workspaceRoot, moduleId: saved.module.id });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.modules, []);
});

test('product modules reject absolute and parent-directory function paths', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'cpp-csv-modules-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await assert.rejects(() => upsertProductModule({
    workspaceRoot,
    module: { name: 'bad', functions: [{ functionName: 'f', relativePath: '../outside.cpp' }] }
  }), /函数路径/);
});
