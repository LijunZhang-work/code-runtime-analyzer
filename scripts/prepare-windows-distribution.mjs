import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distributionRoot = resolve(repositoryRoot, 'build', 'distribution', 'windows');
const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));

async function requirePath(filePath, label) {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`${label}不存在：${filePath}`);
  }
}

await requirePath(resolve(repositoryRoot, 'backend', 'web-dist', 'index.html'), '网页生产构建');

// Windows Defender and editor processes may briefly hold a freshly copied
// dependency file. Retry boundedly so a transient scan does not make release
// packaging fail, while still surfacing a real long-lived lock.
await rm(distributionRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
await mkdir(resolve(distributionRoot, 'runtime'), { recursive: true });
await mkdir(resolve(distributionRoot, 'backend'), { recursive: true });
await mkdir(resolve(distributionRoot, 'docs'), { recursive: true });

await cp(process.execPath, resolve(distributionRoot, 'runtime', 'node.exe'));
for (const directory of ['src', 'dictionaries', 'web-dist']) {
  await cp(resolve(repositoryRoot, 'backend', directory), resolve(distributionRoot, 'backend', directory), { recursive: true });
}
await rm(resolve(distributionRoot, 'backend', 'src', 'mcp-server.mjs'), { force: true });
for (const fileName of ['工具使用指南.md', '字段字典填写说明.md', 'OpenCode-网页工作台.md']) {
  await cp(resolve(repositoryRoot, 'docs', fileName), resolve(distributionRoot, 'docs', fileName));
}
await cp(resolve(repositoryRoot, 'README.md'), resolve(distributionRoot, 'README.md'));
await cp(resolve(repositoryRoot, 'build', 'controller', 'backend-control.exe'), resolve(distributionRoot, 'backend-control.exe'));

await writeFile(resolve(distributionRoot, 'distribution.json'), `${JSON.stringify({
  product: 'code-runtime-analyzer',
  version: rootPackage.version,
  backendEntry: 'backend/src/server.mjs',
  launcherEntry: 'backend/src/launcher.mjs',
  bundledNode: process.version,
  createdAt: new Date().toISOString()
}, null, 2)}\n`, 'utf8');

process.stdout.write(`Prepared Windows distribution ${rootPackage.version} at ${distributionRoot}\n`);
