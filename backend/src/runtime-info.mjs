import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_VERSION = '0.10.0';
export const API_VERSION = '0.10';
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:47831';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export function installedRuntimePaths() {
  const installRoot = process.env.CODE_RUNTIME_ANALYZER_INSTALL_ROOT?.trim();
  if (installRoot) {
    return {
      installRoot,
      nodePath: resolve(installRoot, 'runtime', 'node.exe'),
      mcpPath: resolve(installRoot, 'backend', 'src', 'mcp-server.mjs')
    };
  }
  return {
    installRoot: resolve(sourceDirectory, '..', '..'),
    nodePath: process.execPath,
    mcpPath: resolve(sourceDirectory, 'mcp-server.mjs')
  };
}

export function opencodeConfigurations(baseUrl = DEFAULT_BACKEND_URL) {
  const runtime = installedRuntimePaths();
  const server = {
    type: 'local',
    command: [runtime.nodePath, runtime.mcpPath],
    environment: { CODE_RUNTIME_ANALYZER_URL: baseUrl },
    timeout: 15000
  };
  return {
    serverName: 'code-runtime-analyzer',
    runtime,
    current: {
      $schema: 'https://opencode.ai/config.json',
      mcp: { servers: { 'code-runtime-analyzer': server } }
    },
    legacy: {
      $schema: 'https://opencode.ai/config.json',
      mcp: { 'code-runtime-analyzer': { ...server, enabled: true } }
    }
  };
}
