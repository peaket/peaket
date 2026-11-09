// 웹훅 받기의 규칙과 쓰임새(docs/features/payment.md §5 '웹훅 받기의 첫 구현', BUILD_ORDER HOT-150, P-T8·P-T16·P-T17·P-T30). DB 없이 저장소를 대역으로 돈다. 실제 PostgreSQL·HTTP는 test-int/payment-webhook.int.test.ts다.
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { createPlatformLogger, type Database, fakeClock, PlatformMetrics } from '@peaket/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { webhookAcceptsSimulator } from '../src/config.js';
import type { PaymentGatewayPort, PgName, WebhookParseResult } from '../src/modules/payment/domain/payment-gateway.js';
import type { PaymentGateways, PaymentWebhookLog, PaymentWebhookStore, WebhookReceiveRequest, WebhookReceiveResult, WebhookRejectReason } from '../src/modules/payment/domain/ports.js';
import {
  decideWebhookLedger,
  DrizzleWebhookStore,
  PAYMENT_WEBHOOK_OUTCOMES,
  paymentWebhookLog,
  type PaymentWebhookOutcome,
  PromPaymentWebhookSignals,
  ReceivePaymentWebhook,
  WEBHOOK_DB_MAX,
  webhookDatabaseOptions,
  type WebhookLedgerRow,
  type WebhookRoute,
  webhookRoutePgs,
  webhookRouteRejects,
} from '../src/modules/payment/server.js';

const row = (o: Partial<WebhookLedgerRow> = {}): WebhookLedgerRow => ({ paymentId: 'p-1', orderId: 'o-1', pg: 'TOSS', status: 'UNKNOWN', ...o });

describe('경로가 받는 결제사', () => {
  it('P-T30_토스 경로는 TOSS만, local·ci에서는 SIMULATOR도 받는다', () => {
    expect(webhookRoutePgs('toss', false)).toEqual(['TOSS']);
    expect(webhookRoutePgs('toss', true)).toEqual(['TOSS', 'SIMULATOR']);
  });

  it('P-T30_포트원 경로는 PORTONE만 받는다(시뮬레이터를 켜도 그대로)', () => {
    expect(webhookRoutePgs('portone', false)).toEqual(['PORTONE']);
    expect(webhookRoutePgs('portone', true)).toEqual(['PORTONE']);
  });

  it('P-T17_서명을 쓰는 포트원 경로만 거절을 4xx로 답한다', () => {
    expect(webhookRouteRejects('portone')).toBe(true);
    expect(webhookRouteRejects('toss')).toBe(false);
  });
});

describe('원장을 본 판단', () => {
  it('P-T8_원장에 없으면 먼저 온 웹훅이다', () => {
    expect(decideWebhookLedger(undefined, ['TOSS'])).toEqual({ kind: 'LEDGER_NOT_FOUND' });
  });

  it('P-T30_결제사가 다르면 UNKNOWN이어도 신호를 내지 않는다(경로 대조가 상태보다 먼저다) [ASVS v5.0.0-8.2.2]', () => {
    expect(decideWebhookLedger(row({ pg: 'PORTONE' }), ['TOSS'])).toEqual({ kind: 'PG_MISMATCH', orderId: 'o-1', ledgerPg: 'PORTONE' });
    expect(decideWebhookLedger(row({ pg: 'PORTONE', status: 'APPROVED' }), ['TOSS'])).toEqual({ kind: 'PG_MISMATCH', orderId: 'o-1', ledgerPg: 'PORTONE' });
  });

  it('P-T8_UNKNOWN이면 조회 신호다', () => {
    expect(decideWebhookLedger(row(), ['TOSS'])).toEqual({ kind: 'QUERY_SIGNAL', paymentId: 'p-1', orderId: 'o-1' });
  });

  it.each(['ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED'] as const)('P-T8_%s이면 신호 없이 지표만이다', (status) => {
    expect(decideWebhookLedger(row({ status }), ['TOSS'])).toEqual({ kind: 'STATE_IGNORED', paymentId: 'p-1', orderId: 'o-1' });
  });

  it('P-T30_허용한 결제사 가운데 하나면 된다(local·ci의 시뮬레이터)', () => {
    expect(decideWebhookLedger(row({ pg: 'SIMULATOR' }), ['TOSS', 'SIMULATOR']).kind).toBe('QUERY_SIGNAL');
  });
});

class RecordingLog implements PaymentWebhookLog {
  readonly invalids: { route: WebhookRoute; pg: PgName; reason: WebhookRejectReason }[] = [];
  readonly mismatches: { route: WebhookRoute; pg: PgName; ledgerPg: PgName; orderId: string }[] = [];
  readonly failures: { route: WebhookRoute; pg: PgName; code: string }[] = [];
  invalid(e: RecordingLog['invalids'][number]): void {
    this.invalids.push(e);
  }
  pgMismatch(e: RecordingLog['mismatches'][number]): void {
    this.mismatches.push(e);
  }
  storeFailed(e: RecordingLog['failures'][number]): void {
    this.failures.push(e);
  }
  depositSecretMismatch(): void {
    // 이 파일의 시험은 입금 통보를 보지 않는다(test/virtual-account-deposit.test.ts)
  }
}

class RecordingStore implements PaymentWebhookStore {
  readonly requests: WebhookReceiveRequest[] = [];
  answer: WebhookReceiveResult | Error = { kind: 'QUERY_SIGNAL', paymentId: 'p-1', orderId: 'o-1' };
  async receive(request: WebhookReceiveRequest): Promise<WebhookReceiveResult> {
    this.requests.push(request);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

const gatewayOf = (pg: PgName, result: WebhookParseResult, seen: { headers?: unknown; body?: string } = {}): PaymentGatewayPort =>
  ({
    pg,
    parseWebhook: (headers: unknown, body: string) => {
      seen.headers = headers;
      seen.body = body;
      return result;
    },
  }) as unknown as PaymentGatewayPort;

function harness(o: { adapters?: PaymentGatewayPort[]; allowSimulator?: boolean } = {}) {
  const adapters = o.adapters ?? [gatewayOf('TOSS', { kind: 'TRIGGER', dedupKey: 'TOSS:wh_1', paymentRef: 'tgen_1', orderRef: '0193a000-0000-7000-8000-000000000001' }), gatewayOf('PORTONE', { kind: 'INVALID', reason: 'SIGNATURE' })];
  const gateways: PaymentGateways = { of: (pg) => adapters.find((a) => a.pg === pg) };
  const store = new RecordingStore();
  const log = new RecordingLog();
  const outcomes: [PgName, PaymentWebhookOutcome][] = [];
  const clock = fakeClock({ now: 1_794_000_000_000 });
  const useCase = new ReceivePaymentWebhook({ store, gateways, log, signals: { outcome: (pg, outcome) => outcomes.push([pg, outcome]) }, clock, allowSimulator: o.allowSimulator ?? false });
  return { useCase, store, log, outcomes, clock };
}

const BODY = Buffer.from(JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'tgen_1', status: 'DONE', totalAmount: 1 } }));

describe('ReceivePaymentWebhook', () => {
  it('P-T8_신호를 저장소에 넘기고 200이다. 넘기는 값은 참조·키·허용 결제사·시각뿐이다(본문의 상태·금액을 믿지 않는다) [ASVS v5.0.0-2.2.1]', async () => {
    const { useCase, store, outcomes, clock } = harness();
    await expect(useCase.receive('toss', {}, BODY)).resolves.toBe('ACCEPTED');
    expect(store.requests).toEqual([{ pg: 'TOSS', dedupKey: 'TOSS:wh_1', paymentRef: 'tgen_1', orderRef: '0193a000-0000-7000-8000-000000000001', allowedPgs: ['TOSS'], signed: false, nowMs: clock.now() }]);
    expect(outcomes).toEqual([['TOSS', 'query_signal']]);
  });

  it('P-T17_리뷰 고침 H1: 서명 없는 토스 경로는 signed가 거짓이고 서명을 본 포트원 경로는 참이다(먼저 온 웹훅을 남길지 저장소가 이 값으로 정한다) [ASVS v5.0.0-2.4.1]', async () => {
    const trigger: WebhookParseResult = { kind: 'TRIGGER', dedupKey: 'X:1', paymentRef: 'r-1' };
    const { useCase, store } = harness({ adapters: [gatewayOf('TOSS', trigger), gatewayOf('PORTONE', trigger)] });
    await useCase.receive('toss', {}, BODY);
    await useCase.receive('portone', {}, BODY);
    expect(store.requests.map((r) => [r.pg, r.signed])).toEqual([
      ['TOSS', false],
      ['PORTONE', true],
    ]);
  });

  it('P-T8_리뷰 고침 M2: 조회 신호를 쓰지 못했으면 query_signal이 아니라 query_signal_skipped가 오른다', async () => {
    const { useCase, store, outcomes } = harness();
    store.answer = { kind: 'QUERY_SIGNAL_SKIPPED' };
    await expect(useCase.receive('toss', {}, BODY)).resolves.toBe('ACCEPTED');
    expect(outcomes).toEqual([['TOSS', 'query_signal_skipped']]);
  });

  it('P-T17_어댑터에 원문 바이트를 UTF-8 글로 그대로 넘긴다', async () => {
    const seen: { headers?: unknown; body?: string } = {};
    const { useCase } = harness({ adapters: [gatewayOf('TOSS', { kind: 'IGNORED' }, seen)] });
    const headers = { 'tosspayments-webhook-transmission-id': 'wh_1' };
    await useCase.receive('toss', headers, Buffer.from('{"결제":1}  ', 'utf8'));
    expect(seen).toEqual({ headers, body: '{"결제":1}  ' });
  });

  it('P-T17_포트원 거절은 REJECTED이고 저장소를 부르지 않으며 사유만 로그에 남긴다(본문은 싣지 않는다) [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.3.1] [ASVS v5.0.0-16.2.5]', async () => {
    const { useCase, store, log, outcomes } = harness();
    await expect(useCase.receive('portone', {}, BODY)).resolves.toBe('REJECTED');
    expect(store.requests).toEqual([]);
    expect(log.invalids).toEqual([{ route: 'portone', pg: 'PORTONE', reason: 'SIGNATURE' }]);
    expect(JSON.stringify(log.invalids)).not.toContain('tgen_1');
    expect(outcomes).toEqual([['PORTONE', 'invalid']]);
  });

  it('P-T16_토스 거절은 계약대로 200이고 저장소를 부르지 않는다(서명 없는 경로) [ASVS v5.0.0-16.5.3]', async () => {
    const { useCase, store, log, outcomes } = harness({ adapters: [gatewayOf('TOSS', { kind: 'INVALID', reason: 'HEADER' })] });
    await expect(useCase.receive('toss', {}, BODY)).resolves.toBe('ACCEPTED');
    expect(store.requests).toEqual([]);
    expect(log.invalids).toEqual([{ route: 'toss', pg: 'TOSS', reason: 'HEADER' }]);
    expect(outcomes).toEqual([['TOSS', 'invalid']]);
  });

  it('P-T17_지원하지 않는 사건은 200이고 지표만 오른다(로그 없음, 저장소 안 부름)', async () => {
    const { useCase, store, log, outcomes } = harness({ adapters: [gatewayOf('PORTONE', { kind: 'IGNORED' })] });
    await expect(useCase.receive('portone', {}, BODY)).resolves.toBe('ACCEPTED');
    expect(store.requests).toEqual([]);
    expect(log.invalids).toEqual([]);
    expect(outcomes).toEqual([['PORTONE', 'ignored']]);
  });

  it.each<[string, WebhookReceiveResult, PaymentWebhookOutcome]>([
    ['중복', { kind: 'DUPLICATE' }, 'duplicate'],
    ['먼저 온 웹훅', { kind: 'LEDGER_NOT_FOUND' }, 'ledger_not_found'],
    ['UNKNOWN 아닌 상태', { kind: 'STATE_IGNORED', paymentId: 'p-1', orderId: 'o-1' }, 'state_ignored'],
  ])('P-T8_%s이면 200이고 지표만 오른다', async (_n, answer, outcome) => {
    const { useCase, store, log, outcomes } = harness();
    store.answer = answer;
    await expect(useCase.receive('toss', {}, BODY)).resolves.toBe('ACCEPTED');
    expect(log.mismatches).toEqual([]);
    expect(outcomes).toEqual([['TOSS', outcome]]);
  });

  it('P-T30_경로의 결제사와 다르면 200이고 SEV2 로그와 지표를 남긴다 [ASVS v5.0.0-16.3.3]', async () => {
    const { useCase, store, log, outcomes } = harness();
    store.answer = { kind: 'PG_MISMATCH', orderId: 'o-1', ledgerPg: 'PORTONE' };
    await expect(useCase.receive('toss', {}, BODY)).resolves.toBe('ACCEPTED');
    expect(log.mismatches).toEqual([{ route: 'toss', pg: 'TOSS', ledgerPg: 'PORTONE', orderId: 'o-1' }]);
    expect(outcomes).toEqual([['TOSS', 'pg_mismatch']]);
  });

  it('P-T8_저장이 실패하면 STORE_FAILED이고 로그에는 코드만 싣는다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.3.4]', async () => {
    const { useCase, store, log, outcomes } = harness();
    store.answer = Object.assign(new Error('insert ... wh_secret_value'), { code: '23514' });
    await expect(useCase.receive('toss', {}, BODY)).resolves.toBe('STORE_FAILED');
    expect(log.failures).toEqual([{ route: 'toss', pg: 'TOSS', code: '23514' }]);
    expect(outcomes).toEqual([['TOSS', 'store_failed']]);
  });

  it('P-T17_어댑터가 없으면 저장소를 부르지 않는다(포트원 경로는 거절, 토스 경로는 200) [ASVS v5.0.0-16.5.3]', async () => {
    const { useCase, store, log, outcomes } = harness({ adapters: [] });
    await expect(useCase.receive('portone', {}, BODY)).resolves.toBe('REJECTED');
    await expect(useCase.receive('toss', {}, BODY)).resolves.toBe('ACCEPTED');
    expect(store.requests).toEqual([]);
    expect(log.invalids).toEqual([
      { route: 'portone', pg: 'PORTONE', reason: 'NO_ADAPTER' },
      { route: 'toss', pg: 'TOSS', reason: 'NO_ADAPTER' },
    ]);
    expect(outcomes).toEqual([
      ['PORTONE', 'no_adapter'],
      ['TOSS', 'no_adapter'],
    ]);
  });

  it('P-T30_시뮬레이터 어댑터는 허용한 환경의 토스 경로에서만 읽는다', async () => {
    const sim = gatewayOf('SIMULATOR', { kind: 'TRIGGER', dedupKey: 'SIMULATOR:wh_1', paymentRef: 'tsim_1' });
    const allowed = harness({ adapters: [sim], allowSimulator: true });
    await allowed.useCase.receive('toss', {}, BODY);
    expect(allowed.store.requests).toMatchObject([{ pg: 'SIMULATOR', dedupKey: 'SIMULATOR:wh_1', allowedPgs: ['TOSS', 'SIMULATOR'] }]);
    const denied = harness({ adapters: [sim], allowSimulator: false });
    await denied.useCase.receive('toss', {}, BODY);
    expect(denied.store.requests).toEqual([]);
    expect(denied.outcomes).toEqual([['TOSS', 'no_adapter']]);
  });

  it('P-T30_토스 어댑터가 있으면 local·ci에서도 토스 어댑터가 읽고 원장의 시뮬레이터를 허용한다', async () => {
    const toss = gatewayOf('TOSS', { kind: 'TRIGGER', dedupKey: 'TOSS:wh_1', paymentRef: 'tsim_1' });
    const sim = gatewayOf('SIMULATOR', { kind: 'INVALID', reason: 'BODY' });
    const { useCase, store } = harness({ adapters: [toss, sim], allowSimulator: true });
    await useCase.receive('toss', {}, BODY);
    expect(store.requests).toMatchObject([{ pg: 'TOSS', allowedPgs: ['TOSS', 'SIMULATOR'] }]);
  });
});

describe('paymentWebhookLog', () => {
  const capture = () => {
    const lines: string[] = [];
    const destination = new Writable({
      write: (chunk, _enc, cb) => {
        lines.push(String(chunk));
        cb();
      },
    });
    const clock = fakeClock({ now: 1 });
    const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'info', destination });
    return { lines, clock, log: paymentWebhookLog(logger, clock) };
  };

  it('P-T17_리뷰 고침 M3: 거절 줄은 경로·사유마다 파드에서 1분에 한 줄이다(인증 없는 요청으로 로그를 부풀리지 못한다) [ASVS v5.0.0-16.3.3]', () => {
    const { lines, log, clock } = capture();
    for (let i = 0; i < 3; i += 1) log.invalid({ route: 'toss', pg: 'TOSS', reason: 'HEADER' });
    expect(lines).toHaveLength(1);
    log.invalid({ route: 'toss', pg: 'TOSS', reason: 'BODY' });
    log.invalid({ route: 'portone', pg: 'PORTONE', reason: 'HEADER' });
    expect(lines).toHaveLength(3);
    clock.advance(59_999);
    log.invalid({ route: 'toss', pg: 'TOSS', reason: 'HEADER' });
    expect(lines).toHaveLength(3);
    clock.advance(1);
    log.invalid({ route: 'toss', pg: 'TOSS', reason: 'HEADER' });
    expect(lines).toHaveLength(4);
  });

  it('P-T30_리뷰 고침 M3: 서명 없는 토스 경로의 어긋남은 SEV3이고 1분에 한 줄이다(누구나 만들 수 있어 SEV2로 깨우지 않는다) [ASVS v5.0.0-16.3.3]', () => {
    const { lines, log } = capture();
    log.pgMismatch({ route: 'toss', pg: 'TOSS', ledgerPg: 'PORTONE', orderId: 'o-1' });
    log.pgMismatch({ route: 'toss', pg: 'TOSS', ledgerPg: 'PORTONE', orderId: 'o-2' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'payment-webhook-pg-mismatch', severity: 'SEV3', route: 'toss', ledgerPg: 'PORTONE', orderId: 'o-1' });
  });

  it('P-T30_리뷰 고침 M3: 서명을 본 포트원 경로의 어긋남은 SEV2이고 건마다 남긴다 [ASVS v5.0.0-16.3.3]', () => {
    const { lines, log } = capture();
    log.pgMismatch({ route: 'portone', pg: 'PORTONE', ledgerPg: 'TOSS', orderId: 'o-1' });
    log.pgMismatch({ route: 'portone', pg: 'PORTONE', ledgerPg: 'TOSS', orderId: 'o-2' });
    expect(lines.map((l) => (JSON.parse(l) as { severity: string }).severity)).toEqual(['SEV2', 'SEV2']);
  });

  it('P-T17_거절 줄은 경로·결제사·사유만 싣는다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.3.1]', () => {
    const { lines, log } = capture();
    log.invalid({ route: 'portone', pg: 'PORTONE', reason: 'SIGNATURE' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'payment-webhook-invalid', route: 'portone', pg: 'PORTONE', reason: 'SIGNATURE' });
  });

  it('P-T30_경로 어긋남 줄은 경로·두 결제사·주문 ID를 싣는다 [ASVS v5.0.0-16.3.3]', () => {
    const { lines, log } = capture();
    log.pgMismatch({ route: 'portone', pg: 'PORTONE', ledgerPg: 'TOSS', orderId: 'o-1' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'payment-webhook-pg-mismatch', severity: 'SEV2', route: 'portone', pg: 'PORTONE', ledgerPg: 'TOSS', orderId: 'o-1' });
  });

  it('P-T8_저장 실패 줄은 코드만 싣는다 [ASVS v5.0.0-16.3.4]', () => {
    const { lines, log } = capture();
    log.storeFailed({ route: 'toss', pg: 'TOSS', code: '57014' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'payment-webhook-store-failed', route: 'toss', pg: 'TOSS', code: '57014' });
  });

  it('P-T8_로거가 던져도 삼킨다', () => {
    const log = paymentWebhookLog(
      {
        warn: () => {
          throw new Error('로그 실패');
        },
        error: () => {
          throw new Error('로그 실패');
        },
      },
      fakeClock({ now: 1 }),
    );
    expect(() => {
      log.invalid({ route: 'toss', pg: 'TOSS', reason: 'BODY' });
      log.pgMismatch({ route: 'toss', pg: 'TOSS', ledgerPg: 'PORTONE', orderId: 'o-1' });
      log.storeFailed({ route: 'toss', pg: 'TOSS', code: 'x' });
    }).not.toThrow();
  });
});

describe('PromPaymentWebhookSignals', () => {
  it('P-T8_결제사 셋과 결과를 0으로 미리 보이고 outcome이 1 올린다', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const signals = new PromPaymentWebhookSignals().register(metrics.registry);
    const before = await metrics.registry.metrics();
    for (const pg of ['TOSS', 'PORTONE', 'SIMULATOR']) for (const outcome of PAYMENT_WEBHOOK_OUTCOMES) expect(before).toContain(`payment_webhook_received_total{pg="${pg}",outcome="${outcome}"} 0`);
    signals.outcome('TOSS', 'duplicate');
    expect(await metrics.registry.metrics()).toContain('payment_webhook_received_total{pg="TOSS",outcome="duplicate"} 1');
  });
});

describe('webhookDatabaseOptions', () => {
  it('P-T8_일반 풀이고 승인 명령 접수·실행기와 이름이 다르다', () => {
    expect(webhookDatabaseOptions('postgres://u:p@h/d')).toEqual({ url: 'postgres://u:p@h/d', profile: 'general', max: WEBHOOK_DB_MAX, applicationName: 'payment-svc-webhook' });
  });
});

describe('DrizzleWebhookStore의 시간 예산', () => {
  const dialect = new PgDialect();

  it('P-T8_리뷰 고침 L7: 주문 참조로 못 찾고 결제 참조로 찾아도 문장은 찾기·수신 기록·조회 신호 셋이다(문장 시간 한도 × 3 + 풀 대기가 토스 기한 안이다)', async () => {
    const statements: string[] = [];
    const ledger = { id: '0193a000-0000-7000-8000-000000000002', order_id: '0193a000-0000-7000-8000-000000000001', pg: 'TOSS', status: 'UNKNOWN' };
    const tx = {
      execute: async (query: SQL) => {
        const text = dialect.sqlToQuery(query).sql.trim();
        statements.push(text);
        // 주문 참조만 보는 문장은 못 찾고, 결제 참조를 보는 문장이 찾는다
        if (text.startsWith('select')) return { rows: text.includes('pg_payment_ref') ? [ledger] : [] };
        return { rows: [{ dedup_key: 'TOSS:wh_1', id: ledger.id }], rowCount: 1 };
      },
    };
    const database = { transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx) } as unknown as Database;
    await new DrizzleWebhookStore({ database }).receive({ pg: 'TOSS', dedupKey: 'TOSS:wh_1', paymentRef: 'tgen_1', orderRef: '0193a000-0000-7000-8000-00000000000f', allowedPgs: ['TOSS'], signed: false, nowMs: 1_794_000_000_000 });
    expect(statements).toHaveLength(3);
  });
});

describe('계약 문서', () => {
  const openapi = readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const pathBlock = (path: string): string => {
    const at = openapi.indexOf(`\n  ${path}:\n`);
    return openapi.slice(at, openapi.indexOf('\n  /v1/', at + 1));
  };

  it.each(['/v1/webhooks/toss', '/v1/webhooks/portone'])('P-T17_리뷰 고침 L10: %s 계약에 413·415·503이 있고 서버 SDK 검증이라고 적지 않는다', (path) => {
    const block = pathBlock(path);
    expect(block).not.toBe('');
    for (const status of ['413', '415', '503']) expect(block, status).toContain(`'${status}'`);
    expect(block).not.toContain('서버 SDK');
  });
});

describe('webhookAcceptsSimulator', () => {
  it.each<[string | undefined, boolean]>([
    ['local', true],
    ['ci', true],
    ['demo', false],
    ['staging', false],
    ['prod', false],
    [undefined, false],
  ])('P-T30_PEAKET_ENV %s이면 %s다', (env, expected) => {
    expect(webhookAcceptsSimulator({ PEAKET_ENV: env })).toBe(expected);
  });
});
