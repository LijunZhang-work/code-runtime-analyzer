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
