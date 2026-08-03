import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CsvStore } from '../src/csv-store.mjs';
import { MappingStore } from '../src/mapping-store.mjs';
import { EvidenceService } from '../src/evidence-service.mjs';
import { DictionaryLoadError, listDictionaries, loadDictionaryFolder } from '../src/dictionary-service.mjs';
import { createDiagnosticServer } from '../src/server.mjs';

const workspace = resolve(import.meta.dirname, '../..');
const fixedHeader = 'data_source,data_field,target_kind,target,definition_path';

test('bundled 2048 dictionary loads two CSV files with real definition paths', async () => {
  const dictionaries = await listDictionaries();
  const dictionary = dictionaries.find((item) => item.dictionaryId === '2048-demo');
  assert.deepEqual(dictionary, {
    dictionaryId: '2048-demo',
    fileName: '2048-demo.csv',
    sourceCount: 2,
    mappingDefinitionCount: 5,
    targetKinds: ['member', 'time'],
    dataSources: ['2048_demo_run.csv', '2048_metrics.csv']
  });

  const csvStore = new CsvStore();
  const mappingStore = new MappingStore();
  const result = await loadDictionaryFolder({
    dictionaryId: '2048-demo',
    folderPath: join(workspace, 'runs'),
    workspaceRoot: workspace
  }, { csvStore, mappingStore });
  assert.equal(result.sourceCount, 2);
  assert.equal(result.importedMappings, 35);
  assert.deepEqual(result.matchedFiles, ['2048_demo_run.csv', '2048_metrics.csv']);
  assert.deepEqual(result.missingFiles, []);
  assert.deepEqual(result.unusedFiles, []);

  const fields = mappingStore.listFieldDescriptors(result.runRecordId);
  assert.equal(fields.length, 5);
  const tile = fields.find((item) => item.codeField.typeName === 'Game::tile_t' && item.codeField.fieldName === 'value');
  assert.equal(tile.instanceCount, 16);
  assert.equal(tile.codeField.definitionPath, 'labs/2048_csv_replay/include/tile.hpp');
  const score = fields.find((item) => item.codeField.typeName === 'Game::GameBoard' && item.codeField.fieldName === 'score');
  assert.equal(score.codeField.definitionPath, 'labs/2048_csv_replay/include/gameboard.hpp');

  const evidence = new EvidenceService(csvStore, mappingStore).queryInstances({
    runRecordId: result.runRecordId,
    codeField: { targetKind: 'member', typeName: 'Game::GameBoard', fieldName: 'score' },
    requestedTime: '1785484800000'
  });
  assert.equal(evidence.status, 'ok');
  assert.equal(evidence.instances.length, 1);
  assert.equal(evidence.instances[0].index, null);
  assert.equal(evidence.instances[0].evidence.value, '0');
});

test('folder loader supports BOM, member patterns, aliases by target, symbols and unused files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dictionary-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dictionaryDirectory = join(root, 'dictionaries');
  const folder = join(root, 'data');
  await mkdir(dictionaryDirectory);
  await mkdir(folder);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'model.hpp'), 'struct model {};\n');
  await writeFile(join(dictionaryDirectory, 'multi.csv'), '\uFEFF' + [
    fixedHeader,
    'Alpha.csv,timestamp,time,unix_ms,',
    'Alpha.csv,ITEM_{index},member,Demo::Item::value,src/model.hpp',
    'Alpha.csv,renamed_column,member,Demo::Item::renamed,src/model.hpp',
    'Alpha.csv,global_value,symbol,Demo::global_value,src/model.hpp',
    'Beta.csv,when,time,iso8601,',
    'Beta.csv,flag,member,Demo::State::flag,src/model.hpp'
  ].join('\n'));
  await writeFile(join(folder, 'Alpha.csv'), '\uFEFFtimestamp,ITEM_0,ITEM_1,renamed_column,global_value\n1000,2,4,8,10\n');
  await writeFile(join(folder, 'Beta.csv'), 'when,flag\n2026-01-01T00:00:00Z,1\n');
  await writeFile(join(folder, 'extra.csv'), 'timestamp,x\n1000,1\n');
  await mkdir(join(folder, 'nested'));
  await writeFile(join(folder, 'nested', 'ignored.csv'), 'timestamp,x\n1000,1\n');

  const csvStore = new CsvStore();
  const mappingStore = new MappingStore();
  const result = await loadDictionaryFolder({ dictionaryId: 'multi', folderPath: folder, workspaceRoot: root }, {
    csvStore, mappingStore, dictionaryDirectory
  });
  assert.deepEqual(result.matchedFiles, ['Alpha.csv', 'Beta.csv']);
  assert.deepEqual(result.unusedFiles, ['extra.csv']);
  assert.equal(result.sourceCount, 2);
  assert.equal(result.importedMappings, 5);
  const reloadedIntoSameStores = await loadDictionaryFolder({ dictionaryId: 'multi', folderPath: folder, workspaceRoot: root }, {
    csvStore, mappingStore, dictionaryDirectory
  });
  assert.equal(reloadedIntoSameStores.dataRevision, result.dataRevision);
  assert.equal(mappingStore.listRuns().length, 1);
  assert.equal(csvStore.describeSources(mappingStore.listRuns()[0].sourceIds).length, 2);
  const sameRun = await loadDictionaryFolder({ dictionaryId: 'multi', folderPath: folder, workspaceRoot: root }, {
    csvStore: new CsvStore(), mappingStore: new MappingStore(), dictionaryDirectory
  });
  assert.equal(sameRun.runRecordId, result.runRecordId);

  const memberInstances = mappingStore.findInstances(result.runRecordId, {
    typeName: 'Demo::Item', fieldName: 'value'
  });
  assert.deepEqual(memberInstances.map((mapping) => mapping.csvColumn), ['ITEM_0', 'ITEM_1']);
  assert.equal(mappingStore.find(result.runRecordId, {
    typeName: 'Demo::Item', fieldName: 'renamed'
  }).csvColumn, 'renamed_column');
  assert.equal(mappingStore.find(result.runRecordId, {
    targetKind: 'symbol', qualifiedName: 'Demo::global_value'
  }).csvColumn, 'global_value');
});

test('folder loader is case-sensitive and fail-closed when a required file is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dictionary-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dictionaryDirectory = join(root, 'dictionaries');
  const folder = join(root, 'data');
  await mkdir(dictionaryDirectory);
  await mkdir(folder);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'model.hpp'), 'struct Item {};\n');
  await writeFile(join(dictionaryDirectory, 'strict.csv'), [
    fixedHeader,
    'Alpha.csv,timestamp,time,unix_ms,',
    'Alpha.csv,value,member,Item::value,src/model.hpp'
  ].join('\n'));
  await writeFile(join(folder, 'alpha.csv'), 'timestamp,value\n1000,1\n');
  await writeFile(join(folder, 'unused.csv'), 'timestamp,value\n1000,1\n');
  const mappingStore = new MappingStore();
  await assert.rejects(
    loadDictionaryFolder({ dictionaryId: 'strict', folderPath: folder, workspaceRoot: root }, {
      csvStore: new CsvStore(), mappingStore, dictionaryDirectory
    }),
    (error) => {
      assert.ok(error instanceof DictionaryLoadError);
      assert.deepEqual(error.details.matchedFiles, []);
      assert.deepEqual(error.details.missingFiles, ['Alpha.csv']);
      assert.deepEqual(error.details.unusedFiles, ['alpha.csv', 'unused.csv']);
      return true;
    }
  );
  assert.deepEqual(mappingStore.listRuns(), []);
});

test('dictionary validation reports fixed-header, row, time and exact path errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dictionary-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dictionaryDirectory = join(root, 'dictionaries');
  const folder = join(root, 'data');
  await mkdir(dictionaryDirectory);
  await mkdir(folder);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'model.hpp'), 'struct Item {};\n');
  await writeFile(join(folder, 'data.csv'), 'timestamp,value\n1000,1\n');

  const cases = [
    ['bad-header', 'data_source,data_field,target_kind,target\ndata.csv,timestamp,time,unix_ms', /表头必须严格/],
    ['bad-kind', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,value,member_alias,Item::value,src/model.hpp`, /target_kind 不支持.*第 3 行|第 3 行.*target_kind 不支持/],
    ['bad-pattern', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,X_{index}_{index},member,Item::value,src/model.hpp`, /第 3 行.*最多包含一个/],
    ['bad-member-owner', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,value,member,Item*::value,src/model.hpp`, /第 3 行.*完整限定类型名/],
    ['bad-symbol', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,value,symbol,Demo.value,src/model.hpp`, /第 3 行.*完整限定符号名/],
    ['bad-relative', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,value,member,Item::value,../src/model.hpp`, /第 3 行.*不能包含.*\.\./],
    ['duplicate-time', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,timestamp2,time,unix_ms,`, /必须恰好有一行 time/],
    ['duplicate-row', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,value,member,Item::value,src/model.hpp\ndata.csv,value,member,Item::value,src/model.hpp`, /第 4 行.*第 3 行重复/],
    ['bad-case-path', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,value,member,Item::value,src/Model.hpp`, /第 3 行.*路径大小写不准确/],
    ['bad-case-column', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,VALUE,member,Item::value,src/model.hpp`, /第 3 行.*缺少数据列 VALUE/],
    ['missing-column', `${fixedHeader}\ndata.csv,timestamp,time,unix_ms,\ndata.csv,absent,member,Item::value,src/model.hpp`, /第 3 行.*缺少数据列 absent/]
  ];
  for (const [id, text, pattern] of cases) {
    await writeFile(join(dictionaryDirectory, `${id}.csv`), text);
    await assert.rejects(
      loadDictionaryFolder({ dictionaryId: id, folderPath: folder, workspaceRoot: root }, {
        csvStore: new CsvStore(), mappingStore: new MappingStore(), dictionaryDirectory
      }),
      pattern
    );
  }
});

test('dictionary HTTP endpoints list and load without using the default port', async (t) => {
  const server = createDiagnosticServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const healthResponse = await fetch(`${base}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok', version: '0.9.1', apiVersion: '0.9' });
  const listResponse = await fetch(`${base}/api/dictionaries/list`, { method: 'POST' });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.ok(listed.dictionaries.some((dictionary) => dictionary.dictionaryId === '2048-demo'));

  const loadResponse = await fetch(`${base}/api/dictionaries/load-folder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dictionaryId: '2048-demo', folderPath: join(workspace, 'runs'), workspaceRoot: workspace })
  });
  assert.equal(loadResponse.status, 201);
  const loaded = await loadResponse.json();
  assert.equal(loaded.sourceCount, 2);
  assert.equal(loaded.importedMappings, 35);
  assert.match(loaded.dataRevision, /^[a-f0-9]{64}$/);

  const currentReplay = await fetch(`${base}/api/replay/times`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runRecordId: loaded.runRecordId, dataRevision: loaded.dataRevision })
  });
  assert.equal(currentReplay.status, 200);
  const staleReplay = await fetch(`${base}/api/replay/times`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runRecordId: loaded.runRecordId, dataRevision: 'old-data-revision' })
  });
  assert.equal(staleReplay.status, 400);
});

test('definition path disambiguates identical targets while an omitted path never guesses; time-only sources remain visible', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dictionary-definitions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dictionaryDirectory = join(root, 'dictionaries');
  const folder = join(root, 'data');
  await mkdir(dictionaryDirectory);
  await mkdir(folder);
  await mkdir(join(root, 'first'));
  await mkdir(join(root, 'second'));
  await writeFile(join(root, 'first', 'student.hpp'), 'namespace demo { struct Student { int age; }; }\n');
  await writeFile(join(root, 'second', 'student.hpp'), 'namespace demo { struct Student { int age; }; }\n');
  await writeFile(join(dictionaryDirectory, 'definitions.csv'), [
    fixedHeader,
    'students.csv,timestamp,time,unix_ms,',
    'students.csv,first_age,member,::demo::Student::age,first/student.hpp',
    'students.csv,second_age,member,demo::Student::age,second/student.hpp',
    'clock.csv,when,time,iso8601,'
  ].join('\n'));
  await writeFile(join(folder, 'students.csv'), 'timestamp,first_age,second_age\n1000,11,22\n');
  await writeFile(join(folder, 'clock.csv'), 'when\n2026-01-01T00:00:00Z\n');

  const csvStore = new CsvStore();
  const mappingStore = new MappingStore();
  const loaded = await loadDictionaryFolder({
    dictionaryId: 'definitions', folderPath: folder, workspaceRoot: root
  }, { csvStore, mappingStore, dictionaryDirectory });
  assert.equal(loaded.sourceCount, 2);
  assert.equal(loaded.importedMappings, 2);
  assert.equal(mappingStore.listRuns()[0].sourceIds.length, 2);
  assert.equal(mappingStore.find(loaded.runRecordId, {
    targetKind: 'member', typeName: 'demo::Student', fieldName: 'age',
    definitionPath: 'first/student.hpp'
  }).csvColumn, 'first_age');
  assert.equal(mappingStore.find(loaded.runRecordId, {
    targetKind: 'member', typeName: 'demo::Student', fieldName: 'age'
  }), undefined);
});

test('dictionary and data files reject malformed UTF-8 without mutating stores', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dictionary-utf8-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dictionaryDirectory = join(root, 'dictionaries');
  const folder = join(root, 'data');
  await mkdir(dictionaryDirectory);
  await mkdir(folder);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'model.hpp'), 'struct Item {};\n');
  const validDictionary = [
    fixedHeader,
    'data.csv,timestamp,time,unix_ms,',
    'data.csv,value,member,Item::value,src/model.hpp'
  ].join('\n');
  await writeFile(join(dictionaryDirectory, 'bad-dictionary.csv'), Buffer.concat([
    Buffer.from(validDictionary), Buffer.from([0xc3, 0x28])
  ]));
  await writeFile(join(folder, 'data.csv'), 'timestamp,value\n1000,1\n');
  await assert.rejects(loadDictionaryFolder({
    dictionaryId: 'bad-dictionary', folderPath: folder, workspaceRoot: root
  }, { csvStore: new CsvStore(), mappingStore: new MappingStore(), dictionaryDirectory }), /不是有效的 UTF-8/);

  await writeFile(join(dictionaryDirectory, 'bad-data.csv'), validDictionary);
  await writeFile(join(folder, 'data.csv'), Buffer.from([0x74, 0x69, 0x6d, 0x65, 0xc3, 0x28]));
  const csvStore = new CsvStore();
  const mappingStore = new MappingStore();
  await assert.rejects(loadDictionaryFolder({
    dictionaryId: 'bad-data', folderPath: folder, workspaceRoot: root
  }, { csvStore, mappingStore, dictionaryDirectory }), /不是有效的 UTF-8/);
  assert.deepEqual(mappingStore.listRuns(), []);
  assert.equal(csvStore.describeSource('data.csv'), undefined);
});
