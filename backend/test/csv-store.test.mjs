import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CsvStore } from '../src/csv-store.mjs';

test('CsvStore reports exact, nearest and absent values distinctly', async () => {
  const path = join(tmpdir(), `diagnostic-${Date.now()}.csv`);
  await writeFile(path, 'timestamp,bossId\n2026-01-01T00:00:00.000Z,11\n2026-01-01T00:00:01.000Z,17\n');
  try {
    const store = new CsvStore();
    await store.importSource({ id: 'boss', filePath: path, timeColumn: 'timestamp' });
    assert.equal(store.query({ sourceId: 'boss', column: 'bossId', requestedTime: '2026-01-01T00:00:01.000Z' }).matchType, 'exact');
    assert.equal(store.query({ sourceId: 'boss', column: 'bossId', requestedTime: '2026-01-01T00:00:00.900Z', toleranceMs: 200 }).value, '17');
    assert.equal(store.query({ sourceId: 'boss', column: 'bossId', requestedTime: '2026-01-01T00:00:00.500Z', toleranceMs: 100 }).matchType, 'none');
  } finally {
    await rm(path, { force: true });
  }
});

test('CsvStore accepts an explicitly configured Unix-millisecond time column', async () => {
  const path = join(tmpdir(), `diagnostic-epoch-${Date.now()}.csv`);
  await writeFile(path, 'timestamp,value\n1785484800000,2\n');
  try {
    const store = new CsvStore();
    await store.importSource({ id: 'epoch', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });
    assert.equal(store.query({ sourceId: 'epoch', column: 'value', requestedTime: '1785484800000' }).matchType, 'exact');
    assert.deepEqual(store.listSamples('epoch').map((sample) => sample.requestedTime), ['1785484800000']);
  } finally {
    await rm(path, { force: true });
  }
});

test('CsvStore exposes complete column samples and source summaries', async () => {
  const path = join(tmpdir(), `diagnostic-series-${Date.now()}.csv`);
  await writeFile(path, 'timestamp,value\n1785484800000,2\n1785484801000,4\n');
  try {
    const store = new CsvStore();
    const summary = await store.importSource({ id: 'series', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });
    assert.equal(summary.sourceId, 'series');
    assert.equal(summary.id, 'series');
    assert.deepEqual(summary.columns, ['timestamp', 'value']);
    assert.deepEqual(store.listColumnSamples('series', 'value').map((point) => ({
      value: point.value,
      requestedTime: point.requestedTime,
      sourceRow: point.sourceRow
    })), [
      { value: '2', requestedTime: '1785484800000', sourceRow: 2 },
      { value: '4', requestedTime: '1785484801000', sourceRow: 3 }
    ]);
  } finally {
    await rm(path, { force: true });
  }
});

test('CsvStore reports duplicate, original-order and interval data quality', async () => {
  const path = join(tmpdir(), `diagnostic-quality-${Date.now()}.csv`);
  await writeFile(path, [
    'timestamp,value',
    '1000,1',
    '2000,2',
    '2000,3',
    '1500,4',
    '10000,5'
  ].join('\n'));
  try {
    const store = new CsvStore();
    await store.importSource({ id: 'quality', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });
    assert.deepEqual(store.dataQuality('quality'), {
      sourceId: 'quality',
      sourceName: path.split(/[\\/]/).at(-1),
      schema: {
        columns: ['timestamp', 'value'],
        timeColumn: 'timestamp',
        timeFormat: 'unix_ms'
      },
      rowCount: 5,
      timeRange: { startTime: 1000, endTime: 10000 },
      duplicateTimestampCount: 1,
      nonMonotonicCount: 1,
      medianIntervalMs: 500,
      largeGapCount: 1,
      largeGapThresholdMs: 1500
    });
  } finally {
    await rm(path, { force: true });
  }
});

test('CsvStore treats header case exactly, accepts BOM and rejects exact duplicate columns', async (t) => {
  const path = join(tmpdir(), `diagnostic-headers-${Date.now()}.csv`);
  t.after(() => rm(path, { force: true }));
  await writeFile(path, '\uFEFFtimestamp,age,Age\n1000,11,22\n');
  const store = new CsvStore();
  await store.importSource({ id: 'headers', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });
  assert.equal(store.query({ sourceId: 'headers', column: 'age', requestedTime: '1000' }).value, '11');
  assert.equal(store.query({ sourceId: 'headers', column: 'Age', requestedTime: '1000' }).value, '22');

  await writeFile(path, 'timestamp,age,age\n1000,11,22\n');
  await assert.rejects(
    store.importSource({ id: 'duplicate', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' }),
    /表头存在重复列/
  );
  assert.equal(store.describeSource('duplicate'), undefined);
});

test('CsvStore bounds replay and trend payloads while preserving endpoints and numeric peaks', async (t) => {
  const path = join(tmpdir(), `diagnostic-bounded-${Date.now()}.csv`);
  t.after(() => rm(path, { force: true }));
  const rows = ['timestamp,value'];
  for (let index = 0; index < 1_000; index += 1) {
    rows.push(`${index},${index === 500 ? 99999 : index % 7}`);
  }
  await writeFile(path, rows.join('\n'));
  const store = new CsvStore();
  await store.importSource({ id: 'bounded', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });

  const replay = store.listSamples('bounded', { maxPoints: 20 });
  assert.equal(replay.length, 20);
  assert.equal(replay[0].requestedTime, '0');
  assert.equal(replay.at(-1).requestedTime, '999');

  const trend = store.listColumnSamples('bounded', 'value', { maxPoints: 20 });
  assert.ok(trend.length <= 20);
  assert.equal(trend[0].requestedTime, '0');
  assert.equal(trend.at(-1).requestedTime, '999');
  assert.ok(trend.some((point) => point.value === '99999'), 'downsampling should retain the peak');
  assert.deepEqual(store.columnStatistics('bounded', 'value'), {
    pointCount: 1_000,
    min: 0,
    max: 99999,
    changeCount: 999
  });
});

test('CsvStore binary search preserves duplicate and equidistant nearest-sample choices', async (t) => {
  const path = join(tmpdir(), `diagnostic-binary-search-${Date.now()}.csv`);
  t.after(() => rm(path, { force: true }));
  await writeFile(path, [
    'timestamp,value',
    '2000,right-first',
    '1000,left-first',
    '2000,right-second',
    '1000,left-second',
    '3000,last-first',
    '3000,last-second'
  ].join('\n'));
  const store = new CsvStore();
  await store.importSource({ id: 'binary', filePath: path, timeColumn: 'timestamp', timeFormat: 'unix_ms' });

  const query = (requestedTime, options = {}) => store.query({
    sourceId: 'binary', column: 'value', requestedTime: String(requestedTime), toleranceMs: 10_000, ...options
  });
  assert.deepEqual(
    [query(1000), query(1500), query(1900), query(0), query(4000)].map(({ matchType, value, sourceRow }) => ({ matchType, value, sourceRow })),
    [
      { matchType: 'exact', value: 'left-first', sourceRow: 3 },
      { matchType: 'nearest', value: 'left-first', sourceRow: 3 },
      { matchType: 'nearest', value: 'right-first', sourceRow: 2 },
      { matchType: 'nearest', value: 'left-first', sourceRow: 3 },
      { matchType: 'nearest', value: 'last-first', sourceRow: 6 }
    ]
  );

  assert.deepEqual(query(1500, { toleranceMs: 100 }), {
    matchType: 'none',
    requestedTime: '1500',
    sourceId: 'binary',
    sourceName: path.split(/[\\/]/).at(-1),
    csvColumn: 'value',
    reason: 'nearest_sample_outside_tolerance'
  });
  assert.equal(query(1500, { mode: 'exact' }).reason, 'no_records');
  assert.equal(query(Infinity, { toleranceMs: Infinity }).value, 'left-first');
});
