import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticServer } from '../src/server.mjs';
import { WebSessionBroker } from '../src/web-session-broker.mjs';

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

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

async function register(baseUrl, suffix) {
  const { response, body } = await post(baseUrl, '/api/web/sessions/register', {
    clientName: `测试编辑器 ${suffix}`,
    workspaceRoot: `E:/workspace-${suffix}`,
    capabilities: { definition: true, callHierarchy: suffix === 'a' },
    environment: { family: 'custom-editor', channel: suffix }
  });
  assert.equal(response.status, 201);
  return body.windowSessionId;
}

test('semantic RPC is delivered only to the requested editor window and returns its answer', async () => {
  await withServer({}, async (baseUrl) => {
    const windowA = await register(baseUrl, 'a');
    const windowB = await register(baseUrl, 'b');

    const semanticResponsePromise = post(baseUrl, '/api/web/editor/semantic', {
      windowSessionId: windowA,
      operation: 'typeDefinition',
      payload: { uri: 'file:///E:/workspace-a/main.cpp', line: 8, character: 4 },
      timeoutMs: 2_000
    });

    const wrongWindowPoll = await post(baseUrl, '/api/web/sessions/poll', {
      windowSessionId: windowB,
      timeoutMs: 250
    });
    assert.deepEqual(wrongWindowPoll.body, { status: 'idle' });

    const rightWindowPoll = await post(baseUrl, '/api/web/sessions/poll', {
      windowSessionId: windowA,
      timeoutMs: 1_000
    });
    assert.equal(rightWindowPoll.body.status, 'semanticRequest');
    assert.equal(rightWindowPoll.body.operation, 'typeDefinition');
    assert.deepEqual(rightWindowPoll.body.payload, {
      uri: 'file:///E:/workspace-a/main.cpp', line: 8, character: 4
    });
    assert.match(rightWindowPoll.body.requestId, /^[0-9a-f-]{36}$/i);

    const rejected = await post(baseUrl, '/api/web/editor/semantic/respond', {
      windowSessionId: windowB,
      requestId: rightWindowPoll.body.requestId,
      status: 'ok',
      result: { name: 'Wrong' }
    });
    assert.equal(rejected.response.status, 409);
    assert.match(rejected.body.error, /不属于这个编辑器窗口/);

    const accepted = await post(baseUrl, '/api/web/editor/semantic/respond', {
      windowSessionId: windowA,
      requestId: rightWindowPoll.body.requestId,
      status: 'ok',
      result: { name: 'Student', uri: 'file:///E:/workspace-a/student.h' }
    });
    assert.equal(accepted.response.status, 200);
    assert.deepEqual(accepted.body, { accepted: true, requestId: rightWindowPoll.body.requestId });

    const semanticResponse = await semanticResponsePromise;
    assert.equal(semanticResponse.response.status, 200);
    assert.deepEqual(semanticResponse.body, {
      status: 'ok',
      requestId: rightWindowPoll.body.requestId,
      result: { name: 'Student', uri: 'file:///E:/workspace-a/student.h' }
    });

    const status = await post(baseUrl, '/api/integrations/status', {});
    const summaryA = status.body.vscodeWindows.find((entry) => entry.clientName === '测试编辑器 a');
    assert.deepEqual(summaryA.capabilities, { definition: true, callHierarchy: true });
    assert.deepEqual(summaryA.environment, { family: 'custom-editor', channel: 'a' });
  });
});

test('semantic RPC reports a clear timeout and discards a late response', async () => {
  await withServer({}, async (baseUrl) => {
    const windowSessionId = await register(baseUrl, 'timeout');
    const pending = post(baseUrl, '/api/web/editor/semantic', {
      windowSessionId,
      operation: 'references',
      payload: { uri: 'file:///E:/workspace-timeout/main.cpp', line: 2, character: 1 },
      timeoutMs: 50
    });
    const delivery = await post(baseUrl, '/api/web/sessions/poll', {
      windowSessionId,
      timeoutMs: 500
    });
    assert.equal(delivery.body.status, 'semanticRequest');

    const timedOut = await pending;
    assert.equal(timedOut.response.status, 504);
    assert.equal(timedOut.body.status, 'timeout');
    assert.match(timedOut.body.error, /响应超时/);

    const late = await post(baseUrl, '/api/web/editor/semantic/respond', {
      windowSessionId,
      requestId: delivery.body.requestId,
      status: 'ok',
      result: []
    });
    assert.equal(late.response.status, 409);
    assert.match(late.body.error, /已经超时/);
  });
});

test('semantic RPC propagates an editor error with an explicit upstream status', async () => {
  await withServer({}, async (baseUrl) => {
    const windowSessionId = await register(baseUrl, 'error');
    const pending = post(baseUrl, '/api/web/editor/semantic', {
      windowSessionId,
      operation: 'incomingCalls',
      payload: { item: { name: 'tick' } },
      timeoutMs: 1_000
    });
    const delivery = await post(baseUrl, '/api/web/sessions/poll', {
      windowSessionId,
      timeoutMs: 500
    });
    const answer = await post(baseUrl, '/api/web/editor/semantic/respond', {
      windowSessionId,
      requestId: delivery.body.requestId,
      status: 'error',
      error: { message: '语言插件内部错误' }
    });
    assert.equal(answer.response.status, 200);

    const failed = await pending;
    assert.equal(failed.response.status, 502);
    assert.equal(failed.body.status, 'error');
    assert.equal(failed.body.error, '语言插件内部错误');
  });
});

test('unregister closes pending semantic requests and prevents later responses', async () => {
  await withServer({}, async (baseUrl) => {
    const windowSessionId = await register(baseUrl, 'closed');
    const pending = post(baseUrl, '/api/web/editor/semantic', {
      windowSessionId,
      operation: 'definition',
      payload: { uri: 'file:///E:/workspace-closed/main.cpp', line: 1, character: 1 },
      timeoutMs: 2_000
    });
    const delivery = await post(baseUrl, '/api/web/sessions/poll', {
      windowSessionId,
      timeoutMs: 500
    });
    assert.equal(delivery.body.status, 'semanticRequest');

    const removed = await post(baseUrl, '/api/web/sessions/unregister', { windowSessionId });
    assert.deepEqual(removed.body, { removed: true });

    const closed = await pending;
    assert.equal(closed.response.status, 409);
    assert.equal(closed.body.status, 'closed');
    assert.match(closed.body.error, /窗口会话已经结束/);

    const late = await post(baseUrl, '/api/web/editor/semantic/respond', {
      windowSessionId,
      requestId: delivery.body.requestId,
      status: 'ok',
      result: []
    });
    assert.equal(late.response.status, 409);
  });
});

test('semantic queue is bounded and aborted requests are removed before delivery', async () => {
  const broker = new WebSessionBroker({ maxQueue: 1 });
  const { windowSessionId } = broker.register();
  const first = broker.requestSemantic(windowSessionId, {
    operation: 'hover', payload: { line: 1 }, timeoutMs: 2_000
  });
  const overflow = await broker.requestSemantic(windowSessionId, {
    operation: 'hover', payload: { line: 2 }, timeoutMs: 2_000
  });
  assert.equal(overflow.status, 'queueFull');

  const controller = new AbortController();
  const waiting = broker.poll(windowSessionId, { timeoutMs: 500 });
  const aborted = broker.requestSemantic(windowSessionId, {
    operation: 'definition', payload: { line: 3 }, timeoutMs: 2_000, signal: controller.signal
  });
  const delivered = await waiting;
  assert.equal(delivered.status, 'semanticRequest');
  controller.abort();
  assert.equal((await aborted).status, 'aborted');

  broker.unregister(windowSessionId);
  assert.equal((await first).status, 'closed');
});

test('semantic requests stay bounded after polling has delivered them to the editor', async () => {
  const broker = new WebSessionBroker({ maxQueue: 8, maxSemanticRequests: 1 });
  const { windowSessionId } = broker.register();
  const first = broker.requestSemantic(windowSessionId, {
    operation: 'callHierarchy', payload: { line: 1 }, timeoutMs: 2_000
  });
  const delivered = await broker.poll(windowSessionId, { timeoutMs: 500 });
  assert.equal(delivered.status, 'semanticRequest');

  const overflow = await broker.requestSemantic(windowSessionId, {
    operation: 'callHierarchy', payload: { line: 2 }, timeoutMs: 2_000
  });
  assert.equal(overflow.status, 'queueFull');
  assert.match(overflow.message, /正在处理/);

  broker.unregister(windowSessionId);
  assert.equal((await first).status, 'closed');
});
