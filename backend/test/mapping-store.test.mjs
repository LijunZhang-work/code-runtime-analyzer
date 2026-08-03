import test from 'node:test';
import assert from 'node:assert/strict';
import { MappingStore } from '../src/mapping-store.mjs';

test('MappingStore lists unique CSV sources for a run record', () => {
  const store = new MappingStore();
  for (const [index, csvSourceId] of ['tiles', 'tiles', 'board'].entries()) {
    store.add({
      runRecordId: 'run-1',
      csvSourceId,
      csvColumn: `FIELD_${index}`,
      codeField: { module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value', index }
    });
  }
  assert.deepEqual(store.sourceIdsForRun('run-1'), ['tiles', 'board']);
  assert.deepEqual(store.sourceIdsForRun('missing-run'), []);
});

test('MappingStore lists runs and unique fields without array indexes', () => {
  const store = new MappingStore();
  for (const index of [0, 1, 2]) {
    store.add({
      runRecordId: 'run-1',
      csvSourceId: 'tiles',
      csvColumn: `TILE_${index}_VALUE`,
      codeField: { module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value', index },
      mappingSource: 'rule',
      confidence: 'confirmed'
    });
  }
  store.add({
    runRecordId: 'run-2',
    csvSourceId: 'board',
    csvColumn: 'SCORE',
    codeField: { module: 'demo', typeName: 'Board', variablePath: 'board', fieldName: 'score' }
  });

  assert.deepEqual(store.listRuns(), [
    { runRecordId: 'run-1', sourceIds: ['tiles'], mappingCount: 3 },
    { runRecordId: 'run-2', sourceIds: ['board'], mappingCount: 1 }
  ]);
  assert.deepEqual(store.listFieldDescriptors('run-1', { module: 'demo', typeName: 'Tile' }), [{
    codeField: { module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value' },
    instanceCount: 3,
    mappingSource: 'rule',
    confidence: 'confirmed'
  }]);
  assert.deepEqual(store.listFieldDescriptors('run-1', { typeName: 'Board' }), []);
});

test('MappingStore member identity is type plus field, independent of module and variable path', () => {
  const store = new MappingStore();
  store.add({
    runRecordId: 'run-1',
    csvSourceId: 'tiles',
    csvColumn: 'TILE_0_VALUE',
    codeField: { module: 'legacy-module', typeName: 'Game::Tile', variablePath: 'tiles', fieldName: 'value', index: 0 }
  });
  assert.equal(store.find('run-1', {
    module: 'another-module', typeName: 'Game::Tile', variablePath: 'current', fieldName: 'value', index: 0
  }).csvColumn, 'TILE_0_VALUE');
  assert.equal(store.findInstances('run-1', {
    typeName: 'Game::Tile', fieldName: 'value'
  }).length, 1);
});

test('MappingStore keeps identical qualified targets in different definition files distinct and never guesses', () => {
  const store = new MappingStore();
  for (const [definitionPath, csvColumn] of [
    ['src/first/student.hpp', 'first_age'],
    ['src/second/student.hpp', 'second_age']
  ]) {
    store.add({
      runRecordId: 'run-1',
      csvSourceId: 'students',
      csvColumn,
      codeField: {
        targetKind: 'member',
        typeName: 'demo::Student',
        fieldName: 'age',
        definitionPath
      }
    });
  }

  assert.equal(store.listFieldDescriptors('run-1').length, 2);
  assert.equal(store.find('run-1', {
    targetKind: 'member', typeName: 'demo::Student', fieldName: 'age',
    definitionPath: 'src/first/student.hpp'
  }).csvColumn, 'first_age');
  assert.equal(store.find('run-1', {
    targetKind: 'member', typeName: 'demo::Student', fieldName: 'age'
  }), undefined);
  assert.deepEqual(store.findInstances('run-1', {
    targetKind: 'member', typeName: 'demo::Student', fieldName: 'age'
  }), []);
});
