/**
 * The domain types are represented as JSON-compatible objects so the same
 * contract can be consumed by the extension, a future web workbench and AI.
 */

export function codeFieldKey(field) {
  const definition = field.definitionPath ? `::definition=${field.definitionPath}` : '';
  if (field.targetKind === 'global' || field.targetKind === 'symbol' || field.qualifiedName || field.codeSymbol) {
    return `${['symbol', field.qualifiedName ?? field.codeSymbol].join('::')}${definition}`;
  }
  const index = field.index === undefined || field.index === null ? '*' : String(field.index);
  return `${['member', field.typeName ?? '', field.fieldName, index].join('::')}${definition}`;
}

export function mappingKey(mapping) {
  return `${mapping.runRecordId}::${codeFieldKey(mapping.codeField)}`;
}

export const MatchType = Object.freeze({
  EXACT: 'exact',
  NEAREST: 'nearest',
  NONE: 'none'
});
