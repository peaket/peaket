// 결제 접수 쓰임새(application/accept-payment.ts AcceptPayment, docs/features/payment.md §2 '결제 접수의 첫 구현', BUILD_ORDER PRF-162)를 메모리 가짜 포트로 본다.
// 검사 차례(앞이 걸리면 뒤 포트를 부르지 않는다), 거절 아홉, 멱등 재생(P-T45 ③), 금액 변조(P-T7), 두 탭 경합(P-T23), 결제 접수 계약(P-T28),
// 남의 주문(S-T29 ⑥), accept 입력 칸, 보안 로그의 칸. 실제 PostgreSQL·Valkey로 도는 것은 test-int(다른 담당)다.
import { Deadline, fakeClock, ProblemError } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  ACCEPT_PAYMENT_OPERATION,
  AcceptPayment,
  type AcceptPaymentDeps,
  ATTEMPT_ACCEPT_WINDOW_MS,
  ORDER_STATUSES,
  OrderSeatStoreUnavailable,
  type OrderStatus,
  SAGA_FIRST_STEP,
} from '../src/modules/booking/index.js';
import {
  type AcceptCall,
  acceptCommand,
  AcceptFakes,
  acceptIdem,
  ATTEMPT_ID,
  MIN,
  okAttempt,
  okOrder,
  ORDER_ID,
  OTHER_ACCOUNT,
  OTHER_PSID,
  PAYMENT_KEY,
  PAYMENT_TOKEN,
  PORTONE_PAYMENT_ID,
  portoneBody,
  SEAT_GEN,
  tossBody,
  TX_ID,
} from './accept-cases.js';
import { ACCOUNT, AMOUNT, EVENT, JOURNEY, NOW, PSID } from './order-cases.js';

const clock = fakeClock({ now: NOW });
const fx = new AcceptFakes();
const deps = (over: Partial<AcceptPaymentDeps> = {}): AcceptPaymentDeps => ({
  sessions: fx.sessions,
  reads: fx.accepts,
  writes: fx.accepts,
  slots: fx.slots,
  log: fx.log,
  clock,
  ...over,
});
const run = (cmd = acceptCommand(), over: Partial<AcceptPaymentDeps> = {}) => new AcceptPayment(deps(over)).execute(cmd);

const ACCEPTED = { status: 202, replayed: false } as const;
const REPLAYED = { status: 202, replayed: true } as const;
const rejected = (reason: string) => ({ status: 'REJECTED', reason });
/** 대조를 지난 뒤 부르는 차례 전부 */
const FULL: AcceptCall[] = ['sessions.get', 'reads.findCommitted', 'reads.order', 'reads.activeAttempt', 'slots.read', 'writes.accept'];

/** 이 포트들은 부르지 않았다 */
function notCalled(...ports: AcceptCall[]) {
  for (const p of ports) expect(fx.calls, `${p}를 부르면 안 된다`).not.toContain(p);
}

/** 접수하지 않았다(트랜잭션 없음) */
function noAccept() {
  expect(fx.accepted).toHaveLength(0);
  notCalled('writes.accept');
}

beforeEach(() => {
  fx.reset();
});

describe('정상 202와 검사 차례', () => {
  test('FR011_토스 정상 요청은 202(replayed 거짓)이고, 구매 세션 → 커밋된 멱등 기록 → 주문 → 활성 결제 시도 → 회차 슬롯 → 한 트랜잭션 차례로 한 번씩 부르며 보안 로그가 없다', async () => {
    expect(await run()).toEqual(ACCEPTED);
    expect(fx.calls).toEqual(FULL);
    expect(fx.mismatchLogs).toEqual([]);
  });

  test('FR011_포트원 정상 요청(paymentId = 시도의 pg_order_ref)도 같은 차례로 202다', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    expect(await run(acceptCommand({ body: portoneBody() }))).toEqual(ACCEPTED);
    expect(fx.calls).toEqual(FULL);
  });

  test('FR011_시뮬레이터 정상 요청(토스와 같은 본문, 결제사 SIMULATOR)도 202다', async () => {
    fx.attempt = okAttempt({ pg: 'SIMULATOR' });
    expect(await run(acceptCommand({ body: tossBody({ pg: 'SIMULATOR' }) }))).toEqual(ACCEPTED);
    expect(fx.calls).toEqual(FULL);
  });

  test('FR011_각 포트에 넘기는 값: 구매 세션 ID, 멱등 요청 값, 주소의 orderId(주문·시도 읽기), 주문의 회차(슬롯 읽기), 같은 멱등 요청 값(트랜잭션)', async () => {
    const cmd = acceptCommand();
    await run(cmd);
    expect(fx.sessionGets).toEqual([PSID]);
    expect(fx.committedQueries).toEqual([cmd.idem]);
    expect(fx.orderReads).toEqual([ORDER_ID]);
    expect(fx.attemptReads).toEqual([ORDER_ID]);
    expect(fx.slotReads.map((s) => s.eventId)).toEqual([EVENT]);
    expect(fx.accepted.map((a) => a.once)).toEqual([cmd.idem]);
  });

  test('FR011_상수: 멱등 작업 이름 ACCEPT_PAYMENT, 결제 시도를 받는 시간 40분, Saga 첫 단계 RESERVE', () => {
    expect(ACCEPT_PAYMENT_OPERATION).toBe('ACCEPT_PAYMENT');
    expect(ATTEMPT_ACCEPT_WINDOW_MS).toBe(40 * 60 * 1000);
    expect(SAGA_FIRST_STEP).toBe('RESERVE');
  });

  test('NFR005_결제사를 부르는 포트가 없다: 쓰임새가 받는 포트는 구매 세션·읽기·쓰기·슬롯·로그·시계뿐이다(외부 PG 호출은 Saga, PRF-165)', async () => {
    expect(Object.keys(deps()).sort()).toEqual(['clock', 'log', 'reads', 'sessions', 'slots', 'writes']);
    expect(await run()).toEqual(ACCEPTED);
  });
});

// 결제 접수를 커밋한 직후 Saga 실행기를 깨우는 onAccepted(PRF-165, 2026-11-05 리뷰 M2): 이번에 커밋했을 때만 부르고, 던져도 202 그대로다
describe('onAccepted(접수 커밋 직후 Saga 깨우기, PRF-165 리뷰 M2)', () => {
  test('M2_이번에 접수를 커밋하면(ACCEPTED) 주문 ID로 한 번 부른다', async () => {
    const kicked: string[] = [];
    expect(await run(acceptCommand(), { onAccepted: (id) => void kicked.push(id) })).toEqual(ACCEPTED);
    expect(kicked).toEqual([ORDER_ID]);
  });

  test('M2_트랜잭션 안의 재생(REPLAYED)·커밋된 기록의 재생·거절(STALE ORDER_STATE)에서는 부르지 않는다', async () => {
    const kicked: string[] = [];
    const onAccepted = (id: string) => void kicked.push(id);
    fx.outcome = { status: 'REPLAYED' };
    expect(await run(acceptCommand(), { onAccepted })).toEqual(REPLAYED);
    fx.reset();
    fx.committed = { status: 'COMMITTED', orderId: ORDER_ID };
    expect(await run(acceptCommand(), { onAccepted })).toEqual(REPLAYED);
    fx.reset();
    fx.outcome = { status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' };
    expect((await run(acceptCommand(), { onAccepted })) as { status: string }).toMatchObject({ status: 'REJECTED' });
    expect(kicked).toEqual([]);
  });

  test('M2_onAccepted가 던져도 202 그대로다(깨우기는 응답과 무관하다. 폴링이 줍는다)', async () => {
    expect(
      await run(acceptCommand(), {
        onAccepted: () => {
          throw new Error('kick failed');
        },
      }),
    ).toEqual(ACCEPTED);
    expect(fx.accepted).toHaveLength(1);
  });
});

describe('accept 입력 칸(한 트랜잭션에 넘기는 값)', () => {
  test('FR011_토스: orderId·attemptId(대조한 시도)·eventId(주문의 회차)·refs {pg, paymentKey}·seatGen(슬롯 읽기의 gen)·actor account:<계정>이고 그 밖의 칸이 없다', async () => {
    await run();
    expect(fx.lastInput()).toStrictEqual({
      orderId: ORDER_ID,
      attemptId: ATTEMPT_ID,
      eventId: EVENT,
      refs: { pg: 'TOSS', paymentKey: PAYMENT_KEY },
      seatGen: SEAT_GEN,
      actor: `account:${ACCOUNT}`,
    });
  });

  test('FR011_ADR0044_포트원: refs는 {pg, txId, paymentToken}이고 paymentId는 싣지 않는다(이미 pg_order_ref와 같음을 봤다)', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    await run(acceptCommand({ body: portoneBody() }));
    expect(fx.lastInput().refs).toStrictEqual({ pg: 'PORTONE', txId: TX_ID, paymentToken: PAYMENT_TOKEN });
    expect(fx.lastInput()).toMatchObject({ orderId: ORDER_ID, attemptId: ATTEMPT_ID, eventId: EVENT, seatGen: SEAT_GEN, actor: `account:${ACCOUNT}` });
  });

  test('FR011_시뮬레이터: refs는 {pg SIMULATOR, paymentKey}이고 amount는 싣지 않는다', async () => {
    fx.attempt = okAttempt({ pg: 'SIMULATOR' });
    await run(acceptCommand({ body: tossBody({ pg: 'SIMULATOR', paymentKey: 'sim_key_1' }) }));
    expect(fx.lastInput().refs).toStrictEqual({ pg: 'SIMULATOR', paymentKey: 'sim_key_1' });
  });

  test('FR011_seatGen은 회차 슬롯 읽기의 gen 그대로다(1·7)', async () => {
    for (const gen of [1, 7]) {
      fx.reset();
      fx.slot = { status: 'OK', gen };
      await run();
      expect({ gen, seatGen: fx.lastInput().seatGen }).toEqual({ gen, seatGen: gen });
    }
  });

  test('FR011_attemptId는 활성 결제 시도의 ID다', async () => {
    fx.attempt = okAttempt({ attemptId: '0190f3a1-7c2e-7f00-8000-0000000000a9' });
    await run();
    expect(fx.lastInput().attemptId).toBe('0190f3a1-7c2e-7f00-8000-0000000000a9');
  });

  test('FR011_회차는 주문의 회차다: 슬롯 읽기와 accept의 eventId(정본 모호: 구매 세션의 회차와 주문의 회차가 다른 경우는 정본이 정하지 않았다. 뼈대 주석 "주문의 회차"대로 주문 쪽을 쓴다고 가정)', async () => {
    const orderEvent = '0190f3a1-7c2e-7c00-8000-0000000000c9';
    fx.session = { sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY };
    fx.order = okOrder({ eventId: orderEvent });
    await run();
    expect(fx.slotReads.map((s) => s.eventId)).toEqual([orderEvent]);
    expect(fx.lastInput().eventId).toBe(orderEvent);
  });

  test('FR011_ADR0053_결제 참조(paymentKey·txId·paymentToken)는 accept 입력의 refs에만 있고, 보안 로그 포트로 가지 않는다', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    await run(acceptCommand({ body: portoneBody() }));
    const { refs, ...rest } = fx.lastInput();
    expect(JSON.stringify(rest)).not.toMatch(/PAYTOKENSECRET|TXIDSECRET/);
    expect(JSON.stringify(refs)).toMatch(/PAYTOKENSECRET/);
    expect(fx.mismatchLogs).toEqual([]);
  });
});

describe('요청의 남은 시간(좌석 호출 마감)', () => {
  test('FR011_남은 시간이 없으면 슬롯 읽기에 마감을 넘기지 않는다(플랫폼 기본)', async () => {
    await run();
    expect(fx.slotReads[0]!.o?.deadlineMs).toBeUndefined();
  });

  test('FR011_남은 시간이 30ms면 슬롯 읽기 마감은 30ms다(정본 모호: 상한은 주문 생성의 좌석 호출과 같은 100ms라고 가정, 30ms는 그 안이다)', async () => {
    await run(acceptCommand({ deadline: Deadline.after(30, clock) }));
    expect(fx.slotReads[0]!.o?.deadlineMs).toBe(30);
  });

  // 리뷰 고침 L4(2026-11-05): 좌석 Redis를 부르기 전 남은 시간이 5ms [가정] 미만이면 부르지 않고 504 deadline-exceeded(inventory hold-seats와 같은 기준)
  test('FR011_남은 시간이 4ms면 구매 세션(좌석 Redis)을 부르지 않고 DEADLINE_EXCEEDED다. 5ms면 부르고 이어 간다', async () => {
    expect(await run(acceptCommand({ deadline: Deadline.after(4, clock) }))).toEqual(rejected('DEADLINE_EXCEEDED'));
    expect(fx.calls).toEqual([]);
    fx.reset();
    expect(await run(acceptCommand({ deadline: Deadline.after(5, clock) }))).toEqual(ACCEPTED);
    expect(fx.slotReads[0]!.o).toEqual({ deadlineMs: 5 });
  });

  test('FR011_회차 슬롯 읽기 바로 전 남은 시간이 5ms 미만이면(앞 호출이 시간을 씀) 슬롯을 부르지 않고 DEADLINE_EXCEEDED이며 쓰지 않는다', async () => {
    const own = fakeClock({ now: NOW });
    const deadline = Deadline.after(50, own);
    const reads = {
      ...fx.accepts,
      activeAttempt: async (orderId: string) => {
        const a = await fx.accepts.activeAttempt(orderId);
        own.advance(46);
        return a;
      },
    };
    fx.attempt = okAttempt({ createdAtMs: NOW });
    expect(await run(acceptCommand({ deadline }), { reads, clock: own })).toEqual(rejected('DEADLINE_EXCEEDED'));
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted', 'reads.order', 'reads.activeAttempt']);
    noAccept();
  });

  test('FR011_트랜잭션에는 남은 시간이 DB 문장 상한(1초 [가정])보다 짧을 때만 그 남은 시간을 넘긴다(300ms → 300, 5초·없음 → 넘기지 않음)', async () => {
    await run(acceptCommand({ deadline: Deadline.after(300, clock) }));
    expect(fx.acceptOptions).toEqual([{ deadlineMs: 300 }]);
    fx.reset();
    await run(acceptCommand({ deadline: Deadline.after(5_000, clock) }));
    expect(fx.acceptOptions).toEqual([{}]);
    fx.reset();
    await run();
    expect(fx.acceptOptions).toEqual([{}]);
  });
});

describe('구매 세션(401 purchase-session-ended)', () => {
  test('FR011_구매 세션이 없거나 끝났으면 SESSION_ENDED이고 그 뒤 포트(멱등 기록부터)를 부르지 않는다', async () => {
    fx.session = undefined;
    expect(await run()).toEqual(rejected('SESSION_ENDED'));
    expect(fx.calls).toEqual(['sessions.get']);
  });

  test('FR011_구매 세션의 계정이 요청 계정과 다르면 SESSION_ENDED이고 그 뒤를 부르지 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    fx.session = { sessionId: PSID, accountId: OTHER_ACCOUNT, eventId: EVENT, journeyId: JOURNEY };
    expect(await run()).toEqual(rejected('SESSION_ENDED'));
    expect(fx.calls).toEqual(['sessions.get']);
  });

  test('NFR015_구매 세션 읽기가 좌석 Redis 일시 장애(OrderSeatStoreUnavailable)면 SEAT_STORE_UNAVAILABLE이고 그 뒤를 부르지 않는다', async () => {
    fx.session = new OrderSeatStoreUnavailable(new Error('down'));
    expect(await run()).toEqual(rejected('SEAT_STORE_UNAVAILABLE'));
    expect(fx.calls).toEqual(['sessions.get']);
  });

  test('FR011_PT45_구매 세션이 먼저다: 커밋된 기록이 있어도 세션이 끝났으면 SESSION_ENDED', async () => {
    fx.session = undefined;
    fx.committed = { status: 'COMMITTED', orderId: ORDER_ID };
    expect(await run()).toEqual(rejected('SESSION_ENDED'));
  });
});

describe('PT45 멱등(커밋된 기록 읽기와 트랜잭션 안의 재생)', () => {
  test('PT45_③_같은 키·같은 지문으로 커밋한 접수가 있으면 처음 202를 그대로 돌려준다(replayed 참). 주문·시도·슬롯·쓰기를 부르지 않는다', async () => {
    fx.committed = { status: 'COMMITTED', orderId: ORDER_ID };
    expect(await run()).toEqual(REPLAYED);
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted']);
  });

  test('PT45_③_주문이 그 뒤 상태로 갔거나(ACCEPTED·EXPIRED), 시도가 없거나, 판매가 멈췄거나, 금액이 틀린 본문이어도 커밋된 기록이 있으면 같은 202다', async () => {
    fx.committed = { status: 'COMMITTED', orderId: ORDER_ID };
    fx.order = okOrder({ status: 'EXPIRED' });
    fx.attempt = undefined;
    fx.slot = { status: 'PAUSED' };
    expect(await run(acceptCommand({ body: tossBody({ amount: AMOUNT + 1 }) }))).toEqual(REPLAYED);
    noAccept();
    expect(fx.mismatchLogs).toEqual([]);
  });

  test('PT45_②_같은 키에 다른 지문이면 IDEM_REUSED이고 그 뒤 포트를 부르지 않는다', async () => {
    fx.committed = { status: 'MISMATCH' };
    expect(await run()).toEqual(rejected('IDEM_REUSED'));
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted']);
  });

  test('PT45_⑥_기록이 없거나 보관 기간이 지났으면(NONE) 새 요청으로 검사를 이어 간다', async () => {
    fx.committed = { status: 'NONE' };
    expect(await run()).toEqual(ACCEPTED);
    expect(fx.accepted).toHaveLength(1);
  });

  test('PT45_트랜잭션 안에서 같은 키·같은 지문의 요청이 먼저 커밋했으면(REPLAYED) 202 replayed 참이다', async () => {
    fx.outcome = { status: 'REPLAYED' };
    expect(await run()).toEqual(REPLAYED);
  });

  test('PT45_③_트랜잭션이 던지는 409 idempotency-request-in-progress는 그대로 던지고, 첫 접수가 커밋된 뒤 다시 보내면 처음 202다', async () => {
    const inProgress = new ProblemError({ type: 'idempotency-request-in-progress', status: 409, title: '같은 요청을 아직 처리하고 있습니다', retryAfterSeconds: 1, normalBranch: true });
    fx.outcome = inProgress;
    await expect(run()).rejects.toBe(inProgress);
    fx.reset();
    fx.committed = { status: 'COMMITTED', orderId: ORDER_ID };
    expect(await run()).toEqual(REPLAYED);
  });

  test('PT45_②_트랜잭션이 던지는 422 idempotency-key-reused도 그대로 던진다', async () => {
    const reused = new ProblemError({ type: 'idempotency-key-reused', status: 422, title: '같은 멱등 키를 다른 요청에 썼습니다' });
    fx.outcome = reused;
    await expect(run()).rejects.toBe(reused);
  });

  test('FR011_트랜잭션의 DB 오류는 그대로 던진다', async () => {
    const db = new Error('connection terminated');
    fx.outcome = db;
    await expect(run()).rejects.toBe(db);
  });

  test('FR011_멱등 요청 값은 받는 층이 준 그대로 넘긴다(작업 이름 ACCEPT_PAYMENT)', async () => {
    const idem = acceptIdem({ key: '9a0b8c1e-2d4a-4b6c-9e8f-1a2b3c4d5e70' });
    await run(acceptCommand({ idem }));
    expect(fx.committedQueries[0]).toBe(idem);
    expect(fx.accepted[0]!.once).toBe(idem);
    expect(idem.operation).toBe(ACCEPT_PAYMENT_OPERATION);
  });
});

describe('주문 읽기(404 not-found, S-T29 ⑥)', () => {
  test('FR011_주문이 없으면 NOT_FOUND이고 시도·슬롯·쓰기를 부르지 않는다', async () => {
    fx.order = undefined;
    expect(await run()).toEqual(rejected('NOT_FOUND'));
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted', 'reads.order']);
  });

  test('ST29_⑥_남의 계정의 주문이면 NOT_FOUND이고 그 주문의 시도를 읽지도 쓰지도 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    fx.order = okOrder({ accountId: OTHER_ACCOUNT });
    expect(await run()).toEqual(rejected('NOT_FOUND'));
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted', 'reads.order']);
    expect(fx.mismatchLogs).toEqual([]);
  });

  test('ST29_③_같은 계정이라도 다른 구매 세션(다른 탭)에서 만든 주문이면 NOT_FOUND다 [ASVS v5.0.0-8.2.2]', async () => {
    fx.order = okOrder({ purchaseSessionId: OTHER_PSID });
    expect(await run()).toEqual(rejected('NOT_FOUND'));
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted', 'reads.order']);
  });

  test('ST29_⑥_없는 주문·남의 주문·다른 구매 세션의 주문은 같은 답이다(가리지 않는다)', async () => {
    const answers: unknown[] = [];
    for (const order of [undefined, okOrder({ accountId: OTHER_ACCOUNT }), okOrder({ purchaseSessionId: OTHER_PSID })]) {
      fx.reset();
      fx.order = order;
      answers.push(await run());
    }
    expect(answers).toEqual([rejected('NOT_FOUND'), rejected('NOT_FOUND'), rejected('NOT_FOUND')]);
  });

  test('ST29_⑥_남의 주문이면 상태가 EXPIRED·ACCEPTED여도 404다(상태 표보다 먼저라 남의 주문 상태가 새지 않는다)', async () => {
    for (const status of ['EXPIRED', 'ACCEPTED', 'CONFIRMED'] as OrderStatus[]) {
      fx.reset();
      fx.order = okOrder({ accountId: OTHER_ACCOUNT, status });
      expect({ status, r: await run() }).toEqual({ status, r: rejected('NOT_FOUND') });
    }
  });

  test('FR011_주소의 orderId는 모양을 보지 않은 글 그대로 읽기 포트에 넘기고, 읽기가 비면(소문자 UUID가 아님) NOT_FOUND다', async () => {
    fx.order = undefined;
    expect(await run(acceptCommand({ orderId: ORDER_ID.toUpperCase() }))).toEqual(rejected('NOT_FOUND'));
    // 정본 모호: 쓰임새가 모양을 먼저 보고 읽기를 건너뛰어도 같은 404다. 넘긴다면 글 그대로여야 한다
    for (const id of fx.orderReads) expect(id).toBe(ORDER_ID.toUpperCase());
    noAccept();
  });
});

describe('상태 표(409 order-expired·payment-already-accepted)', () => {
  test('FR011_EXPIRED면 ORDER_EXPIRED이고 시도·슬롯·쓰기를 부르지 않는다(결제사 승인을 부르지 않는다, ADR-0107)', async () => {
    fx.order = okOrder({ status: 'EXPIRED' });
    expect(await run()).toEqual(rejected('ORDER_EXPIRED'));
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted', 'reads.order']);
  });

  const AFTER: OrderStatus[] = ORDER_STATUSES.filter((s) => s !== 'CREATED' && s !== 'EXPIRED');

  test.each(AFTER.map((s) => [s]))('PT23_CREATED·EXPIRED가 아닌 %s면 ALREADY_ACCEPTED이고 시도·슬롯·쓰기를 부르지 않는다(§4.2 2)', async (status) => {
    fx.order = okOrder({ status });
    expect(await run()).toEqual(rejected('ALREADY_ACCEPTED'));
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted', 'reads.order']);
    expect(fx.mismatchLogs).toEqual([]);
  });

  test('FR011_상태 표가 시도 대조보다 먼저다: EXPIRED 주문에 시도가 없어도 ORDER_EXPIRED이고 보안 로그가 없다', async () => {
    fx.order = okOrder({ status: 'EXPIRED' });
    fx.attempt = undefined;
    expect(await run()).toEqual(rejected('ORDER_EXPIRED'));
    expect(fx.mismatchLogs).toEqual([]);
  });

  test('FR011_AUTHENTICATED(인증만 따로 쓴 상태)도 받지 않는다: CREATED만 받는다', async () => {
    fx.order = okOrder({ status: 'AUTHENTICATED' });
    expect(await run()).toEqual(rejected('ALREADY_ACCEPTED'));
  });
});

describe('PT28 활성 결제 시도 대조(409 payment-attempt-mismatch, 보안 로그)', () => {
  /** 보안 로그 한 줄(계정·주문·까닭)을 남겼고 슬롯·쓰기를 부르지 않았다 */
  function mismatched(reason: string) {
    expect(fx.mismatchLogs).toEqual([{ accountId: ACCOUNT, orderId: ORDER_ID, reason }]);
    expect(Object.keys(fx.mismatchLogs[0]!).sort()).toEqual(['accountId', 'orderId', 'reason']);
    notCalled('slots.read');
    noAccept();
  }

  test('PT28_활성 시도가 없으면 ATTEMPT_MISMATCH이고 보안 로그(no_attempt) 한 줄이다 [ASVS v5.0.0-16.3.2]', async () => {
    fx.attempt = undefined;
    expect(await run()).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('no_attempt');
    expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted', 'reads.order', 'reads.activeAttempt', 'log.attemptMismatch']);
  });

  test('PT28_PT23_활성 시도가 READY가 아니면(ACCEPTED) no_attempt다', async () => {
    fx.attempt = okAttempt({ status: 'ACCEPTED' });
    expect(await run()).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('no_attempt');
  });

  test('PT28_ADR0107_시도를 만든 지 정확히 40분이면 받지 않는다(attempt_expired, 40분 이상)', async () => {
    fx.attempt = okAttempt({ createdAtMs: NOW - ATTEMPT_ACCEPT_WINDOW_MS });
    expect(await run()).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('attempt_expired');
  });

  test('PT28_ADR0107_시도를 만든 지 41분이면 attempt_expired다', async () => {
    fx.attempt = okAttempt({ createdAtMs: NOW - 41 * MIN });
    expect(await run()).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('attempt_expired');
  });

  test('PT28_ADR0107_시도를 만든 지 40분 − 1ms면 받는다(202)', async () => {
    fx.attempt = okAttempt({ createdAtMs: NOW - ATTEMPT_ACCEPT_WINDOW_MS + 1 });
    expect(await run()).toEqual(ACCEPTED);
    expect(fx.mismatchLogs).toEqual([]);
  });

  test('PT28_40분은 주입 시계로 잰다: 시계를 40분 앞으로 돌리면 같은 시도가 attempt_expired다', async () => {
    const own = fakeClock({ now: NOW });
    fx.attempt = okAttempt({ createdAtMs: NOW });
    expect(await run(acceptCommand(), { clock: own })).toEqual(ACCEPTED);
    fx.reset();
    fx.attempt = okAttempt({ createdAtMs: NOW });
    own.advance(ATTEMPT_ACCEPT_WINDOW_MS);
    expect(await run(acceptCommand(), { clock: own })).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('attempt_expired');
  });

  test.each<[string, 'TOSS' | 'PORTONE' | 'SIMULATOR', () => ReturnType<typeof tossBody>]>([
    ['토스 시도에 포트원 본문', 'TOSS', () => portoneBody()],
    ['포트원 시도에 토스 본문', 'PORTONE', () => tossBody()],
    ['토스 시도에 시뮬레이터 본문', 'TOSS', () => tossBody({ pg: 'SIMULATOR' })],
    ['시뮬레이터 시도에 토스 본문', 'SIMULATOR', () => tossBody()],
  ])('PT28_본문 pg가 시도의 결제사와 다르면(%s) ATTEMPT_MISMATCH이고 pg_mismatch다 [ASVS v5.0.0-2.2.3]', async (_label, pg, body) => {
    fx.attempt = okAttempt({ pg });
    expect(await run(acceptCommand({ body: body() }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('pg_mismatch');
  });

  test('PT28_포트원 본문 paymentId가 시도의 pg_order_ref와 다르면 payment_id_mismatch다 [ASVS v5.0.0-2.2.3]', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    expect(await run(acceptCommand({ body: portoneBody({ paymentId: `pay-${OTHER_PSID}` }) }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('payment_id_mismatch');
  });

  test('PT28_포트원 시도의 pg_order_ref가 비었으면 어떤 paymentId든 payment_id_mismatch다', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE', pgOrderRef: undefined });
    expect(await run(acceptCommand({ body: portoneBody() }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('payment_id_mismatch');
  });

  test('PT28_포트원 paymentId 대조는 글자 그대로다: 대문자로 바꾼 같은 값도 다르다', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    expect(await run(acceptCommand({ body: portoneBody({ paymentId: PORTONE_PAYMENT_ID.toUpperCase() }) }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('payment_id_mismatch');
  });

  test('PT28_대조 차례: 시도 없음 → 40분 → 결제사 → paymentId. 40분이 지나고 결제사도 다르면 attempt_expired다', async () => {
    fx.attempt = okAttempt({ pg: 'TOSS', createdAtMs: NOW - 41 * MIN });
    expect(await run(acceptCommand({ body: portoneBody() }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('attempt_expired');
  });

  test('PT28_PT7_결제사가 다르고 금액도 다르면 pg_mismatch(409)다: 결제사 대조가 금액보다 먼저다', async () => {
    fx.attempt = okAttempt({ pg: 'SIMULATOR' });
    expect(await run(acceptCommand({ body: tossBody({ amount: AMOUNT + 1 }) }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('pg_mismatch');
  });

  test('PT28_보안 로그는 한 번만 남기고, 로그의 orderId는 주문의 ID다(넘긴 값에 결제 참조·토큰이 없다) [ASVS v5.0.0-16.2.5]', async () => {
    fx.attempt = okAttempt({ pg: 'TOSS' });
    await run(acceptCommand({ body: portoneBody() }));
    expect(fx.calls.filter((c) => c === 'log.attemptMismatch')).toHaveLength(1);
    const text = JSON.stringify(fx.mismatchLogs);
    for (const secret of [PAYMENT_TOKEN, TX_ID, PAYMENT_KEY]) expect(text).not.toContain(secret);
  });

  test('PT28_PT7_토스 본문으로 결제사가 다를 때도 로그에 paymentKey·금액이 없다(세 칸뿐)', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    await run(acceptCommand({ body: tossBody() }));
    expect(JSON.stringify(fx.mismatchLogs)).not.toContain(PAYMENT_KEY);
    expect(fx.mismatchLogs).toEqual([{ accountId: ACCOUNT, orderId: ORDER_ID, reason: 'pg_mismatch' }]);
  });

  test('ST29_⑥_포트원 paymentId에 남의 주문 값(pay-{다른 주문})을 넣어도 이 주문의 시도와 다르면 409이고 쓰지 않는다', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    expect(await run(acceptCommand({ body: portoneBody({ paymentId: 'pay-0190f3a1-7c2e-7f00-8000-0000000000ff' }) }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    noAccept();
  });

  // 리뷰 고침 M2(2026-11-09, PRF-191): 새 시도가 같은 결제사면 결제사·paymentId 대조로는 대체된 시도의 늦은 접수를 가를 수 없다. 본문의 선택 칸 attemptId로 가른다
  const SUPERSEDED_ATTEMPT = '0190f3a1-7c2e-7f00-8000-0000000000b1';

  test.each([
    ['토스', 'TOSS', () => tossBody({ attemptId: SUPERSEDED_ATTEMPT })],
    ['포트원', 'PORTONE', () => portoneBody({ attemptId: SUPERSEDED_ATTEMPT })],
  ] as const)('PT27_리뷰 고침 M2: %s 본문의 attemptId가 지금 READY 시도와 다르면 결제사가 같아도 ATTEMPT_MISMATCH이고 attempt_id_mismatch다 [ASVS v5.0.0-2.3.4]', async (_label, pg, body) => {
    fx.attempt = okAttempt({ pg });
    expect(await run(acceptCommand({ body: body() }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('attempt_id_mismatch');
  });

  test('PT27_리뷰 고침 M2: attemptId 대조가 금액 대조보다 먼저라 대체된 시도의 금액이 달라도 409다', async () => {
    fx.attempt = okAttempt({ pg: 'TOSS' });
    expect(await run(acceptCommand({ body: tossBody({ attemptId: SUPERSEDED_ATTEMPT, amount: AMOUNT + 1 }) }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    mismatched('attempt_id_mismatch');
  });

  test('PT27_리뷰 고침 M2: attemptId가 지금 READY 시도와 같으면 202이고 그 시도로 접수한다', async () => {
    fx.attempt = okAttempt({ pg: 'TOSS' });
    expect(await run(acceptCommand({ body: tossBody({ attemptId: ATTEMPT_ID }) }))).toEqual(ACCEPTED);
    expect(fx.lastInput().attemptId).toBe(ATTEMPT_ID);
  });

  test('PT27_리뷰 고침 M2: attemptId가 없으면 지금처럼 결제사만 대조해 202다', async () => {
    fx.attempt = okAttempt({ pg: 'TOSS' });
    expect(await run(acceptCommand({ body: tossBody() }))).toEqual(ACCEPTED);
  });
});

describe('PT7 금액 대조(400, 토스·시뮬레이터)', () => {
  test.each([[AMOUNT + 1], [AMOUNT - 1], [0], [AMOUNT * 2]])(
    'PT7_토스 본문 amount %d가 주문 금액과 다르면 AMOUNT_MISMATCH이고 보안 로그 한 줄(계정·주문·amount_mismatch, 금액 없음)을 남기며 슬롯·쓰기를 부르지 않는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.3.3]',
    async (amount) => {
      expect(await run(acceptCommand({ body: tossBody({ amount }) }))).toEqual(rejected('AMOUNT_MISMATCH'));
      // 금액 변조도 보안 사건이라 대조 실패와 같은 꼴의 로그 한 줄을 남긴다(payment §2 '활성 결제 시도 대조', 2026-11-05 정본 바로잡음)
      expect(fx.mismatchLogs).toEqual([{ accountId: ACCOUNT, orderId: ORDER_ID, reason: 'amount_mismatch' }]);
      // 금액(받은 값·주문 값)은 싣지 않는다: 세 칸뿐이다
      expect(Object.keys(fx.mismatchLogs[0]!).sort()).toEqual(['accountId', 'orderId', 'reason']);
      expect(fx.calls).toEqual(['sessions.get', 'reads.findCommitted', 'reads.order', 'reads.activeAttempt', 'log.attemptMismatch']);
      notCalled('slots.read');
      noAccept();
    },
  );

  test('PT7_시뮬레이터도 1원 차이면 AMOUNT_MISMATCH다', async () => {
    fx.attempt = okAttempt({ pg: 'SIMULATOR' });
    expect(await run(acceptCommand({ body: tossBody({ pg: 'SIMULATOR', amount: AMOUNT + 1 }) }))).toEqual(rejected('AMOUNT_MISMATCH'));
    expect(fx.mismatchLogs).toEqual([{ accountId: ACCOUNT, orderId: ORDER_ID, reason: 'amount_mismatch' }]);
    noAccept();
  });

  test('PT7_금액은 주문 행의 금액과 견준다(주문 금액이 바뀌면 같은 본문도 다르다)', async () => {
    fx.order = okOrder({ amount: 1_000 });
    expect(await run(acceptCommand({ body: tossBody({ amount: 1_000 }) }))).toEqual(ACCEPTED);
    fx.reset();
    fx.order = okOrder({ amount: 1_000 });
    expect(await run(acceptCommand({ body: tossBody({ amount: AMOUNT }) }))).toEqual(rejected('AMOUNT_MISMATCH'));
  });

  test('PT28_포트원 본문에는 금액이 없어 금액을 견주지 않는다: 주문 금액이 무엇이든 202다(포트원 금액 불일치는 승인 API가 거절한다)', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    fx.order = okOrder({ amount: 1 });
    expect(await run(acceptCommand({ body: portoneBody() }))).toEqual(ACCEPTED);
  });

  test('PT7_금액이 틀리고 시도가 없으면 ATTEMPT_MISMATCH(no_attempt)다: 시도 대조가 먼저다', async () => {
    fx.attempt = undefined;
    expect(await run(acceptCommand({ body: tossBody({ amount: AMOUNT + 1 }) }))).toEqual(rejected('ATTEMPT_MISMATCH'));
    expect(fx.mismatchLogs.map((l) => l.reason)).toEqual(['no_attempt']);
  });
});

describe('회차 슬롯 읽기(423 sale-paused·503 seat-store-unavailable)', () => {
  test('FR011_판매 정지 사본이면(PAUSED) SALE_PAUSED이고 쓰기를 부르지 않는다', async () => {
    fx.slot = { status: 'PAUSED' };
    expect(await run()).toEqual(rejected('SALE_PAUSED'));
    expect(fx.calls).toEqual(FULL.slice(0, -1));
    noAccept();
  });

  test('NFR015_세대 키가 없으면(NOT_READY) SEAT_STORE_UNAVAILABLE이고 쓰기를 부르지 않는다', async () => {
    fx.slot = { status: 'NOT_READY' };
    expect(await run()).toEqual(rejected('SEAT_STORE_UNAVAILABLE'));
    noAccept();
  });

  test('NFR015_슬롯 읽기가 좌석 Redis 일시 장애(OrderSeatStoreUnavailable)면 SEAT_STORE_UNAVAILABLE이고 쓰기를 부르지 않는다', async () => {
    fx.slot = new OrderSeatStoreUnavailable(new Error('down'));
    expect(await run()).toEqual(rejected('SEAT_STORE_UNAVAILABLE'));
    noAccept();
  });

  test('망가진 세대 키(어댑터의 Error)는 그대로 던지고 쓰기를 부르지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const corrupt = new Error('PEAKET_CORRUPT_KEY s:{event:x}:epoch');
    fx.slot = corrupt;
    await expect(run()).rejects.toBe(corrupt);
    noAccept();
  });

  test('FR011_슬롯 읽기는 대조 뒤다: 시도가 없고 판매가 멈췄으면 ATTEMPT_MISMATCH이고 슬롯을 읽지 않는다', async () => {
    fx.attempt = undefined;
    fx.slot = { status: 'PAUSED' };
    expect(await run()).toEqual(rejected('ATTEMPT_MISMATCH'));
    notCalled('slots.read');
  });

  test('PT7_슬롯 읽기는 금액 대조 뒤다: 금액이 틀리고 판매가 멈췄으면 AMOUNT_MISMATCH다', async () => {
    fx.slot = { status: 'PAUSED' };
    expect(await run(acceptCommand({ body: tossBody({ amount: AMOUNT + 1 }) }))).toEqual(rejected('AMOUNT_MISMATCH'));
    notCalled('slots.read');
  });

  test('FR011_상태 표가 판매 정지보다 먼저다: 이미 접수한 주문이면 판매가 멈췄어도 ALREADY_ACCEPTED', async () => {
    fx.order = okOrder({ status: 'ACCEPTED' });
    fx.slot = { status: 'PAUSED' };
    expect(await run()).toEqual(rejected('ALREADY_ACCEPTED'));
  });
});

describe('PT23 한 트랜잭션의 경합(조건부 UPDATE 0행)', () => {
  // 리뷰 고침 M2(2026-11-05): 트랜잭션은 주문 행(T3)을 먼저 잠그고 결제 시도를 뒤에 바꾼다. 다른 탭이 먼저 접수했으면 T3가 0행(current ACCEPTED)이고,
  // 시도 UPDATE 0행은 그사이 시도가 대체·만료된 것뿐이라 시도 대조 실패(409 payment-attempt-mismatch, 보안 로그)다
  test('PT23_②_다른 탭이 먼저 접수했으면(STALE ORDER_STATE, current ACCEPTED) ALREADY_ACCEPTED이고 보안 로그가 없다', async () => {
    fx.outcome = { status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' };
    expect(await run()).toEqual(rejected('ALREADY_ACCEPTED'));
    expect(fx.mismatchLogs).toEqual([]);
  });

  test.each<[('ACCEPTED' | 'SUPERSEDED' | 'EXPIRED') | undefined, string]>([
    ['SUPERSEDED', 'no_attempt'],
    ['EXPIRED', 'attempt_expired'],
    ['ACCEPTED', 'no_attempt'],
    [undefined, 'no_attempt'],
  ])('PT28_트랜잭션 안에서 시도가 READY가 아니게 됐으면(STALE ATTEMPT_GONE, 시도 %s) ATTEMPT_MISMATCH이고 보안 로그 한 줄(%s)이다', async (current, reason) => {
    fx.outcome = current === undefined ? { status: 'STALE', reason: 'ATTEMPT_GONE' } : { status: 'STALE', reason: 'ATTEMPT_GONE', current };
    expect(await run()).toEqual(rejected('ATTEMPT_MISMATCH'));
    expect(fx.mismatchLogs).toEqual([{ accountId: ACCOUNT, orderId: ORDER_ID, reason }]);
    expect(fx.calls.at(-1)).toBe('log.attemptMismatch');
  });

  test('ADR0107_주문 T3·T4가 출발 상태가 아니고 지금 상태가 EXPIRED면(만료와 겹침) ORDER_EXPIRED다', async () => {
    fx.outcome = { status: 'STALE', reason: 'ORDER_STATE', current: 'EXPIRED' };
    expect(await run()).toEqual(rejected('ORDER_EXPIRED'));
  });

  test.each<[OrderStatus | undefined]>([['ACCEPTED'], ['AUTHENTICATED'], ['RESERVED'], [undefined]])(
    'PT23_주문 T3·T4가 출발 상태가 아니고 지금 상태가 %s면 ALREADY_ACCEPTED다',
    async (current) => {
      fx.outcome = current === undefined ? { status: 'STALE', reason: 'ORDER_STATE' } : { status: 'STALE', reason: 'ORDER_STATE', current };
      expect(await run()).toEqual(rejected('ALREADY_ACCEPTED'));
    },
  );

  test('PT23_②_두 탭이 같은 주문을 서로 다른 멱등 키로 겹쳐 보내면 하나만 202이고 다른 하나는 ALREADY_ACCEPTED다(트랜잭션이 둘째에 ORDER_STATE ACCEPTED)', async () => {
    const answers = [{ status: 'ACCEPTED' }, { status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' }] as const;
    const writes = {
      ...fx.accepts,
      accept: async (...a: Parameters<typeof fx.accepts.accept>) => {
        // 몇 번째로 불렸는지는 부르는 순간에 센다(기다린 뒤에 세면 두 요청이 나란히 돌아 둘 다 '둘째'로 본다)
        const nth = fx.accepted.length;
        await fx.accepts.accept(...a);
        return nth === 0 ? answers[0] : answers[1];
      },
    };
    const [a, b] = await Promise.all([
      run(acceptCommand({ idem: acceptIdem({ key: '11111111-2d4a-4b6c-9e8f-1a2b3c4d5e6f' }) }), { writes }),
      run(acceptCommand({ idem: acceptIdem({ key: '22222222-2d4a-4b6c-9e8f-1a2b3c4d5e6f' }) }), { writes }),
    ]);
    expect([a, b]).toEqual(expect.arrayContaining([ACCEPTED, rejected('ALREADY_ACCEPTED')]));
    expect(fx.accepted).toHaveLength(2);
  });
});

describe('입력을 바꾸지 않는다', () => {
  test('FR011_쓰임새는 명령·본문을 고치지 않는다', async () => {
    const cmd = acceptCommand({ body: portoneBody() });
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    const before = JSON.stringify({ ...cmd, idem: { ...cmd.idem, requestHash: [...cmd.idem.requestHash] } });
    await run(cmd);
    expect(JSON.stringify({ ...cmd, idem: { ...cmd.idem, requestHash: [...cmd.idem.requestHash] } })).toBe(before);
  });
});
