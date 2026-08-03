import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startService, stopService } from '../src/launcher.mjs';

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

  const started = await startService(options);
  assert.equal(started.status, 'started');
  assert.equal(started.health.runtimeMode, 'standalone');
  assert.equal(started.health.apiVersion, '0.10');

  const reused = await startService(options);
  assert.equal(reused.status, 'already-running');
  assert.equal(reused.health.instanceId, started.health.instanceId);

  const stopped = await stopService(options);
  assert.equal(stopped.status, 'stopped');
});
