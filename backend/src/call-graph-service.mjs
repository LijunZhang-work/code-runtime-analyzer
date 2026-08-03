import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const FUNCTION_KINDS = new Set(['FunctionDecl', 'CXXMethodDecl', 'CXXConstructorDecl', 'CXXDestructorDecl']);
const CALL_KINDS = new Set(['CallExpr', 'CXXMemberCallExpr', 'CXXOperatorCallExpr']);
const GRAPH_CACHE_MAX_ENTRIES = 16;
const AST_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
const STDERR_MAX_BYTES = 1024 * 1024;
const graphCache = new Map();

class ClangAstOutputLimitError extends Error {
  constructor({ functionName, actualBytes, limitBytes }) {
    super(`函数 ${functionName} 的 Clang AST 输出超过安全上限（已读取 ${Math.ceil(actualBytes / 1024 / 1024)}MB，上限 ${Math.floor(limitBytes / 1024 / 1024)}MB）`);
    this.name = 'ClangAstOutputLimitError';
    this.functionName = functionName;
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('调用链分析已取消');
  error.name = 'AbortError';
  return error;
}

function runClangAstJson(compiler, args, { cwd, signal, functionName, maxBytes = AST_OUTPUT_MAX_BYTES } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(compiler, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let limitError;
    let cancelledError;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      cancelledError = abortError(signal);
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        limitError ??= new ClangAstOutputLimitError({ functionName, actualBytes: stdoutBytes, limitBytes: maxBytes });
        child.stdout.pause();
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= STDERR_MAX_BYTES) return;
      const remaining = STDERR_MAX_BYTES - stderrBytes;
      const retained = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr.push(retained);
      stderrBytes += retained.length;
    });
    child.once('error', (error) => finish(rejectPromise, error));
    child.once('close', (code, terminationSignal) => {
      if (cancelledError) return finish(rejectPromise, cancelledError);
      if (limitError) return finish(rejectPromise, limitError);
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        return finish(rejectPromise, new Error(errorText || `Clang 退出（code=${code ?? 'null'}，signal=${terminationSignal ?? 'null'}）`));
      }
      return finish(resolvePromise, Buffer.concat(stdout).toString('utf8'));
    });
  });
}

function comparablePath(filePath) {
  const absolute = resolve(filePath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function tokenizeCommand(command) {
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
    expanded.push(...tokenizeCommand(await readFile(resolve(workingDirectory, arg.slice(1)), 'utf8')));
  }
  return expanded;
}

function removeBuildOnlyArgs(args, sourceFile, workingDirectory) {
  const retained = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-c' || samePath(resolve(workingDirectory, arg), sourceFile)) continue;
    if (['-o', '-MF', '-MT', '-MQ'].includes(arg)) {
      index += 1;
      continue;
    }
    if (['-MD', '-MMD', '-MP'].includes(arg)) continue;
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
    for (; cursor < output.length; cursor += 1) {
      const character = output[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          roots.push(JSON.parse(output.slice(start, cursor)));
          break;
        }
      }
    }
  }
  return roots;
}

function nodeFile(node) {
  return node?.loc?.file ?? node?.range?.begin?.file ?? null;
}

function resolvedNodeFile(node, inheritedFile, workingDirectory) {
  const value = nodeFile(node) ?? inheritedFile ?? null;
  return value ? resolve(workingDirectory, value) : null;
}

function locationOf(node) {
  const location = node?.loc ?? node?.range?.begin ?? {};
  return {
    line: Number.isInteger(location.line) ? location.line : null,
    column: Number.isInteger(location.col) ? location.col : null
  };
}

function functionHasBody(node) {
  return (node?.inner ?? []).some((child) => child?.kind === 'CompoundStmt');
}

function functionSignature(node) {
  const type = node?.type?.qualType ?? '';
  return `${node.name ?? '匿名函数'}${type.startsWith('(') ? type : type ? ` ${type}` : ''}`.trim();
}

function functionNodeId(node, filePath) {
  const location = locationOf(node);
  return node.id ?? `${filePath}:${node.name ?? 'anonymous'}:${location.line ?? 0}:${location.column ?? 0}`;
}

function maskCommentsAndLiterals(source) {
  let result = '';
  let state = 'code';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line_comment') {
      if (character === '\n') { state = 'code'; result += '\n'; } else result += ' ';
      continue;
    }
    if (state === 'block_comment') {
      if (character === '*' && next === '/') { result += '  '; index += 1; state = 'code'; }
      else result += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'string' || state === 'character') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if ((state === 'string' && character === '"') || (state === 'character' && character === "'")) state = 'code';
      result += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (character === '/' && next === '/') { result += '  '; index += 1; state = 'line_comment'; }
    else if (character === '/' && next === '*') { result += '  '; index += 1; state = 'block_comment'; }
    else if (character === '"') { result += ' '; state = 'string'; }
    else if (character === "'") { result += ' '; state = 'character'; }
    else result += character;
  }
  return result;
}

function discoverFunctionCandidates(source) {
  const code = maskCommentsAndLiterals(source);
  const candidates = [];
  const definition = /^[\t ]*(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?|[<>&*:,\[\]])(?:[\w\s:<>&*,\[\]~]*?\s+)([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept(?:\s*\([^)]*\))?\s*)?(?:->\s*[^{}]+)?\{/gm;
  for (const match of code.matchAll(definition)) {
    const line = code.slice(0, match.index ?? 0).split('\n').length;
    candidates.push({ name: match[1], line });
  }
  return candidates;
}

function chooseFocusedFunction(candidates, focusLine) {
  const line = Number(focusLine);
  if (Number.isInteger(line) && line > 0) {
    const prior = candidates.filter((candidate) => candidate.line <= line).at(-1);
    if (prior) return prior.name;
  }
  return candidates.find((candidate) => candidate.name === 'main')?.name ?? candidates[0]?.name;
}

function collectFunctions(node, sourceFile, workingDirectory, inheritedFile = null, values = []) {
  if (!node || typeof node !== 'object') return values;
  const filePath = resolvedNodeFile(node, inheritedFile, workingDirectory);
  if (FUNCTION_KINDS.has(node.kind) && functionHasBody(node) && filePath && samePath(filePath, sourceFile)) {
    values.push({ node, filePath });
    return values;
  }
  for (const child of node.inner ?? []) collectFunctions(child, sourceFile, workingDirectory, filePath, values);
  return values;
}

function firstReferencedDeclaration(node) {
  if (!node || typeof node !== 'object') return null;
  const referenced = node.referencedDecl;
  if (referenced && FUNCTION_KINDS.has(referenced.kind)) return referenced;
  if (node.kind === 'MemberExpr' && node.referencedMemberDecl) {
    return { id: node.referencedMemberDecl, name: node.name ?? '成员函数', kind: 'CXXMethodDecl' };
  }
  for (const child of node.inner ?? []) {
    const found = firstReferencedDeclaration(child);
    if (found) return found;
  }
  return null;
}

function collectCalls(node, caller, values = []) {
  if (!node || typeof node !== 'object') return values;
  if (FUNCTION_KINDS.has(node.kind) && node !== caller) return values;
  if (CALL_KINDS.has(node.kind)) {
    const callee = firstReferencedDeclaration(node.inner?.[0]);
    if (callee) values.push({ caller, callee, location: locationOf(node) });
  }
  for (const child of node.inner ?? []) collectCalls(child, caller, values);
  return values;
}

async function compilationForFile({ compileCommandsPath, filePath }) {
  const databasePath = resolve(compileCommandsPath);
  const sourceFile = resolve(filePath);
  const database = JSON.parse(await readFile(databasePath, 'utf8'));
  if (!Array.isArray(database)) throw new Error('compile_commands.json 根节点必须是数组');
  const candidates = database
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.file === 'string')
    .map((entry) => ({ entry, directory: resolve(entry.directory ?? dirname(databasePath)) }))
    .filter(({ entry, directory }) => samePath(resolve(directory, entry.file), sourceFile));
  if (candidates.length === 0) throw new Error(`compile_commands.json 中没有文件：${sourceFile}`);

  const prepared = [];
  for (const candidate of candidates) {
    const raw = Array.isArray(candidate.entry.arguments)
      ? candidate.entry.arguments.map(String)
      : typeof candidate.entry.command === 'string' ? tokenizeCommand(candidate.entry.command) : [];
    if (raw.length === 0) throw new Error('编译数据库条目缺少 command 或 arguments');
    const [compiler, ...args] = raw;
    const expanded = await expandResponseFiles(args, candidate.directory);
    prepared.push({ compiler, args: removeBuildOnlyArgs(expanded, sourceFile, candidate.directory), directory: candidate.directory });
  }
  const distinct = [...new Map(prepared.map((item) => [JSON.stringify([item.compiler, item.args, item.directory]), item])).values()];
  if (distinct.length !== 1) {
    throw new Error(`文件存在 ${distinct.length} 套不同编译上下文，调用链分析已停止；请先选择唯一的 compile_commands.json。`);
  }
  return { ...distinct[0], sourceFile };
}

function copyGraph(value) {
  return JSON.parse(JSON.stringify(value));
}

function graphCacheKey({ context, source, workspaceRoot, functionNames, focusLine, includeExternal, maxNodes, maxEdges }) {
  const payload = JSON.stringify({
    compiler: context.compiler,
    args: context.args,
    sourceFile: context.sourceFile,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    workspaceRoot: workspaceRoot ? resolve(workspaceRoot) : null,
    functionNames: Array.isArray(functionNames) ? [...functionNames].sort() : null,
    focusLine: Number(focusLine) || null,
    includeExternal: Boolean(includeExternal),
    maxNodes,
    maxEdges
  });
  return createHash('sha256').update(payload).digest('hex');
}

function rememberGraph(key, sourceFile, graph) {
  graphCache.delete(key);
  graphCache.set(key, { sourceFile, graph: copyGraph(graph) });
  while (graphCache.size > GRAPH_CACHE_MAX_ENTRIES) graphCache.delete(graphCache.keys().next().value);
}

/** Removes only disposable code-graph cache entries; it never changes a dictionary or CSV session. */
export function invalidateCallGraph({ filePath } = {}) {
  if (!filePath) {
    const cleared = graphCache.size;
    graphCache.clear();
    return { cleared };
  }
  const absoluteFile = resolve(filePath);
  let cleared = 0;
  for (const [key, entry] of graphCache) {
    if (!samePath(entry.sourceFile, absoluteFile)) continue;
    graphCache.delete(key);
    cleared += 1;
  }
  return { cleared };
}

/**
 * Builds a bounded, direct call graph for one translation unit using Clang's
 * actual AST. It intentionally does not claim to resolve virtual dispatch,
 * function pointers or callbacks.
 */
export async function buildCallGraph({ compileCommandsPath, filePath, workspaceRoot, functionNames, focusLine, includeExternal = false, maxNodes = 140, maxEdges = 260, signal } = {}, { runAstJson = runClangAstJson } = {}) {
  if (!compileCommandsPath || !filePath) throw new Error('调用链查询需要 compileCommandsPath 和 filePath');
  const startedAt = performance.now();
  const context = await compilationForFile({ compileCommandsPath, filePath });
  const source = await readFile(context.sourceFile, 'utf8');
  const nodeLimit = Math.max(1, Math.min(400, Math.floor(Number(maxNodes) || 140)));
  const edgeLimit = Math.max(1, Math.min(800, Math.floor(Number(maxEdges) || 260)));
  const cacheKey = graphCacheKey({ context, source, workspaceRoot, functionNames, focusLine, includeExternal, maxNodes: nodeLimit, maxEdges: edgeLimit });
  const cached = graphCache.get(cacheKey);
  if (cached) {
    const graph = copyGraph(cached.graph);
    graph.performance = { ...graph.performance, cacheHit: true, totalMs: performance.now() - startedAt };
    return graph;
  }
  const candidates = discoverFunctionCandidates(source);
  const knownFunctionNames = new Set(candidates.map((candidate) => candidate.name));
  const requestedNames = Array.isArray(functionNames) && functionNames.length > 0
    ? [...new Set(functionNames.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))]
    : [chooseFocusedFunction(candidates, focusLine)].filter(Boolean);
  if (requestedNames.length === 0) throw new Error('当前文件未发现可分析的函数定义');

  // A whole translation-unit AST can be hundreds of megabytes. Start at the
  // focused function and expand only reachable functions in this source file.
  // This preserves exact Clang AST evidence while avoiding work on unrelated
  // functions whenever a user simply opens a web graph for one code location.
  const functionLimit = Math.min(48, Math.max(1, nodeLimit));
  const pendingNames = [...requestedNames];
  const queuedNames = new Set(pendingNames);
  const analyzedNames = new Set();
  const functionsById = new Map();
  const oversizedFunctionNames = new Set();
  let clangInvocationCount = 0;
  let analysisTruncated = false;
  while (pendingNames.length > 0) {
    if (analyzedNames.size >= functionLimit) {
      analysisTruncated = true;
      break;
    }
    const name = pendingNames.shift();
    if (!name || analyzedNames.has(name)) continue;
    analyzedNames.add(name);
    const astArgs = [...context.args, '-Xclang', '-ast-dump=json', '-Xclang', `-ast-dump-filter=${name}`, '-fsyntax-only', context.sourceFile];
    clangInvocationCount += 1;
    try {
      const stdout = await runAstJson(context.compiler, astArgs, {
        cwd: context.directory,
        signal,
        functionName: name,
        maxBytes: AST_OUTPUT_MAX_BYTES
      });
      const roots = parseJsonRoots(stdout);
      const functions = roots
        .flatMap((root) => collectFunctions(root, context.sourceFile, context.directory))
        .filter(({ node }) => node.name === name);
      for (const item of functions) {
        const id = functionNodeId(item.node, item.filePath);
        if (!functionsById.has(id)) functionsById.set(id, item);
        for (const call of collectCalls(item.node, item.node)) {
          const calleeName = call.callee.name;
          if (!calleeName || !knownFunctionNames.has(calleeName) || queuedNames.has(calleeName)) continue;
          queuedNames.add(calleeName);
          pendingNames.push(calleeName);
        }
      }
    } catch (error) {
      if (error instanceof ClangAstOutputLimitError || error?.name === 'ClangAstOutputLimitError') {
        oversizedFunctionNames.add(name);
        analysisTruncated = true;
        continue;
      }
      const details = error?.stderr ? String(error.stderr).trim() : error?.message;
      throw new Error(`Clang 调用链分析失败：${details || '未知错误'}`);
    }
  }
  if (pendingNames.length > 0) analysisTruncated = true;
  const functions = [...functionsById.values()];
  const internalById = new Map(functions.map(({ node, filePath: nodeFilePath }) => [node.id, {
    id: functionNodeId(node, nodeFilePath),
    declarationId: node.id,
    label: node.name ?? '匿名函数',
    signature: functionSignature(node),
    filePath: nodeFilePath,
    relativePath: workspaceRoot ? relative(resolve(workspaceRoot), nodeFilePath).replace(/\\/g, '/') : nodeFilePath,
    ...locationOf(node),
    kind: 'definition'
  }]));
  const nodesById = new Map([...internalById.values()].map((node) => [node.id, node]));
  for (const functionName of oversizedFunctionNames) {
    const matchingCandidates = candidates.filter((candidate) => candidate.name === functionName);
    for (const candidate of matchingCandidates) {
      const id = `oversized:${context.sourceFile}:${functionName}:${candidate.line}`;
      nodesById.set(id, {
        id,
        declarationId: null,
        label: functionName,
        signature: `${functionName}（函数体过大，内部调用未展开）`,
        filePath: context.sourceFile,
        relativePath: workspaceRoot ? relative(resolve(workspaceRoot), context.sourceFile).replace(/\\/g, '/') : context.sourceFile,
        line: candidate.line,
        column: 1,
        kind: 'definition',
        analysisState: 'ast_output_limited'
      });
    }
  }
  const internalByName = new Map();
  for (const item of nodesById.values()) {
    if (item.kind !== 'definition') continue;
    const values = internalByName.get(item.label) ?? [];
    values.push(item);
    internalByName.set(item.label, values);
  }
  const calls = functions.flatMap(({ node }) => collectCalls(node, node));
  const edgesById = new Map();
  let omittedExternalCallCount = 0;
  for (const call of calls) {
    const source = internalById.get(call.caller.id);
    if (!source) continue;
    let target = internalById.get(call.callee.id);
    // A call often references a forward declaration whose Clang AST id differs
    // from the later definition. Reconcile only when the source file has one
    // unambiguous function with that name; overloads remain external rather
    // than being silently guessed.
    if (!target) {
      const sameNamedDefinitions = internalByName.get(call.callee.name) ?? [];
      if (sameNamedDefinitions.length === 1) target = sameNamedDefinitions[0];
    }
    if (!target) {
      if (!includeExternal) {
        omittedExternalCallCount += 1;
        continue;
      }
      const externalId = `external:${call.callee.id ?? call.callee.name}`;
      target = nodesById.get(externalId);
      if (!target) {
        target = {
          id: externalId,
          declarationId: call.callee.id ?? null,
          label: call.callee.name ?? '未解析调用',
          signature: call.callee.type?.qualType ?? call.callee.name ?? '未解析调用',
          filePath: null,
          relativePath: null,
          line: null,
          column: null,
          kind: 'external'
        };
        nodesById.set(externalId, target);
      }
    }
    const edgeId = `${source.id}->${target.id}`;
    const prior = edgesById.get(edgeId);
    if (prior) prior.callSites.push(call.location);
    else edgesById.set(edgeId, { id: edgeId, source: source.id, target: target.id, callSites: [call.location], kind: 'direct' });
  }
  // Prefer the file's own functions.  In a large translation unit, library
  // calls can vastly outnumber local edges.  Returning an edge whose endpoint
  // was trimmed would make the diagram misleading, so choose nodes and edges
  // together rather than slicing the two arrays independently.
  const internalNodes = [...nodesById.values()]
    .filter((node) => node.kind === 'definition')
    .sort((left, right) => (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
      || left.label.localeCompare(right.label, 'zh-CN'));
  const allEdges = [...edgesById.values()].sort((left, right) => {
    const leftInternal = nodesById.get(left.target)?.kind === 'definition' ? 0 : 1;
    const rightInternal = nodesById.get(right.target)?.kind === 'definition' ? 0 : 1;
    return leftInternal - rightInternal || left.id.localeCompare(right.id, 'zh-CN');
  });
  const includedNodeIds = new Set(internalNodes.slice(0, nodeLimit).map((node) => node.id));
  const outputEdges = [];
  for (const edge of allEdges) {
    if (outputEdges.length >= edgeLimit || !includedNodeIds.has(edge.source)) continue;
    const target = nodesById.get(edge.target);
    if (!target) continue;
    if (!includedNodeIds.has(target.id)) {
      if (target.kind === 'definition' || includedNodeIds.size >= nodeLimit) continue;
      includedNodeIds.add(target.id);
    }
    outputEdges.push(edge);
  }
  const outputNodes = [...includedNodeIds]
    .map((id) => nodesById.get(id))
    .filter(Boolean)
    .sort((left, right) => (left.kind === 'definition' ? 0 : 1) - (right.kind === 'definition' ? 0 : 1)
      || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
      || left.label.localeCompare(right.label, 'zh-CN'));
  // The web workbench must begin at the function selected from the editor,
  // rather than at whichever function happens to sort first by source line.
  // `requestedNames` is the exact focused candidate when no explicit list was
  // supplied by a caller; if a configured list has multiple names, the first
  // one remains the caller's deterministic primary target.
  const focusedNode = outputNodes.find((node) => node.kind === 'definition' && node.label === requestedNames[0]);
  const graph = {
    analyzer: 'clang-ast-json',
    filePath: context.sourceFile,
    relativePath: workspaceRoot ? relative(resolve(workspaceRoot), context.sourceFile).replace(/\\/g, '/') : context.sourceFile,
    focusNodeId: focusedNode?.id ?? outputNodes.find((node) => node.kind === 'definition')?.id ?? null,
    nodes: outputNodes,
    edges: outputEdges,
    truncated: analysisTruncated || outputNodes.length < nodesById.size || outputEdges.length < allEdges.length,
    omittedExternalCallCount,
    limitations: [
      '从当前焦点函数起，只展开当前文件中可确认的直接调用。',
      '虚函数分派、函数指针、回调和跨线程调用不会被当作确定调用关系。',
      ...(oversizedFunctionNames.size > 0
        ? [`有 ${oversizedFunctionNames.size} 个复杂函数的 AST 输出超过 ${AST_OUTPUT_MAX_BYTES / 1024 / 1024}MB 安全上限；已保留函数节点，但停止展开其内部调用。`]
        : [])
    ],
    oversizedFunctionCount: oversizedFunctionNames.size,
    oversizedFunctions: [...oversizedFunctionNames],
    performance: {
      cacheHit: false,
      clangInvocationCount,
      analyzedFunctionCount: functions.length,
      astOutputLimitBytes: AST_OUTPUT_MAX_BYTES,
      totalMs: performance.now() - startedAt
    }
  };
  rememberGraph(cacheKey, context.sourceFile, graph);
  return graph;
}
