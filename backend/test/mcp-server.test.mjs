import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(testDirectory, '..');

test('MCP exposes the bounded diagnostics tool set over stdio', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/mcp-server.mjs'],
    cwd: backendDirectory,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'diagnostics-test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
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
});
