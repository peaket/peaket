// 굿즈 작업의 트랜잭션 안 재생 대조 단위 시험(AZ-T17 ⑥, W12-core-idem 검증 V6·리뷰 RV3).
// 정본: ADR-0337 결정 6 — 결과 참조가 지금 요청의 계정·경로 주문에 속하는지 본 뒤에만 돌려주고, "같은 키 동시 요청이 트랜잭션 안에서 받는 재생도 같다".
// 맞지 않으면 남의 주문과 같은 404 not-found이고 오류 로그 한 줄(kind idempotency-replay-mismatch·severity SEV2·operation·경로 주문 ID, 계정 ID·결과 참조 원문 없음)이다.
// 바꾸지 않은 재생은 처음 응답과 같다. HTTP 통합 시험(test-int/shop-replay.int.test.ts)은 처음 보기(replayOf)에서 기록을 찾는 길만 탄다.
// 여기서는 처음 보기 직후 같은 키의 다른 요청이 커밋한 차례를 메모리 저장소(포트의 짝 가짜)로 만들어, 유스케이스가 저장 함수(DB에서는 한 트랜잭션)에서 받는 재생을 본다.
// 유스케이스·도메인은 진짜다. 결과 참조를 바꿔 두는 것은 통합 시험의 소유자 연결 고치기와 같은 자리다.
// 결제 시도 시작은 이 길에서 결제창 준비가 저장 함수보다 먼저 돈다(리뷰 RV3, 정리 목록). 그래서 결제창 준비 호출 수는 단언하지 않고 시도·쓰기 0을 본다.
// 시험 값은 코드 상수와 다르게 고른다(가격 16,700원).
import { randomBytes, randomUUID } from 'node:crypto';
import { fakeClock, type IdempotencyRequest } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  CreateMerchOrder,
  type CreateShopOrderInput,
  MemoryHeldTickets,
  MemoryMerchPayments,
  MemoryMerchStock,
  MemoryProductStore,
  MemoryShopOrderStore,
  MerchCancel,
  MerchOrdersRead,
  MerchPayment,
  MerchRefundAccount,
  MerchReturn,
  type ProductRecord,
  type ShopLogger,
  ShopProblem,
  type ShopReauthGate,
} from '../src/modules/shop/index.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-12-15T04:20:00.000Z');
const SELLER = randomUUID();
const PRICE = 16_700;
const MISMATCH = 'idempotency-replay-mismatch';
const ACCOUNT_BODY = { bankCode: '88', accountNumber: '110-444-666666', holderName: '김동시' };
/** 결정 1의 core_app 작업 일곱 */
const OP = {
  order: 'CREATE_MERCH_ORDER',
  addon: 'CREATE_TICKET_ADDON',
  start: 'START_MERCH_PAYMENT',
  accept: 'ACCEPT_MERCH_PAYMENT',
  cancel: 'CANCEL_MERCH_ORDER',
  account: 'SHOP_CANCEL_REFUND_ACCOUNT',
  ret: 'RETURN_MERCH_ORDER',
} as const;

/** 메모리 저장소의 멱등 기록 키(계정|작업|키, memory-merch-orders.ts 머리 주석). 처음 요청이 남긴 기록으로 이 꼴을 매번 확인한다 */
const recordKey = (once: IdempotencyRequest) => `${once.accountRef}|${once.operation}|${once.key}`;

/**
 * 같은 키 동시 요청의 차례를 만드는 메모리 저장소. MemoryShopOrderStore 그대로이고 처음 보기만 감싼다.
 * commitAfterFirstLook을 걸면 다음 처음 보기는 기록을 보지 못하고(다른 요청이 아직 커밋 전), 그 직후 다른 요청의 기록이 커밋된다.
 * 그래서 유스케이스는 저장 함수에서 그 기록을 재생으로 받는다.
 */
class RacingShopOrderStore extends MemoryShopOrderStore {
  /** 처음 보기마다: 본 값과 그 직후 다른 요청의 기록을 커밋했는지 */
  readonly looks: { seen: string | undefined; committedAfter: boolean }[] = [];
  #commit: (() => void) | undefined;

  commitAfterFirstLook(once: IdempotencyRequest, resultRef: string): void {
    this.idempotency.delete(recordKey(once));
    this.#commit = () => this.idempotency.set(recordKey(once), { hash: Buffer.from(once.requestHash), resultRef });
  }

  override async replayOf(once: IdempotencyRequest): Promise<string | undefined> {
    const seen = await super.replayOf(once);
    const commit = this.#commit;
    this.#commit = undefined;
    commit?.();
    this.looks.push({ seen, committedAfter: commit !== undefined });
    return seen;
  }
}

/** 재인증 확인기 대역(늘 통과). 재생 대조는 재인증과 관계없이 404여야 한다(통합 시험의 PassReauth와 같다) */
class PassReauth implements ShopReauthGate {
  async verify(): Promise<boolean> {
    return true;
  }
}

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
  const store = new RacingShopOrderStore(products);
  const payments = new MemoryMerchPayments(() => clock.now());
  const stock = new MemoryMerchStock();
  const held = new MemoryHeldTickets();
  const reauth = new PassReauth();
  const log = new RecordingLogger();
  const read = new MerchOrdersRead({ store, payments, clock });
  return {
    products,
    store,
    payments,
    held,
    log,
    read,
    create: new CreateMerchOrder({ store, stock, held, clock, consentVersion: undefined, logger: log }),
    pay: new MerchPayment({ store, stock, payments, clock, logger: log }),
    cancel: new MerchCancel({ store, payments, reauth, clock, logger: log }),
    refundAccount: new MerchRefundAccount({ store, payments, reauth, clock, logger: log }),
    ret: new MerchReturn({ store, read, clock, logger: log }),
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

const once = (accountRef: string, operation: string): IdempotencyRequest => ({ accountRef, operation, key: randomUUID(), requestHash: randomBytes(32) });

function product(o: Partial<ProductRecord> = {}): ProductRecord {
  const p: ProductRecord = {
    productId: randomUUID(),
    promoterId: SELLER,
    type: 'MERCH',
    name: '동시 재생 굿즈',
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

const order = async (accountId: string, body: CreateShopOrderInput): Promise<string> => (await h.create.shop(accountId, body, once(accountId, OP.order))).orderId;

/** 결제 결과 반영(저장소 포트)으로 PAID를 만들고 취소가 읽는 결제 원장(카드 결제)을 둔다 */
async function paid(orderId: string): Promise<void> {
  await h.store.applyPaid(orderId, { paymentId: randomUUID(), pg: 'SIMULATOR', approvedAtMs: T0 - DAY });
  h.payments.details.set(orderId, { orderId, status: 'APPROVED', pg: 'SIMULATOR', virtualAccountPaid: false });
}

const itemStatuses = (orderId: string) => [...h.store.items.values()].filter((i) => i.orderId === orderId).map((i) => i.status);

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

const recordOf = (o: IdempotencyRequest) => h.store.idempotency.get(recordKey(o))?.resultRef;

/** 같은 키의 다른 요청이 처음 보기 직후 결과 참조 ref로 커밋한 차례에서 run을 부른다. 처음 보기가 비었고 그 뒤 커밋했는지(트랜잭션 안 길) 함께 본다 */
async function inTxValue<T>(o: IdempotencyRequest, ref: string, run: () => Promise<T>): Promise<T> {
  h.log.lines.length = 0;
  h.store.commitAfterFirstLook(o, ref);
  const value = await run();
  expect(h.store.looks.at(-1), ref).toEqual({ seen: undefined, committedAfter: true });
  return value;
}
async function inTxProblem(o: IdempotencyRequest, ref: string, run: () => Promise<unknown>): Promise<Problem> {
  h.log.lines.length = 0;
  h.store.commitAfterFirstLook(o, ref);
  const p = await problemOf(run());
  expect(h.store.looks.at(-1), ref).toEqual({ seen: undefined, committedAfter: true });
  return p;
}

/** 로그가 정확히 한 줄(오류)이고 정한 칸만 있으며, 계정 ID·결과 참조 원문 같은 값이 없다 */
function expectOneMismatch(what: string, operation: string, orderId: string | undefined, forbidden: readonly string[]): void {
  expect(h.log.lines, what).toEqual([{ level: 'error', o: { kind: MISMATCH, severity: 'SEV2', operation, ...(orderId === undefined ? {} : { orderId }) }, msg: expect.any(String) }]);
  const text = JSON.stringify(h.log.lines[0]);
  for (const f of forbidden) expect(text.includes(f), `${what}: 로그에 ${f}`).toBe(false);
}

describe('AZ-T17 ⑥ 굿즈 작업의 트랜잭션 안 재생 대조', () => {
  test('AZ-T17 ⑥ 결제 시도 시작의 트랜잭션 안 재생은 시도 ID·결제사·금액이 경로 주문과 맞지 않거나 JSON이 아니면 404 not-found·로그 한 줄이고 시도를 쓰지 않으며 바꾸지 않은 재생은 처음 응답과 바이트까지 같다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const body = pickupBody();
    const O1 = await order(C, body);
    const O2 = await order(C, body);
    // 현장 수령 주문 금액 = 가격 × 수량(배송비 없음, ADR-0300 결정 4)
    expect(h.store.orders.get(O1)?.amount).toBe(PRICE);
    const other = await h.pay.start(C, O2, {}, once(C, OP.start));
    const K3 = once(C, OP.start);
    const first = await h.pay.start(C, O1, {}, K3);
    // 결과 참조는 처음 응답 그대로다(이 기록으로 메모리 저장소의 기록 키 꼴도 확인한다)
    expect(recordOf(K3)).toBe(JSON.stringify(first));
    const notFound = await foreign404(O1);
    const counts = () => ({ attempts: h.store.attempts.size, writes: h.store.writes, firstAttempt: h.store.attempts.get(first.attemptId)?.status });
    const before = counts();
    expect(before).toMatchObject({ attempts: 2, firstAttempt: 'READY' });

    const again = await inTxValue(K3, JSON.stringify(first), () => h.pay.start(C, O1, {}, K3));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(h.log.lines).toEqual([]);
    expect(counts()).toEqual(before);

    const tampered: [string, string][] = [
      ['(가) 같은 팬 다른 주문의 시도', JSON.stringify({ ...first, attemptId: other.attemptId })],
      ['(나) 다른 결제사', JSON.stringify({ ...first, pg: 'TOSS' })],
      ['(다) 금액 + 1,000원', JSON.stringify({ ...first, checkout: { ...first.checkout, amount: PRICE + 1_000 } })],
      ['(라) JSON이 아닌 글', 'x'],
    ];
    for (const [what, ref] of tampered) {
      expect(await inTxProblem(K3, ref, () => h.pay.start(C, O1, {}, K3)), what).toEqual(notFound);
      expectOneMismatch(what, OP.start, O1, ref.startsWith('{') ? [C, ref, other.attemptId] : [C]);
      expect(counts(), what).toEqual(before);
    }
  });

  test('AZ-T17 ⑥ 결제 접수의 트랜잭션 안 재생은 참조가 두 값(accepted·sold-out) 밖이면 404 not-found·로그 한 줄이고 승인 명령을 보내지 않으며 accepted면 처음처럼 받는다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const O1 = await order(C, pickupBody());
    const attempt = await h.pay.start(C, O1, {}, once(C, OP.start));
    const K4 = once(C, OP.accept);
    const acceptBody = { pg: 'SIMULATOR', paymentKey: `sim_${O1.slice(0, 8)}`, amount: PRICE, attemptId: attempt.attemptId } as const;
    await h.pay.accept(C, O1, acceptBody, K4);
    expect(recordOf(K4)).toBe('accepted');
    expect(h.payments.calls.confirm).toHaveLength(1);
    const notFound = await foreign404(O1);
    const counts = () => ({ confirm: h.payments.calls.confirm.length, jobs: h.store.jobs.size, writes: h.store.writes });
    const before = counts();

    await inTxValue(K4, 'accepted', () => h.pay.accept(C, O1, acceptBody, K4));
    expect(h.log.lines).toEqual([]);
    expect(counts()).toEqual(before);

    for (const ref of ['ACCEPTED', 'x']) {
      expect(await inTxProblem(K4, ref, () => h.pay.accept(C, O1, acceptBody, K4)), ref).toEqual(notFound);
      expectOneMismatch(ref, OP.accept, O1, [C]);
      expect(counts(), ref).toEqual(before);
    }
  });

  test('AZ-T17 ⑥ 굿즈 주문·부가 상품 주문의 트랜잭션 안 재생은 참조가 다른 팬의 주문이면 404 not-found·로그 한 줄이고 주문을 만들지 않으며 바꾸지 않은 재생은 처음 응답과 같다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const D = randomUUID();
    const body = pickupBody();
    const K1 = once(C, OP.order);
    const first = await h.create.shop(C, body, K1);
    expect(recordOf(K1)).toBe(first.orderId);
    const OD = await order(D, body);
    const notFound = await foreign404(first.orderId);
    const counts = () => ({ orders: h.store.orders.size, items: h.store.items.size, writes: h.store.writes });
    let before = counts();

    expect(await inTxValue(K1, first.orderId, () => h.create.shop(C, body, K1))).toEqual(first);
    expect(h.log.lines).toEqual([]);
    expect(counts()).toEqual(before);
    expect(await inTxProblem(K1, OD, () => h.create.shop(C, body, K1))).toEqual(notFound);
    // 경로에 주문이 없는 작업이라 orderId 칸이 없고, 참조한 주문 ID도 싣지 않는다
    expectOneMismatch('굿즈 주문', OP.order, undefined, [C, D, OD]);
    expect(counts()).toEqual(before);

    // 부가 상품 주문(지금 그 회차 티켓을 가진 팬, ADR-0301 결정 2)
    const eventId = randomUUID();
    const ticketId = randomUUID();
    const addon = product({ ticketLinked: true, linkedEventId: eventId, fulfillments: ['WALLET'] });
    h.held.set(C, eventId, [ticketId]);
    const addonBody = { productId: addon.productId, quantity: 1 };
    const K2 = once(C, OP.addon);
    const firstAddon = await h.create.addon(C, ticketId, addonBody, K2);
    expect(recordOf(K2)).toBe(firstAddon.orderId);
    before = counts();

    expect(await inTxValue(K2, firstAddon.orderId, () => h.create.addon(C, ticketId, addonBody, K2))).toEqual(firstAddon);
    expect(h.log.lines).toEqual([]);
    expect(counts()).toEqual(before);
    expect(await inTxProblem(K2, OD, () => h.create.addon(C, ticketId, addonBody, K2))).toEqual(notFound);
    expectOneMismatch('부가 상품 주문', OP.addon, undefined, [C, D, OD]);
    expect(counts()).toEqual(before);
  });

  test('AZ-T17 ⑥ 취소의 트랜잭션 안 재생은 참조가 다른 팬 주문·같은 팬 다른 주문의 취소면 404 not-found·로그 한 줄이고 결제사 취소·환급 행이 없으며 바꾸지 않은 재생은 처음과 같은 답이다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const D = randomUUID();
    const sid = randomUUID();
    const body = pickupBody();
    const [O1, O2, OD] = [await order(C, body), await order(C, body), await order(D, body)];
    for (const o of [O1, O2, OD]) await paid(o);
    const XD = (await h.cancel.run(D, randomUUID(), OD, {}, once(D, OP.cancel))).cancellationId;
    const XC2 = (await h.cancel.run(C, sid, O2, {}, once(C, OP.cancel))).cancellationId;
    // O1의 처음 취소는 결제사가 거절해 422이고 항목이 READY로 남는다(같은 키 동시 요청이 자격 검사를 지나 저장 함수까지 가는 차례)
    h.payments.cancelOutcomes.push('REJECTED');
    const K5 = once(C, OP.cancel);
    const first = await problemOf(h.cancel.run(C, sid, O1, {}, K5));
    expect(first).toMatchObject({ status: 422, type: 'refund-account-required' });
    const ref = recordOf(K5) ?? '';
    expect(h.store.refunds.get(ref.slice('cancel:'.length))?.orderId).toBe(O1);
    const notFound = await foreign404(O1);
    const counts = () => ({ cancels: h.payments.calls.cancel.length, refunds: h.store.refunds.size, writes: h.store.writes, items: itemStatuses(O1) });
    const before = counts();
    expect(before).toMatchObject({ cancels: 3, refunds: 3, items: ['READY'] });

    expect(await inTxProblem(K5, ref, () => h.cancel.run(C, sid, O1, {}, K5))).toEqual(first);
    expect(h.log.lines).toEqual([]);
    expect(counts()).toEqual(before);

    for (const [what, other] of [
      ['다른 팬 주문의 취소', XD],
      ['같은 팬 다른 주문의 취소', XC2],
    ] as const) {
      expect(await inTxProblem(K5, `cancel:${other}`, () => h.cancel.run(C, sid, O1, {}, K5)), what).toEqual(notFound);
      expectOneMismatch(what, OP.cancel, O1, [C, D, other]);
      expect(counts(), what).toEqual(before);
    }
  });

  test('AZ-T17 ⑥ 환급 계좌 다시 받기의 트랜잭션 안 재생은 참조가 다른 팬 주문·같은 팬 다른 주문의 취소면 404 not-found·로그 한 줄이고 결제사 취소·환급 행이 없으며 바꾸지 않은 재생은 처음과 같은 답이다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const D = randomUUID();
    const sid = randomUUID();
    const body = pickupBody();
    const [O1, O2, OD] = [await order(C, body), await order(C, body), await order(D, body)];
    for (const o of [O1, O2, OD]) await paid(o);
    const XD = (await h.cancel.run(D, randomUUID(), OD, {}, once(D, OP.cancel))).cancellationId;
    const XC2 = (await h.cancel.run(C, sid, O2, {}, once(C, OP.cancel))).cancellationId;
    // O1: 결제사가 계좌를 거절한 취소(계좌 다시 받기 대상)
    h.payments.cancelOutcomes.push('REFUND_ACCOUNT_REQUIRED');
    const KC = once(C, OP.cancel);
    expect(await problemOf(h.cancel.run(C, sid, O1, {}, KC))).toMatchObject({ status: 422, type: 'refund-account-required' });
    const X1 = (recordOf(KC) ?? '').slice('cancel:'.length);
    // 처음 계좌 다시 받기도 결제사가 계좌를 거절해 422다. 새 행이 다시 계좌 대기라 같은 키 동시 요청이 자격 검사를 지난다
    h.payments.cancelOutcomes.push('REFUND_ACCOUNT_REQUIRED');
    const K7 = once(C, OP.account);
    const input = { accountId: C, sessionId: sid, orderId: O1, cancellationId: X1, account: ACCOUNT_BODY, reauthToken: 'reauth-unit', idempotencyKey: K7.key, once: K7 };
    const first = await problemOf(h.refundAccount.run(input));
    expect(first).toMatchObject({ status: 422, type: 'refund-account-required' });
    const ref = recordOf(K7) ?? '';
    const X1b = ref.slice('cancel:'.length);
    expect({ startsWith: ref.startsWith('cancel:'), newRow: X1b !== X1, order: h.store.refunds.get(X1b)?.orderId }).toEqual({ startsWith: true, newRow: true, order: O1 });
    const notFound = await foreign404(O1);
    const counts = () => ({ cancels: h.payments.calls.cancel.length, refunds: h.store.refunds.size, writes: h.store.writes, items: itemStatuses(O1) });
    const before = counts();
    expect(before).toMatchObject({ cancels: 4, refunds: 4, items: ['READY'] });

    expect(await inTxProblem(K7, ref, () => h.refundAccount.run(input))).toEqual(first);
    expect(h.log.lines).toEqual([]);
    expect(counts()).toEqual(before);

    for (const [what, other] of [
      ['다른 팬 주문의 취소', XD],
      ['같은 팬 다른 주문의 취소', XC2],
    ] as const) {
      expect(await inTxProblem(K7, `cancel:${other}`, () => h.refundAccount.run(input)), what).toEqual(notFound);
      expectOneMismatch(what, OP.account, O1, [C, D, other, ACCOUNT_BODY.accountNumber]);
      expect(counts(), what).toEqual(before);
    }
  });

  test('AZ-T17 ⑥ 반품의 트랜잭션 안 재생은 참조가 같은 팬의 다른 주문이면 404 not-found·로그 한 줄이고 항목을 바꾸지 않으며 경로 주문의 참조면 그 주문 상세다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const body = pickupBody();
    const [O1, O2] = [await order(C, body), await order(C, body)];
    for (const o of [O1, O2]) {
      await paid(o);
      for (const i of h.store.items.values()) {
        if (i.orderId !== o) continue;
        i.status = 'PICKED_UP';
        i.pickedUpAt = new Date(T0 - DAY);
      }
    }
    const itemIds = [...h.store.items.values()].filter((i) => i.orderId === O1).map((i) => i.itemId);
    const retBody = { itemIds, reason: 'CHANGE_OF_MIND' } as const;
    const K6 = once(C, OP.ret);
    const detail = await h.read.get(C, O1);
    const notFound = await foreign404(O1);
    const counts = () => ({ writes: h.store.writes, o1: itemStatuses(O1), o2: itemStatuses(O2) });
    const before = counts();
    expect(before).toMatchObject({ o1: ['PICKED_UP'], o2: ['PICKED_UP'] });

    expect(await inTxValue(K6, `return:${O1}`, () => h.ret.run(C, O1, retBody, K6))).toEqual(detail);
    expect(h.log.lines).toEqual([]);
    expect(counts()).toEqual(before);

    const p = await inTxProblem(K6, `return:${O2}`, () => h.ret.run(C, O1, retBody, K6));
    expect(p).toEqual(notFound);
    expect(JSON.stringify(p).includes(O2)).toBe(false);
    expectOneMismatch('반품', OP.ret, O1, [C, O2]);
    expect(counts()).toEqual(before);
  });
});
