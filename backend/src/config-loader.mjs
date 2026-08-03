import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { mappingKey } from './domain.mjs';
import { compileIndexPattern, parseMappingFile } from './mapping-file.mjs';
import { CsvStore, readUtf8File } from './csv-store.mjs';

export async function importConfig(configPath, { csvStore, mappingStore }) {
  const config = JSON.parse((await readUtf8File(configPath)).replace(/^\uFEFF/, ''));
  const configDirectory = dirname(configPath);
  const csvSources = config.csvSources ?? [];
  const sourceIds = new Set();
  const preparedSources = [];
  for (const source of csvSources) {
    if (typeof source.id !== 'string' || source.id === '') throw new Error('CSV 来源 id 必须是非空字符串');
    if (sourceIds.has(source.id)) throw new Error(`CSV 来源 id 重复：${source.id}`);
    sourceIds.add(source.id);
    preparedSources.push(await csvStore.prepareSource({
      ...source,
      filePath: resolve(configDirectory, source.filePath)
    }));
  }
  const stagedCsvStore = new CsvStore();
  stagedCsvStore.replaceSources({ sources: preparedSources });
  const validationCsvStore = {
    describeSource: (sourceId) => stagedCsvStore.describeSource(sourceId) ?? csvStore.describeSource(sourceId)
  };

  const mappings = [...(config.mappings ?? [])];
  for (const mapping of mappings) validateMappingColumn(mapping, validationCsvStore, basename(configPath));

  for (const rule of config.rules ?? []) {
    const source = validationCsvStore.describeSource(rule.csvSourceId);
    if (!source) throw new Error(`映射规则引用未知 CSV 来源：${rule.csvSourceId}`);
    const pattern = compileIndexPattern(rule.csvColumnPattern);
    for (const column of source.columns) {
      const match = column.match(pattern);
      if (!match) continue;
      mappings.push({
        runRecordId: rule.runRecordId,
        csvSourceId: rule.csvSourceId,
        csvColumn: column,
        codeField: { ...rule.codeField, index: Number(match[1]) },
        indexRule: rule.indexSource,
        mappingSource: rule.mappingSource,
        confidence: rule.confidence
      });
    }
  }

  let mappingFileMappings = 0;
  if (config.mappingFile !== undefined) {
    if (typeof config.mappingFile !== 'string' || config.mappingFile.trim() === '') {
      throw new Error('mappingFile 必须是非空的相对路径字符串');
    }
    if (isAbsolute(config.mappingFile)) throw new Error('mappingFile 必须是相对于 run config 的路径');
    const mappingPath = resolve(configDirectory, config.mappingFile);
    const parsed = parseMappingFile(await readUtf8File(mappingPath), {
      csvStore: validationCsvStore,
      fileName: basename(mappingPath)
    });
    mappings.push(...parsed);
    mappingFileMappings = parsed.length;
  }

  assertNoDuplicateMappings(mappings);
  const byRun = new Map();
  for (const mapping of mappings) {
    const runMappings = byRun.get(mapping.runRecordId) ?? [];
    runMappings.push(mapping);
    byRun.set(mapping.runRecordId, runMappings);
  }
  mappingStore.replaceRuns([...byRun].map(([runRecordId, runMappings]) => ({
    runRecordId,
    sourceIds: [...new Set(runMappings.map((mapping) => mapping.csvSourceId))],
    mappings: runMappings
  })));
  csvStore.replaceSources({ removeSourceIds: [...sourceIds], sources: preparedSources });
  return {
    importedSources: csvSources.length,
    importedMappings: mappings.length,
    importedMappingFileMappings: mappingFileMappings
  };
}

function validateMappingColumn(mapping, csvStore, sourceName) {
  const source = csvStore.describeSource(mapping.csvSourceId);
  if (!source) throw new Error(`${sourceName} 的字段映射引用未知 CSV 来源：${mapping.csvSourceId}`);
  if (!source.columns.includes(mapping.csvColumn)) {
    throw new Error(`${sourceName} 的字段映射引用的数据列不存在：${source.sourceName}.${mapping.csvColumn}`);
  }
}

function assertNoDuplicateMappings(mappings) {
  const seen = new Map();
  for (const mapping of mappings) {
    const key = mappingKey(mapping);
    const previous = seen.get(key);
    if (previous) {
      const currentLocation = mapping.mappingFile ? `${mapping.mappingFile} 第 ${mapping.mappingFileRow} 行` : 'JSON 配置';
      const previousLocation = previous.mappingFile ? `${previous.mappingFile} 第 ${previous.mappingFileRow} 行` : 'JSON 配置';
      throw new Error(`重复字段映射：${key}（${previousLocation} 与 ${currentLocation}）`);
    }
    seen.set(key, mapping);
  }
}
