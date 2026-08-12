export const PRODUCT_VERSION = '0.10.2';
export const API_VERSION = '0.10';
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:47831';

export function opencodeConfigurations(baseUrl = DEFAULT_BACKEND_URL, accessToken) {
  const environment = { CODE_RUNTIME_ANALYZER_URL: baseUrl };
  if (accessToken) environment.CODE_RUNTIME_ANALYZER_TOKEN = accessToken;
  const server = {
    type: 'local',
    command: ['code-runtime-analyzer-mcp'],
    environment,
    timeout: 15000
  };
  return {
    serverName: 'code-runtime-analyzer',
    packageName: 'code-runtime-analyzer-mcp',
    artifactPattern: 'Code-Runtime-Analyzer-MCP-v*.tgz',
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
