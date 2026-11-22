// 굿즈 결제 시도의 결제창 값을 저장하지 않는 재생(P-T77 ①~⑤, W12-merch-replay, ADR-0352).
// 정본: ADR-0337 결정 6, guidelines §4 '예외 둘째'(굿즈 확장), data.md '서비스마다 둔 멱등 기록 표'.
// 결과 참조는 시도 ID 하나이고, 재생은 PrepareCheckout을 같은 시도 ID·고정 결제사로 다시 불러 지금 설정의 결제창 값을 만든다.
// 대역(ProbeMerchPayments)은 호출마다 바꾸는 공개 키·돌아올 주소·구매자 키와, 시도·주문과 어긋나는 결제사·금액·주문 ID를 줄 수 있다.
// 시험 값은 코드 기본값과 다르게 고른다(가격 16,700원, 공개 키·주소 두 벌, 구매자 키 두 벌).
import { randomBytes, randomUUID } from 'node:crypto';
import { fakeClock, type IdempotencyRequest } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  CheckoutFailed,
  CreateMerchOrder,
  MemoryHeldTickets,
  MemoryMerchStock,
  MemoryProductStore,
  MemoryShopOrderStore,
  MerchOrdersRead,
  MerchPayment,
  type CreateShopOrderInput,
  type ProductRecord,
  ShopProblem,
  type ShopLogger,
} from '../src/modules/shop/index.js';
import { ProbeMerchPayments } from './support.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-12-16T03:00:00.000Z');
const SELLER = randomUUID();
const PRICE = 16_700;
const PRODUCT_NAME = '재생 굿즈';
const OP_START = 'START_MERCH_PAYMENT';
const OP_ORDER = 'CREATE_MERCH_ORDER';
const MISMATCH = 'idempotency-replay-mismatch';
const REPLAY_INVALID = 'merch-checkout-replay-mismatch';

interface LogLine {
  level: 'info' | 'warn' | 'error';
  o: Record<string, unknown>;
  msg: string;
}
class RecordingLogger implements ShopLogger {
  readonly lines: LogLine[] = [];
  info(o: object, msg: string): void {
    this.lines.push({ level: 'info', o: Object.fromEntries(Object.entries(o)), msg });
  }
  warn(o: object, msg: string): void {
    this.lines.push({ level: 'warn', o: Object.fromEntries(Object.entries(o)), msg });
  }
  error(o: object, msg: string): void {
    this.lines.push({ level: 'error', o: Object.fromEntries(Object.entries(o)), msg });
  }
}

function harness() {
  const clock = fakeClock({ now: T0 });
  const products = new MemoryProductStore();
  const store = new MemoryShopOrderStore(products);
  const payments = new ProbeMerchPayments(() => clock.now());
  const stock = new MemoryMerchStock();
  const held = new MemoryHeldTickets();
  const log = new RecordingLogger();
  const read = new MerchOrdersRead({ store, payments, clock });
  return {
    clock,
    products,
    store,
    payments,
    stock,
    held,
    log,
    read,
    create: new CreateMerchOrder({ store, stock, held, clock, consentVersion: undefined, logger: log }),
    pay: new MerchPayment({ store, stock, payments, clock, logger: log }),
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

const once = (accountRef: string, operation: string): IdempotencyRequest => ({ accountRef, operation, key: randomUUID(), requestHash: randomBytes(32) });
const recordKey = (o: IdempotencyRequest) => `${o.accountRef}|${o.operation}|${o.key}`;
const recordOf = (o: IdempotencyRequest) => h.store.idempotency.get(recordKey(o))?.resultRef;

function product(o: Partial<ProductRecord> = {}): ProductRecord {
  const p: ProductRecord = {
    productId: randomUUID(),
    promoterId: SELLER,
    type: 'MERCH',
    name: PRODUCT_NAME,
    status: 'PUBLISHED',
    price: PRICE,
    shippingFee: null,
    returnShippingFee: 3_000,
    returnAddress: '서울특별시 마포구 월드컵로 1',
    limitedQty: null,
    stock: null,
    transferable: false,
    ticketLinked: false,
    linkedEventId: null,
    fulfillments: ['PICKUP'],
    saleStartsAt: null,
    saleEndsAt: null,
    commissionRateBp: 1000,
    attributes: {},
    schemaVersion: 1,
    version: 1,
    publishedAt: new Date(T0 - 10 * DAY),
    updatedAt: new Date(T0 - 10 * DAY),
    ...o,
  };
  h.products.rows.set(p.productId, p);
  return p;
}

/** 한정이 아닌 상품 하나와 끝나지 않은 현장 수령 시간대로 만든 주문 본문 */
function pickupBody(): CreateShopOrderInput {
  const p = product();
  const slotId = randomUUID();
  h.store.slots.set(slotId, { slotId, productId: p.productId, eventId: randomUUID(), startsAt: new Date(T0 + 3_600_000), endsAt: new Date(T0 + 7_200_000), ticketHoldersOnly: false });
  return { fulfillment: 'PICKUP', items: [{ productId: p.productId, quantity: 1 }], pickupSlotId: slotId };
}

const order = async (accountId: string, body: CreateShopOrderInput = pickupBody()): Promise<string> =>
  (await h.create.shop(accountId, body, once(accountId, OP_ORDER))).orderId;

interface Problem {
  status: number;
  type: string;
  title: string;
}
/** ShopProblem 거절이면 그 칸을, 값이 오거나 다른 오류면 시험을 멈춘다 */
async function problemOf(p: Promise<unknown>): Promise<Problem> {
  const s = await p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (s.ok) throw new Error(`거절을 기대했는데 값이 왔다: ${JSON.stringify(s.value)}`);
  if (!(s.error instanceof ShopProblem)) throw s.error;
  return { status: s.error.status, type: s.error.type, title: s.error.title };
}

/** 남의 주문 404(다른 계정이 그 주문을 읽는다). 맞지 않는 재생은 이것과 같아야 한다 */
async function foreign404(orderId: string): Promise<Problem> {
  const p = await problemOf(h.read.get(randomUUID(), orderId));
  expect(p).toMatchObject({ status: 404, type: 'not-found' });
  return p;
}

/** 결과 참조를 직접 바꾼다(옛 JSON 참조·다른 시도 ID를 만드는 자리) */
function setRef(o: IdempotencyRequest, ref: string): void {
  const key = recordKey(o);
  const seen = h.store.idempotency.get(key);
  expect(seen, `${o.operation} 기록`).toBeDefined();
  h.store.idempotency.set(key, { hash: seen!.hash, resultRef: ref });
}

/** 로그가 정확히 한 줄(오류)이고 정한 칸만 있으며, 금지한 값이 없다 */
function expectOneLog(what: string, kind: string, extra: Record<string, unknown>, forbidden: readonly string[]): LogLine {
  expect(h.log.lines, what).toHaveLength(1);
  expect(h.log.lines[0], what).toMatchObject({ level: 'error', o: { kind, severity: 'SEV2', ...extra } });
  const text = JSON.stringify(h.log.lines[0]);
  for (const f of forbidden) expect(text.includes(f), `${what}: 로그에 ${f}`).toBe(false);
  return h.log.lines[0];
}

const mismatchLines = () => h.log.lines.filter((l) => l.o.kind === MISMATCH);

describe('P-T77 굿즈 결제 시도의 결제창 값 재생', () => {
  test('P-T77 ① 처음 굿즈 결제 시도는 결제창 값을 돌려주고 멱등 기록에는 시도 ID만 남긴다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const O = await order(C);
    const K = once(C, OP_START);
    const view = await h.pay.start(C, O, {}, K);
    const checkout = view.checkout as { clientKey: string; customerKey: string; orderId: string; amount: number; successUrl: string; failUrl: string };
    expect({ attemptId: view.attemptId, pg: view.pg, orderId: checkout.orderId, amount: checkout.amount }).toEqual({ attemptId: view.attemptId, pg: 'SIMULATOR', orderId: O, amount: PRICE });
    expect(checkout.clientKey).toBe('test_ck_first');
    expect(checkout.successUrl).toBe(`https://first.example/shop/checkout/return?order=${O}&pg=SIMULATOR`);
    expect(checkout.customerKey).toEqual(expect.any(String));
    expect(view.allowedPayMethods).toContain('CARD');

    const ref = recordOf(K);
    expect(ref, '결과 참조').toBe(view.attemptId);
    const record = h.store.idempotency.get(recordKey(K))!;
    const text = JSON.stringify(record);
    for (const token of ['clientKey', 'customerKey', 'successUrl', 'failUrl', 'redirectUrl', 'totalAmount', '"checkout"', 'first.example']) {
      expect(text.includes(token), `기록에 ${token}`).toBe(false);
    }
    expect(await h.store.paymentAttempt(ref!)).toMatchObject({ attemptId: view.attemptId, orderId: O, pg: 'SIMULATOR', payMethod: null });
  });

  test('P-T77 ② 같은 멱등키 재생은 PrepareCheckout을 같은 시도 ID·결제사로 다시 불러 지금 설정 값으로 결제창을 다시 만든다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const O = await order(C);
    const K = once(C, OP_START);
    const first = await h.pay.start(C, O, {}, K);
    const firstCheckout = first.checkout as { clientKey: string; customerKey: string; successUrl: string };
    const before = { writes: h.store.writes, attempts: h.store.attempts.size, ref: recordOf(K), checkouts: h.payments.calls.checkout.length };

    h.payments.clientKey = 'test_ck_second';
    h.payments.origin = 'https://second.example';
    h.payments.customerKey = 'buyer-second';
    const again = await h.pay.start(C, O, {}, K);
    const againCheckout = again.checkout as { clientKey: string; customerKey: string; successUrl: string; failUrl: string; orderId: string; amount: number };
    expect({ attemptId: again.attemptId, pg: again.pg, orderId: againCheckout.orderId, amount: againCheckout.amount }).toEqual({
      attemptId: first.attemptId,
      pg: 'SIMULATOR',
      orderId: O,
      amount: PRICE,
    });
    expect({ clientKey: againCheckout.clientKey, customerKey: againCheckout.customerKey, successUrl: againCheckout.successUrl }).toEqual({
      clientKey: 'test_ck_second',
      customerKey: 'buyer-second',
      successUrl: `https://second.example/shop/checkout/return?order=${O}&pg=SIMULATOR`,
    });
    expect(againCheckout.customerKey).not.toBe(firstCheckout.customerKey);
    expect(h.payments.calls.checkout.length, '재생이 결제창 준비를 다시 부른다').toBe(before.checkouts + 1);
    expect(h.payments.calls.checkout.at(-1)).toMatchObject({ attemptId: first.attemptId, pinnedPg: 'SIMULATOR', amount: PRICE, orderName: PRODUCT_NAME, pgStore: 'STANDARD' });
    expect({ writes: h.store.writes, attempts: h.store.attempts.size, ref: recordOf(K) }).toEqual({ writes: before.writes, attempts: before.attempts, ref: before.ref });

    // 옛 JSON 참조: 안의 시도 ID만 쓰고, 저장된 공개 키·주소·구매자 키·결제사는 돌려주지 않는다
    const legacy = { ...first, pg: 'TOSS', checkout: { ...(first.checkout as Record<string, unknown>), clientKey: 'stored-key', customerKey: 'stored-buyer', successUrl: 'https://evil.example/shop/checkout/return' } };
    setRef(K, JSON.stringify(legacy));
    h.payments.clientKey = 'test_ck_third';
    h.payments.origin = 'https://third.example';
    h.payments.customerKey = 'buyer-third';
    const fromLegacy = await h.pay.start(C, O, {}, K);
    const legacyCheckout = fromLegacy.checkout as { clientKey: string; customerKey: string; successUrl: string };
    expect({ attemptId: fromLegacy.attemptId, pg: fromLegacy.pg }).toEqual({ attemptId: first.attemptId, pg: 'SIMULATOR' });
    expect({ clientKey: legacyCheckout.clientKey, customerKey: legacyCheckout.customerKey, successUrl: legacyCheckout.successUrl }).toEqual({
      clientKey: 'test_ck_third',
      customerKey: 'buyer-third',
      successUrl: `https://third.example/shop/checkout/return?order=${O}&pg=SIMULATOR`,
    });
    const text = JSON.stringify(fromLegacy);
    for (const stored of ['stored-key', 'stored-buyer', 'evil.example', 'TOSS']) expect(text.includes(stored), `응답에 ${stored}`).toBe(false);
    expect(h.log.lines).toEqual([]);
  });

  test('P-T77 ③ 재생의 시도 ID가 경로 주문·세션 계정의 것이 아니면 404 not-found이고 PrepareCheckout을 부르지 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const D = randomUUID();
    const O1 = await order(C);
    const O2 = await order(C);
    const OD = await order(D);
    const K1 = once(C, OP_START);
    const K2 = once(C, OP_START);
    const KD = once(D, OP_START);
    const first = await h.pay.start(C, O1, {}, K1);
    const second = await h.pay.start(C, O2, {}, K2);
    const other = await h.pay.start(D, OD, {}, KD);
    const notFound = await foreign404(O1);

    const expectMismatch = async (what: string, ref: string, run: () => Promise<unknown>, forbidden: readonly string[]) => {
      setRef(K1, ref);
      const before = { writes: h.store.writes, attempts: h.store.attempts.size, checkouts: h.payments.calls.checkout.length };
      h.log.lines.length = 0;
      expect(await problemOf(run()), what).toEqual(notFound);
      expect(h.payments.calls.checkout.length, what).toBe(before.checkouts);
      expect({ writes: h.store.writes, attempts: h.store.attempts.size }, what).toEqual({ writes: before.writes, attempts: before.attempts });
      expectOneLog(what, MISMATCH, { operation: OP_START, orderId: O1 }, forbidden);
      expect(mismatchLines()).toHaveLength(1);
    };

    await expectMismatch('(가) 같은 팬 다른 주문의 시도', second.attemptId, () => h.pay.start(C, O1, {}, K1), [C, second.attemptId]);
    await expectMismatch('(나) 다른 팬의 시도', other.attemptId, () => h.pay.start(C, O1, {}, K1), [C, D, other.attemptId]);
    const missing = randomUUID();
    await expectMismatch('(다) 없는 시도 ID', missing, () => h.pay.start(C, O1, {}, K1), [C, missing]);
    await expectMismatch('(라) UUID도 JSON도 아닌 글', 'not-an-id', () => h.pay.start(C, O1, {}, K1), [C, 'not-an-id']);
    // 옛 JSON 참조 안의 다른 주문 시도
    await expectMismatch('(마) 옛 JSON의 다른 주문 시도', JSON.stringify({ ...first, attemptId: other.attemptId }), () => h.pay.start(C, O1, {}, K1), [C, D, other.attemptId]);

    // 시도 행의 주문을 다른 주문으로 바꾼 경우
    const attempt = h.store.attempts.get(first.attemptId)!;
    attempt.orderId = O2;
    try {
      setRef(K1, first.attemptId);
      const before = { writes: h.store.writes, attempts: h.store.attempts.size, checkouts: h.payments.calls.checkout.length };
      h.log.lines.length = 0;
      expect(await problemOf(h.pay.start(C, O1, {}, K1)), '(바) 시도 행의 주문 변조').toEqual(notFound);
      expect(h.payments.calls.checkout.length, '(바)').toBe(before.checkouts);
      expect({ writes: h.store.writes, attempts: h.store.attempts.size }, '(바)').toEqual({ writes: before.writes, attempts: before.attempts });
      expectOneLog('(바) 시도 행의 주문 변조', MISMATCH, { operation: OP_START, orderId: O1 }, [C, first.attemptId]);
    } finally {
      attempt.orderId = O1;
    }

    // 세션 계정이 경로 주문의 계정과 다른 경우(같은 시도 ID를 다른 계정의 키로 재생)
    setRef(KD, first.attemptId);
    const before = { writes: h.store.writes, attempts: h.store.attempts.size, checkouts: h.payments.calls.checkout.length };
    h.log.lines.length = 0;
    expect(await problemOf(h.pay.start(D, O1, {}, KD)), '(사) 다른 계정의 재생').toEqual(notFound);
    expect(h.payments.calls.checkout.length, '(사)').toBe(before.checkouts);
    expect({ writes: h.store.writes, attempts: h.store.attempts.size }, '(사)').toEqual({ writes: before.writes, attempts: before.attempts });
    expectOneLog('(사) 다른 계정의 재생', MISMATCH, { operation: OP_START, orderId: O1 }, [C, D, first.attemptId]);
  });

  test('P-T77 ④ 재생 중 PrepareCheckout이 실패하면 5xx이고 아무것도 바꾸지 않으며 같은 키로 다시 시도할 수 있다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const O = await order(C);
    const K = once(C, OP_START);
    const first = await h.pay.start(C, O, {}, K);
    const cases: [CheckoutFailed['reason'], number, string][] = [
      ['unavailable', 503, 'pg-unavailable'],
      ['invalid', 503, 'pg-unavailable'],
      ['paused', 503, 'new-payment-paused'],
      ['error', 503, 'dependency-unavailable'],
    ];
    for (const [reason, status, type] of cases) {
      const before = { writes: h.store.writes, attempts: h.store.attempts.size, ref: recordOf(K) };
      h.log.lines.length = 0;
      h.payments.checkoutFailure = new CheckoutFailed(reason);
      const p = await problemOf(h.pay.start(C, O, {}, K));
      expect({ status: p.status, type: p.type }, reason).toEqual({ status, type });
      expect({ writes: h.store.writes, attempts: h.store.attempts.size, ref: recordOf(K) }, reason).toEqual(before);
      expect(h.log.lines, reason).toEqual([]);
      h.payments.checkoutFailure = undefined;
      const again = await h.pay.start(C, O, {}, K);
      expect({ attemptId: again.attemptId, ref: recordOf(K) }, `${reason} 다시`).toEqual({ attemptId: first.attemptId, ref: first.attemptId });
    }
    expect(h.payments.calls.checkout.length).toBe(1 + cases.length * 2);
  });

  test('P-T77 ⑤ 재생이 만든 결제사·금액·주문 ID가 시도·주문과 다르면 결제창 값을 돌려주지 않고 503 dependency-unavailable이다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const O1 = await order(C);
    const O2 = await order(C);
    const K = once(C, OP_START);
    const first = await h.pay.start(C, O1, {}, K);

    const expectInvalid = async (what: string, field: 'pg' | 'amount' | 'orderId', run: () => Promise<unknown>) => {
      const before = { writes: h.store.writes, attempts: h.store.attempts.size, ref: recordOf(K) };
      h.log.lines.length = 0;
      expect(await problemOf(run()), what).toEqual({ status: 503, type: 'dependency-unavailable', title: expect.any(String) });
      expect({ writes: h.store.writes, attempts: h.store.attempts.size, ref: recordOf(K) }, what).toEqual(before);
      expectOneLog(what, REPLAY_INVALID, { orderId: O1, field }, [C, String(PRICE + 1_000), 'TOSS', 'SIMULATOR', O2]);
    };

    h.payments.replyPg = 'TOSS';
    await expectInvalid('(가) 결제사가 시도와 다름', 'pg', () => h.pay.start(C, O1, {}, K));

    h.payments.replyPg = 'SIMULATOR';
    h.payments.amountDelta = 1_000;
    await expectInvalid('(나) 결제창 금액이 주문과 다름', 'amount', () => h.pay.start(C, O1, {}, K));

    h.payments.amountDelta = 0;
    h.payments.orderIdOverride = O2;
    await expectInvalid('(다) 결제창 주문 ID가 경로 주문과 다름', 'orderId', () => h.pay.start(C, O1, {}, K));

    // 시도 행의 결제사를 바꾼 경우(대역은 SIMULATOR를 돌려준다)
    h.payments.orderIdOverride = undefined;
    const attempt = h.store.attempts.get(first.attemptId)!;
    attempt.pg = 'TOSS';
    try {
      await expectInvalid('(라) 시도 행의 결제사 변조', 'pg', () => h.pay.start(C, O1, {}, K));
    } finally {
      attempt.pg = 'SIMULATOR';
    }
  });
});
