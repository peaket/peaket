// J-T16 늦은 지급 웹훅, J-T6 서명 확인의 바깥 경계(F-07-6 LCH-110, settlement §8 웹훅 행, ADR-0369 결정 5).
// 진짜 ReceiveSettlementWebhook·Settlements·HttpTossPayoutTransport를 시험 안 대역 서버에 붙이고, HTTP(/v1/webhooks/toss)까지 띄워 본다.
// 서명 원문은 `{본문}:{전송 시각}`의 HMAC-SHA256(키 = 보안 키 hex 글)이고, 두 상점의 지금·옛 키 가운데 하나만 맞아도 받는다.
// 5분 넘게 늦은 웹훅은 본문 상태를 쓰지 않고 '늦은 웹훅' 보안 이벤트를 남긴 뒤 단건 조회 결과로만 확정한다.
// 중복은 본문 eventId로 막는다(전송 ID는 보낼 때마다 새로 나온다, 토스 공개 문서 확인 2026-11-23, settlement §8·J-T16, ADR-0369 결정 14).
// 본문은 공개 웹훅 참조 모양 { eventType, createdAt, version, eventId, entityType, entityBody }다(tossWebhookBody, 시험 리뷰 TR-03).
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { ReceiveSettlementWebhook } from '../src/modules/settlement/application/receive-settlement-webhook.js';
import { PaymentModule } from '../src/modules/payment/payment.module.js';
import type { PaymentCommandLog, PaymentCommandSignals, PaymentCommandStore, PaymentGateways, PaymentStateReader, PaymentWebhookLog, PaymentWebhookSignals, PaymentWebhookStore } from '../src/modules/payment/domain/ports.js';
import { quiet } from './settlement-flow-support.js';
import { kst, tossHarness, type TossHarness } from './support/toss-harness.js';
import { tossWebhookBody } from './support/toss-payout-fake.js';

const NOW = kst('2026-12-07T15:00:00.000');
const PAYOUT_DATE = '2026-12-07';
const MIN = 60_000;

let h: TossHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const sign = (body: string, time: string, keyHex: string) => `v1:${createHmac('sha256', keyHex).update(`${body}:${time}`).digest('base64')}`;
const headers = (o: { signature: string; time: string; id?: string }) => ({ 'tosspayments-webhook-signature': o.signature, 'tosspayments-webhook-transmission-time': o.time, 'tosspayments-webhook-transmission-id': o.id ?? `tx-${randomUUID()}` });

/** 실행까지 마친 토스 지급 건 하나(결제사 지급 ID가 있다)와 수신기 */
async function paidOut() {
  // 지급일 전 영업일(금) 10:00에 실행하고, 지급일(월) 15:00에 웹훅을 받는다
  const x = (h = await tossHarness({ now: kst('2026-12-04T10:00:00.000') }));
  const promoterId = randomUUID();
  await x.partner(promoterId);
  const s = await x.confirmed({ promoterId, amount: 2_345_678, payoutDate: PAYOUT_DATE });
  const batchId = await x.approvedBatch({ payoutDate: PAYOUT_DATE });
  await x.settlements.executeBatch(batchId);
  x.at(NOW);
  const [payout] = x.payoutsOf(s.statementId);
  const receiver = new ReceiveSettlementWebhook({ config: x.config, transport: x.transport, settlements: x.settlements, store: x.store, now: () => new Date(x.clock.now()), log: x.log, signals: x.signals });
  return { x, s, payout: payout!, batchId, receiver };
}

describe('J-T16 늦은 지급 웹훅', () => {
  test('J-T16 서명이 맞고 전송 시각이 10분 전이면 본문 상태를 쓰지 않고 settlement_webhook_late를 남긴 뒤 단건 조회 결과로만 확정한다 [ASVS v5.0.0-16.3.3]', async () => {
    const { x, s, payout, receiver } = await paidOut();
    x.fake.setPayout(payout.pgPayoutId!, 'COMPLETED');
    // 본문은 FAILED라고 거짓말한다
    const eventId = `evt-${randomUUID()}`;
    const body = tossWebhookBody('payout.changed', { id: payout.pgPayoutId!, status: 'FAILED' }, { eventId });
    const time = new Date(NOW - 10 * MIN).toISOString();
    const id = `tx-${randomUUID()}`;
    const getsBefore = x.fake.calls('GET', /^\/v2\/payouts\//).length;
    expect(await receiver.receive(headers({ signature: sign(body, time, x.keys.STANDARD.current), time, id }), Buffer.from(body))).toBe('ACCEPTED');
    expect(x.fake.calls('GET', /^\/v2\/payouts\//).slice(getsBefore).map((r) => r.path)).toEqual([`/v2/payouts/${payout.pgPayoutId}`]);
    expect(x.store.payouts.get(payout.payoutId)).toMatchObject({ status: 'COMPLETED', errorCode: null });
    expect(x.store.statements.get(s.statementId)?.status).toBe('PAID');
    expect(x.events('PAYOUT_COMPLETED')).toEqual([expect.objectContaining({ statementId: s.statementId, amount: 2_345_678 })]);
    expect(x.events('PAYOUT_FAILED')).toEqual([]);
    const late = x.lines.filter((l) => l.event === 'settlement_webhook_late');
    expect(late).toEqual([expect.objectContaining({ transmissionId: id, sentAt: time })]);
    expect(x.store.webhookEvents.has(eventId)).toBe(true);
    // 같은 eventId를 새 전송 ID로 다시 보내면(결제사 재전송) 처리하지 않는다(조회·사건 0)
    const again = await receiver.receive(headers({ signature: sign(body, time, x.keys.STANDARD.current), time, id: `tx-${randomUUID()}` }), Buffer.from(body));
    expect(again).toBe('ACCEPTED');
    expect(x.fake.calls('GET', /^\/v2\/payouts\//).length - getsBefore).toBe(1);
    expect(x.events('PAYOUT_COMPLETED')).toHaveLength(1);
    // 전송 ID는 중복 제거 열쇠가 아니다: 같은 전송 ID라도 새 eventId면 처리한다(단건 조회 한 번 더, 이미 끝난 지급이라 사건은 그대로)
    const other = tossWebhookBody('payout.changed', { id: payout.pgPayoutId!, status: 'COMPLETED' });
    expect(await receiver.receive(headers({ signature: sign(other, time, x.keys.STANDARD.current), time, id }), Buffer.from(other))).toBe('ACCEPTED');
    expect(x.fake.calls('GET', /^\/v2\/payouts\//).length - getsBefore).toBe(2);
    expect(x.events('PAYOUT_COMPLETED')).toHaveLength(1);
  });

  test('J-T16 늦음의 경계: 5분까지는 늦은 웹훅이 아니고 5분 1밀리초부터 늦은 웹훅이며, 어느 쪽이든 단건 조회로 확정한다', async () => {
    const { x, payout, receiver } = await paidOut();
    x.fake.setPayout(payout.pgPayoutId!, 'IN_PROGRESS');
    const cases = [
      { ago: 5 * MIN - 1, late: false },
      { ago: 5 * MIN, late: false },
      { ago: 5 * MIN + 1, late: true },
    ];
    for (const c of cases) {
      const time = new Date(NOW - c.ago).toISOString();
      const id = `tx-${c.ago}`;
      const body = tossWebhookBody('payout.changed', { id: payout.pgPayoutId!, status: 'COMPLETED' });
      expect(await receiver.receive(headers({ signature: sign(body, time, x.keys.STANDARD.current), time, id }), Buffer.from(body))).toBe('ACCEPTED');
      expect([c.ago, x.lines.some((l) => l.event === 'settlement_webhook_late' && l.transmissionId === id)]).toEqual([c.ago, c.late]);
    }
    // 본문은 COMPLETED지만 조회는 IN_PROGRESS라 끝나지 않았다
    expect(x.store.payouts.get(payout.payoutId)?.status).toBe('IN_PROGRESS');
    expect(x.events('PAYOUT_COMPLETED')).toEqual([]);
    expect(x.fake.calls('GET', /^\/v2\/payouts\//)).toHaveLength(3);
  });

  test('J-T16 단건 조회가 실패하면 503(STORE_FAILED)이고 eventId를 기록하지 않아, 같은 eventId가 새 전송 ID로 다시 오면 처리한다', async () => {
    const { x, s, payout, receiver } = await paidOut();
    x.fake.setPayout(payout.pgPayoutId!, 'COMPLETED');
    const eventId = `evt-${randomUUID()}`;
    const body = tossWebhookBody('payout.changed', { id: payout.pgPayoutId!, status: 'COMPLETED' }, { eventId });
    const time = new Date(NOW).toISOString();
    const id = `tx-${randomUUID()}`;
    x.fake.inject({ method: 'GET', path: /^\/v2\/payouts\// }, 'NO_RESPONSE');
    expect(await receiver.receive(headers({ signature: sign(body, time, x.keys.STANDARD.current), time, id }), Buffer.from(body))).toBe('STORE_FAILED');
    expect(x.store.webhookEvents.has(eventId)).toBe(false);
    expect(x.store.statements.get(s.statementId)?.status).not.toBe('PAID');
    expect(await receiver.receive(headers({ signature: sign(body, time, x.keys.STANDARD.current), time, id: `tx-${randomUUID()}` }), Buffer.from(body))).toBe('ACCEPTED');
    expect(x.store.statements.get(s.statementId)?.status).toBe('PAID');
    expect(x.store.webhookEvents.has(eventId)).toBe(true);
  });
});

describe('J-T6 웹훅 서명(수신기 경계)', () => {
  test('J-T6 서명이 틀리면 REJECTED·settlement_webhook_signature_invalid(전송 ID·시각, 키·본문 없음)·지표 1이고 조회·상태 변경이 없다 [ASVS v5.0.0-11.4.1] [ASVS v5.0.0-16.3.3]', async () => {
    const { x, payout, receiver } = await paidOut();
    x.fake.setPayout(payout.pgPayoutId!, 'COMPLETED');
    const body = tossWebhookBody('payout.changed', { id: payout.pgPayoutId!, status: 'COMPLETED' });
    const time = new Date(NOW).toISOString();
    const gets = x.fake.calls('GET', /^\/v2\/payouts\//).length;
    // 본문만 서명한 값(옛 원문)은 거절한다
    const bodyOnly = `v1:${createHmac('sha256', x.keys.STANDARD.current).update(body).digest('base64')}`;
    expect(await receiver.receive(headers({ signature: bodyOnly, time, id: 'tx-body-only' }), Buffer.from(body))).toBe('REJECTED');
    // 모르는 키는 거절한다(서명이 틀리면 늦어도 늦은 웹훅이 아니라 서명 불일치다)
    const lateTime = new Date(NOW - 10 * MIN).toISOString();
    expect(await receiver.receive(headers({ signature: sign(body, lateTime, 'f'.repeat(64)), time: lateTime, id: 'tx-unknown-key' }), Buffer.from(body))).toBe('REJECTED');
    expect(x.fake.calls('GET', /^\/v2\/payouts\//)).toHaveLength(gets);
    expect(x.store.payouts.get(payout.payoutId)?.status).toBe('REQUESTED');
    const invalid = x.lines.filter((l) => l.event === 'settlement_webhook_signature_invalid');
    expect(invalid.map((l) => l.transmissionId)).toEqual(['tx-body-only', 'tx-unknown-key']);
    expect(x.lines.some((l) => l.event === 'settlement_webhook_late')).toBe(false);
    expect(JSON.stringify(invalid)).not.toContain(x.keys.STANDARD.current);
    expect(JSON.stringify(invalid)).not.toContain(body);
    expect(await x.metricValue('settlement_webhook_signature_invalid_total')).toBe(2);
  });

  test('J-T6 키 교체 중: 두 상점의 지금·옛 키 가운데 하나로 서명한 것이 넷 가운데 하나만 있어도 받고, 받은 뒤 단건 조회로 확정한다', async () => {
    const { x, s, payout, receiver } = await paidOut();
    x.fake.setPayout(payout.pgPayoutId!, 'COMPLETED');
    const body = tossWebhookBody('payout.changed', { id: payout.pgPayoutId!, status: 'COMPLETED' });
    const time = new Date(NOW).toISOString();
    const four = [sign(body, time, 'a'.repeat(64)), sign(body, time, x.keys.ESCROW.old), sign(body, time, 'b'.repeat(64)), sign(body, time, 'c'.repeat(64))].join(',');
    expect(await receiver.receive(headers({ signature: four, time }), Buffer.from(body))).toBe('ACCEPTED');
    expect(x.store.statements.get(s.statementId)?.status).toBe('PAID');
    expect(x.fake.calls('GET', /^\/v2\/payouts\//)).toHaveLength(1);
  });

  test('J-T6 모르는 지급 ID·셀러 ID는 받기만 하고(결제사 재전송을 막는다) 아무것도 바꾸지 않는다', async () => {
    const { x, receiver } = await paidOut();
    const time = new Date(NOW).toISOString();
    for (const body of [tossWebhookBody('payout.changed', { id: 'FPAY-UNKNOWN', status: 'COMPLETED' }), tossWebhookBody('seller.changed', { id: 'FSEL-UNKNOWN', status: 'APPROVED' })]) {
      expect(await receiver.receive(headers({ signature: sign(body, time, x.keys.STANDARD.current), time }), Buffer.from(body))).toBe('ACCEPTED');
    }
    expect(x.events('PAYOUT_COMPLETED')).toEqual([]);
    expect(x.fake.calls('GET', /^\/v2\/(payouts|sellers)\//)).toHaveLength(0);
  });
});

describe('J-T16·J-T6 HTTP /v1/webhooks/toss', () => {
  test('J-T16 늦었지만 서명이 맞은 웹훅은 200이고 틀린 서명은 400이다', async () => {
    const { x, s, payout, receiver } = await paidOut();
    x.fake.setPayout(payout.pgPayoutId!, 'COMPLETED');
    const outcomes: string[] = [];
    const module = PaymentModule.register({
      store: { store: async () => Promise.reject(new Error('쓰지 않는다')) } satisfies PaymentCommandStore,
      reader: { batchGet: async () => [] } satisfies PaymentStateReader,
      log: { mismatch: () => undefined } satisfies PaymentCommandLog,
      signals: { confirmCommand: () => undefined, batchGet: () => undefined } satisfies PaymentCommandSignals,
      webhook: {
        store: { receive: async () => Promise.reject(new Error('쓰지 않는다')) } satisfies PaymentWebhookStore,
        gateways: { of: () => undefined } satisfies PaymentGateways,
        log: { invalid: () => undefined, pgMismatch: () => undefined, storeFailed: () => undefined, depositSecretMismatch: () => undefined } satisfies PaymentWebhookLog,
        signals: { outcome: (_pg: string, o: string) => void outcomes.push(o) } satisfies PaymentWebhookSignals,
        allowSimulator: false,
      },
      settlementWebhook: receiver,
    });
    const svc = await createService({ name: 'payment-svc', module, env: { PEAKET_ENV: 'ci' }, clock: x.clock, logDestination: quiet() });
    try {
      const body = tossWebhookBody('payout.changed', { id: payout.pgPayoutId!, status: 'FAILED' });
      const time = new Date(NOW - 10 * MIN).toISOString();
      const ok = await svc.http.inject({ method: 'POST', url: '/v1/webhooks/toss', headers: { 'content-type': 'application/json', ...headers({ signature: sign(body, time, x.keys.STANDARD.current), time }) }, payload: body });
      expect(ok.statusCode).toBe(200);
      expect(x.store.statements.get(s.statementId)?.status).toBe('PAID');
      const bad = await svc.http.inject({ method: 'POST', url: '/v1/webhooks/toss', headers: { 'content-type': 'application/json', ...headers({ signature: 'v1:AAAA', time }) }, payload: body });
      expect(bad.statusCode).toBe(400);
      expect(outcomes).toEqual([]);
    } finally {
      await svc.close();
    }
  });
});
