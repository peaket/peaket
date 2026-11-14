// 파트너 웹훅 발송기·DLQ 시험(BUILD_ORDER BAT-610 잔여, N-T5·N-T15, FR-025).
import { fakeClock } from '@peaket/platform';
import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryWebhookStore, WebhookDispatcher, retryDelayMs } from '../src/modules/notify/index.js';
import type { WebhookEndpointRecord } from '../src/modules/notify/domain/webhook.js';
import type { WebhookTransport } from '../src/modules/notify/domain/ports.js';

const NOW = new Date('2026-11-15T00:00:00.000Z');
const PROMOTER = randomUUID();

const endpoint = (o: Partial<WebhookEndpointRecord> = {}): WebhookEndpointRecord => ({
  endpointId: randomUUID(),
  promoterId: PROMOTER,
  url: 'https://partner.example.com/hook',
  eventTypes: ['order.confirmed'],
  status: 'ACTIVE',
  disabledReason: null,
  secret: 'whsec_test',
  previousSecret: null,
  secretIssuedAt: new Date('2026-11-01T00:00:00Z'),
  previousSecretValidUntil: null,
  version: 1,
  ...o,
});

class Receiver implements WebhookTransport {
  readonly calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  constructor(private statuses: number[] = [200]) {}
  async send(input: { url: string; headers: Record<string, string>; body: string }) {
    this.calls.push(input);
    return { status: this.statuses.shift() ?? 500 };
  }
}

const dispatcher = (store: MemoryWebhookStore, transport: WebhookTransport) => new WebhookDispatcher({ store, transport, clock: fakeClock({ now: NOW.getTime() }) });

describe('N-T5·N-T15 웹훅 발송기', () => {
  test('Standard Webhooks 서명은 id.timestamp.body HMAC이고 옛 비밀을 24시간 함께 보낸다', async () => {
    const store = new MemoryWebhookStore();
    const e = endpoint({ previousSecret: 'whsec_old', previousSecretValidUntil: new Date(NOW.getTime() + 60_000) });
    await store.insertEndpoint(e);
    const receiver = new Receiver([200]);
    const d = dispatcher(store, receiver);
    const [delivery] = await d.enqueue({ promoterId: PROMOTER, eventType: 'order.confirmed', data: { orderId: 'o1' }, occurredAt: NOW });
    expect(delivery).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    const result = await d.processDue(NOW);
    expect(result).toMatchObject({ attempted: 1, succeeded: 1 });
    const call = receiver.calls[0]!;
    const body = JSON.stringify({ type: 'order.confirmed', timestamp: NOW.toISOString(), data: { orderId: 'o1' } });
    expect(call.body).toBe(body);
    const expectedNew = `v1,${createHmac('sha256', 'whsec_test').update(`${delivery!.webhookId}.${Math.floor(NOW.getTime() / 1000)}.${body}`).digest('base64')}`;
    const expectedOld = `v1,${createHmac('sha256', 'whsec_old').update(`${delivery!.webhookId}.${Math.floor(NOW.getTime() / 1000)}.${body}`).digest('base64')}`;
    expect(call.headers['webhook-signature']).toBe(`${expectedNew} ${expectedOld}`);
    expect(call.headers['webhook-id']).toBe(delivery!.webhookId);
    expect(store.deliveries.get(delivery!.deliveryId)).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
  });

  test('N-T5 5xx는 1분·5분·30분·2시간·6시간·12시간 뒤 다시 보내고 마지막에 DEAD다', async () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000]);
    expect(retryDelayMs(7)).toBeNull();
    const store = new MemoryWebhookStore();
    await store.insertEndpoint(endpoint());
    const receiver = new Receiver([500, 500, 500, 500, 500, 500, 500]);
    const d = dispatcher(store, receiver);
    const [delivery] = await d.enqueue({ promoterId: PROMOTER, eventType: 'order.confirmed', data: {}, occurredAt: NOW });
    let at = NOW;
    const waits = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
    for (const [i, wait] of waits.entries()) {
      const r = await d.processDue(at);
      expect(r.retrying, `try ${i + 1}`).toBe(1);
      at = new Date(at.getTime() + wait);
      expect(store.deliveries.get(delivery!.deliveryId)!.nextAttemptAt?.getTime()).toBe(at.getTime());
    }
    const last = await d.processDue(at);
    expect(last.dead).toBe(1);
    expect(store.deliveries.get(delivery!.deliveryId)).toMatchObject({ status: 'DEAD', attemptCount: 7, lastHttpStatus: 500 });
  });

  test('N-T15 5일 성공 없이 DEAD 50건이면 DISABLED(FAILING)가 되고 알림 훅이 불린다', async () => {
    const store = new MemoryWebhookStore();
    const e = endpoint();
    await store.insertEndpoint(e);
    // 이미 49건이 DEAD인 상태를 만든다(상수와 다른 시험 값).
    for (let i = 0; i < 49; i += 1) {
      const id = randomUUID();
      store.deliveries.set(id, {
        deliveryId: id,
        endpointId: e.endpointId,
        webhookId: `old-${i}`,
        eventType: 'order.confirmed',
        status: 'DEAD',
        attemptCount: 7,
        lastHttpStatus: 500,
        lastError: 'http-500',
        nextAttemptAt: null,
        createdAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
        finishedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
        payload: {},
      });
    }
    const receiver = new Receiver(Array(7).fill(500));
    const notices: string[] = [];
    const d = new WebhookDispatcher({ store, transport: receiver, clock: fakeClock({ now: NOW.getTime() }), onDisabled: (x) => notices.push(x.endpointId) });
    const [delivery] = await d.enqueue({ promoterId: PROMOTER, eventType: 'order.confirmed', data: {}, occurredAt: NOW });
    let at = NOW;
    for (const wait of [0, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000]) {
      at = new Date(at.getTime() + wait);
      await d.processDue(at);
    }
    expect(store.deliveries.get(delivery!.deliveryId)!.status).toBe('DEAD');
    expect(store.endpoints.get(e.endpointId)).toMatchObject({ status: 'DISABLED', disabledReason: 'FAILING', version: 2 });
    expect(notices).toEqual([e.endpointId]);
  });

  test('N-T15 다시 보낸 것은 같은 webhook-id이고 새 webhook-timestamp다', async () => {
    const store = new MemoryWebhookStore();
    await store.insertEndpoint(endpoint());
    const receiver = new Receiver([200, 200]);
    const d = dispatcher(store, receiver);
    const [delivery] = await d.enqueue({ promoterId: PROMOTER, eventType: 'order.confirmed', data: { a: 1 }, occurredAt: NOW });
    await d.processDue(NOW);
    const later = new Date(NOW.getTime() + 120_000);
    store.deliveries.set(delivery!.deliveryId, { ...store.deliveries.get(delivery!.deliveryId)!, status: 'DEAD', attemptCount: 7, finishedAt: NOW });
    await store.redeliver(PROMOTER, delivery!.deliveryId, later);
    await d.processDue(later);
    expect(receiver.calls).toHaveLength(2);
    expect(receiver.calls[1]!.headers['webhook-id']).toBe(receiver.calls[0]!.headers['webhook-id']);
    expect(receiver.calls[1]!.headers['webhook-timestamp']).not.toBe(receiver.calls[0]!.headers['webhook-timestamp']);
    expect(receiver.calls[1]!.body).toBe(receiver.calls[0]!.body);
  });

  test('N-T5 3xx는 성공이 아니라 재시도다', async () => {
    const store = new MemoryWebhookStore();
    await store.insertEndpoint(endpoint());
    const receiver = new Receiver([302, 200]);
    const d = dispatcher(store, receiver);
    const [delivery] = await d.enqueue({ promoterId: PROMOTER, eventType: 'order.confirmed', data: {}, occurredAt: NOW });
    expect((await d.processDue(NOW)).retrying).toBe(1);
    expect(store.deliveries.get(delivery!.deliveryId)).toMatchObject({ status: 'RETRYING', lastHttpStatus: 302 });
    expect((await d.processDue(new Date(NOW.getTime() + 60_000))).succeeded).toBe(1);
  });

  test('구독하지 않은 이벤트·꺼진 엔드포인트에는 발송 행을 만들지 않는다', async () => {
    const store = new MemoryWebhookStore();
    await store.insertEndpoint(endpoint({ eventTypes: ['event.sold_out'] }));
    await store.insertEndpoint(endpoint({ status: 'DISABLED', disabledReason: 'PARTNER' }));
    const d = dispatcher(store, new Receiver());
    expect(await d.enqueue({ promoterId: PROMOTER, eventType: 'order.confirmed', data: {} })).toHaveLength(0);
    expect(await d.enqueue({ promoterId: PROMOTER, eventType: 'nope' as never, data: {} }).catch((e) => e)).toMatchObject({ status: 400 });
  });
});
