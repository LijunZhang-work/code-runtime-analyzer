import { randomUUID } from 'node:crypto';

export class IntegrationRegistry {
  constructor({ ttlMs = 90_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.clients = new Map();
  }

  register({ clientType = 'mcp', clientName = 'AI 客户端' } = {}) {
    this.#prune();
    const clientId = randomUUID();
    const timestamp = this.now();
    this.clients.set(clientId, {
      clientId,
      clientType: String(clientType).slice(0, 40),
      clientName: String(clientName).slice(0, 120),
      connectedAt: timestamp,
      lastSeen: timestamp
    });
    return { clientId, heartbeatIntervalMs: Math.floor(this.ttlMs / 3) };
  }

  heartbeat(clientId) {
    this.#prune();
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.lastSeen = this.now();
    return true;
  }

  unregister(clientId) {
    return this.clients.delete(clientId);
  }

  summary() {
    this.#prune();
    return [...this.clients.values()].map((client) => ({
      clientType: client.clientType,
      clientName: client.clientName,
      connectedAt: new Date(client.connectedAt).toISOString(),
      lastSeenAt: new Date(client.lastSeen).toISOString()
    }));
  }

  #prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const client of this.clients.values()) {
      if (client.lastSeen < cutoff) this.clients.delete(client.clientId);
    }
  }
}
