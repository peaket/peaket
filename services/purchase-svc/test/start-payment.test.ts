// 결제 시도 시작 쓰임새(application/start-payment.ts StartPayment, docs/features/payment.md §2 '결제 시도 시작의 첫 구현', BUILD_ORDER PRF-191)를 메모리 가짜로 본다.
// 검사 차례, 상태 표, 3회 상한(재생은 세지 않음), 대체는 저장소 몫이라 입력만, 재생의 결제사 고정, 오류 대응, 행동 요약 첫 시도만(P-T23·25·27·28·45⑤·51).
// 실제 PostgreSQL·gRPC로 도는 것은 test-int/start-payment.int.test.ts다.
import { Deadline, fakeClock, ProblemError } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  behaviorSignalKey,
  buildBehaviorSignal,
  DEFAULT_ORDER_NAME,
  ORDER_STATUSES,
  OrderSeatStoreUnavailable,
  type OrderStatus,
  PAYMENT_ATTEMPTS_MAX,
  pgOrderRefOf,
  PREPARE_CHECKOUT_DEADLINE_MS,
  START_PAYMENT_OPERATION,
  StartPayment,
  type StartPaymentDeps,
  type StartPaymentRejection,
} from '../src/modules/booking/index.js';
import { ATTEMPT_ID, ORDER_ID, OTHER_ACCOUNT, OTHER_PSID, PORTONE_PAYMENT_ID } from './accept-cases.js';
import { ACCOUNT, AMOUNT, EVENT, HOLD_ID, JOURNEY, NOW, PID, PSID } from './order-cases.js';
import { BEHAVIOR, DEPOSIT_DUE_AT_MS, ENTRY_OPENS_AT_MS, HOLD_EXPIRES_AT_MS, okCheckout, ORDER_NAME, PORTONE_CHECKOUT, type StartCall, startCommand, StartFakes, startOrder, TOSS_CHECKOUT } from './start-payment-cases.js';

const clock = fakeClock({ now: NOW });
const fx = new StartFakes();

const deps = (over: Partial<StartPaymentDeps> = {}): StartPaymentDeps => ({
  sessions: fx.sessions,
  reads: fx.starts,
  writes: fx.starts,
  slots: fx.slots,
  saleConfigs: fx.saleConfigs,
  holdExpiries: fx.holdExpiries,
  checkouts: fx.checkouts,
  behavior: fx.behavior,
  signals: fx.signals,
  log: fx.log,
  clock,
  ...over,
});
const run = (c = startCommand(), over: Partial<StartPaymentDeps> = {}) => new StartPayment(deps(over)).execute(c);
const rejected = (reason: StartPaymentRejection) => ({ status: 'REJECTED', reason });
/** 응답 뒤로 미룬 비동기 보내기가 돌 틈을 준다 */
const flush = async () => {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => fx.reset());

describe('정상 시작', () => {
  test('PT23_검사 차례: 세션 → 멱등 → 주문 → 횟수 → 슬롯 → 판 → 홀드 만료 → 결제창 준비 → 한 트랜잭션이고 201이다 [ASVS v5.0.0-2.3.1]', async () => {
    const r = await run();
    expect(r.status).toBe(201);
    expect(fx.calls).toEqual<StartCall[]>(['sessions.get', 'reads.findCommitted', 'reads.order', 'reads.attemptCount', 'slots.read', 'saleConfigs.get', 'holdExpiries.expiresAt', 'checkouts.prepare', 'writes.start']);
  });

  test('PT26_결제창 준비 값은 서버의 금액·주문과 판의 주문명·입장 시각·가상계좌이고 시도 ID는 UUIDv7이다. 구매자 키는 보내지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    await run(startCommand({ body: { payMethod: 'VIRTUAL_ACCOUNT' } }));
    const q = fx.lastPrepared();
    expect(q).toMatchObject({ orderId: ORDER_ID, eventId: EVENT, amount: AMOUNT, orderName: ORDER_NAME, payMethod: 'VIRTUAL_ACCOUNT', virtualAccountAllowed: false, entryOpensAtMs: ENTRY_OPENS_AT_MS, deadlineMs: PREPARE_CHECKOUT_DEADLINE_MS });
    expect(q.attemptId).toMatch(UUID_V7);
    expect(q).not.toHaveProperty('pinnedPg');
    expect(q).not.toHaveProperty('customerKey');
  });

  test('PT28_본문에 금액 칸이 섞여 와도 결제창 준비 금액은 서버의 주문 금액이다 [ASVS v5.0.0-2.2.1]', async () => {
    await run(startCommand({ body: { amount: AMOUNT - 1 } as never }));
    expect(fx.lastPrepared().amount).toBe(AMOUNT);
  });

  test('PT26_판에 선택 칸이 없으면 주문명은 고정 문구이고 입장 시각·가상계좌 칸은 싣지 않는다', async () => {
    fx.sale = { saleEndsAtMs: NOW + 1, tierPrices: {} };
    await run();
    const q = fx.lastPrepared();
    expect(q.orderName).toBe(DEFAULT_ORDER_NAME);
    expect(q).not.toHaveProperty('entryOpensAtMs');
    expect(q).not.toHaveProperty('virtualAccountAllowed');
  });

  test('PT23_한 트랜잭션 입력: 같은 시도 ID·결제사·결제사 참조(토스는 주문 ID)·행위자 account:<계정>이고 멱등 범위는 START_PAYMENT다', async () => {
    await run();
    const s = fx.started[0]!;
    expect(s.input).toEqual({ orderId: ORDER_ID, attemptId: fx.lastPrepared().attemptId, pg: 'TOSS', pgOrderRef: ORDER_ID, actor: `account:${ACCOUNT}` });
    expect(s.once.operation).toBe(START_PAYMENT_OPERATION);
  });

  test('PT28_포트원이 골라지면 결제사 참조는 pay-{주문 ID}다(접수의 paymentId 대조 값)', async () => {
    fx.checkoutAnswers = [okCheckout({ pg: 'PORTONE', checkout: PORTONE_CHECKOUT })];
    await run();
    expect(fx.lastStarted()).toMatchObject({ pg: 'PORTONE', pgOrderRef: PORTONE_PAYMENT_ID });
  });

  test('FR011_201 재료: 시도 ID, 결제사, 전환 여부, 홀드 만료, 허용 수단, 입금 기한, 결제창 값 [ASVS v5.0.0-8.2.3]', async () => {
    fx.checkoutAnswers = [okCheckout({ switched: true })];
    const r = await run();
    expect(r).toEqual({
      status: 201,
      replayed: false,
      attempt: {
        attemptId: fx.lastPrepared().attemptId,
        pg: 'TOSS',
        switched: true,
        holdExpiresAtMs: HOLD_EXPIRES_AT_MS,
        allowedPayMethods: ['CARD', 'EASY_PAY', 'VIRTUAL_ACCOUNT'],
        depositDueAtMs: DEPOSIT_DUE_AT_MS,
        checkout: TOSS_CHECKOUT,
      },
    });
    expect(fx.metrics).toEqual([{ pg: 'TOSS', outcome: 'started' }]);
  });

  test('FR011_홀드 만료 읽기는 주문의 회차·홀드·좌석이고 좌석 Redis 마감을 준다', async () => {
    await run(startCommand({ deadline: Deadline.after(80, clock) }));
    expect(fx.holdExpiryReads[0]).toEqual({ q: { eventId: EVENT, holdId: HOLD_ID, seatIds: ['A01', 'A02', 'B01'] }, o: { deadlineMs: 80 } });
  });

  test('FR011_좌석 Redis 장애로 홀드 만료를 읽지 못하거나 홀드가 풀렸으면 칸을 빼고 201이다 [ASVS v5.0.0-16.5.2]', async () => {
    fx.holdExpiry = new OrderSeatStoreUnavailable();
    const a = await run();
    expect(a.status).toBe(201);
    expect(a).not.toHaveProperty('attempt.holdExpiresAtMs');
    fx.reset();
    fx.holdExpiry = undefined;
    const b = await run();
    expect(b.status).toBe(201);
    expect(b).not.toHaveProperty('attempt.holdExpiresAtMs');
  });

  // 리뷰 고침 L7(2026-11-09, PRF-191): 선택 칸 하나를 읽지 못했다고 결제를 500으로 막지 않는다. 대신 설정 로그 한 줄로 드러낸다
  test('FR011_리뷰 고침 L7: 망가진 홀드 키(Error)는 500이 아니라 칸만 빼고 201이며 SEV2 설정 로그 한 줄이다 [ASVS v5.0.0-16.5.2]', async () => {
    fx.holdExpiry = new Error('PEAKET_CORRUPT_KEY 홀드 키 형이 틀림');
    const r = await run();
    expect(r.status).toBe(201);
    expect(r).not.toHaveProperty('attempt.holdExpiresAtMs');
    expect(fx.holdExpiryLogs).toEqual([{ eventId: EVENT }]);
  });

  test('PT45_리뷰 고침 L7: 재생에서도 망가진 홀드 키는 칸만 뺀다', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.holdExpiry = new Error('PEAKET_CORRUPT_KEY 홀드 키 형이 틀림');
    const r = await run();
    expect(r).toMatchObject({ status: 201, replayed: true });
    expect(r).not.toHaveProperty('attempt.holdExpiresAtMs');
  });

  test('FR011_리뷰 고침 L7: 좌석 Redis 일시 장애는 예상한 일이라 설정 로그를 남기지 않는다', async () => {
    fx.holdExpiry = new OrderSeatStoreUnavailable();
    await run();
    expect(fx.holdExpiryLogs).toEqual([]);
  });
});

describe('구매 세션·소유자', () => {
  test('FR011_세션이 없거나 계정이 다르면 SESSION_ENDED이고 뒤를 부르지 않는다', async () => {
    fx.session = undefined;
    expect(await run()).toEqual(rejected('SESSION_ENDED'));
    expect(fx.calls).toEqual<StartCall[]>(['sessions.get']);
    fx.reset();
    fx.session = { sessionId: PSID, accountId: OTHER_ACCOUNT, eventId: EVENT, journeyId: JOURNEY };
    expect(await run()).toEqual(rejected('SESSION_ENDED'));
  });

  test('FR011_세션 읽기의 좌석 Redis 장애는 SEAT_STORE_UNAVAILABLE이다', async () => {
    fx.session = new OrderSeatStoreUnavailable();
    expect(await run()).toEqual(rejected('SEAT_STORE_UNAVAILABLE'));
  });

  test.each([
    ['없는 주문', undefined],
    ['남의 주문', startOrder({ accountId: OTHER_ACCOUNT })],
    ['다른 구매 세션의 주문', startOrder({ purchaseSessionId: OTHER_PSID })],
  ])('ST29_%s는 같은 NOT_FOUND이고 횟수·준비를 보지 않는다 [ASVS v5.0.0-8.2.2]', async (_name, order) => {
    fx.order = order;
    expect(await run()).toEqual(rejected('NOT_FOUND'));
    expect(fx.calls).not.toContain('reads.attemptCount');
    expect(fx.calls).not.toContain('checkouts.prepare');
  });

  test('ST29_남의 주문의 상태가 새지 않는다: 만료된 남의 주문도 NOT_FOUND다', async () => {
    fx.order = startOrder({ accountId: OTHER_ACCOUNT, status: 'EXPIRED' });
    expect(await run()).toEqual(rejected('NOT_FOUND'));
  });
});

describe('상태 표', () => {
  test.each(ORDER_STATUSES.filter((s) => s !== 'CREATED'))('PT23_주문이 %s면 받지 않고 결제창 준비를 부르지 않는다 [ASVS v5.0.0-2.3.1]', async (status: OrderStatus) => {
    fx.order = startOrder({ status });
    expect(await run()).toEqual(rejected(status === 'EXPIRED' ? 'ORDER_EXPIRED' : 'ALREADY_ACCEPTED'));
    expect(fx.calls).not.toContain('checkouts.prepare');
    expect(fx.calls).not.toContain('writes.start');
  });
});

describe('3회 상한', () => {
  test('PT25_시도 행이 3개면 네 번째는 준비 없이 거절되고 보안 로그 한 줄·지표를 남긴다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-16.3.3]', async () => {
    expect(PAYMENT_ATTEMPTS_MAX).toBe(3);
    fx.count = 3;
    expect(await run()).toEqual(rejected('ATTEMPTS_EXCEEDED'));
    expect(fx.calls).not.toContain('checkouts.prepare');
    expect(fx.exceededLogs).toEqual([{ accountId: ACCOUNT, orderId: ORDER_ID }]);
    expect(fx.metrics).toEqual([{ pg: 'none', outcome: 'exceeded' }]);
  });

  test('PT25_시도 행이 2개면 세 번째는 받는다', async () => {
    fx.count = 2;
    fx.outcome = { status: 'STARTED', attemptNo: 3 };
    expect((await run()).status).toBe(201);
  });

  test('PT25_미리 보기를 지나도 트랜잭션 안에서 넘으면 거절이고 같은 로그를 남긴다 [ASVS v5.0.0-2.3.2]', async () => {
    fx.count = 2;
    fx.outcome = { status: 'ATTEMPTS_EXCEEDED' };
    expect(await run()).toEqual(rejected('ATTEMPTS_EXCEEDED'));
    expect(fx.exceededLogs).toHaveLength(1);
  });
});

describe('판매 정지·좌석 저장소', () => {
  test('PT27_판매 정지 사본이면 SALE_PAUSED(423)이고 준비를 부르지 않는다', async () => {
    fx.slot = { status: 'PAUSED' };
    expect(await run()).toEqual(rejected('SALE_PAUSED'));
    expect(fx.calls).not.toContain('checkouts.prepare');
  });

  test('FR011_세대 키가 없거나 슬롯 읽기가 장애면 SEAT_STORE_UNAVAILABLE이다', async () => {
    fx.slot = { status: 'NOT_READY' };
    expect(await run()).toEqual(rejected('SEAT_STORE_UNAVAILABLE'));
    fx.reset();
    fx.slot = new OrderSeatStoreUnavailable();
    expect(await run()).toEqual(rejected('SEAT_STORE_UNAVAILABLE'));
  });

  test('FR011_회차 판이 없으면 SEAT_STORE_UNAVAILABLE이고 준비를 부르지 않는다', async () => {
    fx.sale = undefined;
    expect(await run()).toEqual(rejected('SEAT_STORE_UNAVAILABLE'));
    expect(fx.calls).not.toContain('checkouts.prepare');
  });
});

describe('결제창 준비 실패(결제 시도를 만들지 않는다)', () => {
  test.each([
    ['pg_unavailable', { status: 'PG_UNAVAILABLE', reason: 'pg_unavailable' }, 'PG_UNAVAILABLE', 'pg_unavailable'],
    ['unavailable', { status: 'PG_UNAVAILABLE', reason: 'unavailable' }, 'PG_UNAVAILABLE', 'pg_unavailable'],
    ['deadline', { status: 'PG_UNAVAILABLE', reason: 'deadline' }, 'PG_UNAVAILABLE', 'deadline'],
    ['circuit_open', { status: 'PG_UNAVAILABLE', reason: 'circuit_open' }, 'PG_UNAVAILABLE', 'pg_unavailable'],
    ['수단 거절', { status: 'PAY_METHOD_INVALID' }, 'PAY_METHOD_INVALID', 'pay_method_invalid'],
  ] as const)('PT26_%s면 시도 행을 쓰지 않고 거절이다 [ASVS v5.0.0-16.5.3]', async (_name, answer, reason, outcome) => {
    fx.checkoutAnswers = [answer];
    expect(await run()).toEqual(rejected(reason));
    expect(fx.started).toHaveLength(0);
    expect(fx.metrics).toEqual([{ pg: 'none', outcome }]);
  });

  test('P-T43_새 결제 일시 정지면 시도 행을 쓰지 않고 지금부터 홀드 만료까지의 초를 싣는다(BUILD_ORDER PRF-201) [ASVS v5.0.0-16.5.3]', async () => {
    fx.checkoutAnswers = [{ status: 'NEW_PAYMENT_PAUSED' }];
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'NEW_PAYMENT_PAUSED', holdRemainingSeconds: Math.ceil((HOLD_EXPIRES_AT_MS - NOW) / 1000) });
    expect(fx.started).toHaveLength(0);
    expect(fx.metrics).toEqual([{ pg: 'none', outcome: 'new_payment_paused' }]);
  });

  test('P-T43_남은 시간은 초로 올림하고 이미 지났으면 0이다', async () => {
    fx.checkoutAnswers = [{ status: 'NEW_PAYMENT_PAUSED' }];
    fx.holdExpiry = NOW + 1_001;
    expect(await run()).toMatchObject({ holdRemainingSeconds: 2 });
    fx.checkoutAnswers = [{ status: 'NEW_PAYMENT_PAUSED' }];
    fx.holdExpiry = NOW - 5_000;
    expect(await run()).toMatchObject({ holdRemainingSeconds: 0 });
  });

  test('P-T43_홀드 만료를 읽지 못하면 칸을 뺀다(화면이 칸 없음을 다룬다) [ASVS v5.0.0-16.5.2]', async () => {
    fx.checkoutAnswers = [{ status: 'NEW_PAYMENT_PAUSED' }];
    fx.holdExpiry = undefined;
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'NEW_PAYMENT_PAUSED' });
  });

  test('PT26_예상 밖의 답은 CHECKOUT_MISCONFIGURED이고 SEV2 설정 로그 한 줄이다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    fx.checkoutAnswers = [{ status: 'MISCONFIGURED', reason: 'permission_denied' }];
    expect(await run()).toEqual(rejected('CHECKOUT_MISCONFIGURED'));
    expect(fx.misconfiguredLogs).toEqual([{ reason: 'permission_denied' }]);
    expect(fx.started).toHaveLength(0);
  });
});

describe('한 트랜잭션의 결과', () => {
  test('PT23_T2가 0행이고 지금 상태가 ACCEPTED면 ALREADY_ACCEPTED, EXPIRED면 ORDER_EXPIRED다', async () => {
    fx.outcome = { status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' };
    expect(await run()).toEqual(rejected('ALREADY_ACCEPTED'));
    fx.reset();
    fx.outcome = { status: 'STALE', reason: 'ORDER_STATE', current: 'EXPIRED' };
    expect(await run()).toEqual(rejected('ORDER_EXPIRED'));
  });

  test('PT23_활성 시도 유일 위반(마지막 안전망)은 ALREADY_ACCEPTED다 [ASVS v5.0.0-2.3.4]', async () => {
    fx.outcome = { status: 'ACTIVE_CONFLICT' };
    expect(await run()).toEqual(rejected('ALREADY_ACCEPTED'));
  });

  test('FR011_쓰기가 던진 ProblemError·DB 오류는 그대로 던진다', async () => {
    const e = new ProblemError({ type: 'idempotency-request-in-progress', status: 409, title: '처리 중' });
    fx.outcome = e;
    await expect(run()).rejects.toBe(e);
  });
});

describe('멱등 재생(P-T27·P-T45)', () => {
  test('PT27_커밋된 기록이면 그 시도의 결제사로 고정해 값만 다시 만들고 쓰지 않는다 [ASVS v5.0.0-2.2.3]', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.attemptView = { attemptId: ATTEMPT_ID, orderId: ORDER_ID, pg: 'PORTONE' };
    fx.checkoutAnswers = [okCheckout({ pg: 'PORTONE', checkout: PORTONE_CHECKOUT })];
    const r = await run();
    expect(r).toMatchObject({ status: 201, replayed: true, attempt: { attemptId: ATTEMPT_ID, pg: 'PORTONE' } });
    expect(fx.lastPrepared()).toMatchObject({ attemptId: ATTEMPT_ID, pinnedPg: 'PORTONE', orderId: ORDER_ID });
    expect(fx.started).toHaveLength(0);
    expect(fx.metrics).toEqual([{ pg: 'PORTONE', outcome: 'replayed' }]);
  });

  test('PT25_재생은 횟수를 보지 않아 상한을 넘어도 처음 시도를 돌려준다 [ASVS v5.0.0-2.3.2]', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.count = 3;
    expect((await run()).status).toBe(201);
    expect(fx.calls).not.toContain('reads.attemptCount');
    expect(fx.exceededLogs).toHaveLength(0);
  });

  test.each(['ACCEPTED', 'EXPIRED'] as const)('PT45_재생은 주문이 그사이 %s가 되어도 처음 결과와 같은 201이다', async (status) => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.order = startOrder({ status });
    expect((await run()).status).toBe(201);
  });

  test('PT45_재생은 판매 정지를 보지 않는다(처음 결과와 같다)', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.slot = { status: 'PAUSED' };
    expect((await run()).status).toBe(201);
    expect(fx.calls).not.toContain('slots.read');
  });

  test('PT45_겹친 요청이 트랜잭션에서 재생되면(REPLAYED) 처음 시도의 결제사로 다시 만들고 replayed다', async () => {
    fx.outcome = { status: 'REPLAYED', attemptId: ATTEMPT_ID };
    fx.attemptView = { attemptId: ATTEMPT_ID, orderId: ORDER_ID, pg: 'SIMULATOR' };
    fx.checkoutAnswers = [okCheckout({ pg: 'TOSS' }), okCheckout({ pg: 'SIMULATOR' })];
    const r = await run();
    expect(r).toMatchObject({ status: 201, replayed: true, attempt: { attemptId: ATTEMPT_ID, pg: 'SIMULATOR' } });
    expect(fx.prepared[1]).toMatchObject({ attemptId: ATTEMPT_ID, pinnedPg: 'SIMULATOR' });
  });

  test('PT45_지문이 다르면 IDEM_REUSED이고 주문을 보지 않는다', async () => {
    fx.committed = { status: 'MISMATCH' };
    expect(await run()).toEqual(rejected('IDEM_REUSED'));
    expect(fx.calls).toEqual<StartCall[]>(['sessions.get', 'reads.findCommitted']);
  });

  test('PT45_재생의 결제창 준비가 실패하면 503이고 다시 부를 수 있다 [ASVS v5.0.0-16.5.2]', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.checkoutAnswers = [{ status: 'PG_UNAVAILABLE', reason: 'pg_unavailable' }];
    expect(await run()).toEqual(rejected('PG_UNAVAILABLE'));
  });

  // 리뷰 고침 M4(2026-11-09, PRF-191): 처음 201을 준 요청은 재생에서 400이 되면 안 된다. 다시 보내도 되는 503이다(guidelines §4 '다시 만드는 호출이 실패하면 5xx')
  test.each([
    ['커밋된 기록', () => (fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID })],
    ['겹친 요청', () => (fx.outcome = { status: 'REPLAYED', attemptId: ATTEMPT_ID })],
  ] as const)('PT45_리뷰 고침 M4: %s 재생에서 payment-svc가 수단을 거절해도 400이 아니라 503 PG_UNAVAILABLE이다 [ASVS v5.0.0-16.5.2]', async (label, arrange) => {
    arrange();
    fx.checkoutAnswers = label === '겹친 요청' ? [okCheckout(), { status: 'PAY_METHOD_INVALID' }] : [{ status: 'PAY_METHOD_INVALID' }];
    expect(await run(startCommand({ body: { payMethod: 'VIRTUAL_ACCOUNT' } }))).toEqual(rejected('PG_UNAVAILABLE'));
    expect(fx.metrics.at(-1)).toEqual({ pg: 'none', outcome: 'pay_method_invalid' });
  });

  test('PT26_리뷰 고침 M4: 재생이 아닌 첫 요청의 수단 거절은 그대로 400 쪽이다', async () => {
    fx.checkoutAnswers = [{ status: 'PAY_METHOD_INVALID' }];
    expect(await run()).toEqual(rejected('PAY_METHOD_INVALID'));
  });

  // 리뷰 고침 L5(2026-11-09, PRF-191): 재생도 첫 요청처럼 주문의 구매 세션을 대조한다(멱등 범위는 계정 × 작업이라 다른 구매 세션의 같은 키가 닿을 수 있다)
  test('ST29_리뷰 고침 L5: 재생인데 주문의 구매 세션이 요청과 다르면 NOT_FOUND이고 결제창 값을 만들지 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.order = startOrder({ purchaseSessionId: OTHER_PSID });
    expect(await run()).toEqual(rejected('NOT_FOUND'));
    expect(fx.calls).not.toContain('checkouts.prepare');
    expect(fx.calls).not.toContain('saleConfigs.get');
  });

  test('FR011_멱등 기록의 결과 참조가 가리키는 시도가 없으면(어긋남) 던진다', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.attemptView = undefined;
    await expect(run()).rejects.toThrow('멱등 기록');
  });
});

describe('남은 시간', () => {
  test('FR011_좌석 Redis를 부르기 전 5ms 미만이면 부르지 않고 DEADLINE_EXCEEDED다', async () => {
    expect(await run(startCommand({ deadline: Deadline.after(4, clock) }))).toEqual(rejected('DEADLINE_EXCEEDED'));
    expect(fx.calls).toEqual([]);
  });

  test('FR011_결제창 준비 데드라인은 min(300ms, 남은 시간)이다', async () => {
    await run(startCommand({ deadline: Deadline.after(120, clock) }));
    expect(fx.lastPrepared().deadlineMs).toBe(120);
    fx.reset();
    await run(startCommand({ deadline: Deadline.after(5_000, clock) }));
    expect(fx.lastPrepared().deadlineMs).toBe(300);
  });

  test('FR011_남은 시간이 50ms 미만이면 결제창 준비를 부르지 않고 DEADLINE_EXCEEDED다', async () => {
    expect(await run(startCommand({ deadline: Deadline.after(49, clock) }))).toEqual(rejected('DEADLINE_EXCEEDED'));
    expect(fx.calls).not.toContain('checkouts.prepare');
    expect(fx.metrics).toEqual([{ pg: 'none', outcome: 'deadline' }]);
  });

  test('FR011_트랜잭션에는 남은 시간이 1초보다 짧을 때 그것을 문장 시간 초과로 넘긴다', async () => {
    await run(startCommand({ deadline: Deadline.after(300, clock) }));
    expect(fx.started[0]!.o).toEqual({ deadlineMs: 300 });
  });
});

describe('행동 요약(P-T51)', () => {
  test('PT51_①첫 시도면 응답을 기다리지 않고 BehaviorSignal 하나를 낸다. 망 정보·기기 가명은 없다', async () => {
    await run(startCommand({ body: { behavior: BEHAVIOR } }));
    await flush();
    expect(fx.published).toEqual([
      { pid: PID, refMissing: false, eventId: EVENT, journeyId: JOURNEY, screen: 'PAYMENT', features: BEHAVIOR, ts: new Date(NOW).toISOString(), eventKey: behaviorSignalKey(ORDER_ID) },
    ]);
    for (const k of ['netClass', 'asn', 'deviceRef']) expect(fx.published[0]).not.toHaveProperty(k);
  });

  test('PT51_①보내기는 커밋 뒤다(쓰기가 실패하면 내지 않는다)', async () => {
    await run(startCommand({ body: { behavior: BEHAVIOR } }));
    await flush();
    expect(fx.calls.indexOf('behavior.publish')).toBeGreaterThan(fx.calls.indexOf('writes.start'));
    fx.reset();
    fx.outcome = { status: 'ATTEMPTS_EXCEEDED' };
    await run(startCommand({ body: { behavior: BEHAVIOR } }));
    await flush();
    expect(fx.published).toHaveLength(0);
  });

  test('PT51_②다시 시도(시도 번호 2)에 실린 요약은 버린다', async () => {
    fx.count = 1;
    fx.outcome = { status: 'STARTED', attemptNo: 2 };
    await run(startCommand({ body: { behavior: BEHAVIOR } }));
    await flush();
    expect(fx.published).toHaveLength(0);
    expect(fx.calls).not.toContain('behavior.publish');
  });

  test('PT51_②재생에 실린 요약은 버린다(커밋된 기록·겹친 요청 둘 다)', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    await run(startCommand({ body: { behavior: BEHAVIOR } }));
    await flush();
    expect(fx.published).toHaveLength(0);
    fx.reset();
    fx.outcome = { status: 'REPLAYED', attemptId: ATTEMPT_ID };
    await run(startCommand({ body: { behavior: BEHAVIOR } }));
    await flush();
    expect(fx.published).toHaveLength(0);
  });

  test('PT51_③요약이 없으면 신호 0건이고 시도는 정상이다', async () => {
    expect((await run()).status).toBe(201);
    await flush();
    expect(fx.calls).not.toContain('behavior.publish');
  });

  test('PT51_토큰 pid가 없으면 필수 칸을 채울 수 없어 내지 않는다', async () => {
    const { pid: _pid, ...noPid } = startCommand({ body: { behavior: BEHAVIOR } });
    expect((await run(noPid)).status).toBe(201);
    await flush();
    expect(fx.calls).not.toContain('behavior.publish');
  });

  test.each(['거부', '보내기 전에 던짐'] as const)('PT51_④전송이 실패(%s)해도 응답은 201이고 telemetry_dropped_total만 오른다 [ASVS v5.0.0-16.5.2]', async (kind) => {
    fx.publishFailure = kind === '거부' ? new Error('broker down') : 'sync-throw';
    const r = await run(startCommand({ body: { behavior: BEHAVIOR } }));
    expect(r.status).toBe(201);
    await flush();
    expect(fx.dropped).toEqual(['behavior_signal']);
  });

  test('PT51_⑤고른 결제사는 요약과 관계없다', async () => {
    fx.checkoutAnswers = [okCheckout({ pg: 'PORTONE', switched: true, checkout: PORTONE_CHECKOUT })];
    await run(startCommand({ body: { behavior: BEHAVIOR } }));
    expect(fx.lastPrepared()).not.toHaveProperty('behavior');
    expect(fx.lastStarted().pg).toBe('PORTONE');
  });
});

describe('순수 함수', () => {
  test('PT28_pgOrderRefOf: 토스는 orderId, 포트원은 paymentId다', () => {
    expect(pgOrderRefOf(TOSS_CHECKOUT)).toBe(ORDER_ID);
    expect(pgOrderRefOf(PORTONE_CHECKOUT)).toBe(PORTONE_PAYMENT_ID);
  });

  test('PT51_eventKey는 UUID 버전 8이고 같은 주문이면 같은 값이다', () => {
    const k = behaviorSignalKey(ORDER_ID);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(behaviorSignalKey(ORDER_ID)).toBe(k);
    expect(behaviorSignalKey(HOLD_ID)).not.toBe(k);
  });

  test('PT51_buildBehaviorSignal은 시각이 날짜 범위 밖이면 던진다', () => {
    expect(() => buildBehaviorSignal({ orderId: ORDER_ID, eventId: EVENT, pid: PID, journeyId: JOURNEY, features: BEHAVIOR, occurredAtMs: Number.NaN })).toThrow(RangeError);
  });
});
