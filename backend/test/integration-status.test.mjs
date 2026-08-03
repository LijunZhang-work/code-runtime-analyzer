import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticServer } from '../src/server.mjs';

test('standalone backend reports client capabilities and generates installed OpenCode configuration', async (t) => {
  const server = createDiagnosticServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const registered = await fetch(`${baseUrl}/api/integrations/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientType: 'mcp', clientName: 'OpenCode test' })
  }).then((response) => response.json());
  assert.match(registered.clientId, /^[0-9a-f-]{36}$/i);

  const status = await fetch(`${baseUrl}/api/integrations/status`, { method: 'POST' }).then((response) => response.json());
  assert.equal(status.version, '0.10.0');
  assert.equal(status.apiVersion, '0.10');
  assert.equal(status.aiClients.length, 1);
  assert.equal(status.aiClients[0].clientName, 'OpenCode test');

  const generated = await fetch(`${baseUrl}/api/integrations/opencode-config`, { method: 'POST' }).then((response) => response.json());
  assert.equal(generated.serverName, 'code-runtime-analyzer');
  assert.equal(generated.current.mcp.servers['code-runtime-analyzer'].environment.CODE_RUNTIME_ANALYZER_URL, baseUrl);
  assert.equal(generated.legacy.mcp['code-runtime-analyzer'].environment.CODE_RUNTIME_ANALYZER_URL, baseUrl);
  assert.ok(generated.current.mcp.servers['code-runtime-analyzer'].command[0]);
  assert.ok(generated.current.mcp.servers['code-runtime-analyzer'].command[1].endsWith('mcp-server.mjs'));
});
