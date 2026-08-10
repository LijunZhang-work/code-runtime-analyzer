import * as path from 'path';
import * as vscode from 'vscode';

export type SemanticState = 'available' | 'noEvidence' | 'notReady' | 'unsupported' | 'timeout' | 'failed';

export type SemanticCapability = {
  state: SemanticState;
  summary: string;
  detail: string;
  technical?: string;
};

export type EditorCapabilityProbe = {
  documentSymbols: SemanticCapability;
  definition: SemanticCapability;
  typeDefinition: SemanticCapability;
  references: SemanticCapability;
  callHierarchy: SemanticCapability;
  inlayHints: SemanticCapability;
};

export type EditorGraphNode = {
  id: string;
  label: string;
  signature: string;
  filePath: string | null;
  relativePath: string | null;
  line: number | null;
  column: number | null;
  documentVersion: number | null;
  kind: 'definition' | 'external';
};

export type EditorGraphEdge = {
  id: string;
  source: string;
  target: string;
  callSites: Array<{ line: number | null; column: number | null }>;
};

export type EditorCallGraph = {
  analyzer: 'editor-language-service';
  relativePath?: string;
  focusNodeId?: string | null;
  nodes: EditorGraphNode[];
  edges: EditorGraphEdge[];
  limitations: string[];
  truncated: boolean;
  semanticStatus: SemanticState;
  statusSummary: string;
  statusDetail: string;
  performance: { totalMs: number; analyzedFunctionCount: number };
};

export type SemanticCodeField = {
  targetKind?: string;
  cppTarget?: string;
  typeName?: string;
  ownerType?: string;
  fieldName?: string;
  definitionPath?: string;
  qualifiedName?: string;
  codeSymbol?: string;
  valueType?: string;
};

export type SemanticMappedField = {
  codeField: SemanticCodeField;
  definitionPath?: string;
};

export type SemanticIndexedField = {
  functionName: string | null;
  symbolKind: 'struct_field' | 'global';
  memberName: string | null;
  variablePath: string | null;
  ownerType: string | null;
  accessOwnerType: string | null;
  declaringType: string | null;
  valueType: string | null;
  qualifiedName: string | null;
  declarationFile: string | null;
  definitionFile: string | null;
  declarationLine: number | null;
  definitionLine: number | null;
  rootStorageKind: string | null;
  variableDeclarationKind: string | null;
  variableDeclarationType: string | null;
  expression: string;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
};

export type SemanticIndexResult = {
  fields: SemanticIndexedField[];
  analyzer: 'editor-language-service';
  performance: {
    totalMs: number;
    semanticQueryCount: number;
    candidateCount: number;
    truncated: boolean;
  };
};

type FlatSymbol = {
  name: string;
  detail?: string;
  kind: vscode.SymbolKind;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  containers: string[];
};

type DefinitionTarget = {
  uri: vscode.Uri;
  range: vscode.Range;
};

const FUNCTION_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor
]);

const OWNER_KINDS = new Set([
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum
]);

const timeoutError = Symbol('timeout');

async function withTimeout<T>(promise: Thenable<T> | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isDocumentSymbol(value: vscode.DocumentSymbol | vscode.SymbolInformation): value is vscode.DocumentSymbol {
  return 'range' in value && 'selectionRange' in value;
}

function flattenDocumentSymbols(
  uri: vscode.Uri,
  values: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined,
  parents: string[] = []
): FlatSymbol[] {
  if (!values) return [];
  const flattened: FlatSymbol[] = [];
  for (const value of values) {
    if (isDocumentSymbol(value)) {
      flattened.push({
        name: value.name,
        detail: value.detail,
        kind: value.kind,
        uri,
        range: value.range,
        selectionRange: value.selectionRange,
        containers: parents
      });
      const childParents = OWNER_KINDS.has(value.kind) ? [...parents, value.name] : parents;
      flattened.push(...flattenDocumentSymbols(uri, value.children, childParents));
    } else {
      flattened.push({
        name: value.name,
        kind: value.kind,
        uri: value.location.uri,
        range: value.location.range,
        selectionRange: value.location.range,
        containers: value.containerName ? value.containerName.split('::').filter(Boolean) : []
      });
    }
  }
  return flattened;
}

async function documentSymbols(uri: vscode.Uri, timeoutMs = 3_500): Promise<FlatSymbol[]> {
  const values = await withTimeout(
    vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      'vscode.executeDocumentSymbolProvider',
      uri
    ),
    timeoutMs
  );
  return flattenDocumentSymbols(uri, values);
}

function toDefinitionTarget(value: vscode.Location | vscode.LocationLink): DefinitionTarget {
  if ('targetUri' in value) return { uri: value.targetUri, range: value.targetSelectionRange ?? value.targetRange };
  return { uri: value.uri, range: value.range };
}

async function definitionsAt(uri: vscode.Uri, position: vscode.Position, timeoutMs = 3_500): Promise<DefinitionTarget[]> {
  const values = await withTimeout(
    vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeDefinitionProvider',
      uri,
      position
    ),
    timeoutMs
  );
  return Array.isArray(values) ? values.map(toDefinitionTarget) : [];
}

function contains(range: vscode.Range, position: vscode.Position): boolean {
  return range.contains(position);
}

function functionAt(symbols: readonly FlatSymbol[], position: vscode.Position): FlatSymbol | undefined {
  return symbols
    .filter((symbol) => FUNCTION_KINDS.has(symbol.kind) && contains(symbol.range, position))
    .sort((left, right) => {
      const leftSize = left.range.end.line - left.range.start.line;
      const rightSize = right.range.end.line - right.range.start.line;
      return leftSize - rightSize;
    })[0];
}

function clampPosition(document: vscode.TextDocument, lineOneBased?: number, columnOneBased?: number): vscode.Position {
  const requestedLine = Number(lineOneBased ?? 1);
  const line = Math.max(0, Math.min(document.lineCount - 1, Number.isFinite(requestedLine) ? Math.floor(requestedLine) - 1 : 0));
  const requestedColumn = Number(columnOneBased ?? 1);
  const column = Math.max(0, Math.min(document.lineAt(line).text.length, Number.isFinite(requestedColumn) ? Math.floor(requestedColumn) - 1 : 0));
  return new vscode.Position(line, column);
}

function graphNodeId(item: vscode.CallHierarchyItem): string {
  const range = item.selectionRange;
  return `${encodeURIComponent(item.uri.toString())}:${range.start.line + 1}:${range.start.character + 1}:${encodeURIComponent(item.name)}`;
}

function workspaceContains(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') return false;
  return Boolean(vscode.workspace.workspaceFolders?.some((folder) => {
    if (folder.uri.scheme !== 'file') return false;
    const relativePath = path.relative(path.resolve(folder.uri.fsPath), path.resolve(uri.fsPath));
    return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
  }));
}

function graphNode(item: vscode.CallHierarchyItem): EditorGraphNode {
  const local = workspaceContains(item.uri);
  const detail = item.detail?.trim();
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === item.uri.toString());
  return {
    id: graphNodeId(item),
    label: item.name,
    signature: detail ? `${item.name} — ${detail}` : item.name,
    filePath: local && item.uri.scheme === 'file' ? item.uri.fsPath : null,
    relativePath: local ? vscode.workspace.asRelativePath(item.uri, false) : null,
    line: item.selectionRange.start.line + 1,
    column: item.selectionRange.start.character + 1,
    documentVersion: openDocument?.version ?? null,
    kind: local ? 'definition' : 'external'
  };
}

function callSites(ranges: readonly vscode.Range[] | undefined): Array<{ line: number | null; column: number | null }> {
  return (ranges ?? []).map((range) => ({ line: range.start.line + 1, column: range.start.character + 1 }));
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) if (!result.has(keyOf(value))) result.set(keyOf(value), value);
  return [...result.values()];
}

export async function buildEditorCallGraph(input: {
  filePath: string;
  line?: number;
  column?: number;
  documentVersion?: number;
  timeoutMs?: number;
}): Promise<EditorCallGraph> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1_000, Math.min(12_000, input.timeoutMs ?? 7_000));
  const uri = vscode.Uri.file(path.resolve(input.filePath));
  const document = await vscode.workspace.openTextDocument(uri);
  const expectedVersion = Number(input.documentVersion);
  if (Number.isFinite(expectedVersion) && document.version !== Math.floor(expectedVersion)) {
    return {
      analyzer: 'editor-language-service',
      relativePath: vscode.workspace.asRelativePath(uri, false),
      focusNodeId: null,
      nodes: [],
      edges: [],
      limitations: ['网页保存的代码位置已经过期；工具没有继续按旧行号猜测函数。'],
      truncated: false,
      semanticStatus: 'notReady',
      statusSummary: '代码已经发生变化',
      statusDetail: '打开网页后，这个文件已经被修改。请从当前编辑器的“历史诊断”面板重新打开网页工作台。',
      performance: { totalMs: Date.now() - startedAt, analyzedFunctionCount: 0 }
    };
  }
  const requestedPosition = clampPosition(document, input.line, input.column);
  let symbols: FlatSymbol[] = [];
  try {
    symbols = await documentSymbols(uri, Math.min(timeoutMs, 4_000));
  } catch {
    // Call hierarchy may still work when a provider does not expose document symbols.
  }
  const focusedSymbol = functionAt(symbols, requestedPosition);
  const queryPosition = focusedSymbol?.selectionRange.start ?? requestedPosition;
  let prepared: vscode.CallHierarchyItem[] | undefined;
  try {
    prepared = await withTimeout(
      vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, queryPosition),
      timeoutMs
    );
  } catch (error) {
    const timedOut = error === timeoutError;
    return {
      analyzer: 'editor-language-service',
      relativePath: vscode.workspace.asRelativePath(uri, false),
      focusNodeId: null,
      nodes: [],
      edges: [],
      limitations: ['当前结果来自编辑器正在使用的语言服务；编辑器没有明确返回的关系不会被猜测。'],
      truncated: false,
      semanticStatus: timedOut ? 'timeout' : 'failed',
      statusSummary: timedOut ? '编辑器响应超时' : '编辑器调用关系请求失败',
      statusDetail: timedOut
        ? '编辑器可能仍在理解这个项目。稍后点击“重新检查”即可，不需要重新安装。'
        : `当前编辑器没有完成调用关系请求：${error instanceof Error ? error.message : String(error)}`,
      performance: { totalMs: Date.now() - startedAt, analyzedFunctionCount: 0 }
    };
  }

  const focusItem = prepared?.find((item) => item.uri.toString() === uri.toString() && item.range.contains(queryPosition)) ?? prepared?.[0];
  if (!focusItem) {
    const fallbackNode: EditorGraphNode | undefined = focusedSymbol ? {
      id: `${encodeURIComponent(uri.toString())}:${focusedSymbol.selectionRange.start.line + 1}:${focusedSymbol.selectionRange.start.character + 1}:${encodeURIComponent(focusedSymbol.name)}`,
      label: focusedSymbol.name,
      signature: focusedSymbol.detail || focusedSymbol.name,
      filePath: uri.fsPath,
      relativePath: vscode.workspace.asRelativePath(uri, false),
      line: focusedSymbol.selectionRange.start.line + 1,
      column: focusedSymbol.selectionRange.start.character + 1,
      documentVersion: document.version,
      kind: 'definition'
    } : undefined;
    return {
      analyzer: 'editor-language-service',
      relativePath: vscode.workspace.asRelativePath(uri, false),
      focusNodeId: fallbackNode?.id ?? null,
      nodes: fallbackNode ? [fallbackNode] : [],
      edges: [],
      limitations: ['当前编辑器这次没有返回函数调用层级；这不代表该函数一定没有调用关系。'],
      truncated: false,
      semanticStatus: 'noEvidence',
      statusSummary: '编辑器这次没有返回函数调用关系',
      statusDetail: '请确认光标位于函数内，并等待当前编辑器完成代码索引后重新检查。',
      performance: { totalMs: Date.now() - startedAt, analyzedFunctionCount: fallbackNode ? 1 : 0 }
    };
  }

  let incoming: vscode.CallHierarchyIncomingCall[] = [];
  let outgoing: vscode.CallHierarchyOutgoingCall[] = [];
  const limitations = ['调用关系来自当前编辑器语言服务，只显示它明确返回的直接关系。'];
  const [incomingResult, outgoingResult] = await Promise.allSettled([
    withTimeout(
      vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', focusItem),
      timeoutMs
    ),
    withTimeout(
      vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', focusItem),
      timeoutMs
    )
  ]);
  if (incomingResult.status === 'fulfilled' && Array.isArray(incomingResult.value)) incoming = incomingResult.value;
  else limitations.push('当前编辑器没有完成“谁调用它”的查询。');
  if (outgoingResult.status === 'fulfilled' && Array.isArray(outgoingResult.value)) outgoing = outgoingResult.value;
  else limitations.push('当前编辑器没有完成“它调用谁”的查询。');

  const nodes = uniqueBy([
    graphNode(focusItem),
    ...incoming.map((call) => graphNode(call.from)),
    ...outgoing.map((call) => graphNode(call.to))
  ], (node) => node.id);
  const focusId = graphNodeId(focusItem);
  const edges = uniqueBy<EditorGraphEdge>([
    ...incoming.map((call) => ({
      id: `${graphNodeId(call.from)}->${focusId}`,
      source: graphNodeId(call.from),
      target: focusId,
      callSites: callSites(call.fromRanges)
    })),
    ...outgoing.map((call) => ({
      id: `${focusId}->${graphNodeId(call.to)}`,
      source: focusId,
      target: graphNodeId(call.to),
      callSites: callSites(call.fromRanges)
    }))
  ], (edge) => edge.id);

  return {
    analyzer: 'editor-language-service',
    relativePath: vscode.workspace.asRelativePath(uri, false),
    focusNodeId: focusId,
    nodes,
    edges,
    limitations,
    truncated: false,
    semanticStatus: 'available',
    statusSummary: '函数调用关系可以使用',
    statusDetail: edges.length > 0
      ? `当前编辑器返回了 ${nodes.length} 个函数和 ${edges.length} 条直接调用关系。`
      : '当前编辑器支持调用层级，但这次没有返回直接调用关系。',
    performance: { totalMs: Date.now() - startedAt, analyzedFunctionCount: nodes.length }
  };
}

function isGlobalField(field: SemanticCodeField): boolean {
  return field.targetKind === 'global' || field.targetKind === 'symbol' || Boolean(field.qualifiedName || field.codeSymbol);
}

function globalName(field: SemanticCodeField): string {
  return field.cppTarget ?? field.qualifiedName ?? field.codeSymbol ?? '';
}

function structTarget(field: SemanticCodeField): { typeName: string; fieldName: string } {
  if (field.typeName && field.fieldName) return { typeName: field.typeName, fieldName: field.fieldName };
  const target = field.cppTarget ?? '';
  const separator = target.lastIndexOf('::');
  return separator > 0
    ? { typeName: target.slice(0, separator), fieldName: target.slice(separator + 2) }
    : { typeName: field.typeName ?? field.ownerType ?? '', fieldName: field.fieldName ?? target };
}

function normalizeCppName(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/^(?:struct|class|union)\s+/, '')
    .replace(/^(?:(?:const|volatile)\s+)+/, '')
    .replace(/\s*(?:&&|&|\*)\s*$/, '')
    .replace(/^::/, '');
}

function sameCppOwner(expected: string, actual: string): boolean {
  const left = normalizeCppName(expected);
  const right = normalizeCppName(actual);
  return Boolean(left && right && (left === right || left.endsWith(`::${right}`) || right.endsWith(`::${left}`)));
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function definitionMatches(uri: vscode.Uri, mapping: SemanticMappedField): boolean {
  const wanted = (mapping.codeField.definitionPath ?? mapping.definitionPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!wanted) return true;
  if (uri.scheme !== 'file') return false;
  if (path.isAbsolute(wanted) || /^[A-Za-z]:\//.test(wanted)) return comparablePath(wanted) === comparablePath(uri.fsPath);
  const segments = wanted.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
  if (segments.length === 0 || wanted.split('/').includes('..')) return false;
  return Boolean(vscode.workspace.workspaceFolders?.some((folder) => {
    if (folder.uri.scheme !== 'file') return false;
    return comparablePath(vscode.Uri.joinPath(folder.uri, ...segments).fsPath) === comparablePath(uri.fsPath);
  }));
}

function targetName(mapping: SemanticMappedField): string {
  return isGlobalField(mapping.codeField)
    ? globalName(mapping.codeField).split('::').at(-1) ?? ''
    : structTarget(mapping.codeField).fieldName;
}

function symbolAt(symbols: readonly FlatSymbol[], position: vscode.Position): FlatSymbol | undefined {
  return symbols
    .filter((symbol) => symbol.range.contains(position) || symbol.selectionRange.contains(position))
    .sort((left, right) => {
      const leftSize = left.range.end.line - left.range.start.line;
      const rightSize = right.range.end.line - right.range.start.line;
      return leftSize - rightSize;
    })[0];
}

function expressionAt(document: vscode.TextDocument, range: vscode.Range): string {
  const line = document.lineAt(range.start.line).text;
  const before = line.slice(0, range.start.character);
  const baseMatch = before.match(/([A-Za-z_]\w*(?:\s*\[[^\]]+\])?)\s*(?:\.|->|::)\s*$/);
  return baseMatch ? `${baseMatch[1]}${before.slice(before.lastIndexOf(baseMatch[1]) + baseMatch[1].length)}${document.getText(range)}` : document.getText(range);
}

async function mapLimited<T, R>(values: readonly T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function indexMappedFieldsWithEditor(
  document: vscode.TextDocument,
  mappings: readonly SemanticMappedField[],
  options: { signal?: AbortSignal; maxCandidates?: number } = {}
): Promise<SemanticIndexResult> {
  const startedAt = Date.now();
  const maxCandidates = Math.max(20, Math.min(600, options.maxCandidates ?? 240));
  const byName = new Map<string, SemanticMappedField[]>();
  for (const mapping of mappings) {
    const name = targetName(mapping);
    if (!name) continue;
    const bucket = byName.get(name) ?? [];
    bucket.push(mapping);
    byName.set(name, bucket);
  }
  if (byName.size === 0) {
    return {
      fields: [],
      analyzer: 'editor-language-service',
      performance: { totalMs: Date.now() - startedAt, semanticQueryCount: 0, candidateCount: 0, truncated: false }
    };
  }
  const expression = [...byName.keys()].sort((left, right) => right.length - left.length).map(escapeRegExp).join('|');
  const matcher = new RegExp(`\\b(?:${expression})\\b`, 'g');
  const text = document.getText();
  const candidates: Array<{ name: string; range: vscode.Range; mappings: SemanticMappedField[] }> = [];
  let truncated = false;
  for (const match of text.matchAll(matcher)) {
    if (match.index === undefined) continue;
    if (candidates.length >= maxCandidates) {
      truncated = true;
      break;
    }
    const name = match[0];
    const start = document.positionAt(match.index);
    const end = document.positionAt(match.index + name.length);
    candidates.push({ name, range: new vscode.Range(start, end), mappings: byName.get(name) ?? [] });
  }
  let semanticQueryCount = 0;
  let currentSymbols: FlatSymbol[] = [];
  try {
    currentSymbols = await documentSymbols(document.uri);
  } catch {
    currentSymbols = [];
  }
  const symbolCache = new Map<string, Promise<FlatSymbol[]>>();
  symbolCache.set(document.uri.toString(), Promise.resolve(currentSymbols));

  const resolved = await mapLimited(candidates, 6, async (candidate): Promise<SemanticIndexedField | undefined> => {
    if (options.signal?.aborted) return undefined;
    let definitions: DefinitionTarget[];
    try {
      semanticQueryCount += 1;
      definitions = await definitionsAt(document.uri, candidate.range.start, 3_500);
    } catch {
      return undefined;
    }
    const evidences: Array<{
      mapping: SemanticMappedField;
      target: DefinitionTarget;
      owner: string;
      qualified: string;
      declarationName: string;
    }> = [];
    for (const target of definitions) {
      if (options.signal?.aborted) return undefined;
      const cacheKey = target.uri.toString();
      let symbolsPromise = symbolCache.get(cacheKey);
      if (!symbolsPromise) {
        symbolsPromise = documentSymbols(target.uri).catch(() => []);
        symbolCache.set(cacheKey, symbolsPromise);
      }
      const targetSymbols = await symbolsPromise;
      const declaredSymbol = symbolAt(targetSymbols, target.range.start);
      const owner = declaredSymbol?.containers.join('::') ?? '';
      const declarationName = declaredSymbol?.name ?? candidate.name;
      const qualified = [...(declaredSymbol?.containers ?? []), declarationName].filter(Boolean).join('::');
      for (const mapping of candidate.mappings) {
        if (!definitionMatches(target.uri, mapping)) continue;
        if (isGlobalField(mapping.codeField)) {
          const wanted = normalizeCppName(globalName(mapping.codeField));
          if (wanted.includes('::') && (!qualified || !sameCppOwner(wanted, qualified))) continue;
          if (wanted && !wanted.includes('::') && wanted !== declarationName) continue;
        } else {
          const wanted = structTarget(mapping.codeField);
          if (declarationName !== wanted.fieldName) continue;
          // A file path and field name are not enough: one header can define
          // several structures that all contain `age`.  Without an enclosing
          // type returned by the editor, displaying a value would be a guess.
          if (!owner || !sameCppOwner(wanted.typeName, owner)) continue;
        }
        evidences.push({ mapping, target, owner, qualified, declarationName });
      }
    }
    const distinctMappings = uniqueBy(evidences, (item) => JSON.stringify(item.mapping.codeField));
    // Different dictionary targets survived the same semantic evidence.  That
    // means the editor did not distinguish them clearly enough, so hiding the
    // value is safer than choosing whichever mapping happened to come first.
    if (distinctMappings.length !== 1) return undefined;
    const evidence = distinctMappings[0];
    const mapping = evidence.mapping;
    const global = isGlobalField(mapping.codeField);
    const owner = global ? '' : evidence.owner || structTarget(mapping.codeField).typeName;
    const currentFunction = functionAt(currentSymbols, candidate.range.start);
    return {
      functionName: currentFunction?.name ?? null,
      symbolKind: global ? 'global' : 'struct_field',
      memberName: global ? null : candidate.name,
      variablePath: expressionAt(document, candidate.range),
      ownerType: owner || null,
      accessOwnerType: owner || null,
      declaringType: owner || null,
      valueType: mapping.codeField.valueType ?? null,
      qualifiedName: global ? globalName(mapping.codeField) || evidence.qualified : null,
      declarationFile: evidence.target.uri.scheme === 'file' ? evidence.target.uri.fsPath : null,
      definitionFile: evidence.target.uri.scheme === 'file' ? evidence.target.uri.fsPath : null,
      declarationLine: evidence.target.range.start.line + 1,
      definitionLine: evidence.target.range.start.line + 1,
      rootStorageKind: global ? 'global' : null,
      variableDeclarationKind: null,
      variableDeclarationType: null,
      expression: expressionAt(document, candidate.range),
      range: {
        start: { line: candidate.range.start.line + 1, column: candidate.range.start.character + 1 },
        end: { line: candidate.range.end.line + 1, column: candidate.range.end.character + 1 }
      }
    };
  });

  return {
    fields: resolved.filter((field): field is SemanticIndexedField => Boolean(field)),
    analyzer: 'editor-language-service',
    performance: {
      totalMs: Date.now() - startedAt,
      semanticQueryCount,
      candidateCount: candidates.length,
      truncated
    }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function available(summary: string, detail: string): SemanticCapability {
  return { state: 'available', summary, detail };
}

function noEvidence(summary: string, detail: string): SemanticCapability {
  return { state: 'noEvidence', summary, detail };
}

function failedCapability(error: unknown): SemanticCapability {
  if (error === timeoutError) {
    return {
      state: 'timeout',
      summary: '编辑器响应超时',
      detail: '编辑器可能仍在理解这个项目。稍后重新检测即可，不需要重新安装。'
    };
  }
  return {
    state: 'failed',
    summary: '检测请求失败',
    detail: '当前编辑器没有完成这项检测。展开技术详情或复制诊断信息后可以继续排查。',
    technical: error instanceof Error ? error.message : String(error)
  };
}

async function probeArrayCommand<T>(
  commandId: string,
  args: unknown[],
  successSummary: string,
  successDetail: string,
  emptySummary: string,
  emptyDetail: string
): Promise<SemanticCapability> {
  try {
    const value = await withTimeout(vscode.commands.executeCommand<T[]>(commandId, ...args), 4_000);
    return Array.isArray(value) && value.length > 0
      ? available(successSummary, successDetail)
      : noEvidence(emptySummary, `${emptyDetail} 编辑器本次返回了 0 条可验证结果。`);
  } catch (error) {
    return failedCapability(error);
  }
}

export async function probeEditorCapabilities(document: vscode.TextDocument, requestedPosition: vscode.Position): Promise<EditorCapabilityProbe> {
  const position = clampPosition(document, requestedPosition.line + 1, requestedPosition.character + 1);
  let symbols: FlatSymbol[] = [];
  let symbolsCapability: SemanticCapability;
  try {
    symbols = await documentSymbols(document.uri, 4_000);
    symbolsCapability = symbols.length > 0
      ? available('代码结构可以读取', `编辑器返回了 ${symbols.length} 个代码符号。`)
      : noEvidence('代码结构尚未确认', '编辑器本次返回了 0 个代码符号。请打开一个包含函数的 C/C++ 文件后重新检测。');
  } catch (error) {
    symbolsCapability = failedCapability(error);
  }
  const focusedFunction = functionAt(symbols, position) ?? symbols.find((symbol) => FUNCTION_KINDS.has(symbol.kind));
  const semanticPosition = focusedFunction?.selectionRange.start ?? position;
  const definitionPromise = probeArrayCommand<vscode.Location | vscode.LocationLink>(
    'vscode.executeDefinitionProvider',
    [document.uri, semanticPosition],
    '代码定位可以使用',
    '编辑器已经接受跳转定义请求。',
    '代码定位尚未确认',
    '当前代码位置没有返回定义。请把光标放到一个函数名或变量名上重新检测。'
  );
  const typeDefinitionPromise = probeArrayCommand<vscode.Location | vscode.LocationLink>(
    'vscode.executeTypeDefinitionProvider',
    [document.uri, position],
    '类型定义查询可以使用',
    '编辑器已经接受类型定义请求。',
    '类型定义尚未确认',
    '当前光标位置没有可查询的类型。把光标放到一个变量名上重新检测即可。'
  );
  const referencesPromise = probeArrayCommand<vscode.Location>(
    'vscode.executeReferenceProvider',
    [document.uri, semanticPosition],
    '引用查询可以使用',
    '编辑器已经接受引用查询。',
    '引用查询尚未确认',
    '当前代码位置没有返回引用，请换一个函数或变量后重新检测。'
  );
  const callHierarchyPromise = (async (): Promise<SemanticCapability> => {
    try {
      const prepared = await withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', document.uri, semanticPosition),
        4_000
      );
      return Array.isArray(prepared) && prepared.length > 0
        ? available('函数调用关系可以使用', '编辑器已经识别当前函数，可以查询它的直接调用者和被调用函数。')
        : noEvidence('函数调用关系尚未确认', '编辑器这次没有识别出函数。请把光标放到函数名或函数体内，等待索引完成后重新检测。');
    } catch (error) {
      return failedCapability(error);
    }
  })();
  const inlayHintsPromise = probeArrayCommand<vscode.InlayHint>(
    'vscode.executeInlayHintProvider',
    [document.uri, document.validateRange(new vscode.Range(0, 0, Math.min(document.lineCount - 1, 200), 0))],
    '行内提示接口可以使用',
    '编辑器已经接受行内提示请求；它只作为辅助证据，不会单独决定字段匹配。',
    '行内提示尚未确认',
    '当前编辑器没有返回行内提示。这不会阻止类型定义和跳转定义继续工作。'
  );
  const [definition, typeDefinition, references, callHierarchy, inlayHints] = await Promise.all([
    definitionPromise,
    typeDefinitionPromise,
    referencesPromise,
    callHierarchyPromise,
    inlayHintsPromise
  ]);
  return {
    documentSymbols: symbolsCapability,
    definition,
    typeDefinition,
    references,
    callHierarchy,
    inlayHints
  };
}
