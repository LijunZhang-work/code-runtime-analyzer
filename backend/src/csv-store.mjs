import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { MatchType } from './domain.mjs';

export async function readUtf8File(filePath) {
  const bytes = await readFile(filePath);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${filePath} 不是有效的 UTF-8 文件`);
  }
}

// Handles RFC-4180-style quoted cells. CSV dialect settings will become part
// of the import profile when real project data is connected.
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function parseTimestamp(raw, sourceName, rowNumber, timeFormat) {
  const timestamp = timeFormat === 'unix_ms' ? Number(raw) : Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    throw new Error(`${sourceName} 第 ${rowNumber} 行的时间无法解析：${raw}`);
  }
  return timestamp;
}

export class CsvStore {
  #sources = new Map();

  clear() {
    this.#sources.clear();
  }

  async prepareSource({ id, filePath, timeColumn, timeFormat = 'iso8601', delimiter = ',', contents }) {
    if (typeof id !== 'string' || id === '') throw new Error('CSV 来源 id 必须是非空字符串');
    const rows = parseCsv(contents ?? await readUtf8File(filePath), delimiter);
    if (rows.length < 2) throw new Error(`${filePath} 至少需要表头和一行数据`);
    const columns = rows[0].map((column, index) => index === 0 ? column.replace(/^\uFEFF/, '') : column);
    if (columns.some((column) => column === '')) throw new Error(`${filePath} 的表头不能包含空列名`);
    if (new Set(columns).size !== columns.length) throw new Error(`${filePath} 的表头存在重复列`);
    const timeIndex = columns.indexOf(timeColumn);
    if (timeIndex < 0) throw new Error(`${filePath} 中不存在时间列 ${timeColumn}`);
    const originalRecords = rows.slice(1).map((values, offset) => {
      const rowNumber = offset + 2;
      if (values.length > columns.length) throw new Error(`${filePath} 第 ${rowNumber} 行的数据列数超过表头`);
      const valueByColumn = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? '']));
      return { timestamp: parseTimestamp(valueByColumn[timeColumn], basename(filePath), rowNumber, timeFormat), rowNumber, valueByColumn };
    });
    const records = [...originalRecords].sort((left, right) => left.timestamp - right.timestamp || left.rowNumber - right.rowNumber);
    return { id, filePath, name: basename(filePath), timeColumn, timeFormat, columns, records, originalRecords };
  }

  replaceSources({ removeSourceIds = [], sources = [] }) {
    const next = new Map(this.#sources);
    for (const sourceId of removeSourceIds) next.delete(sourceId);
    for (const source of sources) next.set(source.id, source);
    this.#sources = next;
  }

  async importSource(options) {
    const source = await this.prepareSource(options);
    this.replaceSources({ sources: [source] });
    return this.describeSource(source.id);
  }

  getSource(id) {
    return this.#sources.get(id);
  }

  removeSource(id) {
    this.#sources.delete(id);
  }

  describeSource(id) {
    const source = this.#sources.get(id);
    if (!source) return undefined;
    return {
      id: source.id,
      name: source.name,
      sourceId: source.id,
      sourceName: source.name,
      timeColumn: source.timeColumn,
      timeFormat: source.timeFormat,
      columns: [...source.columns],
      rowCount: source.records.length,
      startTime: source.records[0]?.timestamp ?? null,
      endTime: source.records.at(-1)?.timestamp ?? null
    };
  }

  describeSources(sourceIds) {
    return sourceIds.map((sourceId) => this.describeSource(sourceId)).filter(Boolean);
  }

  listColumnSamples(sourceId, column, { maxPoints = Number.POSITIVE_INFINITY } = {}) {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error(`未知 CSV 来源：${sourceId}`);
    if (!source.columns.includes(column)) throw new Error(`${source.name} 中不存在列 ${column}`);
    const records = downsampleRecords(source.records, maxPoints, (record) => record.valueByColumn[column]);
    return records.map((record) => {
      const value = record.valueByColumn[column];
      return {
        matchType: MatchType.EXACT,
        value,
        rawValue: value,
        requestedTime: source.timeFormat === 'unix_ms'
          ? String(record.timestamp)
          : new Date(record.timestamp).toISOString(),
        sampledTime: new Date(record.timestamp).toISOString(),
        offsetMs: 0,
        sourceId,
        sourceName: source.name,
        csvColumn: column,
        sourceRow: record.rowNumber
      };
    });
  }

  columnStatistics(sourceId, column) {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error(`未知 CSV 来源：${sourceId}`);
    if (!source.columns.includes(column)) throw new Error(`${source.name} 中不存在列 ${column}`);
    let min = null;
    let max = null;
    let numericCount = 0;
    let changeCount = 0;
    let previous;
    for (const record of source.records) {
      const rawValue = record.valueByColumn[column];
      const numeric = String(rawValue).trim() === '' ? Number.NaN : Number(rawValue);
      if (Number.isFinite(numeric)) {
        min = numericCount === 0 ? numeric : Math.min(min, numeric);
        max = numericCount === 0 ? numeric : Math.max(max, numeric);
        numericCount += 1;
      }
      if (previous !== undefined && rawValue !== previous) changeCount += 1;
      previous = rawValue;
    }
    return {
      pointCount: source.records.length,
      min: numericCount > 0 ? min : null,
      max: numericCount > 0 ? max : null,
      changeCount
    };
  }

  dataQuality(sourceId) {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error(`未知 CSV 来源：${sourceId}`);
    const originalTimestamps = source.originalRecords.map((record) => record.timestamp);
    const duplicateTimestampCount = originalTimestamps.length - new Set(originalTimestamps).size;
    let nonMonotonicCount = 0;
    for (let index = 1; index < originalTimestamps.length; index += 1) {
      if (originalTimestamps[index] < originalTimestamps[index - 1]) nonMonotonicCount += 1;
    }

    const uniqueSortedTimestamps = [...new Set(originalTimestamps)].sort((left, right) => left - right);
    const intervals = uniqueSortedTimestamps.slice(1).map((timestamp, index) => timestamp - uniqueSortedTimestamps[index]);
    const medianIntervalMs = median(intervals);
    const largeGapThresholdMs = medianIntervalMs === null ? null : medianIntervalMs * 3;
    const largeGapCount = largeGapThresholdMs === null
      ? 0
      : intervals.filter((interval) => interval > largeGapThresholdMs).length;
    return {
      sourceId: source.id,
      sourceName: source.name,
      schema: {
        columns: [...source.columns],
        timeColumn: source.timeColumn,
        timeFormat: source.timeFormat
      },
      rowCount: source.records.length,
      timeRange: {
        startTime: source.records[0]?.timestamp ?? null,
        endTime: source.records.at(-1)?.timestamp ?? null
      },
      duplicateTimestampCount,
      nonMonotonicCount,
      medianIntervalMs,
      largeGapCount,
      largeGapThresholdMs
    };
  }

  listSamples(sourceId, { maxPoints = Number.POSITIVE_INFINITY } = {}) {
    const source = this.#sources.get(sourceId);
    if (!source) return [];
    const preferredContextColumns = ['move_index', 'direction', 'score', 'largest_tile', 'moved'];
    const contextColumns = preferredContextColumns.filter((column) => source.columns.includes(column));
    return uniformlySampledRecords(source.records, maxPoints).map((record) => ({
      sourceId,
      sourceName: source.name,
      requestedTime: source.timeFormat === 'unix_ms'
        ? String(record.timestamp)
        : new Date(record.timestamp).toISOString(),
      sampledTime: new Date(record.timestamp).toISOString(),
      rowNumber: record.rowNumber,
      context: Object.fromEntries(contextColumns.map((column) => [column, record.valueByColumn[column]]))
    }));
  }

  query({ sourceId, column, requestedTime, mode = 'nearest', toleranceMs = 0 }) {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error(`未知 CSV 来源：${sourceId}`);
    if (!source.columns.includes(column)) throw new Error(`${source.name} 中不存在列 ${column}`);
    const requestedTimestamp = source.timeFormat === 'unix_ms' ? Number(requestedTime) : Date.parse(requestedTime);
    if (Number.isNaN(requestedTimestamp)) throw new Error(`无法解析查询时间：${requestedTime}`);
    const firstAtOrAfter = lowerBoundTimestamp(source.records, requestedTimestamp);
    let chosen = source.records[firstAtOrAfter]?.timestamp === requestedTimestamp
      ? source.records[firstAtOrAfter]
      : undefined;
    let matchType = MatchType.NONE;
    if (chosen) {
      matchType = MatchType.EXACT;
    } else if (mode === 'nearest') {
      // Number() historically allowed +/-Infinity for unix_ms queries.  The
      // former linear scan kept its first record because every distance was
      // Infinity, so retain that edge-case behavior as well.
      chosen = Number.isFinite(requestedTimestamp)
        ? nearestRecord(source.records, requestedTimestamp, firstAtOrAfter)
        : source.records[0];
    }
    if (matchType === MatchType.NONE && chosen && mode === 'nearest' && Math.abs(chosen.timestamp - requestedTimestamp) <= toleranceMs) {
      matchType = MatchType.NEAREST;
    }
    if (matchType === MatchType.NONE) {
      return { matchType, requestedTime, sourceId, sourceName: source.name, csvColumn: column, reason: chosen ? 'nearest_sample_outside_tolerance' : 'no_records' };
    }
    const value = chosen.valueByColumn[column];
    return {
      matchType,
      value,
      rawValue: value,
      requestedTime,
      sampledTime: new Date(chosen.timestamp).toISOString(),
      offsetMs: chosen.timestamp - requestedTimestamp,
      sourceId,
      sourceName: source.name,
      csvColumn: column,
      sourceRow: chosen.rowNumber
    };
  }
}

function lowerBoundTimestamp(records, timestamp) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (records[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nearestRecord(records, requestedTimestamp, firstAtOrAfter) {
  const right = records[firstAtOrAfter];
  let left;
  if (firstAtOrAfter > 0) {
    const leftTimestamp = records[firstAtOrAfter - 1].timestamp;
    // Duplicate timestamps are sorted by source row.  The former linear scan
    // kept the first duplicate it encountered, so preserve that choice.
    left = records[lowerBoundTimestamp(records, leftTimestamp)];
  }
  if (!left) return right;
  if (!right) return left;
  // The former scan also preferred the earlier sample when distances tied.
  return requestedTimestamp - left.timestamp <= right.timestamp - requestedTimestamp ? left : right;
}

function normalizedPointLimit(maxPoints, recordCount) {
  if (!Number.isFinite(maxPoints)) return recordCount;
  return Math.max(1, Math.min(recordCount, Math.floor(maxPoints)));
}

function uniformlySampledRecords(records, maxPoints) {
  const limit = normalizedPointLimit(maxPoints, records.length);
  if (records.length <= limit) return records;
  if (limit === 1) return [records[0]];
  const selected = [];
  let previousIndex = -1;
  for (let index = 0; index < limit; index += 1) {
    const recordIndex = Math.round(index * (records.length - 1) / (limit - 1));
    if (recordIndex === previousIndex) continue;
    selected.push(records[recordIndex]);
    previousIndex = recordIndex;
  }
  return selected;
}

function downsampleRecords(records, maxPoints, valueOf) {
  const limit = normalizedPointLimit(maxPoints, records.length);
  if (records.length <= limit || limit < 3) return uniformlySampledRecords(records, limit);
  const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
  const interiorCount = records.length - 2;
  const selectedIndexes = new Set([0, records.length - 1]);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor(bucket * interiorCount / bucketCount);
    const end = 1 + Math.floor((bucket + 1) * interiorCount / bucketCount);
    let minIndex = start;
    let maxIndex = start;
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;
    let numeric = false;
    for (let index = start; index < end; index += 1) {
      const value = Number(valueOf(records[index]));
      if (!Number.isFinite(value)) continue;
      numeric = true;
      if (value < minValue) {
        minValue = value;
        minIndex = index;
      }
      if (value > maxValue) {
        maxValue = value;
        maxIndex = index;
      }
    }
    if (numeric) {
      selectedIndexes.add(minIndex);
      selectedIndexes.add(maxIndex);
    } else {
      selectedIndexes.add(start);
      selectedIndexes.add(Math.max(start, end - 1));
    }
  }
  const selected = [...selectedIndexes].sort((left, right) => left - right).map((index) => records[index]);
  return selected.length <= limit ? selected : uniformlySampledRecords(selected, limit);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
