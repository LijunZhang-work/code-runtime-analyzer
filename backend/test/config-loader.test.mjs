import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CsvStore } from '../src/csv-store.mjs';
import { MappingStore } from '../src/mapping-store.mjs';
import { importConfig } from '../src/config-loader.mjs';

test('config loader combines legacy inline mappings with a relative mappingFile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-config-'));
  try {
    await writeFile(join(directory, 'data.csv'), 'timestamp,TILE_0_VALUE,TILE_1_VALUE,SCORE\n1000,2,4,10\n');
    await writeFile(join(directory, 'fields.csv'), [
      'run_record_id,target_kind,csv_source_id,csv_column,csv_column_pattern,module,type_name,variable_path,field_name,qualified_name,value_type,index_from,index_to',
      'run-1,struct_field,game,,TILE_{index}_VALUE,demo,Tile,tiles,value,,int,0,1',
      'run-1,global,game,SCORE,,demo,,,,Game::score,int,,'
    ].join('\n'));
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      csvSources: [{ id: 'game', filePath: './data.csv', timeColumn: 'timestamp', timeFormat: 'unix_ms' }],
      mappings: [{
        runRecordId: 'run-1',
        csvSourceId: 'game',
        csvColumn: 'SCORE',
        codeField: { module: 'demo', typeName: 'Board', variablePath: 'board', fieldName: 'score' }
      }],
      mappingFile: './fields.csv'
    }));

    const csvStore = new CsvStore();
    const mappingStore = new MappingStore();
    const result = await importConfig(join(directory, 'config.json'), { csvStore, mappingStore });
    assert.deepEqual(result, { importedSources: 1, importedMappings: 4, importedMappingFileMappings: 3 });
    assert.equal(mappingStore.find('run-1', {
      module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value', valueType: 'int', index: 1
    }).csvColumn, 'TILE_1_VALUE');
    assert.equal(mappingStore.find('run-1', {
      targetKind: 'global', module: 'demo', qualifiedName: 'Game::score'
    }).csvColumn, 'SCORE');
    assert.equal(mappingStore.find('run-1', {
      module: 'demo', typeName: 'Board', variablePath: 'board', fieldName: 'score'
    }).csvColumn, 'SCORE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('config loader keeps legacy rule-only configs compatible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-legacy-config-'));
  try {
    await writeFile(join(directory, 'data.csv'), 'timestamp,TILE_0_VALUE,TILE_1_VALUE\n1000,2,4\n');
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      csvSources: [{ id: 'game', filePath: './data.csv', timeColumn: 'timestamp', timeFormat: 'unix_ms' }],
      mappings: [],
      rules: [{
        runRecordId: 'run-1',
        csvSourceId: 'game',
        csvColumnPattern: 'TILE_{index}_VALUE',
        codeField: { module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value' },
        indexSource: 'loop index',
        mappingSource: 'rule',
        confidence: 'confirmed'
      }]
    }));
    const mappingStore = new MappingStore();
    const result = await importConfig(join(directory, 'config.json'), { csvStore: new CsvStore(), mappingStore });
    assert.deepEqual(result, { importedSources: 1, importedMappings: 2, importedMappingFileMappings: 0 });
    assert.equal(mappingStore.findInstances('run-1', {
      module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value'
    }).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('config loader rejects duplicate targets across mapping file rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-duplicate-config-'));
  try {
    await writeFile(join(directory, 'data.csv'), 'timestamp,SCORE\n1000,10\n');
    await writeFile(join(directory, 'fields.csv'), [
      'run_record_id,target_kind,csv_source_id,csv_column,module,qualified_name',
      'run-1,global,game,SCORE,demo,Game::score',
      'run-1,global,game,SCORE,demo,Game::score'
    ].join('\n'));
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      csvSources: [{ id: 'game', filePath: './data.csv', timeColumn: 'timestamp', timeFormat: 'unix_ms' }],
      mappingFile: './fields.csv'
    }));
    await assert.rejects(
      importConfig(join(directory, 'config.json'), { csvStore: new CsvStore(), mappingStore: new MappingStore() }),
      /重复字段映射.*fields\.csv 第 2 行.*fields\.csv 第 3 行/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('config loader stages every CSV before committing and leaves prior state intact on failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-atomic-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldPath = join(directory, 'old.csv');
  await writeFile(oldPath, 'timestamp,value\n1000,old\n');
  const csvStore = new CsvStore();
  await csvStore.importSource({ id: 'old', filePath: oldPath, timeColumn: 'timestamp', timeFormat: 'unix_ms' });
  const mappingStore = new MappingStore();
  mappingStore.add({
    runRecordId: 'old-run', csvSourceId: 'old', csvColumn: 'value',
    codeField: { typeName: 'Old', fieldName: 'value' }
  });

  await writeFile(join(directory, 'first.csv'), 'timestamp,value\n1000,first\n');
  await writeFile(join(directory, 'second.csv'), 'timestamp,value\nnot-a-time,second\n');
  await writeFile(join(directory, 'config.json'), JSON.stringify({
    csvSources: [
      { id: 'first', filePath: './first.csv', timeColumn: 'timestamp', timeFormat: 'unix_ms' },
      { id: 'second', filePath: './second.csv', timeColumn: 'timestamp', timeFormat: 'unix_ms' }
    ],
    mappings: [{
      runRecordId: 'new-run', csvSourceId: 'first', csvColumn: 'value',
      codeField: { typeName: 'New', fieldName: 'value' }
    }]
  }));

  await assert.rejects(importConfig(join(directory, 'config.json'), { csvStore, mappingStore }), /时间无法解析/);
  assert.equal(csvStore.describeSource('first'), undefined);
  assert.equal(csvStore.query({ sourceId: 'old', column: 'value', requestedTime: '1000' }).value, 'old');
  assert.equal(mappingStore.find('old-run', { typeName: 'Old', fieldName: 'value' }).csvColumn, 'value');
  assert.equal(mappingStore.find('new-run', { typeName: 'New', fieldName: 'value' }), undefined);
});

test('config loader replaces mappings for a repeated run instead of retaining removed fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-reload-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'data.csv'), 'timestamp,a,b\n1000,1,2\n');
  const configPath = join(directory, 'config.json');
  const source = { id: 'data', filePath: './data.csv', timeColumn: 'timestamp', timeFormat: 'unix_ms' };
  const mapping = (field) => ({
    runRecordId: 'run-1', csvSourceId: 'data', csvColumn: field,
    codeField: { typeName: 'State', fieldName: field }
  });
  const csvStore = new CsvStore();
  const mappingStore = new MappingStore();
  await writeFile(configPath, JSON.stringify({ csvSources: [source], mappings: [mapping('a'), mapping('b')] }));
  await importConfig(configPath, { csvStore, mappingStore });
  assert.equal(mappingStore.listFieldDescriptors('run-1').length, 2);

  await writeFile(configPath, JSON.stringify({ csvSources: [source], mappings: [mapping('a')] }));
  await importConfig(configPath, { csvStore, mappingStore });
  assert.deepEqual(mappingStore.listFieldDescriptors('run-1').map((item) => item.codeField.fieldName), ['a']);
});
