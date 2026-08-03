import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');

function waitForMessage(worker, expectedType, timeoutMs = 10_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`等待 worker ${expectedType} 超时`)), timeoutMs);
    const onError = (error) => finish(rejectPromise, error);
    const onExit = (code) => finish(rejectPromise, new Error(`worker 提前退出：${code}`));
    const onMessage = (message) => {
      if (message?.type === 'error') finish(rejectPromise, new Error(message.message));
      if (message?.type === expectedType) finish(resolvePromise, message);
    };
    function finish(callback, value) {
      clearTimeout(timer);
      worker.off('error', onError);
      worker.off('exit', onExit);
      worker.off('message', onMessage);
      callback(value);
    }
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.on('message', onMessage);
  });
}

test('worker backend isolates Clang work and reuses the structural index', {
  skip: process.platform !== 'win32'
}, async () => {
  const worker = new Worker(new URL('../src/worker-server.mjs', import.meta.url), {
    workerData: { host: '127.0.0.1', port: 0 }
  });
  let stopped = false;
  try {
    const ready = await waitForMessage(worker, 'ready');
    const baseUrl = `http://${ready.host}:${ready.port}`;
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    assert.equal(health.status, 'ok');

    const body = {
      compileCommandsPath: `${workspace}/build/2048_csv_replay-current-mingw/compile_commands.json`,
      filePath: `${workspace}/labs/2048_csv_replay/src/replay_scenario.cpp`,
      targetHints: { members: ['value', 'score'], globals: [] }
    };
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 10);
    const cold = await fetch(`${baseUrl}/api/code/index`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then((response) => response.json());
    clearTimeout(timer);
    assert.equal(timerFired, true, 'main event loop should remain responsive while Clang runs in the worker');
    assert.equal(cold.analyzer, 'clangd-ast');
    assert.equal(cold.performance.cacheHit, false);

    const warm = await fetch(`${baseUrl}/api/code/index`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then((response) => response.json());
    assert.equal(warm.performance.cacheHit, true);
    assert.equal(warm.performance.clangProcessCount, 0);

    const stopping = waitForMessage(worker, 'stopped');
    worker.postMessage({ type: 'shutdown' });
    await stopping;
    stopped = true;
  } finally {
    if (!stopped) {
      worker.postMessage({ type: 'shutdown' });
      await Promise.race([waitForMessage(worker, 'stopped').catch(() => {}), new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
    }
    if (worker.threadId !== -1) await worker.terminate();
  }
});
