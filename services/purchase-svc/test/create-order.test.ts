// 주문 생성 쓰임새(application/create-order.ts CreateOrder, docs/features/payment.md §2 '주문 생성의 첫 구현', BUILD_ORDER PRF-161)를 메모리 가짜 포트로 본다.
// 검사 차례(앞이 걸리면 뒤 포트를 부르지 않는다), 거절 열셋, 멱등 재생(P-T45), 판매 종료(P-T37), 재확인 대체 판정(P-T35), 예매 제한(P-T49),
// 조사용 칸(P-T52), 새 주문 칸, 커밋 뒤 Paying 표시. 실제 PostgreSQL·Valkey로 도는 것은 test-int(다른 담당)다.
import { Deadline, fakeClock, ProblemError, uuidv7Time } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  CONTACT_REF_DEADLINE_MS,
  CREATE_ORDER_OPERATION,
  CreateOrder,
  type CreateOrderDeps,
  FALLBACK_REASONS,
  IDENTITY_RECHECK_DEADLINE_MS,
  OrderSeatStoreUnavailable,
  type OrderSignals,
} from '../src/modules/booking/index.js';
import {
  ACCOUNT,
  AMOUNT,
  COMMITTED_VIEW,
  CONSENT_VERSION,
  CONTACT_REF,
  DAY,
  EVENT,
  HOLD_ID,
  IDEM_KEY,
  ITEMS,
  JOURNEY,
  LOGIN,
  NOW,
  okBody,
  okCommand,
  OrderFakes,
  type PortCall,
  PSID,
  SEATS,
  viewOf,
} from './order-cases.js';

const clock = fakeClock({ now: NOW });
const fx = new OrderFakes(clock);
const deps = (over: Partial<CreateOrderDeps> = {}): CreateOrderDeps => ({ ...fx.ports(), clock, consentVersion: CONSENT_VERSION, ...over });
const useCase = (over: Partial<CreateOrderDeps> = {}) => new CreateOrder(deps(over));
const run = (cmd = okCommand(), over: Partial<CreateOrderDeps> = {}) => useCase(over).execute(cmd);

/** 홀드 확인 단계(saleConfigs.get·holds.check)는 둘의 차례·동시 여부를 정본이 정하지 않아 한 단계로 접는다(정본 모호: 판매 종료 비교에 둘 다 쓴다) */
function stepsOf(calls: readonly PortCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    const s = c === 'saleConfigs.get' || c === 'holds.check' ? 'hold-step' : c;
    if (s === 'hold-step' && out.at(-1) === 'hold-step') continue;
    out.push(s);
  }
  return out;
}

/** 이 포트들은 부르지 않았다 */
function notCalled(...ports: PortCall[]) {
  for (const p of ports) expect(fx.calls, `${p}를 부르면 안 된다`).not.toContain(p);
}

/** 주문을 만들지 않았다(쓰기·Paying 표시 없음) */
function noOrder() {
  expect(fx.created).toHaveLength(0);
  notCalled('writes.create', 'sessions.markPaying');
}

beforeEach(() => {
  fx.reset();
});

describe('정상 201과 검사 차례', () => {
  test('FR011_정상 요청은 201이고 replayed 거짓이며, 구매 세션 → 커밋된 멱등 기록 → 홀드 확인 → 재확인 → 예매 제한 → contactRef → 쓰기 → Paying 표시 차례로 한 번씩 부른다', async () => {
    const r = await run();
    expect(r).toEqual({ status: 201, order: viewOf(fx.lastOrder()), replayed: false });
    expect(stepsOf(fx.calls)).toEqual([
      'sessions.get',
      'writes.findCommitted',
      'hold-step',
      'identity.check',
      'restrictions.read',
      'contactRefs.compute',
      'writes.create',
      'sessions.markPaying',
    ]);
    expect(fx.calls.filter((c) => c === 'saleConfigs.get')).toHaveLength(1);
    expect(fx.calls.filter((c) => c === 'holds.check')).toHaveLength(1);
  });

  test('FR011_201의 주문은 writes.create가 돌려준 모습 그대로다', async () => {
    fx.outcome = { status: 'CREATED', order: COMMITTED_VIEW };
    const r = await run();
    expect(r).toEqual({ status: 201, order: COMMITTED_VIEW, replayed: false });
  });

  test('FR011_각 포트에 넘기는 값: 구매 세션 ID, 멱등 요청 값, 세션의 회차, 홀드 질의(회차·구매 세션·계정·holdId), 재확인(계정·로그인 세션), 예매 제한(계정), Paying(구매 세션)', async () => {
    const cmd = okCommand();
    await run(cmd);
    expect(fx.sessionGets).toEqual([PSID]);
    expect(fx.committedQueries).toEqual([cmd.idem]);
    expect(fx.saleGets).toEqual([EVENT]);
    expect(fx.holdQueries).toEqual([{ eventId: EVENT, purchaseSessionId: PSID, accountId: ACCOUNT, holdId: HOLD_ID }]);
    expect(fx.recheckQueries).toEqual([{ accountId: ACCOUNT, sessionId: LOGIN, deadlineMs: IDENTITY_RECHECK_DEADLINE_MS }]);
    expect(fx.restrictionReads).toEqual([ACCOUNT]);
    expect(fx.payingCalls).toEqual([PSID]);
    expect(fx.created[0]!.once).toEqual(cmd.idem);
  });

  test('FR011_홀드 질의의 회차는 구매 세션의 회차다(본문에 회차가 없다). holdId는 본문 글 그대로 넘긴다', async () => {
    fx.session = { sessionId: PSID, accountId: ACCOUNT, eventId: 'other-event', journeyId: JOURNEY };
    await run(okCommand({ body: okBody({ holdId: 'NOT-A-UUID' }) }));
    expect(fx.saleGets).toEqual(['other-event']);
    expect(fx.holdQueries[0]).toEqual({ eventId: 'other-event', purchaseSessionId: PSID, accountId: ACCOUNT, holdId: 'NOT-A-UUID' });
  });

  test('FR011_상수: 멱등 작업 이름 CREATE_ORDER, 재확인 데드라인 150ms, contactRef 데드라인 50ms', () => {
    expect(CREATE_ORDER_OPERATION).toBe('CREATE_ORDER');
    expect(IDENTITY_RECHECK_DEADLINE_MS).toBe(150);
    expect(CONTACT_REF_DEADLINE_MS).toBe(50);
  });
});

describe('새 주문(NewOrder) 칸', () => {
  test('FR011_ADR0171_새 주문: 홀드·구매 세션·계정·회차, 금액 = 등급 가격 합, 예매자(번호는 E.164), 멱등 키, 동의 판, PICK, 항목, 행위자 account:<계정>, CREATED 칸', async () => {
    await run();
    const o = fx.lastOrder();
    expect(o).toMatchObject({
      holdId: HOLD_ID,
      purchaseSessionId: PSID,
      accountId: ACCOUNT,
      eventId: EVENT,
      amount: AMOUNT,
      buyerName: '홍길동',
      buyerPhone: '+821012345678',
      idempotencyKey: IDEM_KEY,
      consentVersion: CONSENT_VERSION,
      seatAssignment: 'PICK',
      items: ITEMS,
      actor: `account:${ACCOUNT}`,
      created: { purchaseSessionId: PSID, journeyId: JOURNEY, contactRef: CONTACT_REF, refMissing: false },
    });
    // created.purchaseSessionId와 purchaseSessionId는 같은 값(ports NewOrder 주석)
    expect(o.created.purchaseSessionId).toBe(o.purchaseSessionId);
  });

  test('FR011_주문 ID는 주입 시계로 만든 UUIDv7이다(소문자, 판 7, 앞 48비트 = 지금)', async () => {
    await run();
    const id = fx.lastOrder().id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7Time(id)).toBe(NOW);
  });

  test('FR011_금액은 클라이언트가 보낸 값을 쓰지 않고 홀드 좌석의 등급 가격으로만 계산한다(가격 표가 바뀌면 금액도 바뀐다)', async () => {
    fx.sale = { saleEndsAtMs: NOW + DAY, tierPrices: { R: 1_000, S: 500 } };
    await run();
    expect(fx.lastOrder().amount).toBe(2_500);
    expect(fx.lastOrder().items.map((i) => i.unitPrice)).toEqual([1_000, 1_000, 500]);
  });

  test('FR011_동의 판은 본문의 consentVersion(= 지금 판)이다', async () => {
    // 본문 판 v3 ≠ 지금 판 v9라 422다. 판을 맞추면 그 판이 주문에 들어간다
    expect(await run(okCommand(), { consentVersion: 'v9' })).toEqual({ status: 'REJECTED', reason: 'CONSENT_VERSION_OUTDATED' });
    fx.reset();
    await run(okCommand({ body: okBody({ consents: { provisionToSeller: true, salesTerms: true, consentVersion: 'v9' } }) }), { consentVersion: 'v9' });
    expect(fx.lastOrder().consentVersion).toBe('v9');
  });
});

describe('PT52 조사용 칸(journeyId·contactRef)', () => {
  test('PT52_①_journeyId는 구매 세션 상태의 여정 ID다', async () => {
    fx.session = { sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: '0190f3a1-7c2e-7d00-8000-0000000000d9' };
    await run();
    expect(fx.lastOrder().created.journeyId).toBe('0190f3a1-7c2e-7d00-8000-0000000000d9');
  });

  test('PT52_①_번호를 010-1234-5678과 +82 10-1234-5678로 넣은 두 주문은 ComputeContactRef에 같은 E.164 글을 보내고 저장 번호도 같다', async () => {
    await run(okCommand({ body: okBody({ buyer: { name: '홍길동', phone: '010-1234-5678' } }) }));
    await run(okCommand({ body: okBody({ buyer: { name: '홍길동', phone: '+82 10-1234-5678' } }) }));
    expect(fx.contactCalls.map((c) => c.phoneE164)).toEqual(['+821012345678', '+821012345678']);
    expect(fx.created.map((c) => c.order.buyerPhone)).toEqual(['+821012345678', '+821012345678']);
  });

  test('PT52_ComputeContactRef는 E.164 번호로 한 번만 부르고(다시 묻지 않는다), 받은 값을 contactRef에 싣고 refMissing은 거짓이다', async () => {
    await run();
    expect(fx.contactCalls).toEqual([{ phoneE164: '+821012345678', deadlineMs: CONTACT_REF_DEADLINE_MS }]);
    expect(fx.lastOrder().created).toEqual({ purchaseSessionId: PSID, journeyId: JOURNEY, contactRef: CONTACT_REF, refMissing: false });
  });

  test('PT52_ADR0171_ComputeContactRef가 실패하면(undefined) 주문을 막지 않고 contactRef를 비우며 refMissing이 참이다', async () => {
    fx.contactRef = undefined;
    const r = await run();
    expect(r).toMatchObject({ status: 201, replayed: false });
    expect(fx.contactCalls).toHaveLength(1);
    const created = fx.lastOrder().created;
    expect(created.refMissing).toBe(true);
    expect(created.contactRef).toBeUndefined();
    expect(created).toMatchObject({ purchaseSessionId: PSID, journeyId: JOURNEY });
  });

  test('PT52_번호 원문은 포트에 넘기지 않는다: 하이픈 섞인 원문이 contactRefs·새 주문 어디에도 없다', async () => {
    await run(okCommand({ body: okBody({ buyer: { name: '홍길동', phone: '010-9876-5432' } }) }));
    const text = JSON.stringify({ contact: fx.contactCalls, order: fx.created.map((c) => c.order) });
    expect(text).not.toContain('010-9876-5432');
    expect(text).toContain('+821098765432');
  });
});

describe('요청의 남은 시간(deadline)', () => {
  test('FR011_남은 시간이 없으면 재확인 150ms, contactRef 50ms를 그대로 쓴다', async () => {
    await run();
    expect(fx.recheckQueries[0]!.deadlineMs).toBe(150);
    expect(fx.contactCalls[0]!.deadlineMs).toBe(50);
  });

  test('FR011_남은 시간이 100ms면 재확인 min(150, 100) = 100ms, contactRef min(50, 100) = 50ms', async () => {
    await run(okCommand({ deadline: Deadline.after(100, clock) }));
    expect(fx.recheckQueries[0]!.deadlineMs).toBe(100);
    expect(fx.contactCalls[0]!.deadlineMs).toBe(50);
  });

  test('FR011_남은 시간이 30ms면 둘 다 30ms', async () => {
    await run(okCommand({ deadline: Deadline.after(30, clock) }));
    expect(fx.recheckQueries[0]!.deadlineMs).toBe(30);
    expect(fx.contactCalls[0]!.deadlineMs).toBe(30);
  });
});

describe('구매 세션(401 purchase-session-ended)', () => {
  test('FR011_구매 세션이 없거나 끝났으면 SESSION_NOT_FOUND이고 그 뒤 포트(멱등 기록부터)를 부르지 않는다', async () => {
    fx.session = undefined;
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'SESSION_NOT_FOUND' });
    expect(fx.calls).toEqual(['sessions.get']);
  });

  test('NFR015_구매 세션 읽기가 좌석 Redis 일시 장애(OrderSeatStoreUnavailable)면 SEAT_STORE_UNAVAILABLE이고 그 뒤를 부르지 않는다', async () => {
    fx.session = new OrderSeatStoreUnavailable(new Error('down'));
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'SEAT_STORE_UNAVAILABLE' });
    expect(fx.calls).toEqual(['sessions.get']);
  });
});

describe('PT45 멱등(커밋된 기록 읽기)', () => {
  test('PT45_①_같은 키·같은 지문으로 커밋한 주문이 있으면 처음 201을 그대로 돌려준다(replayed 참). 홀드·동의·예매자·재확인·제한·contactRef·쓰기를 부르지 않고 Paying 표시는 부른다', async () => {
    fx.committed = { status: 'COMMITTED', order: COMMITTED_VIEW };
    const r = await run();
    expect(r).toEqual({ status: 201, order: COMMITTED_VIEW, replayed: true });
    expect(fx.calls).toEqual(['sessions.get', 'writes.findCommitted', 'sessions.markPaying']);
    expect(fx.payingCalls).toEqual([PSID]);
  });

  test('PT45_①_홀드가 그사이 끝났거나(NOT_FOUND) 판매가 끝났어도, 동의·예매자가 틀린 본문이어도 커밋된 기록이 있으면 같은 201이다', async () => {
    fx.committed = { status: 'COMMITTED', order: COMMITTED_VIEW };
    fx.hold = { status: 'NOT_FOUND' };
    fx.sale = { saleEndsAtMs: NOW - 1, tierPrices: {} };
    fx.recheck = { status: 'DENIED' };
    fx.restriction = { st: 'ACTIVE' };
    const r = await run(okCommand({ body: okBody({ buyer: {}, consents: undefined }) }));
    expect(r).toEqual({ status: 201, order: COMMITTED_VIEW, replayed: true });
    expect(fx.created).toHaveLength(0);
    notCalled('holds.check', 'identity.check', 'restrictions.read', 'contactRefs.compute', 'writes.create');
    expect(fx.payingCalls).toEqual([PSID]);
  });

  test('PT45_②_같은 키에 다른 지문이면 IDEM_REUSED이고 그 뒤 포트를 부르지 않는다(새 주문 없음)', async () => {
    fx.committed = { status: 'MISMATCH' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'IDEM_REUSED' });
    expect(fx.calls).toEqual(['sessions.get', 'writes.findCommitted']);
  });

  test('PT45_⑥_기록이 없거나 보관 기간이 지났으면(NONE) 새 요청으로 검사를 이어 간다', async () => {
    fx.committed = { status: 'NONE' };
    expect(await run()).toMatchObject({ status: 201, replayed: false });
    expect(fx.created).toHaveLength(1);
  });

  test('PT45_트랜잭션 안에서 같은 키·같은 지문의 요청이 먼저 커밋했으면(REPLAYED) 그 주문을 replayed 참으로 돌려주고 Paying 표시를 부른다', async () => {
    fx.outcome = { status: 'REPLAYED', order: COMMITTED_VIEW };
    expect(await run()).toEqual({ status: 201, order: COMMITTED_VIEW, replayed: true });
    expect(fx.payingCalls).toEqual([PSID]);
  });

  test('PT45_③_쓰기가 던지는 ProblemError(409 idempotency-request-in-progress·422 idempotency-key-reused)는 그대로 던지고 Paying 표시를 부르지 않는다', async () => {
    const inProgress = new ProblemError({ type: 'idempotency-request-in-progress', status: 409, title: '같은 요청을 아직 처리하고 있습니다', retryAfterSeconds: 1, normalBranch: true });
    fx.outcome = inProgress;
    await expect(run()).rejects.toBe(inProgress);
    const reused = new ProblemError({ type: 'idempotency-key-reused', status: 422, title: '같은 멱등 키를 다른 요청에 썼습니다' });
    fx.reset();
    fx.outcome = reused;
    await expect(run()).rejects.toBe(reused);
    notCalled('sessions.markPaying');
  });

  test('FR011_쓰기의 DB 오류도 그대로 던지고 Paying 표시를 부르지 않는다', async () => {
    const db = new Error('connection terminated');
    fx.outcome = db;
    await expect(run()).rejects.toBe(db);
    notCalled('sessions.markPaying');
  });
});

describe('홀드 확인(404 not-found·503 seat-store-unavailable)', () => {
  test('FR011_판매 종료 전 홀드 확인이 NOT_FOUND면 HOLD_NOT_FOUND이고 동의·재확인·제한·contactRef·쓰기를 부르지 않는다', async () => {
    fx.hold = { status: 'NOT_FOUND' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'HOLD_NOT_FOUND' });
    expect(stepsOf(fx.calls)).toEqual(['sessions.get', 'writes.findCommitted', 'hold-step']);
    noOrder();
  });

  test('FR011_404가 동의·예매자보다 먼저다: 동의·예매자도 틀린 본문이어도 HOLD_NOT_FOUND', async () => {
    fx.hold = { status: 'NOT_FOUND' };
    expect(await run(okCommand({ body: okBody({ buyer: {}, consents: undefined }) }))).toEqual({ status: 'REJECTED', reason: 'HOLD_NOT_FOUND' });
  });

  test('NFR015_홀드 확인이 STORE_UNAVAILABLE이면 SEAT_STORE_UNAVAILABLE이고 그 뒤를 부르지 않는다', async () => {
    fx.hold = { status: 'STORE_UNAVAILABLE' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'SEAT_STORE_UNAVAILABLE' });
    notCalled('identity.check', 'restrictions.read', 'contactRefs.compute');
    noOrder();
  });

  test('NFR015_회차의 판매 설정(좌석맵 판)이 없으면 SEAT_STORE_UNAVAILABLE이고 재확인·쓰기를 부르지 않는다', async () => {
    fx.sale = undefined;
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'SEAT_STORE_UNAVAILABLE' });
    // 정본 모호: 판매 설정 없음일 때 holds.check를 부르는지는 정하지 않았다(차례·동시 여부). 뒤 단계만 본다
    notCalled('identity.check', 'restrictions.read', 'contactRefs.compute');
    noOrder();
  });
});

describe('PT37 판매 종료 뒤(410 sale-ended)', () => {
  const ended = (o: { saleEndsAtMs?: number } = {}) => {
    fx.sale = { saleEndsAtMs: o.saleEndsAtMs ?? NOW - 3_600_000, tierPrices: { R: 110_000, S: 88_000 } };
  };

  test('PT37_①_판매 종료 1분 전에 잡은 유효한 홀드는 판매 종료 뒤에도 201이다', async () => {
    ended();
    const saleEnd = NOW - 3_600_000;
    fx.hold = { status: 'OK', heldAtMs: saleEnd - 60_000, seats: SEATS };
    expect(await run()).toMatchObject({ status: 201, replayed: false });
  });

  test('PT37_③_판매 종료 뒤 홀드 확인이 NOT_FOUND면(위조·다른 회차·끝난 홀드) 404가 아니라 SALE_ENDED이고 주문이 없다', async () => {
    ended();
    fx.hold = { status: 'NOT_FOUND' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'SALE_ENDED' });
    notCalled('identity.check', 'restrictions.read', 'contactRefs.compute');
    noOrder();
  });

  test('PT37_③_판매 종료 뒤에 잡은 홀드(heldAt ≥ saleEndsAt)는 OK여도 SALE_ENDED다. heldAt이 판매 종료 시각과 같아도 판매 종료 전이 아니다', async () => {
    ended();
    const saleEnd = NOW - 3_600_000;
    for (const heldAtMs of [saleEnd, saleEnd + 1, NOW]) {
      fx.reset();
      ended();
      fx.hold = { status: 'OK', heldAtMs, seats: SEATS };
      expect({ heldAtMs, r: await run() }).toEqual({ heldAtMs, r: { status: 'REJECTED', reason: 'SALE_ENDED' } });
      noOrder();
    }
  });

  test('PT37_판매 종료 시각 정각(지금 = saleEndsAt)부터 판매 종료 뒤다: NOT_FOUND는 SALE_ENDED, 1ms 전이면 HOLD_NOT_FOUND', async () => {
    ended({ saleEndsAtMs: NOW });
    fx.hold = { status: 'NOT_FOUND' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'SALE_ENDED' });
    fx.reset();
    ended({ saleEndsAtMs: NOW + 1 });
    fx.hold = { status: 'NOT_FOUND' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'HOLD_NOT_FOUND' });
  });

  test('PT37_판매 종료 전에는 heldAt을 보지 않는다(홀드가 OK면 통과)', async () => {
    fx.hold = { status: 'OK', heldAtMs: NOW + 5_000, seats: SEATS };
    expect(await run()).toMatchObject({ status: 201 });
  });

  test('PT37_NFR015_판매 종료 뒤라도 좌석 저장소 장애(STORE_UNAVAILABLE)는 410이 아니라 SEAT_STORE_UNAVAILABLE이다(정본 모호: 장애는 holdId에 대한 답이 아니라고 가정)', async () => {
    ended();
    fx.hold = { status: 'STORE_UNAVAILABLE' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'SEAT_STORE_UNAVAILABLE' });
  });

  test('PT37_판매 종료 뒤에도 커밋된 멱등 기록이 있으면 처음 201을 그대로 돌려준다', async () => {
    ended();
    fx.hold = { status: 'NOT_FOUND' };
    fx.committed = { status: 'COMMITTED', order: COMMITTED_VIEW };
    expect(await run()).toEqual({ status: 201, order: COMMITTED_VIEW, replayed: true });
  });
});

describe('동의(422)와 예매자(400)', () => {
  test('FR011_동의가 없으면 CONSENT_REQUIRED이고 재확인·제한·contactRef·쓰기를 부르지 않는다', async () => {
    expect(await run(okCommand({ body: okBody({ consents: undefined }) }))).toEqual({ status: 'REJECTED', reason: 'CONSENT_REQUIRED' });
    notCalled('identity.check', 'restrictions.read', 'contactRefs.compute');
    noOrder();
  });

  test('FR011_동의 하나가 false여도 CONSENT_REQUIRED', async () => {
    expect(await run(okCommand({ body: okBody({ consents: { provisionToSeller: true, salesTerms: false, consentVersion: CONSENT_VERSION } }) }))).toEqual({
      status: 'REJECTED',
      reason: 'CONSENT_REQUIRED',
    });
  });

  test('FR011_동의 판이 지금 판(deps.consentVersion)과 다르면 CONSENT_VERSION_OUTDATED이고 재확인을 부르지 않는다', async () => {
    expect(await run(okCommand(), { consentVersion: 'v4' })).toEqual({ status: 'REJECTED', reason: 'CONSENT_VERSION_OUTDATED' });
    notCalled('identity.check');
    noOrder();
  });

  test('FR011_동의가 예매자보다 먼저다: 동의도 예매자도 틀리면 CONSENT_REQUIRED', async () => {
    expect(await run(okCommand({ body: okBody({ consents: undefined, buyer: { name: '홍길동', phone: '1234' } }) }))).toEqual({ status: 'REJECTED', reason: 'CONSENT_REQUIRED' });
  });

  test('FR011_예매자 번호를 E.164로 맞출 수 없으면 BUYER_INVALID이고 재확인·제한·contactRef·쓰기를 부르지 않는다', async () => {
    expect(await run(okCommand({ body: okBody({ buyer: { name: '홍길동', phone: '1234' } }) }))).toEqual({ status: 'REJECTED', reason: 'BUYER_INVALID' });
    notCalled('identity.check', 'restrictions.read', 'contactRefs.compute');
    noOrder();
  });

  test('FR011_예매자 성명·번호가 없거나 101자면 BUYER_INVALID', async () => {
    for (const buyer of [{}, { name: '홍길동' }, { phone: '010-1234-5678' }, { name: '가'.repeat(101), phone: '010-1234-5678' }]) {
      fx.reset();
      expect({ buyer, r: await run(okCommand({ body: okBody({ buyer }) })) }).toEqual({ buyer, r: { status: 'REJECTED', reason: 'BUYER_INVALID' } });
    }
  });

  test('FR011_예매자 성명은 받은 그대로 저장한다', async () => {
    await run(okCommand({ body: okBody({ buyer: { name: ' 김 민지 ', phone: '+82 10 1111 2222' } }) }));
    expect(fx.lastOrder()).toMatchObject({ buyerName: ' 김 민지 ', buyerPhone: '+821011112222' });
  });
});

describe('PT35 본인확인 재확인(403·대체 판정·503)', () => {
  test('PT35_재확인이 거부(DENIED)면 IDENTITY_DENIED이고 예매 제한·contactRef·쓰기를 부르지 않으며 대체 판정 지표·로그가 없다', async () => {
    fx.recheck = { status: 'DENIED' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'IDENTITY_DENIED' });
    notCalled('restrictions.read', 'contactRefs.compute');
    noOrder();
    expect(fx.fallbackSignals).toEqual([]);
    expect(fx.fallbackLogs).toEqual([]);
  });

  test('PT35_VERIFIED인데 토큰 pid가 pid·previous_pid와 다르면 IDENTITY_DENIED', async () => {
    fx.recheck = { status: 'VERIFIED', pid: 'pid-other', previousPid: 'pid-older' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'IDENTITY_DENIED' });
    noOrder();
  });

  test('PT35_VERIFIED이고 previous_pid가 토큰 pid와 같으면 통과한다', async () => {
    fx.recheck = { status: 'VERIFIED', pid: 'pid-new', previousPid: 'pid-0001' };
    expect(await run()).toMatchObject({ status: 201 });
  });

  test.each(FALLBACK_REASONS.map((r) => [r]))(
    'PT35_ASVS16.5.2_답이 없고(%s) 토큰에 ticket:buy·pid가 있으면 대체 판정으로 201이고, 지표 한 번(그 까닭)과 보안 로그 한 줄(계정·까닭·통과·멱등 키)을 남긴다 [ASVS v5.0.0-16.5.2]',
    async (reason) => {
      fx.recheck = { status: 'FAILED', reason };
      expect(await run()).toMatchObject({ status: 201, replayed: false });
      expect(fx.fallbackSignals).toEqual([reason]);
      expect(fx.fallbackLogs).toEqual([{ accountId: ACCOUNT, reason, passed: true, idempotencyKey: IDEM_KEY }]);
      expect(fx.created).toHaveLength(1);
    },
  );

  test.each(FALLBACK_REASONS.map((r) => [r]))(
    'PT35_ASVS16.5.3_답이 없고(%s) 토큰에 pid가 없으면 IDENTITY_DENIED이고, 거부도 지표 한 번과 보안 로그 한 줄(통과 거짓)을 남긴다 [ASVS v5.0.0-16.5.3]',
    async (reason) => {
      fx.recheck = { status: 'FAILED', reason };
      expect(await run(okCommand({ token: { scopes: ['ticket:buy'] } }))).toEqual({ status: 'REJECTED', reason: 'IDENTITY_DENIED' });
      expect(fx.fallbackSignals).toEqual([reason]);
      expect(fx.fallbackLogs).toEqual([{ accountId: ACCOUNT, reason, passed: false, idempotencyKey: IDEM_KEY }]);
      noOrder();
    },
  );

  test('PT35_ASVS16.5.3_답이 없고 토큰에 ticket:buy가 없으면 IDENTITY_DENIED [ASVS v5.0.0-16.5.3]', async () => {
    fx.recheck = { status: 'FAILED', reason: 'deadline' };
    expect(await run(okCommand({ token: { pid: 'pid-0001', scopes: [] } }))).toEqual({ status: 'REJECTED', reason: 'IDENTITY_DENIED' });
    expect(fx.fallbackLogs).toEqual([{ accountId: ACCOUNT, reason: 'deadline', passed: false, idempotencyKey: IDEM_KEY }]);
  });

  test.each<['permission_denied' | 'invalid_argument']>([['permission_denied'], ['invalid_argument']])(
    'PT35_ASVS16.5.3_재확인이 %s면 대체 판정 없이 IDENTITY_MISCONFIGURED(503)이고 설정 오류 로그 한 줄을 남긴다. 대체 판정 지표·로그는 없다 [ASVS v5.0.0-16.5.3]',
    async (reason) => {
      fx.recheck = { status: 'FAILED', reason };
      expect(await run()).toEqual({ status: 'REJECTED', reason: 'IDENTITY_MISCONFIGURED' });
      expect(fx.configErrors).toEqual([{ what: 'identity_misconfigured', reason }]);
      expect(fx.fallbackSignals).toEqual([]);
      expect(fx.fallbackLogs).toEqual([]);
      notCalled('restrictions.read', 'contactRefs.compute');
      noOrder();
    },
  );

  test('PT35_재확인 통과(PASS)에는 대체 판정 지표·로그가 없다', async () => {
    await run();
    expect(fx.fallbackSignals).toEqual([]);
    expect(fx.fallbackLogs).toEqual([]);
    expect(fx.configErrors).toEqual([]);
  });

  test('PT35_지표 구현에 identityFallback이 없어도(선택 메서드) 대체 판정이 그대로 돈다', async () => {
    fx.recheck = { status: 'FAILED', reason: 'circuit_open' };
    const bare: OrderSignals = { historyMismatch: () => {} };
    expect(await run(okCommand(), { signals: bare })).toMatchObject({ status: 201 });
    expect(fx.fallbackLogs).toEqual([{ accountId: ACCOUNT, reason: 'circuit_open', passed: true, idempotencyKey: IDEM_KEY }]);
  });

  test('PT35_보안 로그에 번호 원문·토큰 pid를 싣지 않는다(계정·까닭·통과·멱등 키 네 칸뿐)', async () => {
    fx.recheck = { status: 'FAILED', reason: 'unavailable' };
    await run();
    expect(Object.keys(fx.fallbackLogs[0]!).sort()).toEqual(['accountId', 'idempotencyKey', 'passed', 'reason']);
  });
});

describe('PT49 예매 제한(403 booking-restricted)', () => {
  test('PT49_①_ACTIVE이고 끝 시각이 없으면 BOOKING_RESTRICTED이고 contactRef·쓰기·Paying 표시를 부르지 않는다(주문 행 0건)', async () => {
    fx.restriction = { st: 'ACTIVE' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'BOOKING_RESTRICTED' });
    notCalled('contactRefs.compute');
    noOrder();
  });

  test('PT49_①_ACTIVE이고 끝 시각이 지금보다 뒤면 BOOKING_RESTRICTED', async () => {
    fx.restriction = { st: 'ACTIVE', untilMs: NOW + 1 };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'BOOKING_RESTRICTED' });
    noOrder();
  });

  test('PT49_ACTIVE여도 끝 시각이 지났거나 지금과 같으면 제한이 끝난 것이라 201이다', async () => {
    for (const untilMs of [NOW, NOW - 1, NOW - DAY]) {
      fx.reset();
      fx.restriction = { st: 'ACTIVE', untilMs };
      expect({ untilMs, r: await run() }).toMatchObject({ untilMs, r: { status: 201 } });
    }
  });

  test('PT49_④_LIFTED면(끝 시각이 뒤여도) 201이다', async () => {
    fx.restriction = { st: 'LIFTED', untilMs: NOW + DAY };
    expect(await run()).toMatchObject({ status: 201 });
    fx.reset();
    fx.restriction = { st: 'LIFTED' };
    expect(await run()).toMatchObject({ status: 201 });
  });

  test('PT49_사본이 없으면 제한이 없는 것으로 보고 201이다', async () => {
    fx.restriction = undefined;
    expect(await run()).toMatchObject({ status: 201 });
  });

  test('PT49_예매 제한은 재확인 뒤에 본다: 재확인이 거부면 사본을 읽지 않는다', async () => {
    fx.recheck = { status: 'DENIED' };
    fx.restriction = { st: 'ACTIVE' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'IDENTITY_DENIED' });
    notCalled('restrictions.read');
  });

  test('NFR015_PT49_사본 읽기가 좌석 Redis 일시 장애면 SEAT_STORE_UNAVAILABLE이고 주문을 만들지 않는다', async () => {
    fx.restriction = new OrderSeatStoreUnavailable(new Error('down'));
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'SEAT_STORE_UNAVAILABLE' });
    notCalled('contactRefs.compute');
    noOrder();
  });

  test('PT49_ASVS16.5.3_망가진 사본(어댑터의 Error)은 제한 없음으로 보지 않고 그대로 던진다: 주문을 만들지 않는다(정본 모호: 쓰임새가 잡지 않는다고 가정) [ASVS v5.0.0-16.5.3]', async () => {
    const broken = new Error('예매 제한 사본이 망가졌다');
    fx.restriction = broken;
    await expect(run()).rejects.toBe(broken);
    noOrder();
  });
});

describe('금액(가격 없는 등급 500)', () => {
  test('FR011_가격이 없는 등급이면 PRICE_MISSING이고 설정 오류 로그(회차·등급) 한 줄을 남기며 contactRef·쓰기를 부르지 않는다', async () => {
    fx.sale = { saleEndsAtMs: NOW + DAY, tierPrices: { R: 110_000 } };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'PRICE_MISSING' });
    expect(fx.configErrors).toEqual([{ what: 'tier_price_missing', eventId: EVENT, tierId: 'S' }]);
    notCalled('contactRefs.compute');
    noOrder();
  });

  test('FR011_판 파일에 tierPrices가 없으면(빈 객체) 첫 좌석의 등급이 가격 없음이다', async () => {
    fx.sale = { saleEndsAtMs: NOW + DAY, tierPrices: {} };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'PRICE_MISSING' });
    expect(fx.configErrors).toEqual([{ what: 'tier_price_missing', eventId: EVENT, tierId: 'R' }]);
  });

  test('FR011_L5_등급 가격 합이 int4를 넘으면 가격 없음과 같은 설정 오류 길이다: PRICE_MISSING(500)이고 설정 오류 로그(amount_out_of_range, 회차) 한 줄, contactRef·쓰기를 부르지 않는다', async () => {
    // SEATS = R·R·S: 2 × 1,000,000,000 + 147,483,648 = int4 + 1
    fx.sale = { saleEndsAtMs: NOW + DAY, tierPrices: { R: 1_000_000_000, S: 147_483_648 } };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'PRICE_MISSING' });
    expect(fx.configErrors).toEqual([{ what: 'amount_out_of_range', eventId: EVENT }]);
    notCalled('contactRefs.compute');
    noOrder();
    // 1원 적으면(= int4) 주문을 만든다
    fx.reset();
    fx.sale = { saleEndsAtMs: NOW + DAY, tierPrices: { R: 1_000_000_000, S: 147_483_647 } };
    expect(await run()).toMatchObject({ status: 201 });
    expect(fx.lastOrder().amount).toBe(2_147_483_647);
  });

  test('FR011_금액은 예매 제한 뒤에 본다: 제한 중이면 가격이 없어도 BOOKING_RESTRICTED이고 설정 오류 로그가 없다', async () => {
    fx.sale = { saleEndsAtMs: NOW + DAY, tierPrices: {} };
    fx.restriction = { st: 'ACTIVE' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'BOOKING_RESTRICTED' });
    expect(fx.configErrors).toEqual([]);
  });
});

describe('같은 홀드의 두 주문(409 hold-already-ordered)', () => {
  test('FR011_쓰기가 HOLD_ALREADY_ORDERED면 그 거절이고 Paying 표시를 부르지 않는다', async () => {
    fx.outcome = { status: 'HOLD_ALREADY_ORDERED' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'HOLD_ALREADY_ORDERED' });
    expect(fx.created).toHaveLength(1);
    notCalled('sessions.markPaying');
  });
});

describe('커밋 뒤 Paying 표시(POL-009)', () => {
  test('POL009_주문을 만든 뒤 구매 세션을 Paying으로 표시한다(쓰기 뒤에 한 번)', async () => {
    await run();
    const i = fx.calls.indexOf('writes.create');
    expect(fx.calls.indexOf('sessions.markPaying')).toBeGreaterThan(i);
    expect(fx.payingCalls).toEqual([PSID]);
  });

  test('POL009_Paying 표시가 false(세션 없음)여도 201은 그대로다', async () => {
    fx.paying = false;
    expect(await run()).toMatchObject({ status: 201, replayed: false });
  });

  test('POL009_Paying 표시가 던져도(좌석 Redis 장애·그 밖의 오류) 주문은 커밋됐으므로 201은 그대로다', async () => {
    fx.paying = new OrderSeatStoreUnavailable(new Error('down'));
    expect(await run()).toMatchObject({ status: 201, replayed: false });
    fx.reset();
    fx.paying = new Error('boom');
    expect(await run()).toMatchObject({ status: 201, replayed: false });
  });

  test('POL009_PT45_커밋된 기록 재생에서 Paying 표시가 던져도 같은 201이다', async () => {
    fx.committed = { status: 'COMMITTED', order: COMMITTED_VIEW };
    fx.paying = new Error('boom');
    expect(await run()).toEqual({ status: 201, order: COMMITTED_VIEW, replayed: true });
  });
});

// ── 리뷰 고침(2026-11-05): M2 정본 목록 밖의 실패는 설정 오류, M3 Paying 표시 다시 부르기·기록, M4 재확인이 답 없음이면 가명 건너뛰기 ──

describe('M2 재확인: 정본 목록 밖의 실패(unexpected)는 대체 판정 없이 503', () => {
  test('PT35_ASVS16.5.3_재확인 실패 까닭이 unexpected(그 밖의 gRPC 코드·gRPC가 아닌 예외)면 토큰에 ticket:buy·pid가 있어도 IDENTITY_MISCONFIGURED이고 설정 오류 로그 한 줄, 대체 판정 지표·로그는 없다 [ASVS v5.0.0-16.5.3]', async () => {
    fx.recheck = { status: 'FAILED', reason: 'unexpected' };
    expect(await run()).toEqual({ status: 'REJECTED', reason: 'IDENTITY_MISCONFIGURED' });
    expect(fx.configErrors).toEqual([{ what: 'identity_misconfigured', reason: 'unexpected' }]);
    expect(fx.fallbackSignals).toEqual([]);
    expect(fx.fallbackLogs).toEqual([]);
    notCalled('restrictions.read', 'contactRefs.compute');
    noOrder();
  });
});

describe('M3 커밋 뒤 Paying 표시의 실패(다시 한 번, 그래도 실패면 경고·지표)', () => {
  const failures: [string, boolean | Error][] = [
    ['false(세션 없음)', false],
    ['좌석 Redis 장애', new OrderSeatStoreUnavailable(new Error('down'))],
    ['그 밖의 오류', new Error('boom')],
  ];

  test.each(failures)('POL009_Paying 표시가 %s면 한 번 더 부르고, 그래도 실패면 경고 한 줄(구매 세션 ID·주문 ID만)과 지표 하나를 남기며 201은 그대로다', async (_label, answer) => {
    fx.paying = answer;
    const r = await run();
    expect(r).toMatchObject({ status: 201, replayed: false });
    expect(fx.payingCalls).toEqual([PSID, PSID]);
    const orderId = fx.lastOrder().id;
    expect(fx.payingFailedLogs).toEqual([{ purchaseSessionId: PSID, orderId }]);
    expect(Object.keys(fx.payingFailedLogs[0]!).sort()).toEqual(['orderId', 'purchaseSessionId']);
    expect(fx.payingFailedSignals).toBe(1);
  });

  test('POL009_첫 표시가 실패하고 다시 부른 표시가 되면 경고·지표가 없다', async () => {
    fx.payingSeq = [new Error('blip'), true];
    expect(await run()).toMatchObject({ status: 201 });
    expect(fx.payingCalls).toEqual([PSID, PSID]);
    expect(fx.payingFailedLogs).toEqual([]);
    expect(fx.payingFailedSignals).toBe(0);
  });

  test('POL009_처음 표시가 되면 한 번만 부른다', async () => {
    await run();
    expect(fx.payingCalls).toEqual([PSID]);
    expect(fx.payingFailedSignals).toBe(0);
  });

  test('POL009_PT45_커밋된 기록 재생에서도 같다: 두 번 실패하면 그 주문 ID로 경고·지표를 남기고 같은 201이다', async () => {
    fx.committed = { status: 'COMMITTED', order: COMMITTED_VIEW };
    fx.paying = false;
    expect(await run()).toEqual({ status: 201, order: COMMITTED_VIEW, replayed: true });
    expect(fx.payingCalls).toEqual([PSID, PSID]);
    expect(fx.payingFailedLogs).toEqual([{ purchaseSessionId: PSID, orderId: COMMITTED_VIEW.orderId }]);
    expect(fx.payingFailedSignals).toBe(1);
  });

  test('POL009_요청의 남은 시간이 다 썼으면 다시 부르지 않고 바로 경고·지표를 남긴다(남은 시간 안에서만 다시)', async () => {
    fx.paying = false;
    // 이 시험만의 시계(공용 시계는 다른 시험이 NOW로 쓴다): 쓰기가 끝날 때 남은 시간을 다 쓴 것으로 만든다
    const own = fakeClock({ now: NOW });
    const deadline = Deadline.after(30, own);
    const writes = {
      ...fx.writes,
      create: async (...a: Parameters<typeof fx.writes.create>) => {
        const r = await fx.writes.create(...a);
        own.advance(30);
        return r;
      },
    };
    expect(await run(okCommand({ deadline }), { writes, clock: own })).toMatchObject({ status: 201 });
    expect(fx.payingCalls).toEqual([PSID]);
    expect(fx.payingFailedSignals).toBe(1);
    expect(fx.payingFailedLogs).toHaveLength(1);
  });
});

describe('M4 재확인이 답하지 않았으면(circuit_open·deadline·unavailable) 가명 호출을 건너뛴다', () => {
  test.each<[FallbackReasonName]>([['circuit_open'], ['deadline'], ['unavailable']])(
    'PT52_ADR0171_재확인 실패가 %s면 ComputeContactRef를 부르지 않고 contactRef 없이 refMissing 참으로 만든다(대체 판정 통과)',
    async (reason) => {
      fx.recheck = { status: 'FAILED', reason };
      expect(await run()).toMatchObject({ status: 201 });
      notCalled('contactRefs.compute');
      expect(fx.contactCalls).toEqual([]);
      const created = fx.lastOrder().created;
      expect(created.refMissing).toBe(true);
      expect(created).not.toHaveProperty('contactRef');
    },
  );

  test.each<[FallbackReasonName]>([['exhausted'], ['internal']])('PT52_재확인 실패가 %s(다시 물은 뒤)면 가명은 그대로 부른다', async (reason) => {
    fx.recheck = { status: 'FAILED', reason };
    expect(await run()).toMatchObject({ status: 201 });
    expect(fx.contactCalls).toHaveLength(1);
    expect(fx.lastOrder().created).toMatchObject({ contactRef: CONTACT_REF, refMissing: false });
  });
});

type FallbackReasonName = (typeof FALLBACK_REASONS)[number];

describe('입력을 바꾸지 않는다', () => {
  test('FR011_쓰임새는 명령·본문을 고치지 않는다', async () => {
    const cmd = okCommand();
    const before = JSON.stringify({ ...cmd, idem: { ...cmd.idem, requestHash: [...cmd.idem.requestHash] } });
    await run(cmd);
    expect(JSON.stringify({ ...cmd, idem: { ...cmd.idem, requestHash: [...cmd.idem.requestHash] } })).toBe(before);
  });
});
