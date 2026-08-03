import { randomUUID } from 'node:crypto';

const validText = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new Error(`${label}必须是非空字符串且不能超过 512 个字符`);
  }
  return value.trim();
};

export class WebSessionBroker {
  constructor({ maxSessions = 32, maxQueue = 8, ttlMs = 30 * 60_000, now = () => Date.now() } = {}) {
    this.maxSessions = maxSessions;
    this.maxQueue = maxQueue;
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  register({ clientName = 'VS Code', workspaceRoot } = {}) {
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
      queue: [],
      waiters: []
    });
    return { windowSessionId: id, expiresInMs: this.ttlMs };
  }

  unregister(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    for (const waiter of session.waiters.splice(0)) waiter.resolve({ status: 'closed' });
    return true;
  }

  publish(id, location) {
    this.#prune();
    const session = this.sessions.get(id);
    if (!session) return false;
    session.lastSeen = this.now();
    const waiter = session.waiters.shift();
    if (waiter) waiter.resolve({ status: 'event', location });
    else {
      session.queue.push(location);
      if (session.queue.length > this.maxQueue) session.queue.splice(0, session.queue.length - this.maxQueue);
    }
    return true;
  }

  async poll(id, { timeoutMs = 20_000, signal } = {}) {
    this.#prune();
    const session = this.sessions.get(id);
    if (!session) return { status: 'missing' };
    session.lastSeen = this.now();
    const location = session.queue.shift();
    if (location) return { status: 'event', location };
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
