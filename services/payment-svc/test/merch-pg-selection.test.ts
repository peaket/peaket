// 굿즈 결제의 결제창 준비(ADR-0299 결정 3, docs/features/payment.md §2 '선택기의 첫 구현'·§11 P-T56 ⑤, BAT-600).
// 공개 도메인 함수 parsePrepareCheckoutInput과 쓰임새 PrepareCheckout(결제사 어댑터·선택 읽기는 대역)를 바깥 경계로 본다.
// 값은 정본에서 적는다: 굿즈 복귀 주소 `{PEAKET_WEB_ORIGIN}/shop/checkout/return?order={orderId}&pg={결제사}`(성공·실패 같은 주소), 가상계좌·입금 기한은 굿즈에도 있다(ADR-0314, BAT-605).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PrepareCheckout } from '../src/modules/payment/application/prepare-checkout.js';
import { PaymentInputError } from '../src/modules/payment/domain/confirm-command.js';
import { type CheckoutAttempt, type CheckoutOrder, type CheckoutValues, PAY_METHODS, type PaymentGatewayPort, type PgCapabilities, type PgName } from '../src/modules/payment/domain/payment-gateway.js';
import { channelTableOf, channelsForStore, escrowProductsOf, parsePrepareCheckoutInput, paymentStoreOf, type PgChannelTable, type PgSelectionState, type PgSwitchRow, type PrepareCheckoutInput } from '../src/modules/payment/domain/pg-selection.js';
import type { PaymentGateways } from '../src/modules/payment/domain/ports.js';

const ORDER = '22222222-2222-7222-8222-222222222222';
const ATTEMPT = '33333333-3333-7333-8333-333333333333';
const EVENT = '11111111-1111-7111-8111-111111111111';
const NOW = Date.parse('2026-11-18T03:00:00.000Z');
const ORIGIN = 'https://shop.peaket.test';

class FakeGateway implements PaymentGatewayPort {
  readonly checkouts: { order: CheckoutOrder; attempt: CheckoutAttempt; payMethod: string }[] = [];
  constructor(readonly pg: PgName) {}
  capabilities(): PgCapabilities {
    return { serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 1, callsPerSecond: 10, redirectCheckout: true };
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

const merchRaw = (o: Partial<PrepareCheckoutInput> = {}): PrepareCheckoutInput => ({ orderKind: 'MERCH', orderId: ORDER, attemptId: ATTEMPT, eventId: '', amount: 39_000, orderName: '공식 응원봉', payMethod: '', ...o });
const sw = (o: Partial<PgSwitchRow> = {}): PgSwitchRow => ({ scope: 'PLATFORM', active: true, version: 1, changedAtMs: NOW, ...o });

/** 선택 읽기 대역: 회차 ID마다 상태. 읽은 회차 ID를 적는다. 모르는 ID는 `fallback`(빈 UUID 같은 값에 행이 생긴 경우를 흉내) */
function setup(o: { byEvent?: Record<string, PgSelectionState>; fallback?: PgSelectionState; virtualAccountReady?: boolean } = {}) {
  const toss = new FakeGateway('TOSS');
  const portone = new FakeGateway('PORTONE');
  const simulator = new FakeGateway('SIMULATOR');
  const gateways = new Registry([toss, portone, simulator]);
  const reads: string[] = [];
  const uc = new PrepareCheckout({
    selection: {
      read: async (eventId) => {
        reads.push(eventId);
        return o.byEvent?.[eventId] ?? o.fallback ?? {};
      },
    },
    pauses: { read: async () => new Map() },
    trials: { isAdmitted: async () => false, admit: async () => undefined },
    gateways,
    channels: channelTableOf(gateways),
    defaults: { primary: 'TOSS', fallback: 'PORTONE' },
    webOrigin: ORIGIN,
    virtualAccountReady: o.virtualAccountReady ?? true,
    clock: fakeClock({ now: NOW }),
    log: { pgUnavailable: () => undefined, methodUnsupported: () => undefined },
    signals: { prepared: () => undefined },
  });
  return { uc, toss, portone, simulator, reads };
}

function fieldOf(fn: () => unknown): string {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, String(err)).toBeInstanceOf(PaymentInputError);
  return (err as PaymentInputError).field;
}

describe('굿즈 결제창 준비 입력(ADR-0299 결정 3)', () => {
  test('P-T56 ⑤ MERCH는 회차가 비어도 받고 회차는 null이다 [ASVS v5.0.0-2.2.1]', () => {
    const c = parsePrepareCheckoutInput(merchRaw());
    expect(c).toMatchObject({ orderKind: 'MERCH', orderId: ORDER, attemptId: ATTEMPT, eventId: null, payMethod: 'CARD' });
  });

  test('P-T56 ⑤ MERCH에 회차가 있으면(티켓 연동 부가 상품의 연결 회차) 소문자 UUID여야 한다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parsePrepareCheckoutInput(merchRaw({ eventId: EVENT })).eventId).toBe(EVENT);
    expect(fieldOf(() => parsePrepareCheckoutInput(merchRaw({ eventId: '0193a1b2-c3d4-7e5f-8a6b-1234567890a3'.toUpperCase() })))).toBe('event_id');
    expect(fieldOf(() => parsePrepareCheckoutInput(merchRaw({ eventId: 'x' })))).toBe('event_id');
  });

  test('P-T56 ⑤ MERCH의 VIRTUAL_ACCOUNT 요청도 받고 다섯 수단을 모두 받는다(굿즈 입금 대기, BAT-605) [ASVS v5.0.0-2.2.1]', () => {
    expect(parsePrepareCheckoutInput(merchRaw({ payMethod: 'VIRTUAL_ACCOUNT' })).payMethod).toBe('VIRTUAL_ACCOUNT');
    expect(parsePrepareCheckoutInput(merchRaw({ eventId: EVENT, payMethod: 'VIRTUAL_ACCOUNT' })).payMethod).toBe('VIRTUAL_ACCOUNT');
    for (const m of PAY_METHODS) expect(parsePrepareCheckoutInput(merchRaw({ payMethod: m })).payMethod, m).toBe(m);
  });

  test('P-T56 ⑤ MERCH는 가상계좌 허용이 기본 참이고 보낸 값을 따른다', () => {
    expect(parsePrepareCheckoutInput(merchRaw()).virtualAccountAllowed).toBe(true);
    expect(parsePrepareCheckoutInput(merchRaw({ virtualAccountAllowed: true })).virtualAccountAllowed).toBe(true);
    // 끄는 쪽(거짓)도 그대로 받는다
    expect(parsePrepareCheckoutInput(merchRaw({ virtualAccountAllowed: false })).virtualAccountAllowed).toBe(false);
  });

  test('P-T56 ⑤ 주문 종류는 TICKET·MERCH만 받고 그 밖은 값마다 INVALID_ARGUMENT(order_kind)다 [ASVS v5.0.0-2.2.1]', () => {
    for (const orderKind of ['UNSPECIFIED', '', 'UNRECOGNIZED', 'GIFT', 'merch']) expect(fieldOf(() => parsePrepareCheckoutInput(merchRaw({ orderKind }))), orderKind).toBe('order_kind');
  });
});

describe('굿즈 결제창 준비 쓰임새(ADR-0299 결정 3)', () => {
  test('P-T56 ⑤ 회차 없는 굿즈의 복귀 주소는 /shop/checkout/return?order=…&pg=…이고 성공·실패가 같다 [ASVS v5.0.0-3.7.2]', async () => {
    const s = setup();
    const a = await s.uc.execute(merchRaw());
    expect(a.pg).toBe('TOSS');
    expect(s.toss.checkouts).toHaveLength(1);
    expect(s.toss.checkouts[0]!.attempt).toEqual({
      attemptId: ATTEMPT,
      successUrl: `https://shop.peaket.test/shop/checkout/return?order=${ORDER}&pg=TOSS`,
      failUrl: `https://shop.peaket.test/shop/checkout/return?order=${ORDER}&pg=TOSS`,
    });
  });

  test('P-T56 ⑤ 회차가 있는 굿즈(부가 상품)도 굿즈 복귀 주소이고 /booking/ 주소가 아니다', async () => {
    const s = setup({ byEvent: { [EVENT]: { assignment: { primary: 'PORTONE' } } } });
    const a = await s.uc.execute(merchRaw({ eventId: EVENT }));
    expect(a.pg).toBe('PORTONE');
    expect(s.portone.checkouts[0]!.attempt.successUrl).toBe(`https://shop.peaket.test/shop/checkout/return?order=${ORDER}&pg=PORTONE`);
    expect(s.portone.checkouts[0]!.attempt.failUrl).toBe(`https://shop.peaket.test/shop/checkout/return?order=${ORDER}&pg=PORTONE`);
  });

  test('P-T56 ⑤ 회차가 없으면 회차 지정·회차 전환 행은 보지 않고 플랫폼 기본 결제사다', async () => {
    // 읽기가 회차 행을 돌려줘도(빈 UUID에 행이 생긴 경우) 굿즈는 따르지 않는다
    const s = setup({ fallback: { assignment: { primary: 'PORTONE' }, eventSwitch: sw({ scope: 'x', toPg: 'SIMULATOR' }) } });
    const a = await s.uc.execute(merchRaw());
    expect(a).toMatchObject({ pg: 'TOSS', switched: false });
    expect(s.portone.checkouts).toEqual([]);
    expect(s.simulator.checkouts).toEqual([]);
  });

  test('P-T56 ⑤ 회차가 없어도 플랫폼 전환 행은 따른다(대상이 비면 플랫폼 대체)', async () => {
    const s = setup({ fallback: { platformSwitch: sw() } });
    expect(await s.uc.execute(merchRaw())).toMatchObject({ pg: 'PORTONE', switched: true });
  });

  test('P-T56 ⑤ 회차가 있으면 그 회차의 지정 행을 따른다(회차 있음·없음 짝)', async () => {
    const s = setup({ byEvent: { [EVENT]: { assignment: { primary: 'SIMULATOR' } } } });
    expect((await s.uc.execute(merchRaw({ eventId: EVENT }))).pg).toBe('SIMULATOR');
    expect(s.reads).toContain(EVENT);
    expect((await s.uc.execute(merchRaw())).pg).toBe('TOSS');
  });

  test('P-T56 ⑤ 굿즈 답의 허용 수단에 가상계좌가 있고 입금 기한은 다음 날 23:59 KST다(계좌 키가 없으면 빠진다)', async () => {
    const s = setup({ virtualAccountReady: true });
    const a = await s.uc.execute(merchRaw());
    expect(a.allowedPayMethods).toContain('VIRTUAL_ACCOUNT');
    expect([...a.allowedPayMethods].sort()).toEqual([...PAY_METHODS].sort());
    // 2026-11-18T03:00Z = 2026-11-18 12:00 KST → 다음 날 23:59 KST = 2026-11-19T14:59Z
    expect(a.depositDueAtMs).toBe(Date.parse('2026-11-19T14:59:00.000Z'));
    // 키가 없으면 입금 기한도 싣지 않는다
    const noKey = setup({ virtualAccountReady: false });
    const b = await noKey.uc.execute(merchRaw());
    expect(b.allowedPayMethods).not.toContain('VIRTUAL_ACCOUNT');
    expect(b).not.toHaveProperty('depositDueAtMs');
    // 허용을 끄면 가상계좌도 기한도 없다
    const off = await s.uc.execute(merchRaw({ virtualAccountAllowed: false }));
    expect(off.allowedPayMethods).not.toContain('VIRTUAL_ACCOUNT');
    expect(off).not.toHaveProperty('depositDueAtMs');
  });

  test('P-T56 ⑤ 굿즈의 VIRTUAL_ACCOUNT 요청은 결제사 어댑터를 부르고 그 수단으로 결제창 값을 만든다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = setup();
    const a = await s.uc.execute(merchRaw({ payMethod: 'VIRTUAL_ACCOUNT' }));
    expect(a.allowedPayMethods).toContain('VIRTUAL_ACCOUNT');
    expect(s.toss.checkouts).toHaveLength(1);
    expect(s.toss.checkouts[0]!.payMethod).toBe('VIRTUAL_ACCOUNT');
    expect(s.portone.checkouts).toEqual([]);
  });
});

describe('에스크로 상점의 값 검사(ADR-0313, BAT-605)', () => {
  test('P-T59 ②_결제_상점_이름은_비면_STANDARD이고_STANDARD·ESCROW만_받는다', () => {
    expect(paymentStoreOf(undefined)).toBe('STANDARD');
    expect(paymentStoreOf('')).toBe('STANDARD');
    expect(paymentStoreOf('UNSPECIFIED')).toBe('STANDARD');
    expect(paymentStoreOf('STANDARD')).toBe('STANDARD');
    expect(paymentStoreOf('ESCROW')).toBe('ESCROW');
    for (const value of ['escrow', 'GIFT', 'PAYMENT_STORE_ESCROW']) expect(fieldOf(() => paymentStoreOf(value)), value).toBe('payment_store');
  });

  test('P-T59 ②_에스크로_상품은_상품마다_값을_검사하고_목록_상한을_지킨다 [ASVS v5.0.0-2.2.1]', () => {
    const product = { id: 'merch-1', name: '응원봉', code: '', unitPrice: 12_300, quantity: 3 };
    expect(escrowProductsOf([product])).toEqual([product]);
    expect(escrowProductsOf(undefined)).toBeUndefined();
    expect(fieldOf(() => escrowProductsOf([]))).toBe('escrow_products');
    const invalid = [
      { ...product, id: '' },
      { ...product, name: '' },
      { ...product, name: 'a\u0007b' },
      { ...product, code: 'x'.repeat(201) },
      { ...product, unitPrice: 0 },
      { ...product, unitPrice: 1.5 },
      { ...product, quantity: 0 },
      { ...product, quantity: 10_000 },
    ];
    for (const value of invalid) expect(fieldOf(() => escrowProductsOf([value])), JSON.stringify(value)).toBe('escrow_products');
    // 목록 경계: 100건은 받고 101건은 거절한다(정본 상한)
    expect(escrowProductsOf(Array.from({ length: 100 }, () => product))).toHaveLength(100);
    expect(fieldOf(() => escrowProductsOf(Array.from({ length: 101 }, () => product)))).toBe('escrow_products');
  });

  test('P-T59 ③_에스크로_상점의_채널은_카드·계좌이체·가상계좌만_남기고_원래_표를_바꾸지_않는다', () => {
    const channels: PgChannelTable = new Map([['TOSS', { active: true, payMethods: new Set(PAY_METHODS) }]]);
    const escrow = channelsForStore(channels, 'ESCROW');
    expect([...escrow.get('TOSS')!.payMethods]).toEqual(['CARD', 'TRANSFER', 'VIRTUAL_ACCOUNT']);
    // 표준 상점은 같은 표를 그대로 돌려주고, 에스크로는 새 표를 만든다(원래 표의 수단이 줄지 않는다)
    expect(channelsForStore(channels, 'STANDARD')).toBe(channels);
    expect([...channels.get('TOSS')!.payMethods]).toEqual([...PAY_METHODS]);
  });
});
