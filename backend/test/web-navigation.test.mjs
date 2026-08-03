import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticServer } from '../src/server.mjs';

async function withServer(options, run) {
  const server = createDiagnosticServer(options);
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

test('web navigation is accepted only for the VS Code window session that opened the page', async () => {
  const received = [];
  await withServer({
    webSessionId: 'window-a',
    onWebOpen(location) { received.push(location); }
  }, async (baseUrl) => {
    const accepted = await fetch(`${baseUrl}/api/web/open-in-vscode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        windowSessionId: 'window-a',
        workspaceRoot: 'E:/Product_B_log',
        filePath: 'E:/Product_B_log/examples/boss_control.cpp',
        line: 12,
        column: 4
      })
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true });
    assert.deepEqual(received, [{
      workspaceRoot: 'E:/Product_B_log',
      filePath: 'E:/Product_B_log/examples/boss_control.cpp',
      line: 12,
      column: 4
    }]);

    const rejected = await fetch(`${baseUrl}/api/web/open-in-vscode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowSessionId: 'window-b', filePath: 'E:/Product_B_log/examples/boss_control.cpp' })
    });
    assert.equal(rejected.status, 403);
    assert.equal(received.length, 1);
  });
});

test('standalone backend binds a web page back to the VS Code window through a bounded session queue', async () => {
  await withServer({}, async (baseUrl) => {
    const registrationResponse = await fetch(`${baseUrl}/api/web/sessions/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientName: 'VS Code test', workspaceRoot: 'E:/Product_B_log' })
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json();
    assert.match(registration.windowSessionId, /^[0-9a-f-]{36}$/i);

    const waiting = fetch(`${baseUrl}/api/web/sessions/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowSessionId: registration.windowSessionId, timeoutMs: 2_000 })
    }).then((response) => response.json());

    const openResponse = await fetch(`${baseUrl}/api/web/open-in-vscode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        windowSessionId: registration.windowSessionId,
        filePath: 'E:/Product_B_log/examples/boss_control.cpp',
        workspaceRoot: 'E:/Product_B_log',
        line: 18,
        column: 7
      })
    });
    assert.equal(openResponse.status, 202);
    assert.deepEqual(await waiting, {
      status: 'event',
      location: {
        filePath: 'E:/Product_B_log/examples/boss_control.cpp',
        workspaceRoot: 'E:/Product_B_log',
        line: 18,
        column: 7
      }
    });

    const unregisterResponse = await fetch(`${baseUrl}/api/web/sessions/unregister`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowSessionId: registration.windowSessionId })
    });
    assert.deepEqual(await unregisterResponse.json(), { removed: true });

    const rejected = await fetch(`${baseUrl}/api/web/open-in-vscode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        windowSessionId: registration.windowSessionId,
        filePath: 'E:/Product_B_log/examples/boss_control.cpp'
      })
    });
    assert.equal(rejected.status, 409);
  });
});
