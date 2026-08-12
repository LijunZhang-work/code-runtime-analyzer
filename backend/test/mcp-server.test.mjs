import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDiagnosticServer } from '../src/server.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(testDirectory, '..');

test('MCP exposes the bounded diagnostics tool set over stdio', async (t) => {
  const accessToken = 'mcp-local-access-token';
  const backend = createDiagnosticServer({ accessToken });
  await new Promise((resolvePromise, rejectPromise) => {
    backend.once('error', rejectPromise);
    backend.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = backend.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/mcp-server.mjs'],
    cwd: backendDirectory,
    env: {
      ...process.env,
      CODE_RUNTIME_ANALYZER_URL: baseUrl,
      CODE_RUNTIME_ANALYZER_TOKEN: accessToken
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'diagnostics-test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await new Promise((resolvePromise) => backend.close(resolvePromise));
  });

  await client.connect(transport);
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'diagnostics_get_call_graph',
    'diagnostics_get_series',
    'diagnostics_get_snapshot',
    'diagnostics_list_dictionaries',
    'diagnostics_list_fields',
    'diagnostics_list_replay_times',
    'diagnostics_list_runs',
    'diagnostics_load_data',
    'diagnostics_make_vscode_link'
  ]);
  const status = await fetch(`${baseUrl}/api/integrations/status`, {
    method: 'POST', headers: { 'x-code-runtime-analyzer-token': accessToken }
  }).then((response) => response.json());
  assert.equal(status.aiClients.length, 1);
  assert.equal(status.aiClients[0].clientType, 'mcp');
});
