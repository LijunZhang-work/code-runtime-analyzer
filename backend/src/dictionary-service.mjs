import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, readUtf8File } from './csv-store.mjs';
import { mappingKey } from './domain.mjs';

const HEADER = ['data_source', 'data_field', 'target_kind', 'target', 'definition_path'];
const TARGET_KINDS = new Set(['time', 'member', 'symbol']);
const TIME_FORMATS = new Set(['unix_ms', 'iso8601']);
const DEFAULT_DICTIONARY_DIRECTORY = fileURLToPath(new URL('../dictionaries/', import.meta.url));

export class DictionaryLoadError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DictionaryLoadError';
    this.details = details;
  }
}

export async function listDictionaries({ dictionaryDirectory = DEFAULT_DICTIONARY_DIRECTORY } = {}) {
  const entries = await readdir(dictionaryDirectory, { withFileTypes: true });
  const dictionaries = [];
  for (const entry of entries.filter((item) => item.isFile() && extname(item.name) === '.csv')
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const dictionaryId = entry.name.slice(0, -4);
    const parsed = await parseDictionaryFile(join(dictionaryDirectory, entry.name), dictionaryId);
    dictionaries.push(summaryOf(parsed));
  }
  return dictionaries;
}

export async function loadDictionaryFolder({ dictionaryId, folderPath, workspaceRoot }, {
  csvStore,
  mappingStore,
  dictionaryDirectory = DEFAULT_DICTIONARY_DIRECTORY
}) {
  for (const [name, value] of Object.entries({ dictionaryId, folderPath, workspaceRoot })) {
    if (typeof value !== 'string' || value.trim() === '') throw new DictionaryLoadError(`${name} 必须是非空字符串`);
  }
  const dictionaryPath = await dictionaryPathFor(dictionaryDirectory, dictionaryId);
  const dictionary = await parseDictionaryFile(dictionaryPath, dictionaryId);
  await validateDefinitionPaths(dictionary, workspaceRoot);

  const folder = resolve(folderPath);
  const folderInfo = await stat(folder).catch(() => null);
  if (!folderInfo?.isDirectory()) throw new DictionaryLoadError(`CSV 文件夹不存在：${folderPath}`);
  const physicalFolder = await realpath(folder);
  const folderEntries = await readdir(folder, { withFileTypes: true });
  const csvFiles = folderEntries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.csv')
    .map((entry) => entry.name).sort();
  const requiredFiles = [...dictionary.sources.keys()].sort();
  const matchedFiles = requiredFiles.filter((name) => csvFiles.includes(name));
  const missingFiles = requiredFiles.filter((name) => !csvFiles.includes(name));
  const unusedFiles = csvFiles.filter((name) => !requiredFiles.includes(name));
  if (missingFiles.length > 0) {
    throw new DictionaryLoadError(`字典 ${dictionaryId} 缺少必需 CSV：${missingFiles.join(', ')}`, {
      dictionaryId, matchedFiles, missingFiles, unusedFiles
    });
  }

  const runRecordId = stableRunRecordId(dictionaryId, physicalFolder);
  const preparedSources = [];
  const mappings = [];
  const sourceFingerprints = [];
  for (const dataSource of requiredFiles) {
    const sourceDefinition = dictionary.sources.get(dataSource);
    const filePath = join(folder, dataSource);
    const prepared = await prepareDataSource(filePath, sourceDefinition, dictionary);
    sourceFingerprints.push({ dataSource, contentsHash: hashText(prepared.contents), time: prepared.time });
    const csvSourceId = `${runRecordId}:${dataSource}`;
    preparedSources.push(await csvStore.prepareSource({
      id: csvSourceId,
      filePath,
      contents: prepared.contents,
      ...prepared.time
    }));
    mappings.push(...prepared.mappings.map((mapping) => ({
      ...mapping,
      dataSource,
      runRecordId,
      csvSourceId,
      mappingSource: 'dictionary',
      confidence: 'confirmed',
      dictionaryId
    })));
  }
  assertNoDuplicateMappings(mappings, dictionary);
  const dataRevision = hashText(JSON.stringify({
    version: 1,
    dictionaryId,
    dictionaryContentsHash: dictionary.contentsHash,
    sources: sourceFingerprints
  }));

  // The panel works on exactly one temporary CSV session.  Everything above
  // has been fully staged and validated, so replacing the in-memory session
  // here cannot expose a half-loaded data set.
  for (const source of preparedSources) source.id = `${runRecordId}:${dataRevision}:${source.name}`;
  for (const mapping of mappings) {
    mapping.csvSourceId = `${runRecordId}:${dataRevision}:${mapping.dataSource}`;
    mapping.dataRevision = dataRevision;
  }

  // All files, headers, patterns, paths and duplicate identities have already
  // been validated.  Mutating the stores only after this point keeps malformed
  // or incomplete folders fail-closed.
  mappingStore.clear();
  csvStore.clear();
  mappingStore.replaceRuns([{
    runRecordId,
    sourceIds: preparedSources.map((source) => source.id),
    mappings
  }]);
  csvStore.replaceSources({ sources: preparedSources });
  return {
    runRecordId,
    dataRevision,
    matchedFiles,
    missingFiles: [],
    unusedFiles,
    importedMappings: mappings.length,
    sourceCount: preparedSources.length
  };
}

async function dictionaryPathFor(dictionaryDirectory, dictionaryId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dictionaryId)) {
    throw new DictionaryLoadError(`dictionaryId 非法：${dictionaryId}`);
  }
  const entries = await readdir(dictionaryDirectory, { withFileTypes: true });
  const expectedName = `${dictionaryId}.csv`;
  const exact = entries.find((entry) => entry.isFile() && entry.name === expectedName);
  if (!exact) throw new DictionaryLoadError(`不存在字典：${dictionaryId}`);
  return join(dictionaryDirectory, exact.name);
}

async function parseDictionaryFile(filePath, dictionaryId) {
  const contents = await readUtf8File(filePath);
  const rows = parseCsv(contents);
  const fileName = basename(filePath);
  if (rows.length < 2) throw new DictionaryLoadError(`${fileName} 至少需要表头和一行内容`);
  const headers = rows[0].map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim());
  if (headers.length !== HEADER.length || headers.some((header, index) => header !== HEADER[index])) {
    throw rowError(fileName, 1, `表头必须严格为：${HEADER.join(',')}`);
  }
  const definitions = [];
  const seenRows = new Map();
  for (const [offset, values] of rows.slice(1).entries()) {
    const rowNumber = offset + 2;
    if (values.length > HEADER.length) throw rowError(fileName, rowNumber, '列数超过固定表头');
    const row = Object.fromEntries(HEADER.map((header, index) => [header, (values[index] ?? '').trim()]));
    for (const name of HEADER.slice(0, 4)) if (!row[name]) throw rowError(fileName, rowNumber, `缺少 ${name}`);
    validateDataSource(row.data_source, fileName, rowNumber);
    if (!TARGET_KINDS.has(row.target_kind)) throw rowError(fileName, rowNumber, `target_kind 不支持：${row.target_kind}`);
    const parsedTarget = validateTarget(row, fileName, rowNumber);
    if (row.target_kind !== 'time' && !row.definition_path) throw rowError(fileName, rowNumber, '缺少 definition_path');
    if (row.definition_path) validateDefinitionPathSyntax(row.definition_path, fileName, rowNumber);
    const duplicateKey = HEADER.map((name) => row[name]).join('\u0000');
    if (seenRows.has(duplicateKey)) {
      throw rowError(fileName, rowNumber, `与第 ${seenRows.get(duplicateKey)} 行重复`);
    }
    seenRows.set(duplicateKey, rowNumber);
    definitions.push({ ...row, ...parsedTarget, rowNumber });
  }
  const sources = new Map();
  for (const definition of definitions) {
    const source = sources.get(definition.data_source) ?? { timeRows: [], mappings: [] };
    if (definition.target_kind === 'time') source.timeRows.push(definition);
    else source.mappings.push(definition);
    sources.set(definition.data_source, source);
  }
  for (const [dataSource, source] of sources) {
    if (source.timeRows.length !== 1) {
      const problemRow = source.timeRows[1]?.rowNumber ?? source.mappings[0]?.rowNumber ?? 1;
      const prior = source.timeRows.length > 1 ? `；第一行 time 位于第 ${source.timeRows[0].rowNumber} 行` : '';
      throw rowError(fileName, problemRow, `${dataSource} 必须恰好有一行 time，实际 ${source.timeRows.length} 行${prior}`);
    }
  }
  return { dictionaryId, filePath, fileName, definitions, sources, contentsHash: hashText(contents) };
}

function validateDataSource(value, fileName, rowNumber) {
  if (value !== basename(value) || /[\\/]/.test(value) || extname(value).toLowerCase() !== '.csv') {
    throw rowError(fileName, rowNumber, 'data_source 必须是大小写准确的第一层 .csv 文件名');
  }
}

function validateTarget(row, fileName, rowNumber) {
  const markerCount = row.data_field.split('{index}').length - 1;
  if (row.target_kind === 'time') {
    if (!TIME_FORMATS.has(row.target)) throw rowError(fileName, rowNumber, `time target 不支持：${row.target}`);
    if (markerCount > 0) throw rowError(fileName, rowNumber, 'time 的 data_field 不能包含 {index}');
    return { timeFormat: row.target };
  }
  if (row.target_kind === 'member') {
    if (markerCount > 1) throw rowError(fileName, rowNumber, 'member 的 data_field 最多包含一个 {index}');
    return splitMemberTarget(row.target, fileName, rowNumber);
  }
  if (markerCount > 0) throw rowError(fileName, rowNumber, 'symbol 的 data_field 不能包含 {index}');
  if (!/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(row.target)) throw rowError(fileName, rowNumber, 'symbol target 必须是完整限定符号名');
  return { qualifiedName: row.target.replace(/^::/, '') };
}

function validateOwner(ownerType, fileName, rowNumber) {
  if (!/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(ownerType)) {
    throw rowError(fileName, rowNumber, 'member target 的 owner 必须是完整限定类型名');
  }
}

function splitMemberTarget(target, fileName, rowNumber) {
  const separator = target.lastIndexOf('::');
  if (separator <= 0 || !/^[A-Za-z_]\w*$/.test(target.slice(separator + 2))) {
    throw rowError(fileName, rowNumber, 'target 必须是完整 Type::field');
  }
  const ownerType = target.slice(0, separator);
  validateOwner(ownerType, fileName, rowNumber);
  return { ownerType: ownerType.replace(/^::/, ''), fieldName: target.slice(separator + 2) };
}

function validateDefinitionPathSyntax(path, fileName, rowNumber) {
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
    throw rowError(fileName, rowNumber, 'definition_path 必须是仓库根相对 POSIX 路径');
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw rowError(fileName, rowNumber, 'definition_path 不能包含空段、. 或 ..');
  }
}

async function validateDefinitionPaths(dictionary, workspaceRoot) {
  const root = resolve(workspaceRoot);
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new DictionaryLoadError(`workspaceRoot 不存在：${workspaceRoot}`);
  const physicalRoot = await realpath(root);
  const checked = new Map();
  for (const definition of dictionary.definitions) {
    if (!definition.definition_path) continue;
    if (checked.has(definition.definition_path)) {
      definition.resolvedDefinitionPath = checked.get(definition.definition_path);
      continue;
    }
    let current = root;
    for (const segment of definition.definition_path.split('/')) {
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      if (!entries.some((entry) => entry.name === segment)) {
        const caseConflict = entries.find((entry) => entry.name.toLowerCase() === segment.toLowerCase());
        const reason = caseConflict
          ? `路径大小写不准确：${segment}，实际为 ${caseConflict.name}`
          : `路径不存在：${definition.definition_path}`;
        throw rowError(dictionary.fileName, definition.rowNumber, reason);
      }
      current = join(current, segment);
    }
    const info = await stat(current);
    if (!info.isFile()) throw rowError(dictionary.fileName, definition.rowNumber, 'definition_path 必须指向文件');
    const physicalTarget = await realpath(current);
    const outside = relative(physicalRoot, physicalTarget);
    if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
      throw rowError(dictionary.fileName, definition.rowNumber, 'definition_path 解析后越出 workspaceRoot');
    }
    const resolvedDefinitionPath = outside.split(sep).join('/');
    checked.set(definition.definition_path, resolvedDefinitionPath);
    definition.resolvedDefinitionPath = resolvedDefinitionPath;
  }
}

async function prepareDataSource(filePath, sourceDefinition, dictionary) {
  const contents = await readUtf8File(filePath);
  const rows = parseCsv(contents);
  if (rows.length < 2) throw new DictionaryLoadError(`${basename(filePath)} 至少需要表头和一行数据`);
  const columns = rows[0].map((column, index) => index === 0 ? column.replace(/^\uFEFF/, '') : column);
  if (new Set(columns).size !== columns.length) throw new DictionaryLoadError(`${basename(filePath)} 表头存在重复列`);
  const timeRow = sourceDefinition.timeRows[0];
  if (!columns.includes(timeRow.data_field)) throw rowError(dictionary.fileName, timeRow.rowNumber, `${basename(filePath)} 缺少时间列 ${timeRow.data_field}`);
  const timeIndex = columns.indexOf(timeRow.data_field);
  for (const [offset, values] of rows.slice(1).entries()) {
    const raw = values[timeIndex] ?? '';
    const timestamp = timeRow.timeFormat === 'unix_ms' ? Number(raw) : Date.parse(raw);
    if (String(raw).trim() === '' || Number.isNaN(timestamp)) {
      throw rowError(dictionary.fileName, timeRow.rowNumber,
        `${basename(filePath)} 第 ${offset + 2} 行时间无法按 ${timeRow.timeFormat} 解析：${raw}`);
    }
  }
  const mappings = [];
  for (const definition of sourceDefinition.mappings) {
    const isPattern = definition.target_kind === 'member' && definition.data_field.includes('{index}');
    const matchedColumns = isPattern
      ? expandPattern(definition.data_field, columns, dictionary.fileName, definition.rowNumber)
      : [definition.data_field];
    for (const column of matchedColumns) {
      if (!columns.includes(column)) throw rowError(dictionary.fileName, definition.rowNumber, `${basename(filePath)} 缺少数据列 ${column}`);
      const index = isPattern
        ? Number(column.match(patternRegex(definition.data_field))[1])
        : undefined;
      const codeField = definition.target_kind === 'symbol'
        ? { targetKind: 'symbol', qualifiedName: definition.qualifiedName, definitionPath: definition.resolvedDefinitionPath }
        : {
            targetKind: 'member',
            typeName: definition.ownerType,
            fieldName: definition.fieldName,
            definitionPath: definition.resolvedDefinitionPath,
            ...(index === undefined ? {} : { index })
          };
      mappings.push({
        csvColumn: column,
        codeField,
        targetKind: definition.target_kind,
        definitionPath: definition.resolvedDefinitionPath,
        dictionaryFile: dictionary.fileName,
        dictionaryRow: definition.rowNumber,
        ...(index === undefined ? {} : { indexRule: 'data_field_pattern' })
      });
    }
  }
  return { time: { timeColumn: timeRow.data_field, timeFormat: timeRow.timeFormat }, mappings, contents };
}

function expandPattern(pattern, columns, fileName, rowNumber) {
  const regex = patternRegex(pattern);
  const matches = columns.filter((column) => regex.test(column))
    .sort((left, right) => Number(left.match(regex)[1]) - Number(right.match(regex)[1]));
  if (matches.length === 0) throw rowError(fileName, rowNumber, `模式未匹配任何数据列：${pattern}`);
  return matches;
}

function patternRegex(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace('\\{index\\}', '(\\d+)')}$`);
}

function assertNoDuplicateMappings(mappings, dictionary) {
  const seen = new Map();
  for (const mapping of mappings) {
    const key = mappingKey(mapping);
    const previous = seen.get(key);
    if (previous) {
      throw rowError(dictionary.fileName, mapping.dictionaryRow,
        `映射目标重复（此前位于第 ${previous.dictionaryRow} 行）`);
    }
    seen.set(key, mapping);
  }
}

function stableRunRecordId(dictionaryId, folderPath) {
  const folderIdentity = process.platform === 'win32' ? resolve(folderPath).toLowerCase() : resolve(folderPath);
  const digest = createHash('sha256').update(`${dictionaryId}\u0000${folderIdentity}`).digest('hex').slice(0, 16);
  return `dictionary:${dictionaryId}:${digest}`;
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function summaryOf(dictionary) {
  const targetKinds = [...new Set(dictionary.definitions.map((row) => row.target_kind))].sort();
  return {
    dictionaryId: dictionary.dictionaryId,
    fileName: dictionary.fileName,
    sourceCount: dictionary.sources.size,
    mappingDefinitionCount: dictionary.definitions.filter((row) => row.target_kind !== 'time').length,
    targetKinds,
    dataSources: [...dictionary.sources.keys()].sort()
  };
}

function rowError(fileName, rowNumber, message) {
  return new DictionaryLoadError(`${fileName} 第 ${rowNumber} 行：${message}`, { fileName, rowNumber });
}
