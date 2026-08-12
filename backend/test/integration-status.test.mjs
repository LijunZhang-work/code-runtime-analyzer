import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDiagnosticServer } from '../src/server.mjs';

test('standalone backend reports clients and generates configuration for the separately installed MCP', async (t) => {
  const accessToken = 'local-test-access-token';
  const webDirectory = await mkdtemp(join(tmpdir(), 'code-runtime-analyzer-web-'));
  await writeFile(join(webDirectory, 'index.html'), '<!doctype html><title>Test workbench</title>', 'utf8');
  const server = createDiagnosticServer({ accessToken, webDirectory });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  t.after(() => rm(webDirectory, { recursive: true, force: true }));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${baseUrl}/health`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/workbench/`)).status, 200);

  const registered = await fetch(`${baseUrl}/api/integrations/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-code-runtime-analyzer-token': accessToken },
    body: JSON.stringify({ clientType: 'mcp', clientName: 'OpenCode test' })
  }).then((response) => response.json());
  assert.match(registered.clientId, /^[0-9a-f-]{36}$/i);

  const status = await fetch(`${baseUrl}/api/integrations/status`, {
    method: 'POST', headers: { 'x-code-runtime-analyzer-token': accessToken }
  }).then((response) => response.json());
  assert.equal(status.version, '0.10.2');
  assert.equal(status.apiVersion, '0.10');
  assert.equal(status.aiClients.length, 1);
  assert.equal(status.aiClients[0].clientName, 'OpenCode test');

  const generated = await fetch(`${baseUrl}/api/integrations/opencode-config`, {
    method: 'POST', headers: { 'x-code-runtime-analyzer-token': accessToken }
  }).then((response) => response.json());
  assert.equal(generated.serverName, 'code-runtime-analyzer');
  assert.equal(generated.packageName, 'code-runtime-analyzer-mcp');
  assert.equal(generated.current.mcp.servers['code-runtime-analyzer'].environment.CODE_RUNTIME_ANALYZER_URL, baseUrl);
  assert.equal(generated.current.mcp.servers['code-runtime-analyzer'].environment.CODE_RUNTIME_ANALYZER_TOKEN, accessToken);
  assert.equal(generated.legacy.mcp['code-runtime-analyzer'].environment.CODE_RUNTIME_ANALYZER_URL, baseUrl);
  assert.equal(generated.legacy.mcp['code-runtime-analyzer'].environment.CODE_RUNTIME_ANALYZER_TOKEN, accessToken);
  assert.deepEqual(generated.current.mcp.servers['code-runtime-analyzer'].command, ['code-runtime-analyzer-mcp']);
});
