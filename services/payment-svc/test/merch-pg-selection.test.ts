// 굿즈 결제의 결제창 준비(ADR-0299 결정 3, docs/features/payment.md §2 '선택기의 첫 구현'·§11 P-T55 ⑤, BAT-600).
// 공개 도메인 함수 parsePrepareCheckoutInput과 쓰임새 PrepareCheckout(결제사 어댑터·선택 읽기는 대역)를 바깥 경계로 본다.
// 값은 정본에서 적는다: 굿즈 복귀 주소 `{PEAKET_WEB_ORIGIN}/shop/checkout/return?order={orderId}&pg={결제사}`(성공·실패 같은 주소), 가상계좌 뺌.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PrepareCheckout } from '../src/modules/payment/application/prepare-checkout.js';
import { PaymentInputError } from '../src/modules/payment/domain/confirm-command.js';
import { type CheckoutAttempt, type CheckoutOrder, type CheckoutValues, PAY_METHODS, type PaymentGatewayPort, type PgCapabilities, type PgName } from '../src/modules/payment/domain/payment-gateway.js';
import { channelTableOf, parsePrepareCheckoutInput, type PgSelectionState, type PgSwitchRow, type PrepareCheckoutInput } from '../src/modules/payment/domain/pg-selection.js';
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
  test('P-T55 ⑤ MERCH는 회차가 비어도 받고 회차는 null이다 [ASVS v5.0.0-2.2.1]', () => {
    const c = parsePrepareCheckoutInput(merchRaw());
    expect(c).toMatchObject({ orderKind: 'MERCH', orderId: ORDER, attemptId: ATTEMPT, eventId: null, payMethod: 'CARD' });
  });

  test('P-T55 ⑤ MERCH에 회차가 있으면(티켓 연동 부가 상품의 연결 회차) 소문자 UUID여야 한다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parsePrepareCheckoutInput(merchRaw({ eventId: EVENT })).eventId).toBe(EVENT);
    expect(fieldOf(() => parsePrepareCheckoutInput(merchRaw({ eventId: '0193a1b2-c3d4-7e5f-8a6b-1234567890a3'.toUpperCase() })))).toBe('event_id');
    expect(fieldOf(() => parsePrepareCheckoutInput(merchRaw({ eventId: 'x' })))).toBe('event_id');
  });

  test('P-T55 ⑤ MERCH의 VIRTUAL_ACCOUNT 요청은 INVALID_ARGUMENT(pay_method)이고 그 밖의 수단은 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(fieldOf(() => parsePrepareCheckoutInput(merchRaw({ payMethod: 'VIRTUAL_ACCOUNT' })))).toBe('pay_method');
    expect(fieldOf(() => parsePrepareCheckoutInput(merchRaw({ eventId: EVENT, payMethod: 'VIRTUAL_ACCOUNT' })))).toBe('pay_method');
    for (const m of PAY_METHODS.filter((x) => x !== 'VIRTUAL_ACCOUNT')) expect(parsePrepareCheckoutInput(merchRaw({ payMethod: m })).payMethod, m).toBe(m);
  });

  test('P-T55 ⑤ MERCH는 가상계좌 허용을 참으로 보내도 거짓이다(굿즈 입금 대기는 BAT-605)', () => {
    expect(parsePrepareCheckoutInput(merchRaw({ virtualAccountAllowed: true })).virtualAccountAllowed).toBe(false);
    expect(parsePrepareCheckoutInput(merchRaw()).virtualAccountAllowed).toBe(false);
  });

  test('P-T55 ⑤ 주문 종류는 TICKET·MERCH만 받고 그 밖은 값마다 INVALID_ARGUMENT(order_kind)다 [ASVS v5.0.0-2.2.1]', () => {
    for (const orderKind of ['UNSPECIFIED', '', 'UNRECOGNIZED', 'GIFT', 'merch']) expect(fieldOf(() => parsePrepareCheckoutInput(merchRaw({ orderKind }))), orderKind).toBe('order_kind');
  });
});

describe('굿즈 결제창 준비 쓰임새(ADR-0299 결정 3)', () => {
  test('P-T55 ⑤ 회차 없는 굿즈의 복귀 주소는 /shop/checkout/return?order=…&pg=…이고 성공·실패가 같다 [ASVS v5.0.0-3.7.2]', async () => {
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

  test('P-T55 ⑤ 회차가 있는 굿즈(부가 상품)도 굿즈 복귀 주소이고 /booking/ 주소가 아니다', async () => {
    const s = setup({ byEvent: { [EVENT]: { assignment: { primary: 'PORTONE' } } } });
    const a = await s.uc.execute(merchRaw({ eventId: EVENT }));
    expect(a.pg).toBe('PORTONE');
    expect(s.portone.checkouts[0]!.attempt.successUrl).toBe(`https://shop.peaket.test/shop/checkout/return?order=${ORDER}&pg=PORTONE`);
    expect(s.portone.checkouts[0]!.attempt.failUrl).toBe(`https://shop.peaket.test/shop/checkout/return?order=${ORDER}&pg=PORTONE`);
  });

  test('P-T55 ⑤ 회차가 없으면 회차 지정·회차 전환 행은 보지 않고 플랫폼 기본 결제사다', async () => {
    // 읽기가 회차 행을 돌려줘도(빈 UUID에 행이 생긴 경우) 굿즈는 따르지 않는다
    const s = setup({ fallback: { assignment: { primary: 'PORTONE' }, eventSwitch: sw({ scope: 'x', toPg: 'SIMULATOR' }) } });
    const a = await s.uc.execute(merchRaw());
    expect(a).toMatchObject({ pg: 'TOSS', switched: false });
    expect(s.portone.checkouts).toEqual([]);
    expect(s.simulator.checkouts).toEqual([]);
  });

  test('P-T55 ⑤ 회차가 없어도 플랫폼 전환 행은 따른다(대상이 비면 플랫폼 대체)', async () => {
    const s = setup({ fallback: { platformSwitch: sw() } });
    expect(await s.uc.execute(merchRaw())).toMatchObject({ pg: 'PORTONE', switched: true });
  });

  test('P-T55 ⑤ 회차가 있으면 그 회차의 지정 행을 따른다(회차 있음·없음 짝)', async () => {
    const s = setup({ byEvent: { [EVENT]: { assignment: { primary: 'SIMULATOR' } } } });
    expect((await s.uc.execute(merchRaw({ eventId: EVENT }))).pg).toBe('SIMULATOR');
    expect(s.reads).toContain(EVENT);
    expect((await s.uc.execute(merchRaw())).pg).toBe('TOSS');
  });

  test('P-T55 ⑤ 굿즈 답의 허용 수단에 가상계좌가 없고 입금 기한도 없다(계좌 키가 있어도)', async () => {
    const s = setup({ virtualAccountReady: true });
    const a = await s.uc.execute(merchRaw({ virtualAccountAllowed: true }));
    expect(a.allowedPayMethods).not.toContain('VIRTUAL_ACCOUNT');
    expect([...a.allowedPayMethods].sort()).toEqual(PAY_METHODS.filter((m) => m !== 'VIRTUAL_ACCOUNT').sort());
    expect(a).not.toHaveProperty('depositDueAtMs');
  });

  test('P-T55 ⑤ 굿즈의 VIRTUAL_ACCOUNT 요청은 결제사 어댑터를 부르지 않고 거절한다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = setup();
    await expect(s.uc.execute(merchRaw({ payMethod: 'VIRTUAL_ACCOUNT' }))).rejects.toBeInstanceOf(PaymentInputError);
    expect(s.toss.checkouts).toEqual([]);
    expect(s.portone.checkouts).toEqual([]);
  });
});
