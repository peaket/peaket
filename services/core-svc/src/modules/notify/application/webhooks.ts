// 파트너 웹훅 유스케이스(FR-025, ADR-0053·0109). 발송기·재시도 워커는 후속이고, 관리·원장만 다룬다.
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { WebhookStore } from '../domain/ports.js';
import {
  checkWebhookUrl,
  deliveryView,
  endpointView,
  newWebhookSecret,
  parseIfMatch,
  redeliveryConflict,
  rotationTooSoon,
  type DeliveryStatus,
  type WebhookDeliveryView,
  type WebhookEndpointRecord,
  type WebhookEndpointView,
  type WebhookEventType,
  WebhookProblem,
} from '../domain/webhook.js';

export interface NotifyDeps {
  readonly store: WebhookStore;
  readonly clock: Clock;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const preconditionFailed = () => new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WebhookProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};
const MIN_ROTATION_MS = 60_000;
const PREVIOUS_SECRET_MS = 24 * 60 * 60 * 1000;

export class Webhooks {
  constructor(private readonly d: NotifyDeps) {}

  async list(promoterId: string): Promise<WebhookEndpointView[]> {
    return (await this.d.store.listEndpoints(promoterId)).map(endpointView);
  }

  async create(promoterId: string, body: { url: string; eventTypes?: WebhookEventType[] }): Promise<WebhookEndpointView & { secret: string }> {
    return guard(async () => {
      checkWebhookUrl(body.url);
      const now = new Date(this.d.clock.now());
      const secret = newWebhookSecret();
      const record: WebhookEndpointRecord = {
        endpointId: uuidv7(this.d.clock),
        promoterId,
        url: body.url.trim(),
        eventTypes: [...new Set(body.eventTypes ?? [])],
        status: 'ACTIVE',
        disabledReason: null,
        secret,
        previousSecret: null,
        secretIssuedAt: now,
        previousSecretValidUntil: null,
        version: 1,
      };
      await this.d.store.insertEndpoint(record);
      return { ...endpointView(record), secret };
    });
  }

  async update(
    promoterId: string,
    endpointId: string,
    body: { url?: string; eventTypes?: WebhookEventType[]; status?: 'ACTIVE' | 'DISABLED' },
    ifMatch: string | undefined,
  ): Promise<WebhookEndpointView> {
    return guard(async () => {
      const expected = parseIfMatch(ifMatch);
      const current = await this.d.store.findEndpoint(promoterId, endpointId);
      if (!current) throw notFound();
      if (current.version !== expected) throw preconditionFailed();
      if (body.url !== undefined) checkWebhookUrl(body.url);
      const next: WebhookEndpointRecord = {
        ...current,
        ...(body.url !== undefined ? { url: body.url.trim() } : {}),
        ...(body.eventTypes !== undefined ? { eventTypes: [...new Set(body.eventTypes)] } : {}),
        ...(body.status !== undefined ? { status: body.status, disabledReason: null } : {}),
      };
      const saved = await this.d.store.saveEndpoint(promoterId, next, expected);
      if (saved === 'conflict') throw preconditionFailed();
      return endpointView(saved);
    });
  }

  async rotate(promoterId: string, endpointId: string): Promise<{ secret: string; previousSecretValidUntil: string }> {
    return guard(async () => {
      const current = await this.d.store.findEndpoint(promoterId, endpointId);
      if (!current) throw notFound();
      const now = new Date(this.d.clock.now());
      if (now.getTime() - current.secretIssuedAt.getTime() < MIN_ROTATION_MS) throw rotationTooSoon();
      const secret = newWebhookSecret();
      const next: WebhookEndpointRecord = {
        ...current,
        previousSecret: current.secret,
        previousSecretValidUntil: new Date(now.getTime() + PREVIOUS_SECRET_MS),
        secret,
        secretIssuedAt: now,
      };
      const saved = await this.d.store.saveEndpoint(promoterId, next, current.version);
      if (saved === 'conflict') throw preconditionFailed();
      return { secret, previousSecretValidUntil: saved.previousSecretValidUntil!.toISOString() };
    });
  }

  async deliveries(promoterId: string, endpointId: string, status: readonly DeliveryStatus[] | undefined, limit: number): Promise<{ items: WebhookDeliveryView[]; nextCursor: null }> {
    if (!(await this.d.store.findEndpoint(promoterId, endpointId))) throw notFound();
    return { items: (await this.d.store.listDeliveries(promoterId, endpointId, status, limit)).map(deliveryView), nextCursor: null };
  }

  async redeliver(promoterId: string, deliveryId: string): Promise<WebhookDeliveryView> {
    return guard(async () => {
      const out = await this.d.store.redeliver(promoterId, deliveryId, new Date(this.d.clock.now()));
      if (out === 'not-found') throw notFound();
      if (out === 'conflict') throw redeliveryConflict();
      return deliveryView(out);
    });
  }
}
