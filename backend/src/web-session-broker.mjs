import { randomUUID } from 'node:crypto';

const validText = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new Error(`${label}必须是非空字符串且不能超过 512 个字符`);
  }
  return value.trim();
};

const optionalMetadata = (value, label) => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new Error(`${label}必须是 JSON 对象或数组`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label}必须能够转换成 JSON`);
  }
  if (typeof serialized !== 'string') throw new Error(`${label}必须能够转换成 JSON`);
  if (serialized.length > 16_384) throw new Error(`${label}不能超过 16 KB`);
  return JSON.parse(serialized);
};

const semanticError = (status, message, requestId) => ({ status, message, requestId });

export class WebSessionBroker {
  constructor({ maxSessions = 32, maxQueue = 8, maxSemanticRequests = 4, ttlMs = 30 * 60_000, now = () => Date.now() } = {}) {
    this.maxSessions = maxSessions;
    this.maxQueue = maxQueue;
    this.maxSemanticRequests = maxSemanticRequests;
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  register({ clientName = '编辑器连接器', workspaceRoot, capabilities, environment } = {}) {
    this.#prune();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.lastSeen - right.lastSeen)[0];
      if (!oldest) break;
      this.unregister(oldest.id);
    }
    const id = randomUUID();
    const timestamp = this.now();
    this.sessions.set(id, {
      id,
      clientName: validText(clientName, '客户端名称'),
      workspaceRoot: typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot.trim() : undefined,
      createdAt: timestamp,
      lastSeen: timestamp,
      capabilities: optionalMetadata(capabilities, '编辑器能力'),
      environment: optionalMetadata(environment, '编辑器环境'),
      queue: [],
      waiters: [],
      pendingSemantic: new Map()
    });
    return { windowSessionId: id, expiresInMs: this.ttlMs };
  }

  unregister(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    for (const waiter of session.waiters.splice(0)) waiter.resolve({ status: 'closed' });
    for (const pending of session.pendingSemantic.values()) {
      pending.finish(semanticError('closed', '编辑器窗口会话已经结束，无法完成语义请求。', pending.requestId));
    }
    return true;
  }

  publish(id, location) {
    this.#prune();
    const session = this.sessions.get(id);
    if (!session) return false;
    session.lastSeen = this.now();
    const event = { status: 'event', location };
    const waiter = session.waiters.shift();
    if (waiter) waiter.resolve(event);
    else {
      session.queue.push(event);
      while (session.queue.length > this.maxQueue) {
        const dropped = session.queue.shift();
        if (dropped?.status === 'semanticRequest') {
          session.pendingSemantic.get(dropped.requestId)?.finish(semanticError(
            'queueFull', '编辑器消息队列已满，这项语义请求未能送达，请稍后重试。', dropped.requestId
          ));
        }
      }
    }
    return true;
  }

  async requestSemantic(id, { operation, payload, timeoutMs = 10_000, signal } = {}) {
    this.#prune();
    const session = this.sessions.get(id);
    if (!session) return semanticError('missing', '找不到对应的编辑器窗口会话，请从原编辑器窗口重新打开网页。');
    const normalizedOperation = validText(operation, '语义操作');
    if (normalizedOperation.length > 128 || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(normalizedOperation)) {
      return semanticError('invalid', '语义操作名称格式不正确。');
    }
    if (payload === undefined) return semanticError('invalid', '语义请求缺少 payload。');
    if (session.pendingSemantic.size >= this.maxSemanticRequests) {
      return semanticError('queueFull', '当前编辑器正在处理的语义请求较多，请等待上一项完成后重试。');
    }
    session.lastSeen = this.now();
    const requestId = randomUUID();
    const boundedTimeout = Math.max(50, Math.min(30_000, Number(timeoutMs) || 10_000));
    return new Promise((resolvePromise) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        session.pendingSemantic.delete(requestId);
        const queuedIndex = session.queue.findIndex((event) => (
          event.status === 'semanticRequest' && event.requestId === requestId
        ));
        if (queuedIndex >= 0) session.queue.splice(queuedIndex, 1);
        resolvePromise(value);
      };
      const onAbort = () => finish(semanticError('aborted', '网页已经取消语义请求。', requestId));
      const timer = setTimeout(() => {
        finish(semanticError('timeout', '等待编辑器语言服务响应超时，请确认编辑器仍在运行且语言服务已经就绪。', requestId));
      }, boundedTimeout);
      session.pendingSemantic.set(requestId, { requestId, finish });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const event = { status: 'semanticRequest', requestId, operation: normalizedOperation, payload };
      const waiter = session.waiters.shift();
      if (waiter) waiter.resolve(event);
      else if (session.queue.length >= this.maxQueue) {
        finish(semanticError('queueFull', '编辑器语义请求队列已满，请稍后重试。', requestId));
      } else {
        session.queue.push(event);
      }
    });
  }

  respondSemantic(id, { requestId, status, result, error } = {}) {
    this.#prune();
    const session = this.sessions.get(id);
    if (!session) return semanticError('missing', '找不到对应的编辑器窗口会话。', requestId);
    const pending = session.pendingSemantic.get(requestId);
    if (!pending) {
      return semanticError('missingRequest', '语义请求不存在、已经超时，或者不属于这个编辑器窗口。', requestId);
    }
    session.lastSeen = this.now();
    const normalizedStatus = typeof status === 'string' && status.trim() ? status.trim() : 'ok';
    if (!['ok', 'noEvidence', 'unsupported', 'notReady', 'error'].includes(normalizedStatus)) {
      return semanticError('invalid', '编辑器返回了无法识别的语义响应状态。', requestId);
    }
    const message = typeof error === 'string'
      ? error.trim()
      : typeof error?.message === 'string' ? error.message.trim() : undefined;
    pending.finish({
      status: normalizedStatus,
      requestId,
      ...(normalizedStatus === 'ok' || normalizedStatus === 'noEvidence' ? { result } : {}),
      ...(message ? { message } : {})
    });
    return { status: 'accepted', requestId };
  }

  async poll(id, { timeoutMs = 20_000, signal } = {}) {
    this.#prune();
    const session = this.sessions.get(id);
    if (!session) return { status: 'missing' };
    session.lastSeen = this.now();
    const event = session.queue.shift();
    if (event) return event;
    const boundedTimeout = Math.max(250, Math.min(25_000, Number(timeoutMs) || 20_000));
    return new Promise((resolvePromise) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = session.waiters.indexOf(waiter);
        if (index >= 0) session.waiters.splice(index, 1);
        resolvePromise(value);
      };
      const waiter = { resolve: finish };
      const onAbort = () => finish({ status: 'closed' });
      const timer = setTimeout(() => finish({ status: 'idle' }), boundedTimeout);
      session.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  summary() {
    this.#prune();
    return [...this.sessions.values()].map((session) => ({
      clientName: session.clientName,
      workspaceRoot: session.workspaceRoot,
      capabilities: session.capabilities,
      environment: session.environment,
      connectedAt: new Date(session.createdAt).toISOString(),
      lastSeenAt: new Date(session.lastSeen).toISOString()
    }));
  }

  #prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const session of this.sessions.values()) {
      if (session.lastSeen < cutoff) this.unregister(session.id);
    }
  }
}
