// J-T37 ⑤⑥ 토스 지급대행 설정과 start.ts 조립(F-07-6 LCH-110, settlement §8 비밀·키 교체, ADR-0369 결정 2·5).
// ⑤ 결제 상점마다 시크릿 키·보안 키(64자 hex, 쉼표로 이은 지금·옛 키)가 다 있어야 서고, 반만 있거나 모양이 틀리면 시작하지 않는다.
// ⑥ start.ts의 조립 함수 assembleTossPayout을 시험 조립(tossHarness)과 따로 불러, 설정이 있으면 실제 전송·지급 어댑터·잔액 원천·수신기를,
//    없으면 503 어댑터와 '설정 없음' 수신기(정산 사건 400, 결제 웹훅 경로로 넘기지 않음)를 쓰는지 본다. 결제사 대신 시험 안 대역 서버를 부른다.
//    start() 자체가 반쯤 된 설정을 듣기 전에 거부하는지도 여기서 보고(시험 리뷰 TR-01 (가)), 실제 PostgreSQL로 띄운 start()의 웹훅·셀러 등록 경로는
//    test-int/settlement-toss-start.int.test.ts가 본다(TR-01 (나)(다)). 수신기는 createWebhook으로 묶고(TR-16), 쓴 주소는 baseUrl로 나온다(TR-04).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { assembleTossPayout } from '../src/start.js';
import { PaymentModule } from '../src/modules/payment/payment.module.js';
import type { PaymentCommandLog, PaymentCommandSignals, PaymentCommandStore, PaymentGateways, PaymentStateReader, PaymentWebhookLog, PaymentWebhookSignals, PaymentWebhookStore } from '../src/modules/payment/domain/ports.js';
import { HttpTossPayoutTransport } from '../src/modules/settlement/adapters/http-toss-payout-transport.js';
import { tossPayoutConfigured, tossPayoutTerms } from '../src/modules/settlement/domain/payout-adapters.js';
import {
  HttpPgBalanceSource,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  Settlements,
  settlementApprovalLog,
  TossPayoutGateway,
  UnavailableTossPayoutGateway,
  type PayoutBatchRecord,
} from '../src/modules/settlement/index.js';
import { collectingLogger, quiet } from './settlement-flow-support.js';
import { kst } from './support/toss-harness.js';
import { startTossPayoutFake, tossWebhookBody, type TossPayoutFake } from './support/toss-payout-fake.js';
import { noApprovals, noSaleSuspensions } from './settlement-support.js';

const NOW = kst('2026-12-04T10:00:00.000');
const hex64 = () => randomBytes(32).toString('hex');

let fake: TossPayoutFake | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('J-T37 ⑤ 결제 상점별 설정', () => {
  test('J-T37 ⑤ 두 상점 모두 비면 undefined이고, 옛 이름 넷(API 키·JWE 키 ID·공개 키·웹훅 비밀)만으로는 서지 않는다', () => {
    expect(tossPayoutConfigured({})).toBeUndefined();
    expect(
      tossPayoutConfigured({
        PEAKET_PG_TOSS_PAYOUT_API_KEY: 'k',
        PEAKET_PG_TOSS_PAYOUT_JWE_KEY_ID: 'id',
        PEAKET_PG_TOSS_PAYOUT_JWE_PUBLIC_KEY: 'pem',
        PEAKET_PG_TOSS_PAYOUT_WEBHOOK_SECRETS: 'a,b',
      }),
    ).toBeUndefined();
  });

  test('J-T37 ⑤ 한 상점의 시크릿 키와 보안 키(쉼표로 이은 지금·옛 키)가 다 있으면 그 상점만 서고 첫째가 지금 키다', () => {
    const current = hex64();
    const old = hex64();
    const config = tossPayoutConfigured({ PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_ESCROW: 'test_sk_escrow', PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_ESCROW: `${current}, ${old}` });
    expect(config?.stores.STANDARD).toBeUndefined();
    const escrow = config?.stores.ESCROW;
    expect(escrow?.secretKey).toBe('test_sk_escrow');
    expect(escrow?.securityKeys.map((k) => k.toString('hex'))).toEqual([current, old]);
    expect(escrow?.securityKeys.map((k) => k.length)).toEqual([32, 32]);
  });

  test('J-T37 ⑤ 시크릿 키나 보안 키 하나만 있으면 던지고, 메시지에 빠진 환경 이름은 있고 키 값은 없다', () => {
    const key = hex64();
    let message = '';
    try {
      tossPayoutConfigured({ PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_STANDARD: 'test_sk_only_secret' });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_STANDARD');
    expect(message).not.toContain('test_sk_only_secret');
    expect(() => tossPayoutConfigured({ PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_ESCROW: key })).toThrow(/PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_ESCROW/);
    // 한 상점은 다 있고 다른 상점이 반만 있어도 시작하지 않는다
    expect(() =>
      tossPayoutConfigured({ PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_STANDARD: 'sk', PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_STANDARD: key, PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_ESCROW: 'sk2' }),
    ).toThrow(/PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_ESCROW/);
  });

  test('J-T37 ⑤ 보안 키가 63자·65자·hex 아님이면 던지고(옛 키 자리도), 64자 hex만 받는다', () => {
    const env = (keys: string) => ({ PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_STANDARD: 'sk', PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_STANDARD: keys });
    const ok = hex64();
    const bad = [ok.slice(0, 63), `${ok}a`, 'g'.repeat(64), `${ok},${ok.slice(0, 63)}`, `${ok},`];
    for (const keys of bad) {
      let message = '';
      try {
        tossPayoutConfigured(env(keys));
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect([keys.length, message]).toEqual([keys.length, expect.stringContaining('PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_STANDARD')]);
      expect(message).not.toContain(ok);
    }
    expect(tossPayoutConfigured(env(ok))?.stores.STANDARD?.securityKeys).toHaveLength(1);
  });

  test('J-T37 ⑤ 지급대행 이용료 설정은 공개 안내 값(월 30만 원·무료 1,000건·건당 100원)이 기본이고 음수·정수 아님은 던진다', () => {
    expect(tossPayoutTerms({})).toEqual({ feeMonthlyKrw: 300_000, feeFreeCount: 1_000, feePerItemKrw: 100 });
    expect(tossPayoutTerms({ PEAKET_TOSS_PAYOUT_FEE_MONTHLY_KRW: '250000', PEAKET_TOSS_PAYOUT_FEE_FREE_COUNT: '7', PEAKET_TOSS_PAYOUT_FEE_PER_ITEM_KRW: '130' })).toEqual({ feeMonthlyKrw: 250_000, feeFreeCount: 7, feePerItemKrw: 130 });
    expect(tossPayoutTerms({ PEAKET_TOSS_PAYOUT_FEE_FREE_COUNT: '0' })).toEqual({ feeMonthlyKrw: 300_000, feeFreeCount: 0, feePerItemKrw: 100 });
    expect(() => tossPayoutTerms({ PEAKET_TOSS_PAYOUT_FEE_MONTHLY_KRW: '-1' })).toThrow();
    expect(() => tossPayoutTerms({ PEAKET_TOSS_PAYOUT_FEE_PER_ITEM_KRW: '1.5' })).toThrow();
    expect(() => tossPayoutTerms({ PEAKET_TOSS_PAYOUT_FEE_FREE_COUNT: 'many' })).toThrow();
  });
});

/** 결제 웹훅 경로의 짝 가짜들(포트 그대로). 정산 사건이 이 경로로 넘어오면 signals.outcome이 불린다 */
function paymentModuleDeps(settlementWebhook: { receive(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<'ACCEPTED' | 'REJECTED' | 'IGNORED' | 'STORE_FAILED'> }) {
  const outcomes: string[] = [];
  const store = { store: async () => Promise.reject(new Error('쓰지 않는다')) } satisfies PaymentCommandStore;
  const reader = { batchGet: async () => [] } satisfies PaymentStateReader;
  const log = { mismatch: () => undefined } satisfies PaymentCommandLog;
  const signals = { confirmCommand: () => undefined, batchGet: () => undefined } satisfies PaymentCommandSignals;
  const webhookStore = { receive: async () => Promise.reject(new Error('정산 사건은 결제 웹훅 저장소에 오지 않는다')) } satisfies PaymentWebhookStore;
  const gateways = { of: () => undefined } satisfies PaymentGateways;
  const webhookLog = { invalid: () => undefined, pgMismatch: () => undefined, storeFailed: () => undefined, depositSecretMismatch: () => undefined } satisfies PaymentWebhookLog;
  const webhookSignals = { outcome: (_pg: string, outcome: string) => void outcomes.push(outcome) } satisfies PaymentWebhookSignals;
  return {
    outcomes,
    module: PaymentModule.register({ store, reader, log, signals, webhook: { store: webhookStore, gateways, log: webhookLog, signals: webhookSignals, allowSimulator: false }, settlementWebhook }),
  };
}

describe('J-T37 ⑤ start()가 반쯤 된 설정을 듣기 전에 거부한다(시험 리뷰 TR-01 (가))', () => {
  // J-T35 ⑦(settlement-business-calendar.test.ts)과 같이 닿지 않는 DB 주소로 띄운다. 설정 검사가 DB·포트보다 먼저여야 한다
  const base = { PEAKET_ENV: 'ci', PEAKET_DATABASE_URL: 'postgres://peaket@127.0.0.1:1/never' };
  const failureOf = async (env: Record<string, string>): Promise<string> => {
    const { start } = await import('../src/start.js');
    return start({ env: { ...base, ...env }, logDestination: quiet() }).then(
      async (svc) => {
        await svc.close();
        return '시작했다';
      },
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
  };

  test('J-T37 ⑤ 시크릿 키만 있으면 start()가 거부하고, 메시지에 빠진 환경 이름은 있고 키 값은 없다', async () => {
    const message = await failureOf({ PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_STANDARD: 'test_sk_partial_only' });
    expect(message).toContain('PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_STANDARD');
    expect(message).not.toContain('test_sk_partial_only');
    // start.ts 첫 가져오기가 무거워(서비스 전체 모듈) 전체 실행 부하에서 기본 5초를 넘긴 적이 있다(J-T35 ⑦ 같은 꼴). 이 시험만 30초
  }, 30_000);

  test('J-T37 ⑤ 보안 키가 63자면 start()가 거부하고, 메시지에 키 값이 없다', async () => {
    const short = hex64().slice(0, 63);
    const message = await failureOf({ PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_ESCROW: 'sk', PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_ESCROW: short });
    expect(message).toContain('PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_ESCROW');
    expect(message).not.toContain(short);
  }, 30_000);
});

describe('J-T37 ⑥ start.ts 조립', () => {
  const stdEnv = () => {
    const current = hex64();
    return { current, env: { PEAKET_ENV: 'ci', PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_STANDARD: 'test_sk_std_assembly', PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_STANDARD: current } };
  };
  /** createWebhook에 넘길 정산 쓰임새(진짜 Settlements·메모리 저장소) */
  const settlementsFor = (log: ReturnType<typeof settlementApprovalLog>) => {
    const store = new MemorySettlementStore();
    const settlements = new Settlements({ store, payments: new MemorySettlementPaymentSource(), approvals: noApprovals, saleSuspensions: noSaleSuspensions, gateways: [new UnavailableTossPayoutGateway()], reauth: new MemoryReauthVerifier(), clock: fakeClock({ now: NOW }), log });
    return { store, settlements, log };
  };

  test('J-T37 ⑥ 설정이 있으면 실제 전송·지급 어댑터·잔액 원천을 내고, 잔액 원천이 그 상점 키로 대역 서버를 부른다', async () => {
    const { current, env } = stdEnv();
    fake = await startTossPayoutFake({
      STANDARD: { secretKey: 'test_sk_std_assembly', securityKey: Buffer.from(current, 'hex') },
      ESCROW: { secretKey: 'unused-escrow', securityKey: randomBytes(32) },
    });
    fake.balances.STANDARD = { available: 7_000_001, pending: 30_000 };
    const { logger } = collectingLogger(() => NOW);
    const a = assembleTossPayout(env, { baseUrl: fake.url, clock: fakeClock({ now: NOW }), log: logger });
    expect(a.gateway).toBeInstanceOf(TossPayoutGateway);
    expect(a.transport).toBeInstanceOf(HttpTossPayoutTransport);
    expect(a.pgBalance).toBeInstanceOf(HttpPgBalanceSource);
    expect(a.baseUrl).toBe(fake.url);
    expect(await a.pgBalance!.available({ pg: 'TOSS', pgStore: 'STANDARD' })).toEqual({ availableAmount: 7_000_001, pendingAmount: 30_000 });
    expect(fake.calls('GET', /^\/v2\/balances$/).map((r) => r.store)).toEqual(['STANDARD']);
  });

  test('J-T37 ⑥ PEAKET_PG_TOSS_PAYOUT_BASE_URL은 local·ci에서만 읽어 대역 서버를 부른다', async () => {
    const { current, env } = stdEnv();
    fake = await startTossPayoutFake({
      STANDARD: { secretKey: 'test_sk_std_assembly', securityKey: Buffer.from(current, 'hex') },
      ESCROW: { secretKey: 'unused-escrow', securityKey: randomBytes(32) },
    });
    const { logger } = collectingLogger(() => NOW);
    const a = assembleTossPayout({ ...env, PEAKET_PG_TOSS_PAYOUT_BASE_URL: fake.url }, { clock: fakeClock({ now: NOW }), log: logger });
    expect(a.baseUrl).toBe(fake.url);
    await a.transport!.balance('STANDARD');
    expect(fake.calls('GET', /^\/v2\/balances$/)).toHaveLength(1);
  });

  test('J-T37 ⑥ 주소 덮어쓰기 허용 목록: local·ci는 환경 값, prod·staging·demo·PEAKET_ENV 없음은 같은 값이 있어도 https://api.tosspayments.com이고, deps.baseUrl이 환경보다 먼저다(시험 리뷰 TR-04)', () => {
    const { env } = stdEnv();
    const { logger } = collectingLogger(() => NOW);
    const leak = 'http://127.0.0.1:9/elsewhere';
    // 결제사는 부르지 않는다(조립만 하고 쓴 주소를 읽는다)
    const used = (peaketEnv: string | undefined) => {
      const e: Record<string, string | undefined> = { ...env, PEAKET_ENV: peaketEnv, PEAKET_PG_TOSS_PAYOUT_BASE_URL: leak };
      return assembleTossPayout(e, { clock: fakeClock({ now: NOW }), log: logger }).baseUrl;
    };
    expect([used('local'), used('ci')]).toEqual([leak, leak]);
    for (const peaketEnv of ['prod', 'staging', 'demo', undefined]) expect([peaketEnv, used(peaketEnv)]).toEqual([peaketEnv, 'https://api.tosspayments.com']);
    expect(assembleTossPayout({ ...env, PEAKET_PG_TOSS_PAYOUT_BASE_URL: leak }, { baseUrl: 'http://127.0.0.1:8/first', clock: fakeClock({ now: NOW }), log: logger }).baseUrl).toBe('http://127.0.0.1:8/first');
    expect(assembleTossPayout({ ...env }, { clock: fakeClock({ now: NOW }), log: logger }).baseUrl).toBe('https://api.tosspayments.com');
  });

  test('J-T37 ⑥ 설정이 있으면 createWebhook이 묶은 수신기가 서명을 견주고, 틀린 서명은 REJECTED와 보안 로그다 [ASVS v5.0.0-16.3.3]', async () => {
    const { env } = stdEnv();
    const { lines, logger } = collectingLogger(() => NOW);
    const a = assembleTossPayout(env, { baseUrl: 'http://127.0.0.1:9', clock: fakeClock({ now: NOW }), log: logger });
    const webhook = a.createWebhook(settlementsFor(settlementApprovalLog(logger)));
    const body = tossWebhookBody('payout.changed', { id: 'FPAY000001', status: 'COMPLETED' });
    const answer = await webhook.receive(
      { 'tosspayments-webhook-signature': `v1:${Buffer.from('nope').toString('base64')}`, 'tosspayments-webhook-transmission-time': new Date(NOW).toISOString(), 'tosspayments-webhook-transmission-id': 'tx-assembly-1' },
      Buffer.from(body),
    );
    expect(answer).toBe('REJECTED');
    expect(lines.filter((l) => l.event === 'settlement_webhook_signature_invalid').map((l) => l.transmissionId)).toEqual(['tx-assembly-1']);
  });

  test('J-T37 ⑥ 설정이 없으면 지급은 503, 잔액·전송은 없음, 정산 사건 웹훅은 REJECTED와 설정 없음 로그다', async () => {
    const { lines, logger } = collectingLogger(() => NOW);
    const a = assembleTossPayout({ PEAKET_ENV: 'ci' }, { clock: fakeClock({ now: NOW }), log: logger });
    expect(a.gateway).toBeInstanceOf(UnavailableTossPayoutGateway);
    expect(a.transport).toBeUndefined();
    expect(a.pgBalance).toBeUndefined();
    const batch: PayoutBatchRecord = {
      batchId: 'b-1',
      pg: 'TOSS',
      pgStore: 'STANDARD',
      payoutDate: '2026-12-07',
      totalAmount: 10_000,
      statementCount: 1,
      approvalId: 'a-1',
      portoneBulkPayoutId: null,
      pgBalanceKrw: null,
      pgBalanceSource: null,
      pgBalanceObservedAt: null,
      pgBalanceObservedBy: null,
      pgBalanceLedgerKrw: null,
      status: 'APPROVED',
      submitAttempts: 0,
      nextSubmitAt: null,
      submitDeadlineAt: null,
      lastSubmitError: null,
      dateRetryUsed: false,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    };
    await expect(a.gateway.submit({ batch, payouts: [], tossSellerIds: {} })).rejects.toMatchObject({ status: 503, type: expect.stringContaining('payout-gateway-unavailable') });
    const webhook = a.createWebhook(settlementsFor(settlementApprovalLog(logger)));
    const body = tossWebhookBody('seller.changed', { id: 'FSEL000001', status: 'APPROVED' });
    expect(await webhook.receive({ 'tosspayments-webhook-transmission-id': 'tx-1', 'tosspayments-webhook-transmission-time': new Date(NOW).toISOString(), 'tosspayments-webhook-signature': 'v1:x' }, Buffer.from(body))).toBe('REJECTED');
    expect(lines.filter((l) => l.event === 'settlement_webhook_unconfigured')).toHaveLength(1);
  });

  test('J-T37 ⑥ 설정이 없으면 /v1/webhooks/toss의 payout.changed·seller.changed는 400이고 결제 웹훅 처리로 넘어가지 않는다', async () => {
    const { logger } = collectingLogger(() => NOW);
    const a = assembleTossPayout({ PEAKET_ENV: 'ci' }, { clock: fakeClock({ now: NOW }), log: logger });
    const deps = paymentModuleDeps(a.createWebhook(settlementsFor(settlementApprovalLog(logger))));
    const svc = await createService({ name: 'payment-svc', module: deps.module, env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW }), logDestination: quiet() });
    try {
      const post = (payload: string) =>
        svc.http.inject({
          method: 'POST',
          url: '/v1/webhooks/toss',
          headers: { 'content-type': 'application/json', 'tosspayments-webhook-transmission-id': `tx-${randomUUID()}`, 'tosspayments-webhook-transmission-time': new Date(NOW).toISOString(), 'tosspayments-webhook-signature': 'v1:x' },
          payload,
        });
      expect((await post(tossWebhookBody('payout.changed', { id: 'FPAY000001', status: 'COMPLETED' }))).statusCode).toBe(400);
      expect((await post(tossWebhookBody('seller.changed', { id: 'FSEL000001', status: 'APPROVED' }))).statusCode).toBe(400);
      expect(deps.outcomes).toEqual([]);
      // 결제 사건은 그대로 결제 웹훅 경로가 받는다(여기서는 어댑터가 없어 no_adapter)
      await post(JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'pk', orderId: 'o', status: 'DONE' } }));
      expect(deps.outcomes).toEqual(['no_adapter']);
    } finally {
      await svc.close();
    }
  });
});
