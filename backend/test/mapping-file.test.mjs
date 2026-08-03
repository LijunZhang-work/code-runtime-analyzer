import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CsvStore } from '../src/csv-store.mjs';
import { parseMappingFile } from '../src/mapping-file.mjs';

async function sourceStore(path) {
  await writeFile(path, 'timestamp,TILE_0_VALUE,TILE_1_VALUE,SCORE\n1000,2,4,10\n');
  const csvStore = new CsvStore();
  await csvStore.importSource({ id: 'game', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });
  return csvStore;
}

test('mapping file parser expands struct patterns and accepts global symbols', async () => {
  const path = join(tmpdir(), `mapping-parser-data-${Date.now()}.csv`);
  try {
    const csvStore = await sourceStore(path);
    const text = [
      'run_record_id,target_kind,csv_source_id,csv_column,csv_column_pattern,module,type_name,variable_path,field_name,qualified_name,code_symbol,value_type,index_from,index_to,mapping_source,confidence',
      'run-1,struct_field,game,,TILE_{index}_VALUE,demo,Game::Tile,tiles,value,,,int,0,1,manual,confirmed',
      'run-1,global,game,SCORE,,demo,,,,,Game::score,int,,,manual,confirmed'
    ].join('\n');
    const mappings = parseMappingFile(text, { csvStore, fileName: 'fields.csv' });
    assert.equal(mappings.length, 3);
    assert.deepEqual(mappings.slice(0, 2).map((mapping) => ({
      csvColumn: mapping.csvColumn,
      codeField: mapping.codeField
    })), [
      {
        csvColumn: 'TILE_0_VALUE',
        codeField: { module: 'demo', typeName: 'Game::Tile', variablePath: 'tiles', fieldName: 'value', valueType: 'int', index: 0 }
      },
      {
        csvColumn: 'TILE_1_VALUE',
        codeField: { module: 'demo', typeName: 'Game::Tile', variablePath: 'tiles', fieldName: 'value', valueType: 'int', index: 1 }
      }
    ]);
    assert.deepEqual(mappings[2].codeField, {
      targetKind: 'global',
      module: 'demo',
      qualifiedName: 'Game::score',
      codeSymbol: 'Game::score',
      valueType: 'int'
    });
    assert.equal(mappings[2].mappingFileRow, 3);
  } finally {
    await rm(path, { force: true });
  }
});

test('mapping file parser discovers pattern indexes when no range is supplied', async () => {
  const path = join(tmpdir(), `mapping-parser-discovery-${Date.now()}.csv`);
  try {
    const csvStore = await sourceStore(path);
    const text = [
      'run_record_id,target_kind,csv_source_id,csv_column_pattern,module,type_name,variable_path,field_name',
      'run-1,struct_field,game,TILE_{index}_VALUE,demo,Game::Tile,tiles,value'
    ].join('\n');
    assert.deepEqual(
      parseMappingFile(text, { csvStore, fileName: 'fields.csv' }).map((mapping) => mapping.codeField.index),
      [0, 1]
    );
  } finally {
    await rm(path, { force: true });
  }
});

test('mapping file parser rejects missing data columns and incomplete ranges', async () => {
  const path = join(tmpdir(), `mapping-parser-invalid-${Date.now()}.csv`);
  try {
    const csvStore = await sourceStore(path);
    const header = 'run_record_id,target_kind,csv_source_id,csv_column,csv_column_pattern,module,type_name,variable_path,field_name,index_from,index_to';
    assert.throws(() => parseMappingFile([
      header,
      'run-1,struct_field,game,DOES_NOT_EXIST,,demo,Tile,tiles,value,,'
    ].join('\n'), { csvStore, fileName: 'fields.csv' }), /数据列不存在/);
    assert.throws(() => parseMappingFile([
      header,
      'run-1,struct_field,game,,TILE_{index}_VALUE,demo,Tile,tiles,value,0,'
    ].join('\n'), { csvStore, fileName: 'fields.csv' }), /必须同时填写/);
  } finally {
    await rm(path, { force: true });
  }
});
