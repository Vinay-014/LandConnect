export interface RealtimeEnvelope {
  targets: string[] | '*';
  excludeUuid?: string;
  payload: unknown;
}

export interface RealtimeBus {
  publish(envelope: RealtimeEnvelope): void;
  subscribe(handler: (envelope: RealtimeEnvelope) => void): () => void;
  close(): void;
}

/**
 * Zero-config in-process Pub/Sub bus for single-node deployments.
 * Implement RealtimeBus with Redis Pub/Sub or NATS to scale horizontally
 * across multiple stateless API/WebSocket replicas.
 */
export class InProcessRealtimeBus implements RealtimeBus {
  private listeners = new Set<(envelope: RealtimeEnvelope) => void>();

  publish(envelope: RealtimeEnvelope): void {
    for (const listener of this.listeners) {
      listener(envelope);
    }
  }

  subscribe(handler: (envelope: RealtimeEnvelope) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  close(): void {
    this.listeners.clear();
  }
}
