import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ClangdIndexService } from './clangd-index-service.mjs';

function comparablePath(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function tokenizeCommand(command) {
  // CMake response files commonly contain arguments such as
  // -I"E:/path with spaces/include".  A quoted fragment may therefore occur
  // inside an argument rather than only at its beginning.
  return (command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [])
    .map((token) => token.replace(/"([^"]*)"/g, '$1'));
}

async function expandResponseFiles(args, workingDirectory) {
  const expanded = [];
  for (const arg of args) {
    if (!arg.startsWith('@')) {
      expanded.push(arg);
      continue;
    }
    const responsePath = resolve(workingDirectory, arg.slice(1));
    expanded.push(...tokenizeCommand(await readFile(responsePath, 'utf8')));
  }
  return expanded;
}

function sourcePosition(source, offset) {
  const prefix = source.slice(0, offset);
  const line = prefix.split('\n').length;
  const lastNewline = prefix.lastIndexOf('\n');
  return { line, column: offset - lastNewline };
}

function sourceRange(node, source) {
  if (node.range?.begin?.offset === undefined || node.range?.end?.offset === undefined) return null;
  const begin = node.range.begin.offset;
  const end = node.range.end.offset + (node.range.end.tokLen ?? 0);
  return {
    begin,
    end,
    expression: source.slice(begin, end),
    range: { start: sourcePosition(source, begin), end: sourcePosition(source, end) }
  };
}

function clangType(node) {
  return node?.type?.desugaredQualType ?? node?.type?.qualType ?? null;
}

function normalizeType(type, { stripPointer = false } = {}) {
  if (!type) return null;
  let result = String(type).trim();
  result = result.replace(/^(?:(?:const|volatile)\s+)+/, '');
  result = result.replace(/\s+(?:const|volatile)(?=\s*(?:[&*]|$))/g, '');
  result = result.replace(/\s*&&?\s*$/, '');
  if (stripPointer) result = result.replace(/\s*\*\s*$/, '');
  result = result.replace(/^(?:struct|class|union)\s+/, '');
  return result.trim() || null;
}

function ownerTypeOf(member) {
  const base = member.inner?.[0];
  return normalizeType(clangType(base), { stripPointer: member.isArrow === true });
}

function declReferences(node, values = []) {
  if (!node || typeof node !== 'object') return values;
  const declaration = node.kind === 'DeclRefExpr' ? node.referencedDecl : null;
  if (declaration && ['VarDecl', 'ParmVarDecl', 'FieldDecl'].includes(declaration.kind)) {
    values.push(declaration.name);
  }
  for (const child of node.inner ?? []) declReferences(child, values);
  return values;
}

function collectLocalDeclarations(node, declarations = new Map()) {
  if (!node || typeof node !== 'object') return declarations;
  if (node.id && ['VarDecl', 'ParmVarDecl'].includes(node.kind)) declarations.set(node.id, node);
  for (const child of node.inner ?? []) collectLocalDeclarations(child, declarations);
  return declarations;
}

function rootObjectDeclaration(node, localDeclarations) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'DeclRefExpr') {
    const referenced = node.referencedDecl;
    if (!referenced || !['VarDecl', 'ParmVarDecl', 'FieldDecl'].includes(referenced.kind)) return null;
    return localDeclarations.get(referenced.id) ?? referenced;
  }
  if (node.kind === 'CXXThisExpr') {
    return { kind: 'CXXThisExpr', name: 'this', type: node.type };
  }
  if (node.kind === 'MemberExpr') return rootObjectDeclaration(node.inner?.[0], localDeclarations);
  if (node.kind === 'ArraySubscriptExpr') return rootObjectDeclaration(node.inner?.[0], localDeclarations);
  if (node.kind === 'CXXOperatorCallExpr') {
    // For operator[] the first child is the operator function and the second
    // child is the object.  Looking at the whole subtree would mistake the
    // array index for the owning variable.
    return rootObjectDeclaration(node.inner?.[1], localDeclarations);
  }
  if (['ImplicitCastExpr', 'ParenExpr', 'ExprWithCleanups', 'MaterializeTemporaryExpr',
    'CXXBindTemporaryExpr', 'UnaryOperator'].includes(node.kind)) {
    return rootObjectDeclaration(node.inner?.[0], localDeclarations);
  }
  return null;
}

function rootStorageKind(declaration, localDeclarations) {
  if (!declaration) return null;
  if (declaration.kind === 'ParmVarDecl') return 'parameter';
  if (declaration.kind === 'FieldDecl') return 'member';
  if (declaration.kind === 'CXXThisExpr') return 'this';
  if (declaration.kind === 'VarDecl') return localDeclarations.has(declaration.id) ? 'local' : 'global';
  return null;
}

function memberFact(node, source, functionName, localDeclarations) {
  const location = sourceRange(node, source);
  if (!location || !node.name) return null;
  const ownerType = ownerTypeOf(node);
  const declaration = rootObjectDeclaration(node.inner?.[0], localDeclarations);
  const declarations = [...new Set(declReferences(node))];
  const variablePath = declaration?.name ?? declarations[0] ?? null;
  const indexExpression = declarations.find((name) => name !== variablePath) ?? null;
  const rawValueType = clangType(node);
  return {
    kind: 'clang_semantic_fact',
    symbolKind: 'struct_field',
    functionName,
    memberName: node.name,
    variablePath,
    indexExpression,
    expression: location.expression,
    range: location.range,
    type: rawValueType,
    ownerType,
    accessOwnerType: ownerType,
    declaringType: null,
    valueType: normalizeType(rawValueType),
    qualifiedName: ownerType ? `${ownerType}::${node.name}` : null,
    qualifiedNameSource: ownerType ? 'base_static_type' : null,
    referencedMemberDeclId: node.referencedMemberDecl ?? null,
    declarationFile: null,
    declarationLine: null,
    definitionFile: null,
    definitionLine: null,
    variableDeclarationKind: declaration?.kind ?? null,
    variableDeclarationType: clangType(declaration),
    rootStorageKind: rootStorageKind(declaration, localDeclarations)
  };
}

function qualifiedGlobalName(node, source, name) {
  const location = sourceRange(node, source);
  if (!location) return { name, source: 'referenced_decl_name' };
  const expression = location.expression.replace(/\s+/g, '');
  if (/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(expression)
      && expression.replace(/^::/, '').split('::').at(-1) === name) {
    return {
      name: expression.replace(/^::/, ''),
      source: expression.includes('::') ? 'source_expression' : 'referenced_decl_name'
    };
  }
  return { name, source: 'referenced_decl_name' };
}

function globalFact(node, source, functionName, localDeclarations) {
  if (node.kind !== 'DeclRefExpr' || node.referencedDecl?.kind !== 'VarDecl') return null;
  if (localDeclarations.has(node.referencedDecl.id)) return null;
  const location = sourceRange(node, source);
  if (!location) return null;
  const qualified = qualifiedGlobalName(node, source, node.referencedDecl.name);
  const rawValueType = clangType(node);
  return {
    kind: 'clang_semantic_fact',
    symbolKind: 'global',
    functionName,
    name: node.referencedDecl.name,
    memberName: null,
    variablePath: node.referencedDecl.name,
    indexExpression: null,
    expression: location.expression,
    range: location.range,
    type: rawValueType,
    ownerType: null,
    valueType: normalizeType(rawValueType),
    qualifiedName: qualified.name,
    qualifiedNameSource: qualified.source,
    declarationFile: null,
    declarationLine: null,
    definitionFile: null,
    definitionLine: null,
    storageClass: null,
    internalLinkage: null,
    variableDeclarationKind: 'VarDecl',
    variableDeclarationType: clangType(node.referencedDecl),
    rootStorageKind: 'global'
  };
}

function visitFunction(node, source, functionName, localDeclarations, fields, suppressGlobal = false) {
  if (!node || typeof node !== 'object') return;
  if (node.kind === 'MemberExpr') {
    const fact = memberFact(node, source, functionName, localDeclarations);
    if (fact) fields.push(fact);
    for (const child of node.inner ?? []) {
      visitFunction(child, source, functionName, localDeclarations, fields, true);
    }
    return;
  }
  if (!suppressGlobal) {
    const fact = globalFact(node, source, functionName, localDeclarations);
    if (fact) fields.push(fact);
  }
  for (const child of node.inner ?? []) {
    visitFunction(child, source, functionName, localDeclarations, fields, suppressGlobal);
  }
}

function removeBuildOnlyArgs(args, sourceFile) {
  const retained = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-c' || samePath(arg, sourceFile)) continue;
    if (arg === '-o') {
      index += 1;
      continue;
    }
    retained.push(arg);
  }
  return retained;
}

function parseJsonRoots(output) {
  const roots = [];
  let cursor = 0;
  while (cursor < output.length) {
    while (cursor < output.length && /\s/.test(output[cursor])) cursor += 1;
    if (cursor >= output.length) break;
    if (output[cursor] !== '{') throw new Error(`Clang AST JSON 含无法识别的内容（偏移 ${cursor}）`);
    const start = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let completed = false;
    for (; cursor < output.length; cursor += 1) {
      const character = output[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          roots.push(JSON.parse(output.slice(start, cursor)));
          completed = true;
          break;
        }
      }
    }
    if (!completed) throw new Error('Clang AST JSON 根对象未闭合');
  }
  return roots;
}

function nodeFile(node) {
  return node.loc?.file ?? node.range?.begin?.file ?? null;
}

function resolvedNodeFile(node, inheritedFile, workingDirectory) {
  const file = nodeFile(node) ?? inheritedFile ?? null;
  return file ? resolve(workingDirectory, file) : null;
}

function declarationLine(node) {
  return node.loc?.line ?? node.range?.begin?.line ?? null;
}

function collectRecordDefinitions(node, workingDirectory, inheritedFile = null, values = []) {
  if (!node || typeof node !== 'object') return values;
  const file = resolvedNodeFile(node, inheritedFile, workingDirectory);
  if (['CXXRecordDecl', 'RecordDecl'].includes(node.kind) && node.completeDefinition === true) {
    values.push({ node, file });
  }
  for (const child of node.inner ?? []) {
    collectRecordDefinitions(child, workingDirectory, file, values);
  }
  return values;
}

function collectVariableDeclarations(node, workingDirectory, inheritedFile = null, values = []) {
  if (!node || typeof node !== 'object') return values;
  const file = resolvedNodeFile(node, inheritedFile, workingDirectory);
  if (node.kind === 'VarDecl') values.push({ node, file });
  for (const child of node.inner ?? []) {
    collectVariableDeclarations(child, workingDirectory, file, values);
  }
  return values;
}

function uniqueDeclarations(values) {
  return [...new Map(values.map((value) => [[
    value.node.kind,
    value.node.name,
    value.file,
    declarationLine(value.node),
    value.node.type?.desugaredQualType ?? value.node.type?.qualType
  ].join('\u0000'), value])).values()];
}

function safeRecordFilter(type) {
  if (!type || type.startsWith('std::')) return null;
  return /^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*$/.test(type) ? type : null;
}

function safeSymbolFilter(name) {
  return /^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*$/.test(name ?? '') ? name : null;
}

function createDeclarationResolver({ compiler, compileArgs, sourceFile, workingDirectory }) {
  const rootsByFilter = new Map();
  const recordsByType = new Map();
  const fieldsByIdentity = new Map();
  const globalsByName = new Map();

  function filteredRoots(filter) {
    if (rootsByFilter.has(filter)) return rootsByFilter.get(filter);
    const astArgs = [...compileArgs, '-Xclang', '-ast-dump=json', '-Xclang',
      `-ast-dump-filter=${filter}`, '-fsyntax-only', sourceFile];
    let roots = [];
    try {
      const output = execFileSync(compiler, astArgs, {
        encoding: 'utf8', cwd: workingDirectory, maxBuffer: 16 * 1024 * 1024
      });
      roots = parseJsonRoots(output);
    } catch {
      // Declaration enrichment is deliberately best-effort.  A failed or
      // over-large auxiliary filter must never make us guess a declaration.
      roots = [];
    }
    rootsByFilter.set(filter, roots);
    return roots;
  }

  function recordInfo(type) {
    if (recordsByType.has(type)) return recordsByType.get(type);
    const filter = safeRecordFilter(type);
    if (!filter) {
      recordsByType.set(type, null);
      return null;
    }
    const simpleName = type.split('::').at(-1);
    const candidates = uniqueDeclarations(filteredRoots(filter)
      .flatMap((root) => collectRecordDefinitions(root, workingDirectory))
      .filter(({ node }) => node.name === simpleName));
    if (candidates.length !== 1) {
      recordsByType.set(type, null);
      return null;
    }
    const [{ node, file }] = candidates;
    const fields = new Map();
    const nonFieldMemberNames = new Set();
    for (const child of node.inner ?? []) {
      if (!child.name) continue;
      if (child.kind !== 'FieldDecl') {
        if (['CXXMethodDecl', 'FunctionTemplateDecl', 'VarDecl', 'UsingDecl',
          'UsingShadowDecl'].includes(child.kind)) nonFieldMemberNames.add(child.name);
        continue;
      }
      const existing = fields.get(child.name) ?? [];
      existing.push({
        name: child.name,
        valueType: normalizeType(clangType(child)),
        declarationFile: resolvedNodeFile(child, file, workingDirectory),
        declarationLine: declarationLine(child)
      });
      fields.set(child.name, existing);
    }
    const bases = (node.bases ?? [])
      .map((base) => normalizeType(clangType(base)))
      .filter(Boolean);
    const info = {
      type,
      definitionFile: file,
      definitionLine: declarationLine(node),
      fields,
      nonFieldMemberNames,
      bases
    };
    recordsByType.set(type, info);
    return info;
  }

  function resolveField(type, memberName, visited = new Set()) {
    const cacheKey = `${type}\u0000${memberName}`;
    if (fieldsByIdentity.has(cacheKey)) return fieldsByIdentity.get(cacheKey);
    if (visited.has(type)) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(type);
    const record = recordInfo(type);
    if (!record) {
      fieldsByIdentity.set(cacheKey, null);
      return null;
    }
    const direct = record.fields.get(memberName) ?? [];
    if (direct.length === 1) {
      const result = {
        declaringType: type,
        definitionFile: record.definitionFile,
        definitionLine: record.definitionLine,
        ...direct[0]
      };
      fieldsByIdentity.set(cacheKey, result);
      return result;
    }
    if (direct.length > 1) {
      fieldsByIdentity.set(cacheKey, null);
      return null;
    }
    if (record.nonFieldMemberNames.has(memberName)) {
      fieldsByIdentity.set(cacheKey, null);
      return null;
    }
    const inherited = record.bases
      .map((base) => resolveField(base, memberName, nextVisited))
      .filter(Boolean);
    const unique = [...new Map(inherited.map((field) => [[
      field.declaringType,
      field.declarationFile,
      field.declarationLine,
      field.name
    ].join('\u0000'), field])).values()];
    const result = unique.length === 1 ? unique[0] : null;
    fieldsByIdentity.set(cacheKey, result);
    return result;
  }

  function resolveGlobal(qualifiedName, valueType) {
    const cacheKey = `${qualifiedName}\u0000${valueType ?? ''}`;
    if (globalsByName.has(cacheKey)) return globalsByName.get(cacheKey);
    const filter = safeSymbolFilter(qualifiedName);
    if (!filter) {
      globalsByName.set(cacheKey, null);
      return null;
    }
    const simpleName = qualifiedName.split('::').at(-1);
    const candidates = uniqueDeclarations(filteredRoots(filter)
      .flatMap((root) => collectVariableDeclarations(root, workingDirectory))
      .filter(({ node }) => node.name === simpleName)
      .filter(({ node }) => !valueType || normalizeType(clangType(node)) === valueType));
    const definitions = candidates.filter(({ node }) => node.storageClass !== 'extern' || node.init);
    const selected = definitions.length === 1
      ? definitions[0]
      : definitions.length === 0 && candidates.length === 1 ? candidates[0] : null;
    if (!selected) {
      globalsByName.set(cacheKey, null);
      return null;
    }
    const isDefinition = selected.node.storageClass !== 'extern' || Boolean(selected.node.init);
    const result = {
      declarationFile: selected.file,
      declarationLine: declarationLine(selected.node),
      definitionFile: isDefinition ? selected.file : null,
      definitionLine: isDefinition ? declarationLine(selected.node) : null,
      storageClass: selected.node.storageClass ?? null,
      internalLinkage: selected.node.storageClass === 'static' ? true : null
    };
    globalsByName.set(cacheKey, result);
    return result;
  }

  return { resolveField, resolveGlobal };
}

function exactFunctions(node, functionName, sourceFile, values = []) {
  if (!node || typeof node !== 'object') return values;
  if (node.kind === 'FunctionDecl' && node.name === functionName) {
    const file = nodeFile(node);
    if (!file || samePath(file, sourceFile)) values.push(node);
  }
  for (const child of node.inner ?? []) exactFunctions(child, functionName, sourceFile, values);
  return values;
}

function maskCommentsAndLiterals(source) {
  let result = '';
  let state = 'code';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line_comment') {
      if (character === '\n') {
        state = 'code';
        result += '\n';
      } else result += ' ';
      continue;
    }
    if (state === 'block_comment') {
      if (character === '*' && next === '/') {
        result += '  ';
        index += 1;
        state = 'code';
      } else result += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'string' || state === 'character') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if ((state === 'string' && character === '"') || (state === 'character' && character === "'")) state = 'code';
      result += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (character === '/' && next === '/') {
      result += '  ';
      index += 1;
      state = 'line_comment';
    } else if (character === '/' && next === '*') {
      result += '  ';
      index += 1;
      state = 'block_comment';
    } else if (character === '"') {
      result += ' ';
      state = 'string';
    } else if (character === "'") {
      result += ' ';
      state = 'character';
    } else {
      result += character;
    }
  }
  return result;
}

function discoverFunctionNames(source) {
  const code = maskCommentsAndLiterals(source);
  const names = [];
  const definition = /^[\t ]*(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?|[<>&*:,\[\]])(?:[\w\s:<>&*,\[\]~]*?\s+)([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept(?:\s*\([^)]*\))?\s*)?(?:->\s*[^{}]+)?\{/gm;
  for (const match of code.matchAll(definition)) names.push(match[1]);
  return [...new Set(names)];
}

function uniqueFunctionNames(functionName, functionNames, source) {
  const requested = Array.isArray(functionNames) && functionNames.length > 0
    ? functionNames
    : functionName ? [functionName] : discoverFunctionNames(source);
  return [...new Set(requested.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))];
}

function fieldKey(field) {
  const start = field.range?.start;
  const end = field.range?.end;
  return [field.symbolKind, field.functionName, field.qualifiedName, field.expression,
    start?.line, start?.column, end?.line, end?.column].join('\u0000');
}

async function indexFileLegacy({ compileCommandsPath, filePath, functionName, functionNames }) {
  const database = JSON.parse(await readFile(compileCommandsPath, 'utf8'));
  const absoluteFile = resolve(filePath);
  const entry = database.find((candidate) => samePath(resolve(candidate.directory, candidate.file), absoluteFile));
  if (!entry) throw new Error(`compile_commands.json 中没有文件：${absoluteFile}`);
  if (!entry.command) throw new Error('当前仅支持 command 形式的编译数据库条目');

  const source = await readFile(absoluteFile, 'utf8');
  const selectedFunctionNames = uniqueFunctionNames(functionName, functionNames, source);
  const [compiler, ...unexpandedArgs] = tokenizeCommand(entry.command);
  const expandedArgs = await expandResponseFiles(unexpandedArgs, entry.directory);
  const compileArgs = removeBuildOnlyArgs(expandedArgs, absoluteFile);
  const fields = [];

  for (const selectedFunctionName of selectedFunctionNames) {
    const astArgs = [...compileArgs, '-Xclang', '-ast-dump=json', '-Xclang',
      `-ast-dump-filter=${selectedFunctionName}`, '-fsyntax-only', absoluteFile];
    let output;
    try {
      output = execFileSync(compiler, astArgs, {
        encoding: 'utf8', cwd: entry.directory, maxBuffer: 64 * 1024 * 1024
      });
    } catch (error) {
      throw new Error(`Clang 索引失败：${error.stderr?.toString() || error.message}`);
    }
    const roots = parseJsonRoots(output);
    for (const root of roots) {
      for (const declaration of exactFunctions(root, selectedFunctionName, absoluteFile)) {
        const localDeclarations = collectLocalDeclarations(declaration);
        visitFunction(declaration, source, selectedFunctionName, localDeclarations, fields);
      }
    }
  }

  const declarationResolver = createDeclarationResolver({
    compiler,
    compileArgs,
    sourceFile: absoluteFile,
    workingDirectory: entry.directory
  });
  for (const field of fields) {
    if (field.symbolKind === 'struct_field' && field.ownerType && field.memberName) {
      const declaration = declarationResolver.resolveField(field.ownerType, field.memberName);
      if (!declaration) continue;
      field.accessOwnerType = field.ownerType;
      field.ownerType = declaration.declaringType;
      field.declaringType = declaration.declaringType;
      field.qualifiedName = `${declaration.declaringType}::${field.memberName}`;
      field.qualifiedNameSource = 'field_declaration';
      field.declarationFile = declaration.declarationFile;
      field.declarationLine = declaration.declarationLine;
      field.definitionFile = declaration.definitionFile;
      field.definitionLine = declaration.definitionLine;
    } else if (field.symbolKind === 'global' && field.qualifiedName) {
      const declaration = declarationResolver.resolveGlobal(field.qualifiedName, field.valueType);
      if (!declaration) continue;
      Object.assign(field, declaration);
    }
  }

  const uniqueFields = [...new Map(fields.map((field) => [fieldKey(field), field])).values()];
  return {
    analyzer: 'clang-ast-json',
    filePath: absoluteFile,
    functionName: functionName ?? (selectedFunctionNames.length === 1 ? selectedFunctionNames[0] : null),
    functionNames: selectedFunctionNames,
    fields: uniqueFields
  };
}

export function createClangIndexService(options = {}) {
  return new ClangdIndexService({ fallback: indexFileLegacy, ...options });
}

const defaultIndexService = createClangIndexService();
let defaultIndexServiceUsers = 0;

export async function indexFile(options) {
  defaultIndexServiceUsers += 1;
  try {
    return await defaultIndexService.indexFile(options);
  } finally {
    defaultIndexServiceUsers -= 1;
    if (defaultIndexServiceUsers === 0) await defaultIndexService.dispose();
  }
}
