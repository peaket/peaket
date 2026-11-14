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

  async listActiveEndpoints(promoterId: string) {
    return (await this.listEndpoints(promoterId)).filter((e) => e.status === 'ACTIVE');
  }
  async findEndpointById(endpointId: string) {
    return this.endpoints.get(endpointId);
  }
  async insertDeliveries(records: readonly WebhookDeliveryRecord[]) {
    for (const r of records) this.deliveries.set(r.deliveryId, { ...r });
  }
  async listDueDeliveries(now: Date, limit: number) {
    return [...this.deliveries.values()]
      .filter((d) => (d.status === 'PENDING' || d.status === 'RETRYING') && d.nextAttemptAt !== null && d.nextAttemptAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextAttemptAt!.getTime() - b.nextAttemptAt!.getTime())
      .slice(0, limit);
  }
  async saveDelivery(record: WebhookDeliveryRecord) {
    this.deliveries.set(record.deliveryId, { ...record });
  }
  async countDeadSince(endpointId: string, since: Date) {
    return [...this.deliveries.values()].filter((d) => d.endpointId === endpointId && d.status === 'DEAD' && (d.finishedAt?.getTime() ?? d.createdAt.getTime()) >= since.getTime()).length;
  }
  async lastSuccessAt(endpointId: string) {
    const rows = [...this.deliveries.values()].filter((d) => d.endpointId === endpointId && d.status === 'SUCCEEDED' && d.finishedAt !== null);
    return rows.length === 0 ? null : new Date(Math.max(...rows.map((d) => d.finishedAt!.getTime())));
  }
  async disableEndpoint(endpointId: string, _now: Date) {
    const e = this.endpoints.get(endpointId);
    if (!e) return;
    this.endpoints.set(endpointId, { ...e, status: 'DISABLED', disabledReason: 'FAILING', version: e.version + 1 });
  }
}
