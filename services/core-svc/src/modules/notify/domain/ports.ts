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

  // ---- 발송기(BUILD_ORDER BAT-610 잔여, N-T15·N-T5) ----
  listActiveEndpoints(promoterId: string): Promise<WebhookEndpointRecord[]>;
  findEndpointById(endpointId: string): Promise<WebhookEndpointRecord | undefined>;
  insertDeliveries(records: readonly WebhookDeliveryRecord[]): Promise<void>;
  listDueDeliveries(now: Date, limit: number): Promise<WebhookDeliveryRecord[]>;
  saveDelivery(record: WebhookDeliveryRecord): Promise<void>;
  countDeadSince(endpointId: string, since: Date): Promise<number>;
  lastSuccessAt(endpointId: string): Promise<Date | null>;
  disableEndpoint(endpointId: string, now: Date): Promise<void>;
}

export const WEBHOOK_STORE = Symbol.for('peaket.notify.webhook-store');
export const WEBHOOK_TRANSPORT = Symbol.for('peaket.notify.webhook-transport');

/** 발송 경계. 실제 전송은 HTTPS만, 시험은 가짜 수신기를 꽂는다. */
export interface WebhookTransport {
  send(input: { url: string; headers: Record<string, string>; body: string }): Promise<{ status: number }>;
}
