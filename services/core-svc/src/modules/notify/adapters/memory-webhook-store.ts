// notify 메모리 저장소(단위 시험·개발).
import type { WebhookStore } from '../domain/ports.js';
import type { DeliveryStatus, WebhookDeliveryRecord, WebhookEndpointRecord } from '../domain/webhook.js';

export class MemoryWebhookStore implements WebhookStore {
  readonly endpoints = new Map<string, WebhookEndpointRecord>();
  readonly deliveries = new Map<string, WebhookDeliveryRecord>();

  async listEndpoints(promoterId: string) {
    return [...this.endpoints.values()].filter((e) => e.promoterId === promoterId).sort((a, b) => b.secretIssuedAt.getTime() - a.secretIssuedAt.getTime());
  }
  async findEndpoint(promoterId: string, endpointId: string) {
    const e = this.endpoints.get(endpointId);
    return e?.promoterId === promoterId ? e : undefined;
  }
  async insertEndpoint(record: WebhookEndpointRecord) {
    this.endpoints.set(record.endpointId, { ...record, eventTypes: [...record.eventTypes] });
  }
  async saveEndpoint(promoterId: string, record: WebhookEndpointRecord, expectedVersion: number) {
    const current = await this.findEndpoint(promoterId, record.endpointId);
    if (!current) throw new Error('not-found');
    if (current.version !== expectedVersion) return 'conflict';
    const next = { ...record, version: current.version + 1, eventTypes: [...record.eventTypes] };
    this.endpoints.set(record.endpointId, next);
    return next;
  }
  async listDeliveries(promoterId: string, endpointId: string, status: readonly DeliveryStatus[] | undefined, limit: number) {
    const endpoint = await this.findEndpoint(promoterId, endpointId);
    if (!endpoint) return [];
    return [...this.deliveries.values()]
      .filter((d) => d.endpointId === endpointId && (!status || status.length === 0 || status.includes(d.status)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
  async findDelivery(promoterId: string, deliveryId: string) {
    const d = this.deliveries.get(deliveryId);
    if (!d) return undefined;
    return (await this.findEndpoint(promoterId, d.endpointId)) ? d : undefined;
  }
  async redeliver(promoterId: string, deliveryId: string, now: Date) {
    const d = await this.findDelivery(promoterId, deliveryId);
    if (!d) return 'not-found';
    if (d.status === 'PENDING' || d.status === 'RETRYING') return 'conflict';
    const next = { ...d, status: 'PENDING' as const, attemptCount: d.attemptCount + 1, nextAttemptAt: now, finishedAt: null };
    this.deliveries.set(deliveryId, next);
    return next;
  }
}
