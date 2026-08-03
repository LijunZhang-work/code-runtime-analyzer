import { parseCsv } from './csv-store.mjs';

const SUPPORTED_TARGET_KINDS = new Set(['struct_field', 'global']);

export function parseMappingFile(text, { csvStore, fileName = 'mappingFile' }) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`${fileName} 至少需要表头和一行映射`);
  const headers = rows[0].map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '').trim() : header.trim());
  if (new Set(headers).size !== headers.length) throw new Error(`${fileName} 的表头存在重复列`);

  const mappings = [];
  for (const [offset, values] of rows.slice(1).entries()) {
    const rowNumber = offset + 2;
    const row = Object.fromEntries(headers.map((header, index) => [header, (values[index] ?? '').trim()]));
    const targetKind = required(row, 'target_kind', fileName, rowNumber);
    if (!SUPPORTED_TARGET_KINDS.has(targetKind)) {
      throw new Error(`${fileName} 第 ${rowNumber} 行的 target_kind 不支持：${targetKind}`);
    }
    const context = { fileName, rowNumber, csvStore };
    mappings.push(...(targetKind === 'struct_field'
      ? parseStructField(row, context)
      : parseGlobal(row, context)));
  }
  return mappings;
}

function parseStructField(row, context) {
  const common = commonValues(row, context);
  const codeField = {
    module: common.module,
    typeName: required(row, 'type_name', context.fileName, context.rowNumber),
    variablePath: required(row, 'variable_path', context.fileName, context.rowNumber),
    fieldName: required(row, 'field_name', context.fileName, context.rowNumber)
  };
  if (row.value_type) codeField.valueType = row.value_type;

  const hasColumn = Boolean(row.csv_column);
  const hasPattern = Boolean(row.csv_column_pattern);
  if (hasColumn === hasPattern) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行必须且只能填写 csv_column 或 csv_column_pattern`);
  }
  if (hasColumn) {
    rejectRange(row, context);
    ensureColumn(common.source, row.csv_column, context);
    return [mappingOf(common, row.csv_column, codeField, row, context)];
  }

  const columns = expandPattern(row.csv_column_pattern, row, common.source, context);
  return columns.map(({ column, index }) => mappingOf(
    common,
    column,
    { ...codeField, index },
    row,
    context,
    row.index_rule || 'csv-column-pattern'
  ));
}

function parseGlobal(row, context) {
  const common = commonValues(row, context);
  const qualifiedName = row.qualified_name || row.code_symbol;
  if (!qualifiedName) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行缺少 qualified_name 或 code_symbol`);
  }
  if (row.qualified_name && row.code_symbol && row.qualified_name !== row.code_symbol) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行的 qualified_name 与 code_symbol 不一致`);
  }
  if (!row.csv_column || row.csv_column_pattern) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行的 global 映射必须填写 csv_column，且不能填写 csv_column_pattern`);
  }
  rejectRange(row, context);
  ensureColumn(common.source, row.csv_column, context);
  const codeField = { targetKind: 'global', module: common.module, qualifiedName };
  if (row.code_symbol) codeField.codeSymbol = row.code_symbol;
  if (row.value_type) codeField.valueType = row.value_type;
  return [mappingOf(common, row.csv_column, codeField, row, context)];
}

function commonValues(row, context) {
  const runRecordId = required(row, 'run_record_id', context.fileName, context.rowNumber);
  const csvSourceId = required(row, 'csv_source_id', context.fileName, context.rowNumber);
  const module = required(row, 'module', context.fileName, context.rowNumber);
  const source = context.csvStore.describeSource(csvSourceId);
  if (!source) throw new Error(`${context.fileName} 第 ${context.rowNumber} 行引用未知 CSV 来源：${csvSourceId}`);
  return { runRecordId, csvSourceId, module, source };
}

function mappingOf(common, csvColumn, codeField, row, context, indexRule = undefined) {
  return {
    runRecordId: common.runRecordId,
    csvSourceId: common.csvSourceId,
    csvColumn,
    codeField,
    targetKind: row.target_kind,
    mappingSource: row.mapping_source || 'manual',
    confidence: row.confidence || 'confirmed',
    description: row.description || undefined,
    indexRule: indexRule ?? null,
    mappingFile: context.fileName,
    mappingFileRow: context.rowNumber
  };
}

function expandPattern(pattern, row, source, context) {
  const markerCount = pattern.split('{index}').length - 1;
  if (markerCount !== 1) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行的 csv_column_pattern 必须恰好包含一个 {index}`);
  }
  const hasFrom = Boolean(row.index_from);
  const hasTo = Boolean(row.index_to);
  if (hasFrom !== hasTo) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行的 index_from 与 index_to 必须同时填写`);
  }
  if (hasFrom) {
    const from = parseIndex(row.index_from, 'index_from', context);
    const to = parseIndex(row.index_to, 'index_to', context);
    if (from > to) throw new Error(`${context.fileName} 第 ${context.rowNumber} 行的 index_from 不能大于 index_to`);
    return Array.from({ length: to - from + 1 }, (_, offset) => {
      const index = from + offset;
      const column = pattern.replace('{index}', String(index));
      ensureColumn(source, column, context);
      return { column, index };
    });
  }

  const regex = compileIndexPattern(pattern);
  const matches = source.columns.flatMap((column) => {
    const match = column.match(regex);
    return match ? [{ column, index: Number(match[1]) }] : [];
  }).sort((left, right) => left.index - right.index);
  if (matches.length === 0) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行的模式未匹配到数据列：${pattern}`);
  }
  return matches;
}

export function compileIndexPattern(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace('\\{index\\}', '(\\d+)')}$`);
}

function ensureColumn(source, column, context) {
  if (!source.columns.includes(column)) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行引用的数据列不存在：${source.sourceName}.${column}`);
  }
}

function rejectRange(row, context) {
  if (row.index_from || row.index_to) {
    throw new Error(`${context.fileName} 第 ${context.rowNumber} 行只有 csv_column_pattern 可以使用 index_from/index_to`);
  }
}

function parseIndex(raw, name, context) {
  if (!/^\d+$/.test(raw)) throw new Error(`${context.fileName} 第 ${context.rowNumber} 行的 ${name} 必须是非负整数`);
  return Number(raw);
}

function required(row, name, fileName, rowNumber) {
  if (!row[name]) throw new Error(`${fileName} 第 ${rowNumber} 行缺少 ${name}`);
  return row[name];
}
