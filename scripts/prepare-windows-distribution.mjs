import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distributionRoot = resolve(repositoryRoot, 'build', 'distribution', 'windows');
const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
const vsixPath = resolve(process.env.CRA_VSIX_PATH || process.argv[2] || resolve(repositoryRoot, `Code-Runtime-Analyzer-v${rootPackage.version}.vsix`));

async function requirePath(filePath, label) {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`${label}不存在：${filePath}`);
  }
}

await requirePath(vsixPath, 'VS Code 扩展安装包');
await requirePath(resolve(repositoryRoot, 'backend', 'web-dist', 'index.html'), '网页生产构建');
await requirePath(resolve(repositoryRoot, 'backend', 'node_modules', '@modelcontextprotocol', 'sdk'), 'MCP 运行依赖');

await rm(distributionRoot, { recursive: true, force: true });
await mkdir(resolve(distributionRoot, 'runtime'), { recursive: true });
await mkdir(resolve(distributionRoot, 'backend'), { recursive: true });
await mkdir(resolve(distributionRoot, 'extension'), { recursive: true });
await mkdir(resolve(distributionRoot, 'docs'), { recursive: true });

await cp(process.execPath, resolve(distributionRoot, 'runtime', 'node.exe'));
for (const directory of ['src', 'dictionaries', 'web-dist', 'node_modules']) {
  await cp(resolve(repositoryRoot, 'backend', directory), resolve(distributionRoot, 'backend', directory), { recursive: true });
}
for (const fileName of ['package.json', 'package-lock.json']) {
  await cp(resolve(repositoryRoot, 'backend', fileName), resolve(distributionRoot, 'backend', fileName));
}
await cp(vsixPath, resolve(distributionRoot, 'extension', basename(vsixPath)));
for (const fileName of ['工具使用指南.md', '字段字典填写说明.md', 'OpenCode-网页工作台.md']) {
  await cp(resolve(repositoryRoot, 'docs', fileName), resolve(distributionRoot, 'docs', fileName));
}
await cp(resolve(repositoryRoot, 'README.md'), resolve(distributionRoot, 'README.md'));
await cp(resolve(repositoryRoot, 'installer', 'assets', 'launcher.vbs'), resolve(distributionRoot, 'launcher.vbs'));

await writeFile(resolve(distributionRoot, 'distribution.json'), `${JSON.stringify({
  product: 'code-runtime-analyzer',
  version: rootPackage.version,
  vsix: `extension/${basename(vsixPath)}`,
  backendEntry: 'backend/src/server.mjs',
  launcherEntry: 'backend/src/launcher.mjs',
  mcpEntry: 'backend/src/mcp-server.mjs',
  bundledNode: process.version,
  createdAt: new Date().toISOString()
}, null, 2)}\n`, 'utf8');

process.stdout.write(`Prepared Windows distribution ${rootPackage.version} at ${distributionRoot}\n`);
