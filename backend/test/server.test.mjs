import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CsvStore } from '../src/csv-store.mjs';
import { MappingStore } from '../src/mapping-store.mjs';
import { createDiagnosticServer } from '../src/server.mjs';

test('POST /api/evidence/snapshot returns a batch of field snapshots', async (t) => {
  const csvStore = new CsvStore();
  const source = await csvStore.prepareSource({
    id: 'metrics',
    filePath: 'metrics.csv',
    timeColumn: 'timestamp',
    timeFormat: 'unix_ms',
    contents: 'timestamp,score,moved\n1000,7,0\n2000,9,1\n'
  });
  csvStore.replaceSources({ sources: [source] });
  const mappingStore = new MappingStore();
  for (const fieldName of ['score', 'moved']) {
    mappingStore.add({
      runRecordId: 'run-server',
      csvSourceId: 'metrics',
      csvColumn: fieldName,
      codeField: { typeName: 'Game', fieldName }
    });
  }
  const server = createDiagnosticServer({ csvStore, mappingStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/api/evidence/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runRecordId: 'run-server',
      requestedTime: '2000',
      codeFields: [
        { typeName: 'Game', fieldName: 'score' },
        { typeName: 'Game', fieldName: 'moved' }
      ]
    })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.results.map((item) => item.instances[0].evidence.value), ['9', '1']);
});
