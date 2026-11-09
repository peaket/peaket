// 결제사 선택과 결제창 준비(docs/features/payment.md §2.2 '선택기의 첫 구현', ADR-0044, 명세 specs/payment.qnt `selected`, BUILD_ORDER PRF-190).
// 순수 함수의 선택 표, 입력 검사, 값 만들기, 캐시, 허용 수단을 본다. 실제 PostgreSQL과 gRPC까지 잇는 것은 test-int/payment-checkout.int.test.ts가 본다.
import { readFileSync } from 'node:fs';
import { type Database, fakeClock, PlatformMetrics } from '@peaket/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { CachedPgSelectionReader, PG_SELECTION_CACHE_READ_BUDGET_MS, PG_SELECTION_CACHE_TTL_MS } from '../src/modules/payment/application/pg-selection-cache.js';
import { PrepareCheckout, type PrepareCheckoutDeps } from '../src/modules/payment/application/prepare-checkout.js';
import { ENTRY_OPENS_AT_MAX_MS, parseConfirmPaymentInput, PaymentDeadlineError, PaymentInputError } from '../src/modules/payment/domain/confirm-command.js';
import { type CheckoutAttempt, type CheckoutOrder, type CheckoutValues, PAY_METHODS, type PayMethod, type PaymentGatewayPort, type PgCapabilities, type PgName } from '../src/modules/payment/domain/payment-gateway.js';
import { allowedPayMethods, channelOf, channelTableOf, checkoutReturnUrls, type PgChannel, type PgChannelTable, type PgSelectionInput, type PgSelectionState, PaymentPgUnavailableError, parsePrepareCheckoutInput, type PgSwitchRow, type PrepareCheckoutInput, selectPg } from '../src/modules/payment/domain/pg-selection.js';
import type { PaymentGateways, PgSelectionReader, PrepareCheckoutLog, PrepareCheckoutOutcome, PrepareCheckoutSignals } from '../src/modules/payment/domain/ports.js';
import { type EntryPauseRow, PaymentNewPausedError } from '../src/modules/payment/domain/entry-pause.js';
import { capDepositDueAtEntry, checkoutDepositDueAtMs, reversalDueAtMs } from '../src/modules/payment/domain/virtual-account.js';
import { checkoutAdapterWarnings, loadCheckoutConfig, loadPortoneGatewayConfig } from '../src/config.js';
import { DrizzlePgSelection } from '../src/modules/payment/adapters/db/drizzle-pg-selection.js';
import { paymentCheckoutLog } from '../src/modules/payment/adapters/payment-checkout-log.js';
import { PortoneGateway } from '../src/modules/payment/adapters/pg/portone-gateway.js';
import { StaticPaymentGateways } from '../src/modules/payment/adapters/pg/payment-gateways.js';
import { PromPaymentCheckoutSignals } from '../src/modules/payment/adapters/prom-payment-checkout-signals.js';

const ALL_METHODS: ReadonlySet<PayMethod> = new Set(PAY_METHODS);
const ON: PgChannel = { active: true, payMethods: ALL_METHODS };
const CHANNELS: PgChannelTable = new Map<PgName, PgChannel>([
  ['TOSS', ON],
  ['PORTONE', ON],
]);
const DEFAULTS = { primary: 'TOSS', fallback: 'PORTONE' } as const;
const EVENT = '11111111-1111-7111-8111-111111111111';
const ORDER = '22222222-2222-7222-8222-222222222222';
const ATTEMPT = '33333333-3333-7333-8333-333333333333';
/** 2026-11-09 12:00 KST */
const NOW = Date.parse('2026-11-09T03:00:00.000Z');
/** 다음 날 23:59 KST */
const NEXT_DAY_END = Date.parse('2026-11-10T14:59:00.000Z');

const sw = (o: Partial<PgSwitchRow> = {}): PgSwitchRow => ({ scope: 'PLATFORM', active: true, version: 1, changedAtMs: NOW, ...o });
const input = (o: Partial<PgSelectionInput> = {}): PgSelectionInput => ({ defaults: DEFAULTS, channels: CHANNELS, payMethod: 'CARD', ...o });

describe('selectPg: 선택 규칙(전환 → 회차 지정 → 플랫폼 기본)', () => {
  test.each<[string, Partial<PgSelectionInput>, PgName, boolean]>([
    ['지정도 전환도 없으면 플랫폼 기본', {}, 'TOSS', false],
    ['회차 지정이 플랫폼 기본보다 앞선다', { assignment: { primary: 'PORTONE' } }, 'PORTONE', false],
    ['플랫폼 전환이 켜지면 대상으로 간다', { platformSwitch: sw({ toPg: 'PORTONE' }) }, 'PORTONE', true],
    ['회차 전환이 플랫폼 전환보다 앞선다', { eventSwitch: sw({ scope: EVENT, toPg: 'SIMULATOR' }), platformSwitch: sw({ toPg: 'PORTONE' }), channels: new Map([...CHANNELS, ['SIMULATOR', ON]]) }, 'SIMULATOR', true],
    ['회차 전환이 꺼져 있으면 플랫폼 전환을 본다', { eventSwitch: sw({ scope: EVENT, active: false }), platformSwitch: sw({ toPg: 'PORTONE' }) }, 'PORTONE', true],
    ['꺼진 전환은 보지 않는다', { platformSwitch: sw({ active: false, toPg: 'PORTONE' }) }, 'TOSS', false],
    ['to_pg가 비면 회차의 대체 결제사', { assignment: { primary: 'TOSS', fallback: 'PORTONE' }, platformSwitch: sw() }, 'PORTONE', true],
    ['회차 지정 행이 없으면 플랫폼 대체', { platformSwitch: sw() }, 'PORTONE', true],
    ['대체가 없으면 기준 결제사 그대로', { assignment: { primary: 'TOSS' }, platformSwitch: sw() }, 'TOSS', false],
    ['from_pg가 기준과 다르면 전환하지 않는다', { assignment: { primary: 'PORTONE' }, platformSwitch: sw({ fromPg: 'TOSS', toPg: 'TOSS' }) }, 'PORTONE', false],
    ['from_pg가 기준과 같으면 전환한다', { assignment: { primary: 'TOSS' }, platformSwitch: sw({ fromPg: 'TOSS', toPg: 'PORTONE' }) }, 'PORTONE', true],
    ['전환 대상이 기준과 같으면 switched가 아니다', { platformSwitch: sw({ toPg: 'TOSS' }) }, 'TOSS', false],
    ['리뷰 고침 7: 켜진 회차 행의 from_pg가 어긋나면 플랫폼 행으로 내려간다', { eventSwitch: sw({ scope: EVENT, fromPg: 'PORTONE', toPg: 'SIMULATOR' }), platformSwitch: sw({ toPg: 'PORTONE' }) }, 'PORTONE', true],
    ['리뷰 고침 7: 두 행의 from_pg가 다 어긋나면 전환하지 않는다', { eventSwitch: sw({ scope: EVENT, fromPg: 'PORTONE', toPg: 'SIMULATOR' }), platformSwitch: sw({ fromPg: 'SIMULATOR', toPg: 'PORTONE' }) }, 'TOSS', false],
  ])('P-T26_%s', (_name, o, pg, switched) => {
    expect(selectPg(input(o))).toMatchObject({ kind: 'SELECTED', pg, switched });
  });

  test.each<[string, Partial<PgSelectionInput>, PgName, string]>([
    ['고른 결제사가 채널 표에 없다', { channels: new Map([['PORTONE', ON]]) }, 'TOSS', 'NO_CHANNEL'],
    ['고른 결제사가 비활성이다', { channels: new Map([['TOSS', { active: false, payMethods: ALL_METHODS }], ['PORTONE', ON]]) }, 'TOSS', 'INACTIVE'],
    ['요청 수단을 받지 않는다', { channels: new Map([['TOSS', { active: true, payMethods: new Set<PayMethod>(['CARD']) }], ['PORTONE', ON]]), payMethod: 'EASY_PAY' }, 'TOSS', 'METHOD_UNSUPPORTED'],
    ['전환 대상의 어댑터가 없으면 기본으로 돌아가지 않는다', { channels: new Map([['TOSS', ON]]), platformSwitch: sw({ toPg: 'PORTONE' }) }, 'PORTONE', 'NO_CHANNEL'],
  ])('P-T26_다른 결제사로 넘기지 않는다: %s [ASVS v5.0.0-16.5.3]', (_name, o, pg, reason) => {
    expect(selectPg(input(o))).toEqual({ kind: 'UNAVAILABLE', pg, reason });
  });
});

class FakeGateway implements PaymentGatewayPort {
  readonly checkouts: { order: CheckoutOrder; attempt: CheckoutAttempt; payMethod: string }[] = [];
  constructor(
    readonly pg: PgName,
    private readonly caps: Partial<PgCapabilities> = {},
  ) {}
  capabilities(): PgCapabilities {
    return { serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 1, callsPerSecond: 10, redirectCheckout: true, ...this.caps };
  }
  checkout(order: CheckoutOrder, attempt: CheckoutAttempt, payMethod: string): CheckoutValues {
    this.checkouts.push({ order, attempt, payMethod });
    return { toss: { clientKey: `ck-${this.pg}`, customerKey: order.customerKey ?? 'cust', orderId: order.orderId, orderName: order.orderName, amount: order.amount, successUrl: attempt.successUrl, failUrl: attempt.failUrl } };
  }
  confirm = (): never => {
    throw new Error('결제창 준비는 결제사를 부르지 않는다');
  };
  query = this.confirm;
  listTransactions = this.confirm;
  cancel = this.confirm;
  parseWebhook = this.confirm;
}

class Registry implements PaymentGateways {
  constructor(readonly list: readonly FakeGateway[]) {}
  of(pg: PgName) {
    return this.list.find((g) => g.pg === pg);
  }
}

describe('채널 표', () => {
  test('P-T26_어댑터 등록부의 어댑터만 표에 있고 받는 수단은 능력 플래그를 따른다', () => {
    const table = channelTableOf(new Registry([new FakeGateway('TOSS'), new FakeGateway('SIMULATOR', { payMethods: ['CARD'] })]));
    expect([...table.keys()].sort()).toEqual(['SIMULATOR', 'TOSS']);
    expect([...table.get('TOSS')!.payMethods].sort()).toEqual([...PAY_METHODS].sort());
    expect([...table.get('SIMULATOR')!.payMethods]).toEqual(['CARD']);
  });

  test('P-T26_서버 승인을 못 하는 어댑터는 비활성이다 [ASVS v5.0.0-2.2.3]', () => {
    expect(channelOf(new FakeGateway('TOSS', { serverConfirm: false })).active).toBe(false);
    expect(channelOf(new FakeGateway('TOSS')).active).toBe(true);
  });

  const portone = (channelKeys?: Readonly<Partial<Record<PayMethod, string>>>) =>
    new PortoneGateway({ baseUrl: 'http://pg.test', secret: 'sec', storeId: 's', channelKey: 'single', webhookSecrets: [`whsec_${Buffer.alloc(24, 1).toString('base64')}`], isTest: true, ...(channelKeys ? { channelKeys } : {}) });

  test('HOT-140 넘긴 것: 수단별 채널 키 표가 있으면 표의 키와 표의 수단만이다', () => {
    const g = portone({ CARD: 'card-key', EASY_PAY: 'easy-key' });
    expect([...channelOf(g).payMethods].sort()).toEqual(['CARD', 'EASY_PAY']);
    const v = g.checkout({ orderId: ORDER, orderName: '티켓', amount: 1_000 }, { attemptId: ATTEMPT, successUrl: 'https://w/s', failUrl: 'https://w/f' }, 'EASY_PAY');
    expect('portone' in v && v.portone.channelKey).toBe('easy-key');
  });

  test('HOT-140 넘긴 것: 표가 없으면 하나인 채널 키로 다섯 수단을 받는다', () => {
    const g = portone();
    expect(channelOf(g).payMethods.size).toBe(PAY_METHODS.length);
    const v = g.checkout({ orderId: ORDER, orderName: '티켓', amount: 1_000 }, { attemptId: ATTEMPT, successUrl: 'https://w/s', failUrl: 'https://w/f' }, 'MOBILE');
    expect('portone' in v && v.portone.channelKey).toBe('single');
  });

  test('HOT-153 넘긴 것: 포트원 값에 customData.orderId와 통화가 있다', () => {
    const v = portone().checkout({ orderId: ORDER, orderName: '티켓', amount: 1_000 }, { attemptId: ATTEMPT, successUrl: 'https://w/s', failUrl: 'https://w/f' }, 'CARD');
    expect('portone' in v && v.portone).toMatchObject({ customData: { orderId: ORDER }, currency: 'KRW', paymentId: `pay-${ORDER}` });
  });

  test('시뮬레이터 어댑터는 카드만 받는다고 알린다', async () => {
    const { SimulatorPaymentGateway } = await import('../src/modules/payment/adapters/pg/simulator-gateway.js');
    expect([...channelOf(new SimulatorPaymentGateway({ baseUrl: 'http://sim.test', secretKey: 'sim_sk_x', clientKey: 'sim_ck_x' })).payMethods]).toEqual(['CARD']);
  });

  test('등록부로 표를 만들 수 있다(StaticPaymentGateways)', () => {
    expect(channelTableOf(new StaticPaymentGateways([new FakeGateway('PORTONE')])).has('PORTONE')).toBe(true);
  });
});

describe('입금 기한과 허용 수단', () => {
  test('HOT-152 넘긴 것: 입장 시각이 있으면 입장 시작 24시간 전을 넘지 않는다', () => {
    const entry = Date.parse('2026-11-10T12:00:00.000Z');
    expect(capDepositDueAtEntry(NEXT_DAY_END, entry)).toBe(entry - 24 * 3_600_000);
    expect(capDepositDueAtEntry(NEXT_DAY_END, entry + 30 * 86_400_000)).toBe(NEXT_DAY_END);
    expect(capDepositDueAtEntry(NEXT_DAY_END, undefined)).toBe(NEXT_DAY_END);
  });

  test('결제창의 입금 기한은 다음 날 23:59(KST)와 입장 24시간 전 가운데 이른 때다', () => {
    expect(checkoutDepositDueAtMs(NOW, undefined)).toBe(NEXT_DAY_END);
    expect(checkoutDepositDueAtMs(NOW, Date.parse('2026-11-11T00:00:00.000Z'))).toBe(Date.parse('2026-11-10T00:00:00.000Z'));
  });

  test('HOT-152 넘긴 것: 입금 오류 되돌림의 새 기한도 입장 24시간 전으로 자른다', () => {
    const entry = Date.parse('2026-11-11T00:00:00.000Z');
    expect(reversalDueAtMs(undefined, NOW, entry)).toBe(entry - 24 * 3_600_000);
    expect(reversalDueAtMs(NOW + 40 * 3_600_000, NOW, entry)).toBe(entry - 24 * 3_600_000);
    expect(reversalDueAtMs(undefined, NOW)).toBe(NEXT_DAY_END);
  });

  const HOUR = 3_600_000;

  test('P-T26_리뷰 고침 4: 입장 상한이 지금 + 2시간보다 가까우면 새 기한은 지금 + 2시간이다', () => {
    expect(reversalDueAtMs(undefined, NOW, NOW + 10 * HOUR)).toBe(NOW + 2 * HOUR);
    expect(reversalDueAtMs(NOW + 72 * HOUR, NOW, NOW + 25 * HOUR)).toBe(NOW + 2 * HOUR);
  });

  test('P-T26_리뷰 고침 4: 입장이 꼭 2시간 뒤면 입장 시각까지이고 입장을 넘지 않는다', () => {
    expect(reversalDueAtMs(undefined, NOW, NOW + 2 * HOUR)).toBe(NOW + 2 * HOUR);
  });

  test('P-T26_리뷰 고침 4: 입장이 2시간 안이면 새 기한이 없다(재입금 불가)', () => {
    expect(reversalDueAtMs(undefined, NOW, NOW + 2 * HOUR - 1)).toBeUndefined();
    expect(reversalDueAtMs(NOW + 72 * HOUR, NOW, NOW - HOUR)).toBeUndefined();
  });

  const o = { virtualAccountAllowed: true, virtualAccountReady: true, depositDueAtMs: NOW + 3 * 3_600_000, nowMs: NOW };

  test('P-T26_가상계좌는 끄는 조건이 없을 때만 낸다 [ASVS v5.0.0-2.2.3]', () => {
    expect(allowedPayMethods(ON, o)).toEqual([...PAY_METHODS]);
    expect(allowedPayMethods(ON, { ...o, virtualAccountAllowed: false })).not.toContain('VIRTUAL_ACCOUNT');
    expect(allowedPayMethods(ON, { ...o, virtualAccountReady: false })).not.toContain('VIRTUAL_ACCOUNT');
    expect(allowedPayMethods(ON, { ...o, depositDueAtMs: NOW + 2 * 3_600_000 - 1 })).not.toContain('VIRTUAL_ACCOUNT');
    expect(allowedPayMethods(ON, { ...o, depositDueAtMs: NOW + 2 * 3_600_000 })).toContain('VIRTUAL_ACCOUNT');
  });

  test('채널이 받지 않는 수단은 내지 않고 차례는 계약 목록 그대로다', () => {
    expect(allowedPayMethods({ active: true, payMethods: new Set<PayMethod>(['MOBILE', 'CARD']) }, o)).toEqual(['CARD', 'MOBILE']);
  });
});

test('복귀 주소는 웹 함수 paymentReturnUrls와 같은 모양이다 [ASVS v5.0.0-3.7.2] [ASVS v5.0.0-14.2.1]', () => {
  expect(checkoutReturnUrls('https://www.example', 'e 1', 'o/1', 'TOSS')).toEqual({ successUrl: 'https://www.example/booking/e%201/checkout/return?order=o%2F1&pg=TOSS', failUrl: 'https://www.example/booking/e%201/checkout/return?order=o%2F1&pg=TOSS' });
  expect(checkoutReturnUrls('https://www.example', 'e', 'o', 'PORTONE').successUrl).toBe('https://www.example/booking/e/checkout/return?order=o&pg=PORTONE');
});

const raw = (o: Partial<PrepareCheckoutInput> = {}): PrepareCheckoutInput => ({ orderKind: 'TICKET', orderId: ORDER, attemptId: ATTEMPT, eventId: EVENT, amount: 55_000, orderName: '공연 티켓', payMethod: '', ...o });

describe('selectPg: 멱등 재생의 결제사 고정(P-T27, BUILD_ORDER PRF-191)', () => {
  test('P-T27_고정하면 전환이 켜져도 그 결제사다 [ASVS v5.0.0-2.2.3]', () => {
    const r = selectPg(input({ pinnedPg: 'TOSS', platformSwitch: sw({ toPg: 'PORTONE' }) }));
    expect(r).toMatchObject({ kind: 'SELECTED', pg: 'TOSS', switched: false });
  });

  test('P-T27_고정한 결제사가 회차 기준과 다르면 switched는 참이다(처음 시도가 전환으로 골랐다)', () => {
    expect(selectPg(input({ pinnedPg: 'PORTONE' }))).toMatchObject({ kind: 'SELECTED', pg: 'PORTONE', switched: true });
    expect(selectPg(input({ pinnedPg: 'PORTONE', assignment: { primary: 'PORTONE' } }))).toMatchObject({ kind: 'SELECTED', pg: 'PORTONE', switched: false });
  });

  test.each<[string, Partial<PgSelectionInput>, string]>([
    ['채널에 없다', { channels: new Map([['PORTONE', ON]]) }, 'NO_CHANNEL'],
    ['비활성이다', { channels: new Map([['TOSS', { active: false, payMethods: ALL_METHODS }]]) }, 'INACTIVE'],
    ['수단을 받지 않는다', { channels: new Map([['TOSS', { active: true, payMethods: new Set<PayMethod>(['MOBILE']) }]]) }, 'METHOD_UNSUPPORTED'],
  ])('P-T27_고정한 결제사가 %s면 UNAVAILABLE이고 다른 결제사로 넘기지 않는다 [ASVS v5.0.0-16.5.3]', (_name, o, reason) => {
    expect(selectPg(input({ pinnedPg: 'TOSS', ...o }))).toEqual({ kind: 'UNAVAILABLE', pg: 'TOSS', reason });
  });
});

describe('parsePrepareCheckoutInput', () => {
  test('P-T27_pinned_pg 이름을 받고 비면 칸이 없다, 모르는 이름은 입력 오류다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parsePrepareCheckoutInput(raw({ pinnedPg: 'PORTONE' }))).toMatchObject({ pinnedPg: 'PORTONE' });
    expect(parsePrepareCheckoutInput(raw())).not.toHaveProperty('pinnedPg');
    expect(parsePrepareCheckoutInput(raw({ pinnedPg: '' }))).not.toHaveProperty('pinnedPg');
    expect(parsePrepareCheckoutInput(raw({ pinnedPg: 'UNSPECIFIED' }))).not.toHaveProperty('pinnedPg');
    expect(() => parsePrepareCheckoutInput(raw({ pinnedPg: 'KCP' }))).toThrow('입력이 틀렸다: pinned_pg');
  });

  test('P-T26_비어 있는 수단은 CARD이고 가상계좌 허용 기본은 참이다', () => {
    expect(parsePrepareCheckoutInput(raw())).toEqual({ orderId: ORDER, attemptId: ATTEMPT, eventId: EVENT, amount: 55_000, orderName: '공연 티켓', payMethod: 'CARD', virtualAccountAllowed: true });
  });

  test('P-T26_선택 칸을 그대로 넘긴다', () => {
    const c = parsePrepareCheckoutInput(raw({ payMethod: 'EASY_PAY', customerKey: 'cust-key-1', virtualAccountAllowed: false, entryOpensAtMs: NOW }));
    expect(c).toMatchObject({ payMethod: 'EASY_PAY', customerKey: 'cust-key-1', virtualAccountAllowed: false, entryOpensAtMs: NOW });
  });

  test.each<[string, Partial<PrepareCheckoutInput>, string]>([
    ['주문 종류 없음', { orderKind: 'UNSPECIFIED' }, 'order_kind'],
    ['굿즈(복귀 주소가 아직 없다)', { orderKind: 'MERCH' }, 'order_kind'],
    ['주문 ID 모양', { orderId: 'ORDER' }, 'order_id'],
    ['시도 ID 모양', { attemptId: '' }, 'attempt_id'],
    ['회차 ID 모양', { eventId: 'x' }, 'event_id'],
    ['금액 0', { amount: 0 }, 'amount'],
    ['금액 소수', { amount: 1.5 }, 'amount'],
    ['금액 없음', { amount: Number.NaN }, 'amount'],
    ['금액 원장 상한 초과', { amount: 2_147_483_648 }, 'amount'],
    ['주문명 없음', { orderName: '' }, 'order_name'],
    ['주문명 101자', { orderName: 'a'.repeat(101) }, 'order_name'],
    ['주문명 제어 문자', { orderName: '티켓\n결제' }, 'order_name'],
    ['모르는 수단', { payMethod: 'BITCOIN' }, 'pay_method'],
    ['구매자 키 형식', { customerKey: '한글' }, 'customer_key'],
    ['비회원 고정 값', { customerKey: 'ANONYMOUS' }, 'customer_key'],
    ['입장 시각 0', { entryOpensAtMs: 0 }, 'entry_opens_at'],
    ['리뷰 고침 7: 입장 시각 9999년 넘김', { entryOpensAtMs: ENTRY_OPENS_AT_MAX_MS + 1 }, 'entry_opens_at'],
    ['리뷰 고침 7: 주문명 양방향 제어(U+202E)', { orderName: '공연‮티켓' }, 'order_name'],
    ['리뷰 고침 7: 주문명 양방향 격리(U+2066)', { orderName: '공연⁦티켓' }, 'order_name'],
    ['리뷰 고침 7: 주문명 폭 없는 공백(U+200B)', { orderName: '공연​티켓' }, 'order_name'],
    ['리뷰 고침 7: 주문명 BOM(U+FEFF)', { orderName: '﻿공연 티켓' }, 'order_name'],
    ['리뷰 고침 7: 주문명 줄 구분자(U+2028)', { orderName: '공연 티켓' }, 'order_name'],
    ['리뷰 고침 7: 주문명 문단 구분자(U+2029)', { orderName: '공연 티켓' }, 'order_name'],
    ['리뷰 고침 7: 주문명 공백뿐', { orderName: '   ' }, 'order_name'],
    ['리뷰 고침 7: 주문명 전각 공백뿐', { orderName: '　　' }, 'order_name'],
    ['리뷰 고침 7: 주문명 한글 채움 문자뿐', { orderName: 'ㅤ' }, 'order_name'],
  ])('P-T26_%s는 입력 오류이고 글에 값을 싣지 않는다 [ASVS v5.0.0-2.2.1]', (_name, o, field) => {
    let err: unknown;
    try {
      parsePrepareCheckoutInput(raw(o));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PaymentInputError);
    expect((err as PaymentInputError).field).toBe(field);
    expect((err as Error).message).toBe(`입력이 틀렸다: ${field}`);
  });

  test('P-T26_리뷰 고침 7: 입장 시각 상한(9999년 끝)과 글자 사이 공백·이모지는 받는다', () => {
    expect(parsePrepareCheckoutInput(raw({ entryOpensAtMs: ENTRY_OPENS_AT_MAX_MS })).entryOpensAtMs).toBe(ENTRY_OPENS_AT_MAX_MS);
    expect(parsePrepareCheckoutInput(raw({ orderName: '공연 ❤️ 티켓' })).orderName).toBe('공연 ❤️ 티켓');
  });

  test('P-T29_리뷰 고침 7: ConfirmPayment도 입장 시각 상한을 본다 [ASVS v5.0.0-2.2.1]', () => {
    const confirm = (entryOpensAtMs: number) => parseConfirmPaymentInput({ orderId: ORDER, attemptId: ATTEMPT, attemptNo: 1, eventId: EVENT, pg: 'TOSS', paymentRef: { kind: 'toss', paymentKey: 'pk-1' }, amount: 55_000, authenticatedAtMs: NOW, entryOpensAtMs }, NOW);
    expect(confirm(ENTRY_OPENS_AT_MAX_MS).entryOpensAtMs).toBe(ENTRY_OPENS_AT_MAX_MS);
    expect(() => confirm(ENTRY_OPENS_AT_MAX_MS + 1)).toThrow('입력이 틀렸다: entry_opens_at');
  });

  test('P-T26_리뷰 고침 7: 입장 시각 상한은 9999년의 끝이다', () => {
    expect(new Date(ENTRY_OPENS_AT_MAX_MS).toISOString()).toBe('9999-12-31T23:59:59.999Z');
  });
});

describe('CachedPgSelectionReader', () => {
  const stateOf = (primary: PgName): PgSelectionState => ({ assignment: { primary } });

  const counting = (first: PgSelectionState = stateOf('TOSS')) => {
    const calls: string[] = [];
    let value = first;
    const reader: PgSelectionReader = {
      read: async (eventId) => {
        calls.push(eventId);
        return value;
      },
    };
    return { reader, calls, set: (v: PgSelectionState) => (value = v) };
  };

  test('P-T26_1초 안에는 다시 읽지 않고 1초가 지나면 새 값을 읽는다', async () => {
    const clock = fakeClock({ now: NOW });
    const r = counting();
    const cache = new CachedPgSelectionReader({ reader: r.reader, clock });
    expect(await cache.read(EVENT)).toEqual(stateOf('TOSS'));
    r.set(stateOf('PORTONE'));
    clock.advance(PG_SELECTION_CACHE_TTL_MS - 1);
    expect(await cache.read(EVENT)).toEqual(stateOf('TOSS'));
    expect(r.calls).toHaveLength(1);
    clock.advance(1);
    expect(await cache.read(EVENT)).toEqual(stateOf('PORTONE'));
    expect(r.calls).toHaveLength(2);
  });

  test('P-T26_회차마다 따로 둔다', async () => {
    const r = counting();
    const cache = new CachedPgSelectionReader({ reader: r.reader, clock: fakeClock({ now: NOW }) });
    await cache.read('a');
    await cache.read('b');
    await cache.read('a');
    expect(r.calls).toEqual(['a', 'b']);
  });

  test('P-T26_겹친 호출은 읽기 하나를 함께 기다린다', async () => {
    let release!: (v: PgSelectionState) => void;
    let calls = 0;
    const cache = new CachedPgSelectionReader({
      reader: {
        read: () => {
          calls++;
          return new Promise<PgSelectionState>((res) => (release = res));
        },
      },
      clock: fakeClock({ now: NOW }),
    });
    const both = Promise.all([cache.read(EVENT), cache.read(EVENT)]);
    release(stateOf('TOSS'));
    expect(await both).toEqual([stateOf('TOSS'), stateOf('TOSS')]);
    expect(calls).toBe(1);
  });

  test('P-T26_읽기 실패는 캐시하지 않고 오래된 값으로 답하지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const clock = fakeClock({ now: NOW });
    let fail = false;
    let calls = 0;
    const cache = new CachedPgSelectionReader({
      reader: {
        read: async () => {
          calls++;
          if (fail) throw new Error('db down');
          return stateOf('TOSS');
        },
      },
      clock,
    });
    await cache.read(EVENT);
    fail = true;
    clock.advance(PG_SELECTION_CACHE_TTL_MS);
    await expect(cache.read(EVENT)).rejects.toThrow('db down');
    fail = false;
    await expect(cache.read(EVENT)).resolves.toEqual(stateOf('TOSS'));
    expect(calls).toBe(3);
  });

  test('P-T26_회차 수 상한을 넘으면 가장 먼저 넣은 회차를 버린다', async () => {
    const r = counting();
    const cache = new CachedPgSelectionReader({ reader: r.reader, clock: fakeClock({ now: NOW }), maxEvents: 2 });
    await cache.read('a');
    await cache.read('b');
    await cache.read('c');
    await cache.read('a');
    expect(r.calls).toEqual(['a', 'b', 'c', 'a']);
  });

  /** release를 부를 때까지 끝나지 않는 읽기 */
  const held = () => {
    let release!: (v: PgSelectionState) => void;
    const budgets: unknown[] = [];
    const reader: PgSelectionReader = {
      read: (_e, b) => {
        budgets.push(b);
        return new Promise<PgSelectionState>((res) => (release = res));
      },
    };
    return { reader, budgets, release: (v: PgSelectionState) => release(v) };
  };

  test('P-T26_리뷰 고침 2: 저장소 읽기는 첫 호출의 남은 시간이 아니라 고정 150ms다', async () => {
    const budgets: unknown[] = [];
    const cache = new CachedPgSelectionReader({
      reader: {
        read: async (_e, b) => {
          budgets.push(b);
          return stateOf('TOSS');
        },
      },
      clock: fakeClock({ now: NOW }),
    });
    await cache.read(EVENT, { remainingMs: 60 });
    expect(budgets).toEqual([{ remainingMs: PG_SELECTION_CACHE_READ_BUDGET_MS }]);
    expect(PG_SELECTION_CACHE_READ_BUDGET_MS).toBe(150);
  });

  test('P-T26_리뷰 고침 2: 겹친 호출은 저마다 자기 시한을 재고, 먼저 끝난 호출이 읽기를 끊지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const h = held();
    const cache = new CachedPgSelectionReader({ reader: h.reader, clock: fakeClock({ now: NOW }) });
    const short = cache.read(EVENT, { remainingMs: 5 });
    const long = cache.read(EVENT, { remainingMs: 60_000 });
    const unbounded = new Promise<never>((_res, rej) => setTimeout(() => rej(new Error('자기 시한을 재지 않았다')), 1_000));
    await expect(Promise.race([short, unbounded])).rejects.toBeInstanceOf(PaymentDeadlineError);
    h.release(stateOf('TOSS'));
    await expect(long).resolves.toEqual(stateOf('TOSS'));
    expect(h.budgets).toHaveLength(1);
  });

  test('P-T26_리뷰 고침 2: 벽시계가 멈추거나 뒤로 가도 단조 시계로 수명을 잰다', async () => {
    let mono = 0;
    let wall = NOW;
    const r = counting();
    const clock = { now: () => wall, monotonicMs: () => mono };
    const cache = new CachedPgSelectionReader({ reader: r.reader, clock });
    await cache.read(EVENT);
    wall += 3_600_000;
    await cache.read(EVENT);
    expect(r.calls).toHaveLength(1);
    wall -= 7_200_000;
    mono += PG_SELECTION_CACHE_TTL_MS;
    r.set(stateOf('PORTONE'));
    expect(await cache.read(EVENT)).toEqual(stateOf('PORTONE'));
    expect(r.calls).toHaveLength(2);
  });

  test('P-T26_리뷰 고침 2: 회차 하나를 무효로 하면 수명 안이어도 다시 읽고 다른 회차는 그대로다', async () => {
    const r = counting();
    const cache = new CachedPgSelectionReader({ reader: r.reader, clock: fakeClock({ now: NOW }) });
    await cache.read('a');
    await cache.read('b');
    r.set(stateOf('PORTONE'));
    cache.invalidate('a');
    expect(await cache.read('a')).toEqual(stateOf('PORTONE'));
    expect(await cache.read('b')).toEqual(stateOf('TOSS'));
    expect(r.calls).toEqual(['a', 'b', 'a']);
  });

  test('P-T26_리뷰 고침 2: 인자 없이 무효로 하면 모든 회차를 다시 읽는다(플랫폼 전환)', async () => {
    const r = counting();
    const cache = new CachedPgSelectionReader({ reader: r.reader, clock: fakeClock({ now: NOW }) });
    await cache.read('a');
    await cache.read('b');
    cache.invalidate();
    await cache.read('a');
    await cache.read('b');
    expect(r.calls).toEqual(['a', 'b', 'a', 'b']);
  });

  test('P-T26_리뷰 고침 2: 읽는 도중 무효로 하면 뒤에 오는 호출은 앞 읽기를 기다리지 않는다', async () => {
    const h = held();
    const cache = new CachedPgSelectionReader({ reader: h.reader, clock: fakeClock({ now: NOW }) });
    const before = cache.read(EVENT);
    cache.invalidate(EVENT);
    const after = cache.read(EVENT);
    expect(h.budgets).toHaveLength(2);
    h.release(stateOf('PORTONE'));
    await expect(after).resolves.toEqual(stateOf('PORTONE'));
    expect(before).toBeInstanceOf(Promise);
  });
});

describe('DrizzlePgSelection', () => {
  const dialect = new PgDialect();
  const BLANK = { pg_primary: null, pg_fallback: null, e_scope: null, e_active: null, e_from_pg: null, e_to_pg: null, e_version: null, e_changed_at: null, p_scope: null, p_active: null, p_from_pg: null, p_to_pg: null, p_version: null, p_changed_at: null };

  function fakeDatabase(row: Record<string, unknown>) {
    const statements: string[] = [];
    const tx = {
      execute: async (q: SQL) => {
        const text = dialect.sqlToQuery(q).sql;
        statements.push(text);
        return { rows: text.includes('set_config') ? [] : [row] };
      },
      select: () => {
        statements.push('select');
        return { from: () => ({ where: async () => [] }) };
      },
    };
    const database = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as Database;
    return { database, statements };
  }

  test('P-T26_리뷰 고침 3: 문장 시간 한도를 건 뒤 업무 문장은 하나다(문장 한도가 합쳐서 300ms를 넘지 않게)', async () => {
    const d = fakeDatabase(BLANK);
    await new DrizzlePgSelection({ database: d.database }).read(EVENT, { remainingMs: 150 });
    expect(d.statements[0]).toContain('set_config');
    expect(d.statements.slice(1)).toHaveLength(1);
  });

  test('P-T26_리뷰 고침 3: 한 행의 칸을 회차 전환·플랫폼 전환·회차 지정으로 나눈다', async () => {
    const at = new Date(NOW).toISOString();
    const d = fakeDatabase({ ...BLANK, pg_primary: 'PORTONE', pg_fallback: 'TOSS', e_scope: EVENT, e_active: true, e_from_pg: 'PORTONE', e_to_pg: 'TOSS', e_version: '7', e_changed_at: at, p_scope: 'PLATFORM', p_active: false, p_version: '2', p_changed_at: at });
    await expect(new DrizzlePgSelection({ database: d.database }).read(EVENT)).resolves.toEqual({
      assignment: { primary: 'PORTONE', fallback: 'TOSS' },
      eventSwitch: { scope: EVENT, active: true, fromPg: 'PORTONE', toPg: 'TOSS', version: 7, changedAtMs: NOW },
      platformSwitch: { scope: 'PLATFORM', active: false, version: 2, changedAtMs: NOW },
    });
  });

  test('P-T26_리뷰 고침 3: 행이 없는 칸은 싣지 않는다', async () => {
    await expect(new DrizzlePgSelection({ database: fakeDatabase(BLANK).database }).read(EVENT)).resolves.toEqual({});
  });
});

describe('PrepareCheckout 쓰임새', () => {
  const setup = (o: { state?: PgSelectionState; gateways?: readonly FakeGateway[]; deps?: Partial<PrepareCheckoutDeps>; pauses?: readonly EntryPauseRow[]; admitted?: readonly string[] } = {}) => {
    const pauseReads: unknown[] = [];
    const trialReads: [string, PgName][] = [];
    const toss = new FakeGateway('TOSS');
    const portone = new FakeGateway('PORTONE');
    const gateways = new Registry(o.gateways ?? [toss, portone]);
    const outcomes: [PgName | 'none', PrepareCheckoutOutcome][] = [];
    const unavailable: unknown[] = [];
    const unsupported: unknown[] = [];
    const signals: PrepareCheckoutSignals = { prepared: (pg, outcome) => outcomes.push([pg, outcome]) };
    const log: PrepareCheckoutLog = { pgUnavailable: (e) => unavailable.push(e), methodUnsupported: (e) => unsupported.push(e) };
    const clock = fakeClock({ now: NOW });
    const budgets: unknown[] = [];
    const uc = new PrepareCheckout({
      selection: {
        read: async (_e, b) => {
          budgets.push(b);
          return o.state ?? {};
        },
      },
      pauses: {
        read: async (b) => {
          pauseReads.push(b);
          return new Map((o.pauses ?? []).map((r) => [r.pg, r]));
        },
      },
      trials: {
        isAdmitted: async (orderId, pg) => {
          trialReads.push([orderId, pg]);
          return (o.admitted ?? []).includes(orderId);
        },
      },
      gateways,
      channels: channelTableOf(gateways),
      defaults: DEFAULTS,
      webOrigin: 'https://www.example',
      virtualAccountReady: true,
      clock,
      log,
      signals,
      ...o.deps,
    });
    return { uc, toss, portone, outcomes, unavailable, unsupported, clock, budgets, pauseReads, trialReads };
  };

  const pausedRow = (o: Partial<EntryPauseRow> = {}): EntryPauseRow => ({ pg: 'TOSS', stage: 'PROBING', reason: 'PG_FAILURE', sinceMs: NOW, version: 1, ...o });

  const cardOnly = () => [new FakeGateway('TOSS', { payMethods: ['CARD'] }), new FakeGateway('PORTONE')];

  test('P-T26_리뷰 고침 1: 수단 미지원은 method_unsupported로 세고 SEV2 경보·오류 로그에 넣지 않는다 [ASVS v5.0.0-16.3.4]', async () => {
    const s = setup({ gateways: cardOnly() });
    await expect(s.uc.execute(raw({ payMethod: 'EASY_PAY' }))).rejects.toBeInstanceOf(PaymentPgUnavailableError);
    expect(s.outcomes).toEqual([['TOSS', 'method_unsupported']]);
    expect(s.unavailable).toEqual([]);
    expect(s.unsupported).toEqual([{ pg: 'TOSS', eventId: EVENT, payMethod: 'EASY_PAY' }]);
  });

  test('P-T26_리뷰 고침 1: 수단 미지원 경고도 결제사·수단마다 1분에 한 번이다', async () => {
    const s = setup({ gateways: cardOnly() });
    await expect(s.uc.execute(raw({ payMethod: 'EASY_PAY' }))).rejects.toBeInstanceOf(PaymentPgUnavailableError);
    await expect(s.uc.execute(raw({ payMethod: 'EASY_PAY' }))).rejects.toBeInstanceOf(PaymentPgUnavailableError);
    await expect(s.uc.execute(raw({ payMethod: 'MOBILE' }))).rejects.toBeInstanceOf(PaymentPgUnavailableError);
    expect(s.unsupported).toHaveLength(2);
    s.clock.advance(60_000);
    await expect(s.uc.execute(raw({ payMethod: 'EASY_PAY' }))).rejects.toBeInstanceOf(PaymentPgUnavailableError);
    expect(s.unsupported).toHaveLength(3);
  });

  test('P-T26_리뷰 고침 1: 지표 이름표 method_unsupported를 미리 0으로 보인다', async () => {
    const m = new PlatformMetrics('payment-svc');
    new PromPaymentCheckoutSignals().register(m.registry);
    expect(await m.registry.metrics()).toContain('payment_checkout_prepared_total{pg="TOSS",outcome="method_unsupported"} 0');
  });

  test('P-T26_리뷰 고침 1: 수단 미지원 로그는 warn이고 결제사 장애 로그는 error다 [ASVS v5.0.0-16.2.5]', () => {
    const lines: [string, Record<string, unknown>][] = [];
    const log = paymentCheckoutLog({ warn: (o: Record<string, unknown>) => lines.push(['warn', o]), error: (o: Record<string, unknown>) => lines.push(['error', o]) } as never);
    log.methodUnsupported({ pg: 'TOSS', eventId: EVENT, payMethod: 'MOBILE' });
    log.pgUnavailable({ pg: 'TOSS', reason: 'NO_CHANNEL', eventId: EVENT });
    expect(lines).toEqual([
      ['warn', { kind: 'payment-pg-method-unsupported', pg: 'TOSS', payMethod: 'MOBILE', eventId: EVENT }],
      ['error', { kind: 'payment-pg-unavailable', pg: 'TOSS', reason: 'NO_CHANNEL', eventId: EVENT }],
    ]);
  });

  test('P-T26_고른 결제사의 어댑터로 값을 만들고 복귀 주소는 서버가 정한다 [ASVS v5.0.0-3.7.2]', async () => {
    const s = setup();
    const a = await s.uc.execute(raw({ customerKey: 'cust-key-1' }), { remainingMs: 300 });
    expect(a.pg).toBe('TOSS');
    expect(a.switched).toBe(false);
    expect(s.toss.checkouts).toEqual([
      {
        order: { orderId: ORDER, orderName: '공연 티켓', amount: 55_000, customerKey: 'cust-key-1' },
        attempt: { attemptId: ATTEMPT, successUrl: `https://www.example/booking/${EVENT}/checkout/return?order=${ORDER}&pg=TOSS`, failUrl: `https://www.example/booking/${EVENT}/checkout/return?order=${ORDER}&pg=TOSS` },
        payMethod: 'CARD',
      },
    ]);
    expect(s.portone.checkouts).toEqual([]);
    expect(s.budgets).toEqual([{ remainingMs: 300 }]);
    expect(s.outcomes).toEqual([['TOSS', 'ok']]);
  });

  test('P-T26_구매자 키가 없으면 칸을 넘기지 않아 어댑터가 만든다 [ASVS v5.0.0-11.5.1]', async () => {
    const s = setup();
    await s.uc.execute(raw());
    expect(s.toss.checkouts[0]!.order).not.toHaveProperty('customerKey');
  });

  test('P-T26_전환으로 고르면 switched이고 지표가 다르다', async () => {
    const s = setup({ state: { platformSwitch: sw({ toPg: 'PORTONE' }) } });
    const a = await s.uc.execute(raw());
    expect(a).toMatchObject({ pg: 'PORTONE', switched: true });
    expect(s.outcomes).toEqual([['PORTONE', 'switched']]);
  });

  test('P-T26_채널이 없으면 값을 만들지 않고 new-payment-paused이며 경보 로그는 까닭마다 1분에 한 번이다(PRF-201로 답이 바뀜) [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.2.5]', async () => {
    const portone = new FakeGateway('PORTONE');
    const s = setup({ gateways: [portone] });
    await expect(s.uc.execute(raw())).rejects.toBeInstanceOf(PaymentNewPausedError);
    await expect(s.uc.execute(raw())).rejects.toThrow('new-payment-paused');
    expect(portone.checkouts).toEqual([]);
    expect(s.unavailable).toEqual([{ pg: 'TOSS', reason: 'NO_CHANNEL', eventId: EVENT }]);
    expect(s.outcomes).toEqual([
      ['TOSS', 'pg_unavailable'],
      ['TOSS', 'pg_unavailable'],
    ]);
    s.clock.advance(60_000);
    await expect(s.uc.execute(raw())).rejects.toBeInstanceOf(PaymentNewPausedError);
    expect(s.unavailable).toHaveLength(2);
  });

  test('P-T26_서버 승인을 못 하는 어댑터는 고르지 않고 new-payment-paused다(PRF-201로 답이 바뀜) [ASVS v5.0.0-2.2.3]', async () => {
    const toss = new FakeGateway('TOSS', { serverConfirm: false });
    const s = setup({ gateways: [toss, new FakeGateway('PORTONE')] });
    await expect(s.uc.execute(raw())).rejects.toBeInstanceOf(PaymentNewPausedError);
    expect(s.unavailable).toEqual([{ pg: 'TOSS', reason: 'INACTIVE', eventId: EVENT }]);
    expect(toss.checkouts).toEqual([]);
  });

  describe('새 결제 일시 정지(P-T43, BUILD_ORDER PRF-201)', () => {
    test('P-T43_고른 결제사가 확인 호출 단계면 값을 만들지 않고 new-payment-paused이며 지표가 오른다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-2.3.2]', async () => {
      const s = setup({ pauses: [pausedRow()] });
      await expect(s.uc.execute(raw())).rejects.toBeInstanceOf(PaymentNewPausedError);
      expect(s.toss.checkouts).toEqual([]);
      expect(s.outcomes).toEqual([['TOSS', 'new_payment_paused']]);
      expect(s.trialReads).toEqual([]);
    });

    test('P-T43_다른 결제사가 멈춰도 고른 결제사가 열려 있으면 값을 만든다', async () => {
      const s = setup({ pauses: [pausedRow({ pg: 'PORTONE' })] });
      await expect(s.uc.execute(raw())).resolves.toMatchObject({ pg: 'TOSS' });
      expect(s.toss.checkouts).toHaveLength(1);
    });

    test('P-T43_OPEN 행은 열림이다', async () => {
      const s = setup({ pauses: [pausedRow({ stage: 'OPEN' })] });
      await expect(s.uc.execute(raw())).resolves.toMatchObject({ pg: 'TOSS' });
    });

    test('P-T43_시험 재개에서 받지 않은 주문은 503이고 받은 주문의 재호출은 다시 통과한다 [ASVS v5.0.0-2.3.2]', async () => {
      const s = setup({ pauses: [pausedRow({ stage: 'TRIAL' })], admitted: [ORDER] });
      await expect(s.uc.execute(raw({ orderId: ATTEMPT }))).rejects.toBeInstanceOf(PaymentNewPausedError);
      await expect(s.uc.execute(raw())).resolves.toMatchObject({ pg: 'TOSS' });
      expect(s.trialReads).toEqual([
        [ATTEMPT, 'TOSS'],
        [ORDER, 'TOSS'],
      ]);
    });

    test('P-T43_확인 호출 단계로 돌아가면 받은 주문이어도 통과하지 않고 시험 행을 읽지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
      const s = setup({ pauses: [pausedRow({ stage: 'PROBING' })], admitted: [ORDER] });
      await expect(s.uc.execute(raw())).rejects.toBeInstanceOf(PaymentNewPausedError);
      expect(s.trialReads).toEqual([]);
    });

    test('P-T43_재생은 정지를 읽지 않고 값을 다시 만든다 [ASVS v5.0.0-16.5.2]', async () => {
      const s = setup({ pauses: [pausedRow()] });
      await expect(s.uc.execute(raw({ pinnedPg: 'TOSS' }))).resolves.toMatchObject({ pg: 'TOSS' });
      expect(s.pauseReads).toEqual([]);
      expect(s.toss.checkouts).toHaveLength(1);
    });

    test('P-T43_재생에서 채널이 없으면 new-payment-paused가 아니라 pg-unavailable이다(처음 201을 준 요청이다)', async () => {
      const s = setup({ gateways: [new FakeGateway('PORTONE')] });
      await expect(s.uc.execute(raw({ pinnedPg: 'TOSS' }))).rejects.toBeInstanceOf(PaymentPgUnavailableError);
    });

    test('P-T43_수단 미지원은 정지가 아니라 pg-unavailable 그대로다', async () => {
      const s = setup({ gateways: cardOnly(), pauses: [pausedRow()] });
      await expect(s.uc.execute(raw({ payMethod: 'EASY_PAY' }))).rejects.toBeInstanceOf(PaymentPgUnavailableError);
    });

    test('P-T43_정지 중이어도 틀린 수단은 입력 오류가 먼저다 [ASVS v5.0.0-2.2.1]', async () => {
      const s = setup({ pauses: [pausedRow()] });
      await expect(s.uc.execute(raw({ payMethod: 'VIRTUAL_ACCOUNT', virtualAccountAllowed: false }))).rejects.toBeInstanceOf(PaymentInputError);
    });

    test('P-T43_정지 행 읽기와 선택 읽기는 함께 돌아 이 호출의 시한을 두 번 쓰지 않는다', async () => {
      const order: string[] = [];
      let releaseSelection = (): void => {};
      const gate = new Promise<void>((r) => {
        releaseSelection = r;
      });
      const s = setup({
        deps: {
          selection: {
            read: async () => {
              order.push('selection');
              await gate;
              return {};
            },
          },
          pauses: {
            read: async () => {
              order.push('pauses');
              releaseSelection();
              return new Map();
            },
          },
        },
      });
      await expect(s.uc.execute(raw())).resolves.toMatchObject({ pg: 'TOSS' });
      expect(order).toEqual(['selection', 'pauses']);
    });

    test('P-T43_정지 행을 읽지 못하면 그대로 던지고 error로 한 번만 센다(값을 지어내지 않는다) [ASVS v5.0.0-16.5.3]', async () => {
      const boom = new Error('읽기 실패');
      const s = setup({
        deps: {
          pauses: {
            read: async () => {
              throw boom;
            },
          },
        },
      });
      await expect(s.uc.execute(raw())).rejects.toBe(boom);
      expect(s.outcomes).toEqual([['none', 'error']]);
      expect(s.toss.checkouts).toEqual([]);
    });

    test('P-T43_리뷰 고침 L3: 시험 행 읽기에는 앞의 읽기에 쓴 시간을 뺀 시한을 준다 [ASVS v5.0.0-16.5.2]', async () => {
      const seen: unknown[] = [];
      const s = setup({
        pauses: [pausedRow({ stage: 'TRIAL' })],
        deps: {
          selection: {
            read: async () => {
              s.clock.advance(120);
              return {};
            },
          },
          trials: {
            isAdmitted: async (_orderId, _pg, budget) => {
              seen.push(budget);
              return true;
            },
          },
        },
      });
      await expect(s.uc.execute(raw(), { remainingMs: 300 })).resolves.toMatchObject({ pg: 'TOSS' });
      expect(seen).toEqual([{ remainingMs: 180 }]);
    });

    test('P-T43_시험 행을 읽지 못하면 통과시키지 않고 던진다 [ASVS v5.0.0-16.5.3]', async () => {
      const boom = new Error('시험 행 읽기 실패');
      const s = setup({
        pauses: [pausedRow({ stage: 'TRIAL' })],
        deps: {
          trials: {
            isAdmitted: async () => {
              throw boom;
            },
          },
        },
      });
      await expect(s.uc.execute(raw())).rejects.toBe(boom);
      expect(s.toss.checkouts).toEqual([]);
    });
  });

  test('P-T26_허용 수단과 입금 기한을 답에 싣는다(입장 시각 상한 포함)', async () => {
    const s = setup();
    const entry = Date.parse('2026-11-11T00:00:00.000Z');
    const a = await s.uc.execute(raw({ entryOpensAtMs: entry }));
    expect(a.allowedPayMethods).toEqual([...PAY_METHODS]);
    expect(a.depositDueAtMs).toBe(entry - 24 * 3_600_000);
  });

  test('HOT-151 넘긴 것: 계좌번호 암호화 키가 없으면 가상계좌를 뺀다', async () => {
    const s = setup({ deps: { virtualAccountReady: false } });
    const a = await s.uc.execute(raw());
    expect(a.allowedPayMethods).not.toContain('VIRTUAL_ACCOUNT');
    expect(a).not.toHaveProperty('depositDueAtMs');
  });

  test('PRF-184 넘긴 것: 고수요 회차에서 끈 가상계좌를 요청하면 입력 오류다 [ASVS v5.0.0-2.2.3]', async () => {
    const s = setup();
    await expect(s.uc.execute(raw({ payMethod: 'VIRTUAL_ACCOUNT', virtualAccountAllowed: false }))).rejects.toMatchObject({ field: 'pay_method' });
    expect(s.toss.checkouts).toEqual([]);
    expect(s.outcomes).toEqual([['none', 'invalid']]);
  });

  test('P-T26_입력이 틀리면 저장소를 읽지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = setup();
    await expect(s.uc.execute(raw({ orderId: 'x' }))).rejects.toBeInstanceOf(PaymentInputError);
    expect(s.budgets).toEqual([]);
    expect(s.outcomes).toEqual([['none', 'invalid']]);
  });

  test('P-T26_읽기 실패는 그대로 던지고 error로 센다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = setup({
      deps: {
        selection: {
          read: async () => {
            throw new Error('db down');
          },
        },
      },
    });
    await expect(s.uc.execute(raw())).rejects.toThrow('db down');
    expect(s.outcomes).toEqual([['none', 'error']]);
  });
});

describe('loadCheckoutConfig', () => {
  const prod = { PEAKET_ENV: 'prod', PEAKET_WEB_ORIGIN: 'https://www.peaket.example' };

  test('P-T26_local·ci는 기본값이 있다', () => {
    expect(loadCheckoutConfig({ PEAKET_ENV: 'ci' })).toEqual({ defaults: { primary: 'TOSS', fallback: 'PORTONE' }, webOrigin: 'http://localhost:3000' });
  });

  test('P-T26_값을 읽는다', () => {
    expect(loadCheckoutConfig({ ...prod, PEAKET_PG_DEFAULT: 'PORTONE', PEAKET_PG_FALLBACK: 'TOSS' })).toEqual({ defaults: { primary: 'PORTONE', fallback: 'TOSS' }, webOrigin: 'https://www.peaket.example' });
  });

  test('P-T26_대체를 none으로 끌 수 있다', () => {
    expect(loadCheckoutConfig({ ...prod, PEAKET_PG_FALLBACK: 'none' }).defaults).toEqual({ primary: 'TOSS' });
  });

  test.each<[string, Record<string, string>]>([
    ['local·ci 밖에서 출처 없음', { PEAKET_ENV: 'prod' }],
    ['http 출처', { PEAKET_ENV: 'prod', PEAKET_WEB_ORIGIN: 'http://www.peaket.example' }],
    ['경로가 있는 출처', { ...prod, PEAKET_WEB_ORIGIN: 'https://www.peaket.example/app' }],
    ['모르는 결제사', { ...prod, PEAKET_PG_DEFAULT: 'KAKAO' }],
    ['운영에 시뮬레이터', { ...prod, PEAKET_PG_DEFAULT: 'SIMULATOR' }],
    ['기본과 대체가 같음', { ...prod, PEAKET_PG_DEFAULT: 'PORTONE', PEAKET_PG_FALLBACK: 'PORTONE' }],
  ])('P-T26_%s는 시작 실패다 [ASVS v5.0.0-3.7.2]', (_name, env) => {
    expect(() => loadCheckoutConfig(env)).toThrow();
  });

  describe('checkoutAdapterWarnings', () => {
    const has = (...pgs: PgName[]) => (pg: PgName) => pgs.includes(pg);
    const defaults = { primary: 'TOSS', fallback: 'PORTONE' } as const;

    test('P-T26_리뷰 고침 6: local·ci 밖에서 플랫폼 기본의 어댑터가 없으면 시작 실패다', () => {
      expect(() => checkoutAdapterWarnings({ PEAKET_ENV: 'prod' }, defaults, has('PORTONE'))).toThrow(/PEAKET_PG_DEFAULT/);
      expect(() => checkoutAdapterWarnings({}, defaults, has())).toThrow(/PEAKET_PG_DEFAULT/);
      expect(() => checkoutAdapterWarnings({ PEAKET_ENV: 'staging' }, { primary: 'PORTONE' }, has('TOSS'))).toThrow(/PEAKET_PG_DEFAULT/);
    });

    test('P-T26_리뷰 고침 6: local·ci 밖에서 대체의 어댑터가 없으면 경고 한 줄이다', () => {
      expect(checkoutAdapterWarnings({ PEAKET_ENV: 'prod' }, defaults, has('TOSS'))).toEqual([expect.stringContaining('PEAKET_PG_FALLBACK')]);
    });

    test('P-T26_리뷰 고침 6: 둘 다 있거나 대체를 껐으면 경고가 없다', () => {
      expect(checkoutAdapterWarnings({ PEAKET_ENV: 'prod' }, defaults, has('TOSS', 'PORTONE'))).toEqual([]);
      expect(checkoutAdapterWarnings({ PEAKET_ENV: 'prod' }, { primary: 'TOSS' }, has('TOSS'))).toEqual([]);
    });

    test.each(['local', 'ci'])('P-T26_리뷰 고침 6: %s는 어댑터 없이 켠다', (PEAKET_ENV) => {
      expect(checkoutAdapterWarnings({ PEAKET_ENV }, defaults, has())).toEqual([]);
    });
  });

  const portoneEnv = { PEAKET_ENV: 'ci', PEAKET_PG_PORTONE_SECRET: 'sec', PEAKET_PG_PORTONE_STORE_ID: 's', PEAKET_PG_PORTONE_CHANNEL_KEY: 'c', PEAKET_PG_PORTONE_WEBHOOK_SECRET: 'w' };

  test('HOT-140 넘긴 것: 수단별 채널 키 표를 읽는다', () => {
    expect(loadPortoneGatewayConfig({ ...portoneEnv, PEAKET_PG_PORTONE_CHANNEL_KEYS: '{"CARD":"k1","EASY_PAY":"k2"}' })?.channelKeys).toEqual({ CARD: 'k1', EASY_PAY: 'k2' });
    expect(loadPortoneGatewayConfig(portoneEnv)).not.toHaveProperty('channelKeys');
  });

  test.each([['JSON이 아님', 'x'], ['모르는 수단', '{"BITCOIN":"k"}'], ['빈 값', '{"CARD":""}'], ['배열', '["k"]']])('HOT-140 넘긴 것: 채널 키 표가 %s면 시작 실패이고 글에 값을 싣지 않는다', (_n, raw2) => {
    expect(() => loadPortoneGatewayConfig({ ...portoneEnv, PEAKET_PG_PORTONE_CHANNEL_KEYS: raw2 })).toThrow(/PEAKET_PG_PORTONE_CHANNEL_KEYS/);
  });
});

test('운영 조립: 설정 읽기는 듣기 전이고 PrepareCheckout을 처리기에 잇는다(글 검사)', () => {
  const m = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  expect(m.indexOf('loadCheckoutConfig(process.env)')).toBeGreaterThan(-1);
  expect(m.indexOf('loadCheckoutConfig(process.env)')).toBeLessThan(m.indexOf('await service.listen()'));
  expect(m).toMatch(/prepareCheckout: new PrepareCheckout\(/);
  expect(m).toMatch(/new CachedPgSelectionReader\(/);
  expect(m).toMatch(/virtualAccountReady: virtualAccountCipher\.ready/);
});

test('P-T26_리뷰 고침 6: 운영 조립: 어댑터 확인은 듣기 전이고 경고는 로그로 낸다(글 검사)', () => {
  const m = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const at = m.indexOf('checkoutAdapterWarnings(process.env');
  expect(at).toBeGreaterThan(-1);
  expect(at).toBeLessThan(m.indexOf('await service.listen()'));
  expect(at).toBeGreaterThan(m.indexOf('const gateways = new StaticPaymentGateways'));
  expect(m).toMatch(/for \(const warning of checkoutWarnings\) service\.logger\.warn\(\{ kind: 'payment-checkout-adapter' \}, warning\)/);
});
