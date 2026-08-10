import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = resolve(repositoryRoot, 'build', 'mcp-package');
const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
const backendPackage = JSON.parse(await readFile(resolve(repositoryRoot, 'backend', 'package.json'), 'utf8'));
const backendLock = JSON.parse(await readFile(resolve(repositoryRoot, 'backend', 'package-lock.json'), 'utf8'));

await rm(stagingRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
await mkdir(resolve(stagingRoot, 'src'), { recursive: true });
await cp(resolve(repositoryRoot, 'backend', 'src', 'mcp-server.mjs'), resolve(stagingRoot, 'src', 'mcp-server.mjs'));
await cp(resolve(repositoryRoot, 'backend', 'src', 'runtime-info.mjs'), resolve(stagingRoot, 'src', 'runtime-info.mjs'));
await cp(resolve(repositoryRoot, 'docs', 'MCP手动安装.md'), resolve(stagingRoot, 'README.md'));

const mcpPackage = {
  name: 'code-runtime-analyzer-mcp',
  version: rootPackage.version,
  description: 'OpenCode/AI connector for a separately installed Code Runtime Analyzer backend',
  type: 'module',
  bin: { 'code-runtime-analyzer-mcp': 'src/mcp-server.mjs' },
  files: ['src', 'README.md'],
  engines: { node: '>=20' },
  dependencies: backendPackage.dependencies,
  bundledDependencies: Object.keys(backendPackage.dependencies)
};
await writeFile(resolve(stagingRoot, 'package.json'), `${JSON.stringify(mcpPackage, null, 2)}\n`, 'utf8');

// Use the backend's committed lock graph so the same source revision bundles
// the same MCP transitive dependencies instead of resolving newer ^ versions
// on each release date.
backendLock.name = mcpPackage.name;
backendLock.version = mcpPackage.version;
backendLock.packages[''] = {
  ...backendLock.packages[''],
  name: mcpPackage.name,
  version: mcpPackage.version,
  type: mcpPackage.type,
  bin: mcpPackage.bin,
  engines: mcpPackage.engines,
  dependencies: mcpPackage.dependencies
};
delete backendLock.packages[''].private;
await writeFile(resolve(stagingRoot, 'package-lock.json'), `${JSON.stringify(backendLock, null, 2)}\n`, 'utf8');

process.stdout.write(`Prepared MCP package ${rootPackage.version} at ${stagingRoot}\n`);
