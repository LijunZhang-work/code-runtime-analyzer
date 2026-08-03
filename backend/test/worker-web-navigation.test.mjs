import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

const workerModule = new URL('../src/worker-server.mjs', import.meta.url);

test('embedded backend forwards a bound web navigation request to its parent window', async (t) => {
  const worker = new Worker(workerModule, {
    workerData: { host: '127.0.0.1', port: 0, webSessionId: 'window-a' }
  });
  t.after(async () => {
    if (worker.threadId === -1) return;
    worker.postMessage({ type: 'shutdown' });
    await new Promise((resolvePromise) => worker.once('exit', resolvePromise));
  });

  const ready = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('worker startup timeout')), 10_000);
    const onMessage = (message) => {
      if (message?.type === 'ready') {
        clearTimeout(timer);
        worker.off('message', onMessage);
        resolvePromise(message);
      }
      if (message?.type === 'error') {
        clearTimeout(timer);
        worker.off('message', onMessage);
        rejectPromise(new Error(message.message));
      }
    };
    worker.on('message', onMessage);
  });
  const opened = new Promise((resolvePromise) => {
    worker.on('message', (message) => {
      if (message?.type === 'web-open-function') resolvePromise(message.location);
    });
  });
  const response = await fetch(`http://127.0.0.1:${ready.port}/api/web/open-in-vscode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      windowSessionId: 'window-a',
      filePath: 'E:/Product_B_log/examples/boss_control.cpp',
      workspaceRoot: 'E:/Product_B_log',
      line: 8,
      column: 2
    })
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await opened, {
    filePath: 'E:/Product_B_log/examples/boss_control.cpp',
    workspaceRoot: 'E:/Product_B_log',
    line: 8,
    column: 2
  });
});
