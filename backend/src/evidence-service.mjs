import { codeFieldKey } from './domain.mjs';

export class EvidenceService {
  constructor(csvStore, mappingStore) {
    this.csvStore = csvStore;
    this.mappingStore = mappingStore;
  }

  queryField({ runRecordId, codeField, requestedTime, mode = 'nearest', toleranceMs = 1000 }) {
    const mapping = this.mappingStore.find(runRecordId, codeField);
    if (!mapping) {
      return { codeFieldKey: codeFieldKey(codeField), status: 'unmapped', message: '未找到经确认的 CSV 字段映射' };
    }
    const value = this.csvStore.query({ sourceId: mapping.csvSourceId, column: mapping.csvColumn, requestedTime, mode, toleranceMs });
    return {
      codeFieldKey: codeFieldKey(codeField),
      status: value.matchType === 'none' ? 'no_data' : 'ok',
      codeField,
      mapping: {
        csvSourceId: mapping.csvSourceId,
        csvColumn: mapping.csvColumn,
        mappingSource: mapping.mappingSource,
        confidence: mapping.confidence,
        description: mapping.description,
        mappingFile: mapping.mappingFile,
        mappingFileRow: mapping.mappingFileRow,
        indexRule: mapping.indexRule ?? null
      },
      evidence: value
    };
  }

  queryInstances({ runRecordId, codeField, requestedTime, mode = 'nearest', toleranceMs = 1000 }) {
    const mappings = this.mappingStore.findInstances(runRecordId, codeField);
    if (mappings.length === 0) {
      return { status: 'unmapped', codeField, message: '未找到该数组字段的经确认实例映射', instances: [] };
    }
    return {
      status: 'ok',
      codeField,
      instances: mappings.map((mapping) => ({
        index: mapping.codeField.index ?? null,
        ...this.queryField({ runRecordId, codeField: mapping.codeField, requestedTime, mode, toleranceMs })
      }))
    };
  }

  querySnapshot({ runRecordId, codeFields, requestedTime, mode = 'nearest', toleranceMs = 1000 }) {
    if (!Array.isArray(codeFields)) throw new Error('codeFields 必须是数组');
    for (const [index, codeField] of codeFields.entries()) {
      if (!codeField || typeof codeField !== 'object' || Array.isArray(codeField)) {
        throw new Error(`codeFields[${index}] 必须是对象`);
      }
    }
    return {
      status: 'ok',
      runRecordId,
      requestedTime,
      results: codeFields.map((codeField) => this.queryInstances({
        runRecordId,
        codeField,
        requestedTime,
        mode,
        toleranceMs
      }))
    };
  }

  querySeries({ runRecordId, codeField, maxPoints = 2000 }) {
    const pointLimit = Number.isFinite(Number(maxPoints))
      ? Math.max(10, Math.min(10_000, Math.floor(Number(maxPoints))))
      : 2000;
    const mappings = this.mappingStore.findInstances(runRecordId, codeField);
    if (mappings.length === 0) {
      return { status: 'unmapped', runRecordId, codeField, message: '未找到该字段的经确认实例映射', instances: [] };
    }
    return {
      status: 'ok',
      runRecordId,
      codeField: withoutIndex(codeField),
      instances: mappings.map((mapping) => {
        const points = this.csvStore.listColumnSamples(mapping.csvSourceId, mapping.csvColumn, {
          maxPoints: pointLimit
        });
        const statistics = typeof this.csvStore.columnStatistics === 'function'
          ? this.csvStore.columnStatistics(mapping.csvSourceId, mapping.csvColumn)
          : statisticsOf(points);
        return {
          index: mapping.codeField.index ?? null,
          codeField: mapping.codeField,
          mapping: {
            csvSourceId: mapping.csvSourceId,
            csvColumn: mapping.csvColumn,
            mappingSource: mapping.mappingSource,
            confidence: mapping.confidence,
            description: mapping.description,
            mappingFile: mapping.mappingFile,
            mappingFileRow: mapping.mappingFileRow,
            indexRule: mapping.indexRule ?? null
          },
          source: this.csvStore.describeSource(mapping.csvSourceId),
          points,
          statistics,
          sampled: points.length < statistics.pointCount,
          totalPointCount: statistics.pointCount
        };
      })
    };
  }
}

function withoutIndex(codeField) {
  const result = { ...codeField };
  delete result.index;
  return result;
}

function statisticsOf(points) {
  let min = null;
  let max = null;
  let changeCount = 0;
  for (let index = 0; index < points.length; index += 1) {
    const rawValue = points[index].rawValue;
    if (String(rawValue).trim() !== '') {
      const value = Number(rawValue);
      if (Number.isFinite(value)) {
        if (min === null || value < min) min = value;
        if (max === null || value > max) max = value;
      }
    }
    if (index > 0 && rawValue !== points[index - 1].rawValue) changeCount += 1;
  }
  return {
    pointCount: points.length,
    min,
    max,
    changeCount
  };
}
