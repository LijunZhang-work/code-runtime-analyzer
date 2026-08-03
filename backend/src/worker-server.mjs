import { parentPort, workerData } from 'node:worker_threads';
import { createDiagnosticServer } from './server.mjs';

if (!parentPort) throw new Error('worker-server.mjs 必须由 Worker 启动');

const host = workerData?.host ?? '127.0.0.1';
const port = Number(workerData?.port ?? 0);
const server = createDiagnosticServer({
  webSessionId: workerData?.webSessionId,
  onWebOpen(location) {
    parentPort.postMessage({ type: 'web-open-function', location });
  }
});
let closing = false;

server.once('error', (error) => {
  parentPort.postMessage({ type: 'error', message: error.message, code: error.code ?? null });
});

server.listen(port, host, () => {
  const address = server.address();
  parentPort.postMessage({
    type: 'ready',
    host,
    port: typeof address === 'object' && address ? address.port : port
  });
});

async function shutdown() {
  if (closing) return;
  closing = true;
  if (server.listening) {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
  await server.closeDiagnosticServices?.();
  parentPort.postMessage({ type: 'stopped' });
  parentPort.close();
}

parentPort.on('message', (message) => {
  if (message?.type === 'shutdown') void shutdown();
});
