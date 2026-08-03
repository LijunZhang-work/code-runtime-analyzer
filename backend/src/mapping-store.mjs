import { codeFieldKey, mappingKey } from './domain.mjs';

export class MappingStore {
  #mappings = new Map();
  #runSources = new Map();

  clear() {
    this.#mappings.clear();
    this.#runSources.clear();
  }

  registerSource(runRecordId, csvSourceId) {
    const sourceIds = this.#runSources.get(runRecordId) ?? [];
    if (!sourceIds.includes(csvSourceId)) sourceIds.push(csvSourceId);
    this.#runSources.set(runRecordId, sourceIds);
  }

  removeRun(runRecordId) {
    this.#runSources.delete(runRecordId);
    for (const [key, mapping] of this.#mappings) {
      if (mapping.runRecordId === runRecordId) this.#mappings.delete(key);
    }
  }

  add(mapping) {
    const complete = completeMapping(mapping);
    this.#mappings.set(mappingKey(complete), complete);
    return complete;
  }

  replaceRuns(replacements) {
    const runIds = new Set();
    const completeReplacements = replacements.map(({ runRecordId, sourceIds = [], mappings = [] }) => {
      if (typeof runRecordId !== 'string' || runRecordId === '') throw new Error('runRecordId 必须是非空字符串');
      if (runIds.has(runRecordId)) throw new Error(`重复替换运行记录：${runRecordId}`);
      runIds.add(runRecordId);
      const completeMappings = mappings.map((mapping) => {
        if (mapping.runRecordId !== runRecordId) throw new Error(`字段映射不属于运行记录 ${runRecordId}`);
        return completeMapping(mapping);
      });
      const keys = completeMappings.map((mapping) => mappingKey(mapping));
      if (new Set(keys).size !== keys.length) throw new Error(`运行记录 ${runRecordId} 存在重复字段映射`);
      return { runRecordId, sourceIds: [...new Set(sourceIds)], mappings: completeMappings };
    });

    const nextMappings = new Map(this.#mappings);
    const nextRunSources = new Map([...this.#runSources].map(([runRecordId, sourceIds]) => [runRecordId, [...sourceIds]]));
    for (const replacement of completeReplacements) {
      for (const [key, mapping] of nextMappings) {
        if (mapping.runRecordId === replacement.runRecordId) nextMappings.delete(key);
      }
      nextRunSources.delete(replacement.runRecordId);
      if (replacement.sourceIds.length > 0) nextRunSources.set(replacement.runRecordId, replacement.sourceIds);
      for (const mapping of replacement.mappings) nextMappings.set(mappingKey(mapping), mapping);
    }
    this.#mappings = nextMappings;
    this.#runSources = nextRunSources;
  }

  find(runRecordId, codeField) {
    const exact = this.#mappings.get(mappingKey({ runRecordId, codeField }));
    if (exact) return exact;
    const candidates = [...this.#mappings.values()].filter((mapping) => mapping.runRecordId === runRecordId
      && sameField(mapping.codeField, codeField));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  findInstances(runRecordId, codeField) {
    const candidates = [...this.#mappings.values()]
      .filter((mapping) => mapping.runRecordId === runRecordId
        && sameFieldWithoutIndex(mapping.codeField, codeField))
      .sort((left, right) => Number(left.codeField.index) - Number(right.codeField.index));
    if (codeField.definitionPath) return candidates;
    const definitions = new Set(candidates.map((mapping) => mapping.codeField.definitionPath ?? ''));
    return definitions.size <= 1 ? candidates : [];
  }

  sourceIdsForRun(runRecordId) {
    return [...new Set([...(this.#runSources.get(runRecordId) ?? []), ...[...this.#mappings.values()]
      .filter((mapping) => mapping.runRecordId === runRecordId)
      .map((mapping) => mapping.csvSourceId)])];
  }

  listRuns() {
    const byRun = new Map();
    for (const [runRecordId, sourceIds] of this.#runSources) {
      byRun.set(runRecordId, { runRecordId, sourceIds: [...sourceIds], mappingCount: 0 });
    }
    for (const mapping of this.#mappings.values()) {
      const run = byRun.get(mapping.runRecordId) ?? {
        runRecordId: mapping.runRecordId,
        sourceIds: [],
        mappingCount: 0
      };
      if (!run.sourceIds.includes(mapping.csvSourceId)) run.sourceIds.push(mapping.csvSourceId);
      run.mappingCount += 1;
      byRun.set(mapping.runRecordId, run);
    }
    return [...byRun.values()].sort((left, right) => left.runRecordId.localeCompare(right.runRecordId));
  }

  listFieldDescriptors(runRecordId, { module, typeName } = {}) {
    const fields = new Map();
    for (const mapping of this.#mappings.values()) {
      if (mapping.runRecordId !== runRecordId) continue;
      if (module !== undefined && mapping.codeField.module !== module) continue;
      if (typeName !== undefined && mapping.codeField.typeName !== typeName) continue;
      const codeField = { ...mapping.codeField };
      delete codeField.index;
      const key = codeFieldKey(codeField);
      const descriptor = fields.get(key) ?? {
        codeField,
        instanceCount: 0,
        mappingSource: mapping.mappingSource,
        confidence: mapping.confidence,
        ...(mapping.description ? { description: mapping.description } : {}),
        ...(mapping.mappingFile ? { mappingFile: mapping.mappingFile } : {}),
        ...(mapping.mappingFileRow ? { mappingFileRow: mapping.mappingFileRow } : {}),
        ...(mapping.dictionaryFile ? { dictionaryFile: mapping.dictionaryFile } : {}),
        ...(mapping.dictionaryRow ? { dictionaryRow: mapping.dictionaryRow } : {})
      };
      descriptor.instanceCount += 1;
      fields.set(key, descriptor);
    }
    return [...fields.values()].sort((left, right) => {
      const leftKey = codeFieldKey(left.codeField);
      const rightKey = codeFieldKey(right.codeField);
      return leftKey.localeCompare(rightKey);
    });
  }
}

function sameFieldWithoutIndex(left, right) {
  const leftGlobal = left.targetKind === 'global' || left.targetKind === 'symbol' || left.qualifiedName || left.codeSymbol;
  const rightGlobal = right.targetKind === 'global' || right.targetKind === 'symbol' || right.qualifiedName || right.codeSymbol;
  if (leftGlobal || rightGlobal) {
    return Boolean(leftGlobal && rightGlobal)
      && (left.qualifiedName ?? left.codeSymbol) === (right.qualifiedName ?? right.codeSymbol)
      && definitionMatches(left, right);
  }
  return left.typeName === right.typeName
    && left.fieldName === right.fieldName
    && definitionMatches(left, right);
}

function sameField(left, right) {
  const leftIndex = left.index ?? null;
  const rightIndex = right.index ?? null;
  return leftIndex === rightIndex && sameFieldWithoutIndex(left, right);
}

function definitionMatches(left, right) {
  return !right.definitionPath || left.definitionPath === right.definitionPath;
}

function completeMapping(mapping) {
  const required = ['runRecordId', 'csvSourceId', 'csvColumn', 'codeField'];
  for (const name of required) if (!mapping[name]) throw new Error(`字段映射缺少 ${name}`);
  return {
    mappingSource: 'manual',
    confidence: 'confirmed',
    ...mapping
  };
}
