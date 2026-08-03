import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CsvStore } from '../src/csv-store.mjs';
import { MappingStore } from '../src/mapping-store.mjs';
import { EvidenceService } from '../src/evidence-service.mjs';

test('EvidenceService returns a full series and statistics for every mapped instance', async () => {
  const path = join(tmpdir(), `diagnostic-evidence-series-${Date.now()}.csv`);
  await writeFile(path, [
    'timestamp,TILE_0_VALUE,TILE_1_VALUE',
    '1000,2,4',
    '2000,2,8',
    '3000,16,8'
  ].join('\n'));
  try {
    const csvStore = new CsvStore();
    await csvStore.importSource({ id: 'tiles', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });
    const mappingStore = new MappingStore();
    for (const index of [0, 1]) {
      mappingStore.add({
        runRecordId: 'run-1',
        csvSourceId: 'tiles',
        csvColumn: `TILE_${index}_VALUE`,
        codeField: { module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value', index },
        mappingSource: 'rule',
        confidence: 'confirmed'
      });
    }

    const result = new EvidenceService(csvStore, mappingStore).querySeries({
      runRecordId: 'run-1',
      codeField: { module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value' }
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.instances.length, 2);
    assert.deepEqual(result.instances[0].statistics, { pointCount: 3, min: 2, max: 16, changeCount: 1 });
    assert.deepEqual(result.instances[1].statistics, { pointCount: 3, min: 4, max: 8, changeCount: 1 });
    assert.equal(result.instances[0].mapping.csvColumn, 'TILE_0_VALUE');
    assert.deepEqual(result.instances[0].points.map((point) => point.value), ['2', '2', '16']);
    assert.equal(result.instances[0].points[0].sourceName, path.split(/[\\/]/).at(-1));
  } finally {
    await rm(path, { force: true });
  }
});

test('EvidenceService reports an unmapped series without throwing', () => {
  const service = new EvidenceService(new CsvStore(), new MappingStore());
  const result = service.querySeries({
    runRecordId: 'missing',
    codeField: { module: 'demo', typeName: 'Tile', variablePath: 'tiles', fieldName: 'value' }
  });
  assert.equal(result.status, 'unmapped');
  assert.deepEqual(result.instances, []);
});

test('EvidenceService returns multiple field snapshots in input order', async (t) => {
  const path = join(tmpdir(), `diagnostic-evidence-snapshot-${Date.now()}.csv`);
  t.after(() => rm(path, { force: true }));
  await writeFile(path, [
    'timestamp,score,moved',
    '1000,7,0',
    '2000,9,1'
  ].join('\n'));
  const csvStore = new CsvStore();
  await csvStore.importSource({ id: 'metrics', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });
  const mappingStore = new MappingStore();
  for (const fieldName of ['score', 'moved']) {
    mappingStore.add({
      runRecordId: 'run-snapshot',
      csvSourceId: 'metrics',
      csvColumn: fieldName,
      codeField: { typeName: 'Game', fieldName },
      mappingSource: 'rule',
      confidence: 'confirmed'
    });
  }
  const fields = [
    { typeName: 'Game', fieldName: 'moved' },
    { typeName: 'Game', fieldName: 'missing' },
    { typeName: 'Game', fieldName: 'score' }
  ];
  const result = new EvidenceService(csvStore, mappingStore).querySnapshot({
    runRecordId: 'run-snapshot', codeFields: fields, requestedTime: '2000'
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.runRecordId, 'run-snapshot');
  assert.equal(result.requestedTime, '2000');
  assert.deepEqual(result.results.map(({ status, codeField }) => ({ status, codeField })), [
    { status: 'ok', codeField: fields[0] },
    { status: 'unmapped', codeField: fields[1] },
    { status: 'ok', codeField: fields[2] }
  ]);
  assert.equal(result.results[0].instances[0].evidence.value, '1');
  assert.equal(result.results[2].instances[0].evidence.value, '9');
  assert.throws(
    () => new EvidenceService(csvStore, mappingStore).querySnapshot({ runRecordId: 'run-snapshot', requestedTime: '2000' }),
    /codeFields 必须是数组/
  );
});

test('EvidenceService computes statistics for very large series without spreading numeric arrays', () => {
  const pointCount = 200_000;
  const points = Array.from({ length: pointCount }, (_, index) => ({ rawValue: String(index) }));
  const csvStore = {
    listColumnSamples: () => points,
    describeSource: () => ({ id: 'large', name: 'large.csv' })
  };
  const mappingStore = new MappingStore();
  mappingStore.add({
    runRecordId: 'run-large',
    csvSourceId: 'large',
    csvColumn: 'value',
    codeField: { typeName: 'Metrics', fieldName: 'value' }
  });

  const result = new EvidenceService(csvStore, mappingStore).querySeries({
    runRecordId: 'run-large', codeField: { typeName: 'Metrics', fieldName: 'value' }
  });
  assert.deepEqual(result.instances[0].statistics, {
    pointCount,
    min: 0,
    max: pointCount - 1,
    changeCount: pointCount - 1
  });
});
