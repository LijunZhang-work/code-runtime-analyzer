import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const CONFIG_DIRECTORY = '.cpp-csv-diagnostics';
const CONFIG_FILE = 'product-modules.json';
const FORMAT = 'cpp-csv-diagnostics/product-modules';
const MAX_MODULES = 200;
const MAX_FUNCTIONS_PER_MODULE = 400;

/**
 * Product modules are deliberately separate from source folders.  They are a
 * small, repository-relative user configuration: a product capability and
 * the functions that participate in it.  Keeping the file inside the code
 * repository makes the definition portable across computers without making
 * the extension installation directory writable.
 */
export async function listProductModules({ workspaceRoot }) {
  const location = await configLocation(workspaceRoot);
  const document = await readDocument(location, { allowMissing: true });
  return {
    storagePath: location.storagePath,
    modules: document.modules
  };
}

export async function upsertProductModule({ workspaceRoot, module }) {
  const location = await configLocation(workspaceRoot);
  const document = await readDocument(location, { allowMissing: true });
  const normalized = normalizeModule(module);
  const index = document.modules.findIndex((item) => item.id === normalized.id);
  const modules = index === -1
    ? [...document.modules, normalized]
    : document.modules.map((item, itemIndex) => itemIndex === index ? normalized : item);
  if (modules.length > MAX_MODULES) throw new Error(`功能模块数量不能超过 ${MAX_MODULES}`);
  const next = { format: FORMAT, modules };
  await writeDocument(location, next);
  return { storagePath: location.storagePath, module: normalized, modules };
}

export async function deleteProductModule({ workspaceRoot, moduleId }) {
  if (typeof moduleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(moduleId)) {
    throw new Error('moduleId 非法');
  }
  const location = await configLocation(workspaceRoot);
  const document = await readDocument(location, { allowMissing: true });
  const modules = document.modules.filter((module) => module.id !== moduleId);
  if (modules.length === document.modules.length) {
    return { storagePath: location.storagePath, deleted: false, modules };
  }
  await writeDocument(location, { format: FORMAT, modules });
  return { storagePath: location.storagePath, deleted: true, modules };
}

async function configLocation(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new Error('功能模块需要 workspaceRoot');
  }
  const root = resolve(workspaceRoot);
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`workspaceRoot 不存在：${workspaceRoot}`);
  const configDirectory = resolve(root, CONFIG_DIRECTORY);
  const configPath = resolve(configDirectory, CONFIG_FILE);
  if (!isWithin(root, configPath)) throw new Error('功能模块配置路径越出代码仓库');
  return {
    root,
    configDirectory,
    configPath,
    storagePath: `${CONFIG_DIRECTORY}/${CONFIG_FILE}`
  };
}

async function readDocument(location, { allowMissing }) {
  let text;
  try {
    text = await readFile(location.configPath, 'utf8');
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return { format: FORMAT, modules: [] };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`功能模块配置无法读取：${location.storagePath} 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.format !== FORMAT || !Array.isArray(parsed.modules)) {
    throw new Error(`功能模块配置格式不正确：${location.storagePath}`);
  }
  if (parsed.modules.length > MAX_MODULES) throw new Error(`功能模块配置超过 ${MAX_MODULES} 个模块`);
  const modules = parsed.modules.map((module) => normalizeModule(module));
  const ids = new Set(modules.map((module) => module.id));
  if (ids.size !== modules.length) throw new Error('功能模块配置存在重复 id');
  return { format: FORMAT, modules };
}

async function writeDocument(location, document) {
  await mkdir(location.configDirectory, { recursive: true });
  await writeFile(location.configPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

function normalizeModule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模块内容必须是对象');
  const id = typeof input.id === 'string' && input.id !== '' ? input.id : `module-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) throw new Error('模块 id 只能包含字母、数字、下划线和连字符');
  const name = requiredText(input.name, '模块名称', 80);
  const description = optionalText(input.description, '模块说明', 400);
  if (!Array.isArray(input.functions)) throw new Error('模块 functions 必须是数组');
  if (input.functions.length > MAX_FUNCTIONS_PER_MODULE) {
    throw new Error(`一个模块最多关联 ${MAX_FUNCTIONS_PER_MODULE} 个函数`);
  }
  const functions = input.functions.map(normalizeFunction);
  const keys = new Set(functions.map((item) => `${item.functionName}\u0000${item.relativePath ?? ''}`));
  if (keys.size !== functions.length) throw new Error('同一个模块不能重复关联同一函数');
  return {
    id,
    name,
    ...(description ? { description } : {}),
    functions
  };
}

function normalizeFunction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('函数关联必须是对象');
  const functionName = requiredText(input.functionName, '函数名', 240);
  const rawPath = optionalText(input.relativePath, '函数相对路径', 500);
  let relativePath;
  if (rawPath) {
    if (isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath) || rawPath.includes('\\')) {
      throw new Error('函数路径必须是仓库根相对 POSIX 路径');
    }
    const pieces = rawPath.split('/');
    if (pieces.some((piece) => !piece || piece === '.' || piece === '..')) {
      throw new Error('函数路径不能包含空段、. 或 ..');
    }
    relativePath = rawPath;
  }
  const line = input.line === undefined || input.line === null || input.line === ''
    ? undefined
    : Number(input.line);
  if (line !== undefined && (!Number.isInteger(line) || line < 1 || line > 10_000_000)) {
    throw new Error('函数行号必须是正整数');
  }
  return {
    functionName,
    ...(relativePath ? { relativePath } : {}),
    ...(line ? { line } : {})
  };
}

function requiredText(value, label, limit) {
  const text = optionalText(value, label, limit);
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function optionalText(value, label, limit) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
  const text = value.trim();
  if (text.length > limit) throw new Error(`${label}不能超过 ${limit} 个字符`);
  return text;
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
