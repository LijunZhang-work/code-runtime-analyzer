import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { constants as osConstants, setPriority } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FUNCTION_SYMBOL_KINDS = new Set([6, 9, 12, 25]);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function abortError() {
  const error = new Error('代码索引已取消');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export class ClangdUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'ClangdUnavailableError';
  }
}

function comparablePath(value) {
  const absolute = resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tokenizeCommand(command) {
  return (String(command).match(/(?:[^\s"]+|"[^"]*")+/g) ?? [])
    .map((token) => token.replace(/"([^"]*)"/g, '$1'));
}

function commandArguments(entry) {
  if (Array.isArray(entry.arguments) && entry.arguments.every((argument) => typeof argument === 'string')) {
    return [...entry.arguments];
  }
  return typeof entry.command === 'string' ? tokenizeCommand(entry.command) : [];
}

function entryIdentity(entry) {
  return JSON.stringify({
    directory: comparablePath(entry.directory),
    invocation: Array.isArray(entry.arguments) ? entry.arguments : entry.command
  });
}

function compileContextError(message, details) {
  const error = new Error(message);
  error.details = details;
  return error;
}

function normalizedHints(targetHints) {
  if (!targetHints || typeof targetHints !== 'object') return null;
  const members = [...new Set((Array.isArray(targetHints.members) ? targetHints.members : [])
    .filter((value) => typeof value === 'string' && /^[A-Za-z_]\w*$/.test(value)))].sort();
  const globals = [...new Set((Array.isArray(targetHints.globals) ? targetHints.globals : [])
    .filter((value) => typeof value === 'string' && /^[A-Za-z_]\w*$/.test(value)))].sort();
  return { members, globals };
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

function firstTypeFromArcana(arcana) {
  const prefix = String(arcana ?? '').split(/\s+(?:lvalue|xvalue|prvalue|rvalue)\b/, 1)[0];
  const matches = [...prefix.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  return normalizeType(matches.at(-1));
}

function lastQuotedType(arcana) {
  const matches = [...String(arcana ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]);
  return matches.at(-1) ?? null;
}

function referencedDeclaration(arcana) {
  const match = /\b(ParmVar|Var|Field|CXXMethod|Function)(?:Decl)?\s+(0x[0-9a-f]+)\b/i.exec(String(arcana ?? ''));
  return match ? { kind: match[1], id: match[2].toLowerCase() } : null;
}

function declarationId(node) {
  return /\b(?:ParmVarDecl|VarDecl|FieldDecl)\s+(0x[0-9a-f]+)\b/i.exec(String(node?.arcana ?? ''))?.[1]?.toLowerCase() ?? null;
}

function memberDeclarationId(node) {
  const escaped = String(node?.detail ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.${escaped}\\s+(0x[0-9a-f]+)\\b`, 'i').exec(String(node?.arcana ?? ''))?.[1]?.toLowerCase() ?? null;
}

function symbolRange(symbol) {
  return symbol?.range ?? symbol?.location?.range ?? null;
}

function symbolUri(symbol) {
  return symbol?.location?.uri ?? null;
}

function functionIdentity(symbol) {
  const rawName = String(symbol?.name ?? '').replace(/\(.*$/, '');
  const name = rawName.split('::').at(-1) ?? rawName;
  const container = String(symbol?.containerName ?? '').replace(/::$/, '');
  return { name, qualifiedName: container ? `${container}::${rawName}` : rawName };
}

function selectedFunctionSymbols(symbols, requestedNames, sourceUri) {
  const requested = Array.isArray(requestedNames) && requestedNames.length > 0
    ? new Set(requestedNames.map((name) => String(name).trim()).filter(Boolean))
    : null;
  return (Array.isArray(symbols) ? symbols : [])
    .filter((symbol) => FUNCTION_SYMBOL_KINDS.has(symbol.kind))
    .filter((symbol) => !symbolUri(symbol) || symbolUri(symbol) === sourceUri)
    .filter((symbol) => symbolRange(symbol))
    .filter((symbol) => {
      if (!requested) return true;
      const identity = functionIdentity(symbol);
      return requested.has(identity.name) || requested.has(identity.qualifiedName);
    })
    .sort((left, right) => {
      const leftRange = symbolRange(left);
      const rightRange = symbolRange(right);
      return leftRange.start.line - rightRange.start.line
        || leftRange.start.character - rightRange.start.character;
    });
}

function lineStartsOf(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function sourceOffset(lineStarts, position, sourceLength) {
  const start = lineStarts[position.line];
  if (start === undefined) return sourceLength;
  return Math.min(sourceLength, start + position.character);
}

function expressionFromRange(source, lineStarts, range) {
  if (!range?.start || !range?.end) return null;
  const begin = sourceOffset(lineStarts, range.start, source.length);
  const end = sourceOffset(lineStarts, range.end, source.length);
  return source.slice(begin, end);
}

function externalRange(range) {
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 }
  };
}

function identifierPosition(node) {
  if (!node?.range?.end) return null;
  const { line, character } = node.range.end;
  if (character <= 0) return null;
  return { line, character: character - 1 };
}

function filePathFromUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function semanticLocation(symbol, kind) {
  const value = kind === 'definition'
    ? symbol?.definitionRange ?? symbol?.declarationRange
    : symbol?.declarationRange ?? symbol?.definitionRange;
  if (!value?.uri || !value?.range) return { file: null, line: null };
  return { file: filePathFromUri(value.uri), line: value.range.start.line + 1 };
}

function traverse(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const child of node.children ?? []) traverse(child, visitor);
}

function rootVariable(base, localIds) {
  const references = [];
  let hasThis = false;
  traverse(base, (node) => {
    if (node.kind === 'CXXThis') hasThis = true;
    if (node.kind !== 'DeclRef') return;
    const declaration = referencedDeclaration(node.arcana);
    if (!declaration || !['ParmVar', 'Var', 'Field'].includes(declaration.kind)) return;
    references.push({ node, declaration });
  });
  if (references.length === 0 && hasThis) {
    return {
      variablePath: 'this',
      indexExpression: null,
      variableDeclarationKind: 'CXXThisExpr',
      variableDeclarationType: null,
      rootStorageKind: 'this'
    };
  }
  const root = references[0];
  if (!root) return {
    variablePath: null,
    indexExpression: null,
    variableDeclarationKind: null,
    variableDeclarationType: null,
    rootStorageKind: null
  };
  const index = references.find((reference) => reference.node.detail !== root.node.detail);
  const kind = root.declaration.kind === 'ParmVar'
    ? 'ParmVarDecl' : root.declaration.kind === 'Field' ? 'FieldDecl' : 'VarDecl';
  const storage = root.declaration.kind === 'ParmVar'
    ? 'parameter' : root.declaration.kind === 'Field' ? 'member'
      : localIds.has(root.declaration.id) ? 'local' : 'global';
  return {
    variablePath: root.node.detail ?? null,
    indexExpression: index?.node?.detail ?? null,
    variableDeclarationKind: kind,
    variableDeclarationType: lastQuotedType(root.node.arcana),
    rootStorageKind: storage
  };
}

function fieldKey(field) {
  const start = field.range?.start;
  const end = field.range?.end;
  return [field.symbolKind, field.functionName, field.qualifiedName, field.expression,
    start?.line, start?.column, end?.line, end?.column].join('\u0000');
}

function storageInfo(source, lineStarts, symbol, definitionFile, activeFile) {
  if (!definitionFile || !samePath(definitionFile, activeFile)) return { storageClass: null, internalLinkage: null };
  const line = (symbol?.definitionRange ?? symbol?.declarationRange)?.range?.start?.line;
  if (!Number.isInteger(line)) return { storageClass: null, internalLinkage: null };
  const start = lineStarts[line] ?? 0;
  const end = lineStarts[line + 1] ?? source.length;
  const declaration = source.slice(start, end);
  if (/\bstatic\b/.test(declaration)) return { storageClass: 'static', internalLinkage: true };
  if (/\bextern\b/.test(declaration)) return { storageClass: 'extern', internalLinkage: null };
  return { storageClass: null, internalLinkage: null };
}

class ClangdSession {
  constructor({ executable, compileCommandsDirectory, maxOpenDocuments = 4, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.executable = executable;
    this.compileCommandsDirectory = compileCommandsDirectory;
    this.maxOpenDocuments = maxOpenDocuments;
    this.requestTimeoutMs = requestTimeoutMs;
    this.documents = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.stderr = '';
    this.started = null;
    this.closed = false;
  }

  async start() {
    if (this.started) return this.started;
    this.started = this.#start();
    return this.started;
  }

  async #start() {
    const args = [
      `--compile-commands-dir=${this.compileCommandsDirectory}`,
      '--background-index=0',
      '--clang-tidy=0',
      '--header-insertion=never',
      '--pch-storage=disk',
      '--limit-results=0',
      '--log=error'
    ];
    try {
      this.child = spawn(this.executable, args, {
        cwd: this.compileCommandsDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      throw new ClangdUnavailableError(`无法启动 clangd：${this.executable}`, error);
    }
    this.child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16_384);
    });
    this.child.once('error', (error) => this.#failAll(new ClangdUnavailableError(`clangd 启动失败：${error.message}`, error)));
    this.child.once('exit', (code, signal) => {
      if (this.closed) return;
      this.#failAll(new Error(`clangd 意外退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）：${this.stderr.trim()}`));
    });
    try {
      setPriority(this.child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Priority lowering is best-effort and is not supported on every host.
    }
    const initialized = await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.compileCommandsDirectory).href,
      capabilities: {},
      initializationOptions: {
        compilationDatabasePath: this.compileCommandsDirectory,
        clangdFileStatus: false
      }
    });
    if (initialized?.capabilities?.astProvider !== true) {
      await this.dispose();
      throw new ClangdUnavailableError(`clangd 不支持 textDocument/ast：${this.executable}`);
    }
    this.notify('initialized', {});
  }

  #onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthText = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!lengthText) {
        this.#failAll(new Error(`clangd 返回了非法 LSP 头：${header}`));
        return;
      }
      const length = Number(lengthText);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      let message;
      try {
        message = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));
      } catch (error) {
        this.#failAll(new Error(`无法解析 clangd 响应：${error.message}`));
        return;
      }
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (message.error) waiter.reject(new Error(`clangd ${waiter.method} 失败：${message.error.message ?? JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const result = message.method === 'workspace/configuration' ? [] : null;
      this.#send({ jsonrpc: '2.0', id: message.id, result });
    }
  }

  #send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('clangd 会话已关闭');
    const json = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs, signal) {
    throwIfAborted(signal);
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const cancel = (error) => {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        try {
          this.notify('$/cancelRequest', { id });
        } catch {
          // The process may already be gone.
        }
        rejectPromise(error);
      };
      const timer = setTimeout(() => {
        cancel(new Error(`clangd ${method} 超过 ${timeoutMs}ms，已取消`));
      }, timeoutMs);
      const onAbort = () => cancel(abortError());
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        cancel(error);
      }
    });
  }

  #failAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  async ensureDocument(filePath, source, contextFingerprint, signal) {
    await this.start();
    throwIfAborted(signal);
    const uri = pathToFileURL(filePath).href;
    const contentHash = sha256(source);
    const current = this.documents.get(uri);
    if (current?.contextFingerprint !== contextFingerprint) {
      this.notify('textDocument/didClose', { textDocument: { uri } });
      this.documents.delete(uri);
    }
    const refreshed = this.documents.get(uri);
    if (!refreshed) {
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: extname(filePath).toLowerCase() === '.c' ? 'c' : 'cpp',
          version: 1,
          text: source
        }
      });
      this.documents.set(uri, { version: 1, contentHash, contextFingerprint, touchedAt: Date.now() });
    } else if (refreshed.contentHash !== contentHash) {
      const version = refreshed.version + 1;
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: source }],
        wantDiagnostics: false
      });
      this.documents.set(uri, { version, contentHash, contextFingerprint, touchedAt: Date.now() });
    } else {
      refreshed.touchedAt = Date.now();
    }
    await this.#evictDocuments(uri);
    return uri;
  }

  async #evictDocuments(activeUri) {
    while (this.documents.size > this.maxOpenDocuments) {
      const candidate = [...this.documents.entries()]
        .filter(([uri]) => uri !== activeUri)
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (!candidate) return;
      this.notify('textDocument/didClose', { textDocument: { uri: candidate[0] } });
      this.documents.delete(candidate[0]);
    }
  }

  closeAllDocuments() {
    for (const uri of this.documents.keys()) {
      try {
        this.notify('textDocument/didClose', { textDocument: { uri } });
      } catch {
        break;
      }
    }
    this.documents.clear();
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.#failAll(new Error('clangd 会话已关闭'));
    if (!this.child) return;
    const child = this.child;
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolvePromise) => child.once('exit', () => resolvePromise()));
    try {
      const id = this.nextId++;
      const json = JSON.stringify({ jsonrpc: '2.0', id, method: 'shutdown', params: null });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
      const exit = JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: {} });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(exit)}\r\n\r\n${exit}`);
    } catch {
      // Fall through to termination.
    }
    child.kill();
    await Promise.race([
      exited,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
    ]);
  }
}

export class ClangdIndexService {
  constructor({
    fallback,
    maxCacheEntries = 64,
    maxCacheBytes = 128 * 1024 * 1024,
    maxSessions = 2,
    maxOpenDocuments = 4,
    maxClangdMemoryBytes = 768 * 1024 * 1024,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  } = {}) {
    this.fallback = fallback;
    this.maxCacheEntries = maxCacheEntries;
    this.maxCacheBytes = maxCacheBytes;
    this.maxSessions = maxSessions;
    this.maxOpenDocuments = maxOpenDocuments;
    this.maxClangdMemoryBytes = maxClangdMemoryBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.compileDatabases = new Map();
    this.cache = new Map();
    this.cacheBytes = 0;
    this.inflight = new Map();
    this.sessions = new Map();
    this.queue = Promise.resolve();
  }

  async indexFile(options) {
    throwIfAborted(options.signal);
    const startedAt = performance.now();
    let context;
    try {
      context = await this.#prepareContext(options);
    } catch (error) {
      throw error;
    }
    throwIfAborted(options.signal);
    const cached = this.cache.get(context.cacheKey);
    if (cached) {
      this.cache.delete(context.cacheKey);
      this.cache.set(context.cacheKey, cached);
      return {
        ...cached.result,
        performance: {
          ...cached.result.performance,
          cacheHit: true,
          clangProcessCount: 0,
          clangdMs: 0,
          totalMs: performance.now() - startedAt
        }
      };
    }
    if (this.inflight.has(context.cacheKey)) return this.inflight.get(context.cacheKey);
    const task = this.#enqueue(async () => {
      throwIfAborted(options.signal);
      try {
        const result = await this.#indexWithClangd(context, options, startedAt);
        this.#remember(context.cacheKey, context.absoluteFile, result);
        return result;
      } catch (error) {
        if (!(error instanceof ClangdUnavailableError) || typeof this.fallback !== 'function') throw error;
        const result = await this.fallback(options);
        return {
          ...result,
          performance: {
            cacheHit: false,
            fallback: true,
            reason: error.message,
            totalMs: performance.now() - startedAt
          }
        };
      }
    });
    this.inflight.set(context.cacheKey, task);
    task.finally(() => this.inflight.delete(context.cacheKey)).catch(() => {});
    return task;
  }

  async #prepareContext(options) {
    const compileCommandsPath = resolve(options.compileCommandsPath);
    const requestedFile = resolve(options.filePath);
    const absoluteFile = await realpath(requestedFile).catch(() => requestedFile);
    const [database, source] = await Promise.all([
      this.#loadCompileDatabase(compileCommandsPath),
      readUtf8(absoluteFile)
    ]);
    const candidates = database.entriesByFile.get(comparablePath(absoluteFile)) ?? [];
    if (candidates.length === 0) {
      throw compileContextError(`compile_commands.json 中没有文件：${absoluteFile}`, {
        code: 'compile_context_missing', filePath: absoluteFile
      });
    }
    const unique = [...new Map(candidates.map((entry) => [entryIdentity(entry), entry])).values()];
    if (unique.length !== 1) {
      throw compileContextError(`文件存在 ${unique.length} 套不同的编译配置，工具拒绝猜测，请先选择产品或构建配置：${absoluteFile}`, {
        code: 'compile_context_ambiguous',
        filePath: absoluteFile,
        candidateCount: unique.length,
        candidates: unique.map((entry) => ({ directory: entry.directory, output: entry.output ?? null }))
      });
    }
    const entry = unique[0];
    const responseFingerprint = await responseFilesFingerprint(entry);
    const clangdExecutable = await findClangdExecutable(entry, options.clangdPath);
    const functionNames = Array.isArray(options.functionNames) && options.functionNames.length > 0
      ? [...new Set(options.functionNames.map((value) => String(value).trim()).filter(Boolean))]
      : options.functionName ? [String(options.functionName).trim()] : [];
    const targetHints = normalizedHints(options.targetHints);
    const contextFingerprint = sha256(JSON.stringify({
      databaseHash: database.hash,
      entry: entryIdentity(entry),
      responseFingerprint,
      clangdExecutable
    }));
    const cacheKey = sha256(JSON.stringify({
      version: 3,
      absoluteFile: comparablePath(absoluteFile),
      sourceHash: sha256(source),
      contextFingerprint,
      functionNames: [...functionNames].sort(),
      targetHints
    }));
    return {
      compileCommandsPath,
      compileCommandsDirectory: dirname(compileCommandsPath),
      databaseHash: database.hash,
      entry,
      source,
      absoluteFile,
      clangdExecutable,
      functionNames,
      targetHints,
      contextFingerprint,
      cacheKey
    };
  }

  async #loadCompileDatabase(filePath) {
    const info = await stat(filePath);
    const statKey = `${info.size}:${info.mtimeMs}`;
    const cached = this.compileDatabases.get(comparablePath(filePath));
    if (cached?.statKey === statKey) return cached;
    const text = await readUtf8(filePath);
    let entries;
    try {
      entries = JSON.parse(text);
    } catch (error) {
      throw new Error(`compile_commands.json 无法解析：${error.message}`);
    }
    if (!Array.isArray(entries)) throw new Error('compile_commands.json 根节点必须是数组');
    const entriesByFile = new Map();
    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== 'object' || typeof rawEntry.file !== 'string') continue;
      const requestedDirectory = resolve(rawEntry.directory ?? dirname(filePath));
      const directory = await realpath(requestedDirectory).catch(() => requestedDirectory);
      const entry = { ...rawEntry, directory };
      const requestedSourcePath = resolve(directory, rawEntry.file);
      const sourcePath = await realpath(requestedSourcePath).catch(() => requestedSourcePath);
      const key = comparablePath(sourcePath);
      const list = entriesByFile.get(key) ?? [];
      list.push(entry);
      entriesByFile.set(key, list);
    }
    const database = { statKey, hash: sha256(text), entriesByFile };
    this.compileDatabases.set(comparablePath(filePath), database);
    return database;
  }

  #enqueue(work) {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => {});
    return result;
  }

  async #indexWithClangd(context, options, startedAt) {
    const signal = options.signal;
    throwIfAborted(signal);
    const session = await this.#sessionFor(context);
    const uri = await session.ensureDocument(context.absoluteFile, context.source, context.contextFingerprint, signal);
    const parseStartedAt = performance.now();
    const symbols = await session.request('textDocument/documentSymbol', { textDocument: { uri } }, undefined, signal);
    const functions = selectedFunctionSymbols(symbols, context.functionNames, uri);
    const localIds = new Set();
    const candidates = [];
    let astNodeCount = 0;
    for (const symbol of functions) {
      throwIfAborted(signal);
      const ast = await session.request('textDocument/ast', {
        textDocument: { uri },
        range: symbolRange(symbol)
      }, undefined, signal);
      if (!ast) continue;
      traverse(ast, (node) => {
        astNodeCount += 1;
        if (node.kind === 'Var' || node.kind === 'ParmVar') {
          const id = declarationId(node);
          if (id) localIds.add(id);
        }
      });
      const identity = functionIdentity(symbol);
      traverse(ast, (node) => {
        if (!node.range || !node.detail) return;
        if (node.kind === 'Member') {
          if (/\<bound member function type\>/.test(String(node.arcana ?? ''))) return;
          if (context.targetHints && !context.targetHints.members.includes(node.detail)) return;
          candidates.push({ kind: 'member', node, functionName: identity.name, functionIdentity: identity.qualifiedName });
          return;
        }
        if (node.kind !== 'DeclRef') return;
        const declaration = referencedDeclaration(node.arcana);
        if (!declaration || declaration.kind !== 'Var' || localIds.has(declaration.id)) return;
        if (context.targetHints && !context.targetHints.globals.includes(node.detail)) return;
        candidates.push({ kind: 'global', node, declaration, functionName: identity.name, functionIdentity: identity.qualifiedName });
      });
    }

    const lineStarts = lineStartsOf(context.source);
    const semanticCache = new Map();
    const fields = [];
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const position = identifierPosition(candidate.node);
      if (!position) continue;
      const declarationKey = candidate.kind === 'member'
        ? memberDeclarationId(candidate.node) ?? `${candidate.node.detail}:${position.line}:${position.character}`
        : candidate.declaration.id;
      let semantic = semanticCache.get(declarationKey);
      if (!semantic) {
        semantic = session.request('textDocument/symbolInfo', {
          textDocument: { uri }, position
        }, undefined, signal).then((values) => (Array.isArray(values) ? values : [])
          .find((value) => value?.name === candidate.node.detail) ?? null);
        semanticCache.set(declarationKey, semantic);
      }
      const symbol = await semantic;
      if (!symbol) continue;
      const expression = expressionFromRange(context.source, lineStarts, candidate.node.range);
      if (expression === null) continue;
      if (candidate.kind === 'member') {
        const ownerType = String(symbol.containerName ?? '').replace(/::$/, '') || null;
        if (!ownerType) continue;
        const declaration = semanticLocation(symbol, 'declaration');
        const definition = semanticLocation(symbol, 'definition');
        const root = rootVariable(candidate.node.children?.[0], localIds);
        fields.push({
          kind: 'clang_semantic_fact',
          symbolKind: 'struct_field',
          functionName: candidate.functionName,
          functionIdentity: candidate.functionIdentity,
          memberName: candidate.node.detail,
          ...root,
          expression,
          range: externalRange(candidate.node.range),
          type: firstTypeFromArcana(candidate.node.arcana),
          ownerType,
          accessOwnerType: normalizeType(firstTypeFromArcana(candidate.node.children?.[0]?.arcana), {
            stripPointer: String(candidate.node.arcana ?? '').includes(`->${candidate.node.detail}`)
          }),
          declaringType: ownerType,
          valueType: firstTypeFromArcana(candidate.node.arcana),
          qualifiedName: `${ownerType}::${candidate.node.detail}`,
          qualifiedNameSource: 'field_declaration',
          declarationFile: declaration.file,
          declarationLine: declaration.line,
          definitionFile: declaration.file ?? definition.file,
          definitionLine: declaration.line ?? definition.line,
          referencedMemberDeclId: memberDeclarationId(candidate.node)
        });
      } else {
        const container = String(symbol.containerName ?? '').replace(/::$/, '');
        const qualifiedName = container ? `${container}::${symbol.name}` : symbol.name;
        const declaration = semanticLocation(symbol, 'declaration');
        const definition = semanticLocation(symbol, 'definition');
        const storage = storageInfo(context.source, lineStarts, symbol, definition.file, context.absoluteFile);
        fields.push({
          kind: 'clang_semantic_fact',
          symbolKind: 'global',
          functionName: candidate.functionName,
          functionIdentity: candidate.functionIdentity,
          name: symbol.name,
          memberName: null,
          variablePath: symbol.name,
          indexExpression: null,
          expression,
          range: externalRange(candidate.node.range),
          type: firstTypeFromArcana(candidate.node.arcana),
          ownerType: null,
          valueType: firstTypeFromArcana(candidate.node.arcana),
          qualifiedName,
          qualifiedNameSource: 'clangd_symbol_info',
          declarationFile: declaration.file,
          declarationLine: declaration.line,
          definitionFile: definition.file,
          definitionLine: definition.line,
          ...storage,
          variableDeclarationKind: 'VarDecl',
          variableDeclarationType: lastQuotedType(candidate.node.arcana),
          rootStorageKind: 'global'
        });
      }
    }
    const uniqueFields = [...new Map(fields.map((field) => [fieldKey(field), field])).values()];
    const functionNames = [...new Set(functions.map((symbol) => functionIdentity(symbol).name))];
    throwIfAborted(signal);
    const memory = await session.request('$/memoryUsage', null, 5_000).catch(() => null);
    const clangdMemoryBytes = Number(memory?._total);
    const memoryLimitExceeded = Number.isFinite(clangdMemoryBytes)
      && clangdMemoryBytes > this.maxClangdMemoryBytes;
    if (memoryLimitExceeded) session.closeAllDocuments();
    return {
      analyzer: 'clangd-ast',
      filePath: context.absoluteFile,
      functionName: options.functionName ?? (functionNames.length === 1 ? functionNames[0] : null),
      functionNames,
      fields: uniqueFields,
      performance: {
        cacheHit: false,
        clangProcessCount: session.wasNew ? 1 : 0,
        parsedFunctionCount: functions.length,
        semanticQueryCount: semanticCache.size,
        astNodeCount,
        clangdMemoryBytes: Number.isFinite(clangdMemoryBytes) ? clangdMemoryBytes : null,
        memoryLimitExceeded,
        clangdMs: performance.now() - parseStartedAt,
        totalMs: performance.now() - startedAt
      }
    };
  }

  async #sessionFor(context) {
    const sessionKey = sha256(JSON.stringify({
      executable: context.clangdExecutable,
      directory: comparablePath(context.compileCommandsDirectory),
      databaseHash: context.databaseHash
    }));
    let wrapper = this.sessions.get(sessionKey);
    if (wrapper) {
      wrapper.touchedAt = Date.now();
      wrapper.session.wasNew = false;
      return wrapper.session;
    }
    const session = new ClangdSession({
      executable: context.clangdExecutable,
      compileCommandsDirectory: context.compileCommandsDirectory,
      maxOpenDocuments: this.maxOpenDocuments,
      requestTimeoutMs: this.requestTimeoutMs
    });
    session.wasNew = true;
    await session.start();
    wrapper = { session, touchedAt: Date.now() };
    this.sessions.set(sessionKey, wrapper);
    while (this.sessions.size > this.maxSessions) {
      const [oldestKey, oldest] = [...this.sessions.entries()]
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      this.sessions.delete(oldestKey);
      await oldest.session.dispose();
    }
    return session;
  }

  #remember(key, filePath, result) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const previous = this.cache.get(key);
    if (previous) this.cacheBytes -= previous.bytes;
    this.cache.delete(key);
    this.cache.set(key, { result, filePath, bytes });
    this.cacheBytes += bytes;
    while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes) {
      const [oldestKey, oldest] = this.cache.entries().next().value;
      this.cache.delete(oldestKey);
      this.cacheBytes -= oldest.bytes;
    }
  }

  invalidate({ filePath } = {}) {
    for (const [key, value] of this.cache) {
      if (!filePath || samePath(filePath, value.filePath)) {
        this.cache.delete(key);
        this.cacheBytes -= value.bytes;
      }
    }
    if (!filePath) {
      for (const { session } of this.sessions.values()) session.closeAllDocuments();
    }
    return { invalidated: true, filePath: filePath ? resolve(filePath) : null };
  }

  async dispose() {
    const sessions = [...this.sessions.values()].map(({ session }) => session.dispose());
    this.sessions.clear();
    this.cache.clear();
    this.cacheBytes = 0;
    await Promise.allSettled(sessions);
  }
}

async function readUtf8(filePath) {
  const bytes = await readFile(filePath);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${filePath} 不是有效的 UTF-8 文件，拒绝使用错误位置显示历史值`);
  }
}

async function responseFilesFingerprint(entry) {
  const seen = new Set();
  const parts = [];
  async function include(args, directory) {
    for (const argument of args) {
      if (!argument.startsWith('@')) continue;
      const filePath = resolve(directory, argument.slice(1));
      const key = comparablePath(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      let contents;
      try {
        contents = await readUtf8(filePath);
      } catch (error) {
        parts.push(`${key}\u0000ERROR:${error.message}`);
        continue;
      }
      parts.push(`${key}\u0000${sha256(contents)}`);
      await include(tokenizeCommand(contents), dirname(filePath));
    }
  }
  await include(commandArguments(entry), entry.directory);
  return sha256(parts.sort().join('\u0000'));
}

async function findClangdExecutable(entry, configuredPath) {
  if (typeof configuredPath === 'string' && configuredPath.trim()) return configuredPath.trim();
  const args = commandArguments(entry);
  let compiler = args[0];
  if (compiler && /^(?:ccache|sccache)(?:\.exe)?$/i.test(basename(compiler))) compiler = args[1];
  const candidates = [];
  if (compiler) {
    const compilerPath = isAbsolute(compiler) ? compiler : resolve(entry.directory, compiler);
    candidates.push(join(dirname(compilerPath), process.platform === 'win32' ? 'clangd.exe' : 'clangd'));
  }
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return process.platform === 'win32' ? 'clangd.exe' : 'clangd';
}
