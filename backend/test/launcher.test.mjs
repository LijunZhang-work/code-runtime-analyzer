import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { diagnoseService, exportDiagnosticReport, startService, stopService } from '../src/launcher.mjs';

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return port;
}

test('launcher starts one shared backend and stops only the recorded instance', async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cra-launcher-'));
  const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const port = await unusedPort();
  const options = { stateDirectory, installRoot, port };
  t.after(async () => {
    await stopService(options).catch(() => undefined);
  });

  const oversizedLog = join(stateDirectory, 'backend.log');
  await writeFile(oversizedLog, 'x'.repeat((2 * 1024 * 1024) + 1), 'utf8');

  const started = await startService(options);
  assert.equal(started.status, 'started');
  assert.equal(started.health.runtimeMode, 'standalone');
  assert.equal(started.health.apiVersion, '0.10');
  const privateState = JSON.parse(await readFile(join(stateDirectory, 'service-state.json'), 'utf8'));
  assert.equal(privateState.baseUrl, started.baseUrl);
  assert.equal(typeof privateState.accessToken, 'string');
  assert.ok(privateState.accessToken.length >= 32);
  assert.equal(JSON.stringify(started).includes(privateState.accessToken), false);
  assert.equal((await fetch(`${started.baseUrl}/health`)).status, 401);
  assert.equal((await fetch(`${started.baseUrl}/health`, {
    headers: { 'x-code-runtime-analyzer-token': 'incorrect' }
  })).status, 401);
  assert.equal((await fetch(`${started.baseUrl}/health`, {
    headers: { 'x-code-runtime-analyzer-token': privateState.accessToken }
  })).status, 200);

  const reused = await startService(options);
  assert.equal(reused.status, 'already-running');
  assert.equal(reused.health.instanceId, started.health.instanceId);

  assert.ok((await stat(`${oversizedLog}.previous`)).size > 2 * 1024 * 1024);
  const diagnosis = await diagnoseService(options);
  assert.equal(diagnosis.checks.find((check) => check.id === 'endpoint')?.status, 'ready');
  assert.equal(diagnosis.endpoint.health.instanceId, started.health.instanceId);

  const exported = await exportDiagnosticReport(options);
  assert.equal(exported.status, 'exported');
  const exportedReport = JSON.parse(await readFile(exported.reportFile, 'utf8'));
  assert.equal(exportedReport.reportVersion, 1);
  assert.equal(exportedReport.checks.find((check) => check.id === 'endpoint')?.status, 'ready');
  assert.equal(JSON.stringify(exportedReport).includes(privateState.accessToken), false);

  const stopped = await stopService(options);
  assert.equal(stopped.status, 'stopped');
});

test('launcher automatically selects another local port when the preferred port is occupied', async (t) => {
  const openSockets = new Set();
  const foreignServer = createServer((socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
    socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello');
  });
  await new Promise((resolvePromise, rejectPromise) => {
    foreignServer.once('error', rejectPromise);
    foreignServer.listen(0, '127.0.0.1', resolvePromise);
  });
  t.after(async () => {
    for (const socket of openSockets) socket.destroy();
    await new Promise((resolvePromise) => foreignServer.close(resolvePromise));
  });
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cra-launcher-conflict-'));
  const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const port = foreignServer.address().port;
  const options = { stateDirectory, installRoot, port };
  t.after(async () => stopService(options).catch(() => undefined));

  const started = await startService(options);
  assert.equal(started.status, 'started');
  assert.notEqual(started.port, port);
  const state = JSON.parse(await readFile(join(stateDirectory, 'service-state.json'), 'utf8'));
  assert.equal(state.port, started.port);
  assert.equal(state.baseUrl, started.baseUrl);
  const response = await fetch(`${started.baseUrl}/health`, {
    headers: { 'x-code-runtime-analyzer-token': state.accessToken }
  });
  assert.equal(response.status, 200);
});
