// notify 저장 포트. 웹훅 엔드포인트·발송 원장.
import type { DeliveryStatus, WebhookDeliveryRecord, WebhookEndpointRecord } from './webhook.js';

export interface WebhookStore {
  listEndpoints(promoterId: string): Promise<WebhookEndpointRecord[]>;
  findEndpoint(promoterId: string, endpointId: string): Promise<WebhookEndpointRecord | undefined>;
  insertEndpoint(record: WebhookEndpointRecord): Promise<void>;
  saveEndpoint(promoterId: string, record: WebhookEndpointRecord, expectedVersion: number): Promise<WebhookEndpointRecord | 'conflict'>;
  listDeliveries(promoterId: string, endpointId: string, status: readonly DeliveryStatus[] | undefined, limit: number): Promise<WebhookDeliveryRecord[]>;
  findDelivery(promoterId: string, deliveryId: string): Promise<WebhookDeliveryRecord | undefined>;
  redeliver(promoterId: string, deliveryId: string, now: Date): Promise<WebhookDeliveryRecord | 'not-found' | 'conflict'>;
}

export const WEBHOOK_STORE = Symbol.for('peaket.notify.webhook-store');
