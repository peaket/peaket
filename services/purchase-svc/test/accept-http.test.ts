// 받는 층: 결제 접수 POST /v1/orders/{orderId}/payment-acceptance(openapi createOrderPaymentAcceptance, docs/features/payment.md §2 '결제 접수의 첫 구현', BUILD_ORDER PRF-162).
// orders-http.test.ts(주문 생성)와 같은 꼴: AppModule을 메모리 조립(inventory memory + booking 조립 값)으로 띄워 fastify inject로 부른다.
// 신원은 게이트웨이 내부 머리, 구매 세션 요청 서명은 MemoryPurchaseSessions의 시험 키로 단다. 결제 접수 포트는 test/accept-cases.ts의 메모리 가짜다
// (쓰임새 자체의 검사 차례는 accept-payment.test.ts가 본다. 여기는 HTTP 모양·플랫폼 가드·조립·대응표를 본다).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createService, DEADLINE_HEADER, fakeClock, PROBLEM_TYPE_BASE, ProblemError, purchaseMac, purchaseMacInput, RequestValidationError } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ACCEPT_PROBLEMS, type AcceptPaymentRejection, PaymentAcceptRequest, throwAcceptProblem } from '../src/modules/booking/index.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { AcceptFakes, okAttempt, okOrder, ORDER_ID, PAYMENT_KEY, PAYMENT_TOKEN, PORTONE_PAYMENT_ID, TX_ID } from './accept-cases.js';
import { ACCOUNT, AMOUNT, CONSENT_VERSION, EVENT, IDEM_KEY, JOURNEY, LOGIN, NOW, OrderFakes, PID, PSID } from './order-cases.js';

const KEY = Buffer.alloc(32, 9);
const logLines: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    for (const l of String(c).split('\n')) if (l) logLines.push(l);
    cb();
  },
});
const clock = fakeClock({ now: NOW });
const orders = new OrderFakes(clock);
const fx = new AcceptFakes();
const sessions = new MemoryPurchaseSessions();
sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY, loginSessionId: LOGIN, key: KEY });

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  // 쓰임새의 구매 세션 포트는 결제 접수 가짜(fx.sessions)로 바꿔 끼운다(주문 생성과 같은 sessions 칸을 같이 쓴다)
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      booking: { ...orders.ports(), sessions: fx.sessions, ...fx.bookingPorts(), consentVersion: CONSENT_VERSION, clock },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  fx.reset();
  logLines.length = 0;
});

const pathOf = (orderId: string) => `/v1/orders/${orderId}/payment-acceptance`;
let seq = 0;
interface PostOptions {
  orderId?: string;
  /** null이면 Idempotency-Key를 싣지 않는다 */
  key?: string | null;
  /** null이면 X-Purchase-Mac을 싣지 않는다 */
  mac?: string | null;
  macKey?: Buffer;
  seq?: number;
  scope?: string;
  headers?: Record<string, string>;
}
/** 서명한 결제 접수 요청 */
function post(body: unknown, o: PostOptions = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const url = pathOf(o.orderId ?? ORDER_ID);
  const n = o.seq ?? ++seq;
  const headers: Record<string, string> = {
    'x-user-id': ACCOUNT,
    'x-session-id': LOGIN,
    'x-user-aud': 'fan',
    'x-user-scope': o.scope ?? 'ticket:buy',
    'x-user-pid': PID,
    'content-type': 'application/json',
    'x-purchase-seq': String(n),
  };
  if (o.mac !== null) headers['x-purchase-mac'] = o.mac ?? purchaseMac(o.macKey ?? KEY, purchaseMacInput('POST', url, n, Buffer.from(payload, 'utf8')));
  if (o.key !== null) headers['idempotency-key'] = o.key ?? IDEM_KEY;
  Object.assign(headers, o.headers);
  return svc.http.inject({ method: 'POST', url, headers, payload });
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;
const toss = (over: Record<string, unknown> = {}) => ({ pg: 'TOSS', paymentKey: PAYMENT_KEY, amount: AMOUNT, ...over });
const portone = (over: Record<string, unknown> = {}) => ({ pg: 'PORTONE', paymentId: PORTONE_PAYMENT_ID, paymentToken: PAYMENT_TOKEN, txId: TX_ID, ...over });

/** 결제 참조·토큰이 응답과 서비스 로그 어디에도 없다 */
function noSecrets(r: { payload: string; headers: Record<string, unknown> }) {
  const text = `${r.payload}\n${JSON.stringify(r.headers)}\n${logLines.join('\n')}`;
  for (const s of [PAYMENT_KEY, PAYMENT_TOKEN, TX_ID]) expect(text, s).not.toContain(s);
}

describe('202 접수됨(본문 없음)', () => {
  test('FR011_토스 정상 요청은 202이고 본문이 비었으며 Cache-Control no-store다 [ASVS v5.0.0-14.3.2]', async () => {
    const r = await post(toss());
    expect(r.statusCode).toBe(202);
    expect(r.payload).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(fx.accepted).toHaveLength(1);
    noSecrets(r);
  });

  test('FR011_포트원 정상 요청도 202·본문 없음·no-store다', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    const r = await post(portone());
    expect(r.statusCode).toBe(202);
    expect(r.payload).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(fx.lastInput().refs).toEqual({ pg: 'PORTONE', txId: TX_ID, paymentToken: PAYMENT_TOKEN });
    noSecrets(r);
  });

  test('FR011_시뮬레이터 본문(토스와 같은 모양)도 202다', async () => {
    fx.attempt = okAttempt({ pg: 'SIMULATOR' });
    const r = await post(toss({ pg: 'SIMULATOR' }));
    expect(r.statusCode).toBe(202);
  });

  test('FR011_받는 층이 쓰임새에 넘기는 값: 구매 세션 참조(jti), 멱등 요청(계정 × ACCEPT_PAYMENT × 소문자 키, 지문 32바이트), 경로의 orderId 그대로, 본문, 행위자 account:<계정>', async () => {
    const r = await post(toss(), { key: IDEM_KEY.toUpperCase() });
    expect(r.statusCode).toBe(202);
    expect(fx.sessionGets).toEqual([PSID]);
    const once = fx.committedQueries[0]!;
    expect({ accountRef: once.accountRef, operation: once.operation, key: once.key }).toEqual({ accountRef: ACCOUNT, operation: 'ACCEPT_PAYMENT', key: IDEM_KEY });
    expect(once.requestHash).toHaveLength(32);
    expect(fx.orderReads).toEqual([ORDER_ID]);
    expect(fx.lastInput()).toMatchObject({ orderId: ORDER_ID, refs: { pg: 'TOSS', paymentKey: PAYMENT_KEY }, actor: `account:${ACCOUNT}` });
  });

  test('ST29_⑥_경로의 orderId는 모양을 보지 않고 글 그대로 쓰임새에 넘긴다(대문자 UUID·UUID 아님). 읽기가 비면 404다', async () => {
    for (const id of [ORDER_ID.toUpperCase(), 'not-a-uuid']) {
      fx.reset();
      fx.order = undefined;
      const r = await post(toss(), { orderId: id });
      expect({ id, status: r.statusCode, type: json(r).type }).toEqual({ id, status: 404, type: problem('not-found') });
      for (const read of fx.orderReads) expect(read).toBe(id);
    }
  });

  test('FR011_남은 시간 머리(x-peaket-deadline-ms) 30이면 슬롯 읽기 마감이 30ms다(요청 맥락의 deadline을 넘긴다)', async () => {
    const r = await post(toss(), { headers: { [DEADLINE_HEADER]: '30' } });
    expect(r.statusCode).toBe(202);
    expect(fx.slotReads[0]!.o?.deadlineMs).toBe(30);
  });

  test('PT45_③_커밋된 같은 요청이 있으면 처음 202를 그대로 돌려준다(본문 없음, 쓰기 없음)', async () => {
    fx.committed = { status: 'COMMITTED', orderId: ORDER_ID };
    fx.order = okOrder({ status: 'ACCEPTED' });
    const r = await post(toss());
    expect(r.statusCode).toBe(202);
    expect(r.payload).toBe('');
    expect(fx.accepted).toHaveLength(0);
  });
});

/** 거절 까닭마다 그 거절이 나게 하는 준비(가짜 포트 값 또는 본문) */
const REJECTIONS: Record<AcceptPaymentRejection, { arrange?: () => void; body?: () => unknown; headers?: Record<string, string> }> = {
  SESSION_ENDED: { arrange: () => (fx.session = undefined) },
  IDEM_REUSED: { arrange: () => (fx.committed = { status: 'MISMATCH' }) },
  NOT_FOUND: { arrange: () => (fx.order = undefined) },
  ORDER_EXPIRED: { arrange: () => (fx.order = okOrder({ status: 'EXPIRED' })) },
  ALREADY_ACCEPTED: { arrange: () => (fx.order = okOrder({ status: 'ACCEPTED' })) },
  ATTEMPT_MISMATCH: { arrange: () => (fx.attempt = undefined) },
  AMOUNT_MISMATCH: { body: () => toss({ amount: AMOUNT + 1 }) },
  SALE_PAUSED: { arrange: () => (fx.slot = { status: 'PAUSED' }) },
  SEAT_STORE_UNAVAILABLE: { arrange: () => (fx.slot = { status: 'NOT_READY' }) },
  // 남은 시간 4ms(5ms [가정] 미만)면 좌석 Redis를 부르지 않는다(리뷰 고침 L4)
  DEADLINE_EXCEEDED: { headers: { [DEADLINE_HEADER]: '4' } },
};

/** openapi x-peaket-problem-types(이름 → status·title)를 계약 파일에서 읽는다 */
function contractProblemTypes(): Map<string, { status: number; title: string }> {
  const yaml = readFileSync(fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url)), 'utf8');
  const out = new Map<string, { status: number; title: string }>();
  for (const m of yaml.matchAll(/^ {4}([a-z0-9-]+): \{ status: (\d+), title: "([^"]*)"/gm)) out.set(m[1]!, { status: Number(m[2]), title: m[3]! });
  return out;
}

describe('거절 → 문제 상세(ACCEPT_PROBLEMS 전부)', () => {
  test('FR011_대응표는 거절 까닭 열 모두를 덮고, 이름 있는 줄의 status·title은 계약 x-peaket-problem-types와 같다', () => {
    expect(Object.keys(ACCEPT_PROBLEMS).sort()).toEqual(Object.keys(REJECTIONS).sort());
    const contract = contractProblemTypes();
    for (const [reason, spec] of Object.entries(ACCEPT_PROBLEMS)) {
      if (spec.type === 'about:blank') continue;
      expect({ reason, got: { status: spec.status, title: spec.title } }).toEqual({ reason, got: contract.get(spec.type) });
    }
  });

  test('FR011_대응표의 상태 코드·이름은 openapi 결제 접수 응답 설명대로다(503은 Retry-After 2초, 두 탭 경합만 정상 분기)', () => {
    const want: Record<AcceptPaymentRejection, [number, string]> = {
      SESSION_ENDED: [401, 'purchase-session-ended'],
      IDEM_REUSED: [422, 'idempotency-key-reused'],
      NOT_FOUND: [404, 'not-found'],
      ORDER_EXPIRED: [409, 'order-expired'],
      ALREADY_ACCEPTED: [409, 'payment-already-accepted'],
      ATTEMPT_MISMATCH: [409, 'payment-attempt-mismatch'],
      AMOUNT_MISMATCH: [400, 'about:blank'],
      SALE_PAUSED: [423, 'sale-paused'],
      SEAT_STORE_UNAVAILABLE: [503, 'seat-store-unavailable'],
      DEADLINE_EXCEEDED: [504, 'deadline-exceeded'],
    };
    for (const [reason, [status, type]] of Object.entries(want)) {
      const spec = ACCEPT_PROBLEMS[reason as AcceptPaymentRejection];
      expect({ reason, status: spec.status, type: spec.type }).toEqual({ reason, status, type });
    }
    expect(ACCEPT_PROBLEMS.SEAT_STORE_UNAVAILABLE.retryAfterSeconds).toBe(2);
    expect(ACCEPT_PROBLEMS.ALREADY_ACCEPTED.normalBranch).toBe(true);
    // 보안 사건(시도 대조 실패)은 정상 분기로 세지 않는다
    expect(ACCEPT_PROBLEMS.ATTEMPT_MISMATCH.normalBranch).toBeUndefined();
    for (const r of Object.keys(want) as AcceptPaymentRejection[]) if (r !== 'SEAT_STORE_UNAVAILABLE') expect(ACCEPT_PROBLEMS[r].retryAfterSeconds, r).toBeUndefined();
  });

  test.each(Object.keys(REJECTIONS) as AcceptPaymentRejection[])(
    'PT7_PT23_PT28_PT45_%s → 대응표의 상태 코드·문제 상세(type·title)·Retry-After, application/problem+json, Cache-Control no-store이고 접수가 없다',
    async (reason) => {
      const spec = ACCEPT_PROBLEMS[reason];
      const setup = REJECTIONS[reason];
      setup.arrange?.();
      const r = await post(setup.body ? setup.body() : toss(), setup.headers ? { headers: setup.headers } : {});
      expect(r.statusCode).toBe(spec.status);
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(r.headers['cache-control']).toBe('no-store');
      if (spec.type === 'about:blank') {
        expect(json(r)).toMatchObject({ type: 'about:blank', status: spec.status });
      } else {
        expect(json(r)).toMatchObject({ type: problem(spec.type), status: spec.status, title: spec.title });
      }
      expect(r.headers['retry-after']).toBe(spec.retryAfterSeconds === undefined ? undefined : String(spec.retryAfterSeconds));
      expect(fx.accepted).toHaveLength(0);
      noSecrets(r);
    },
  );

  test('FR011_구매 세션이 끝났으면 401 purchase-session-ended와 WWW-Authenticate: Cookie realm="peaket"이다', async () => {
    fx.session = undefined;
    const r = await post(toss());
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    expect(json(r)).toMatchObject({ type: problem('purchase-session-ended'), status: 401, title: '예매 시간이 끝났습니다' });
  });

  test('PT7_금액 400은 받은 금액·주문 금액을 싣지 않는다(detail 없음) [ASVS v5.0.0-16.2.5]', async () => {
    const r = await post(toss({ amount: 987_654_321 }));
    expect(r.statusCode).toBe(400);
    expect(json(r).detail).toBeUndefined();
    expect(r.payload).not.toContain('987654321');
    expect(r.payload).not.toContain(String(AMOUNT));
  });

  test('PT28_결제사가 다르면 409 payment-attempt-mismatch이고 보안 로그 한 줄(계정·주문·까닭)을 acceptLog에 남긴다 [ASVS v5.0.0-16.3.2]', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    const r = await post(toss());
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: problem('payment-attempt-mismatch'), status: 409 });
    expect(fx.mismatchLogs).toEqual([{ accountId: ACCOUNT, orderId: ORDER_ID, reason: 'pg_mismatch' }]);
    noSecrets(r);
  });

  test('PT28_포트원 paymentId가 다르면 409 payment-attempt-mismatch다', async () => {
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    const r = await post(portone({ paymentId: 'pay-other' }));
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: problem('payment-attempt-mismatch') });
    expect(fx.mismatchLogs.map((l) => l.reason)).toEqual(['payment_id_mismatch']);
  });

  test('PT23_②_다른 탭이 먼저 접수했으면(트랜잭션 T3가 0행, ORDER_STATE ACCEPTED) 409 payment-already-accepted다', async () => {
    fx.outcome = { status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' };
    const r = await post(toss());
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: problem('payment-already-accepted'), status: 409 });
  });

  test('PT28_트랜잭션 안에서 시도가 대체됐으면(ATTEMPT_GONE SUPERSEDED) 409 payment-attempt-mismatch이고 보안 로그(no_attempt) 한 줄이다(리뷰 고침 M2)', async () => {
    fx.outcome = { status: 'STALE', reason: 'ATTEMPT_GONE', current: 'SUPERSEDED' };
    const r = await post(toss());
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: problem('payment-attempt-mismatch'), status: 409 });
    expect(fx.mismatchLogs).toEqual([{ accountId: ACCOUNT, orderId: ORDER_ID, reason: 'no_attempt' }]);
  });

  test('PT45_③_트랜잭션이 던진 409 idempotency-request-in-progress는 그대로 나간다(Retry-After 1)', async () => {
    fx.outcome = new ProblemError({ type: 'idempotency-request-in-progress', status: 409, title: '같은 요청을 아직 처리하고 있습니다', retryAfterSeconds: 1, normalBranch: true });
    const r = await post(toss());
    expect(r.statusCode).toBe(409);
    expect(r.headers['retry-after']).toBe('1');
    expect(json(r)).toMatchObject({ type: problem('idempotency-request-in-progress'), status: 409 });
  });

  test('FR011_트랜잭션의 DB 오류는 500 about:blank이고 오류 글을 응답에 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    fx.outcome = new Error('DBSECRET connection terminated');
    const r = await post(toss());
    expect(r.statusCode).toBe(500);
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 500 });
    expect(r.payload).not.toContain('DBSECRET');
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('throwAcceptProblem(거절 → 오류)', () => {
  const reply = () => {
    const headers: Record<string, string> = {};
    return { headers, header: (n: string, v: string) => (headers[n.toLowerCase()] = v) };
  };

  test('FR011_이름 있는 거절은 대응표의 ProblemError를 던지고, SESSION_ENDED만 WWW-Authenticate를 단다', () => {
    for (const reason of Object.keys(ACCEPT_PROBLEMS) as AcceptPaymentRejection[]) {
      const spec = ACCEPT_PROBLEMS[reason];
      if (spec.type === 'about:blank') continue;
      const rep = reply();
      let err: unknown;
      try {
        throwAcceptProblem(reason, rep);
      } catch (e) {
        err = e;
      }
      expect({ reason, isProblem: err instanceof ProblemError }).toEqual({ reason, isProblem: true });
      expect((err as ProblemError).status, reason).toBe(spec.status);
      expect(rep.headers['www-authenticate'], reason).toBe(reason === 'SESSION_ENDED' ? 'Cookie realm="peaket"' : undefined);
    }
  });

  test('PT7_AMOUNT_MISMATCH는 문제 이름 없는 400(플랫폼 RequestValidationError)이고 머리를 달지 않는다', () => {
    const rep = reply();
    let err: unknown;
    try {
      throwAcceptProblem('AMOUNT_MISMATCH', rep);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RequestValidationError);
    expect(rep.headers).toEqual({});
  });
});

describe('플랫폼 가드와 본문 모양(쓰임새에 닿기 전)', () => {
  test('PT45_⑦_Idempotency-Key가 없거나 UUID v4가 아니거나 따옴표로 감쌌으면 400 idempotency-key-invalid이고 쓰임새를 부르지 않는다', async () => {
    for (const key of [null, 'not-a-uuid', `"${IDEM_KEY}"`]) {
      fx.reset();
      const r = await post(toss(), { key });
      expect({ key, status: r.statusCode, type: json(r).type }).toEqual({ key, status: 400, type: problem('idempotency-key-invalid') });
      expect(r.headers['cache-control']).toBe('no-store');
      expect(fx.calls).toEqual([]);
    }
  });

  test('FR011_구매 세션 요청 서명 머리가 없거나 키가 틀리면 401 purchase-signature-invalid(WWW-Authenticate)이고 쓰임새를 부르지 않는다', async () => {
    for (const o of [{ mac: null }, { macKey: Buffer.alloc(32, 1) }] as PostOptions[]) {
      fx.reset();
      const r = await post(toss(), o);
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(json(r)).toMatchObject({ type: problem('purchase-signature-invalid'), status: 401 });
      expect(fx.calls).toEqual([]);
    }
  });

  test('FR011_서명은 경로까지 덮는다: 다른 주문 경로로 만든 서명이면 401이고 쓰임새를 부르지 않는다', async () => {
    const n = ++seq;
    const body = JSON.stringify(toss());
    const mac = purchaseMac(KEY, purchaseMacInput('POST', pathOf('0190f3a1-7c2e-7f00-8000-0000000000ff'), n, Buffer.from(body, 'utf8')));
    const r = await post(body, { seq: n, mac });
    expect(r.statusCode).toBe(401);
    expect(fx.calls).toEqual([]);
  });

  test('FR011_ticket:buy 스코프가 없으면 403이고 쓰임새를 부르지 않는다', async () => {
    const r = await post(toss(), { scope: 'ticket:read' });
    expect(r.statusCode).toBe(403);
    expect(fx.calls).toEqual([]);
  });

  test('PT28_허용 밖 칸은 400(about:blank)이고 쓰임새를 부르지 않는다: 토스에 orderId·포트원 칸, 포트원에 amount·paymentKey [ASVS v5.0.0-15.3.3]', async () => {
    const bodies: unknown[] = [
      toss({ orderId: ORDER_ID }),
      toss({ paymentId: PORTONE_PAYMENT_ID }),
      toss({ pg: 'SIMULATOR', txId: TX_ID }),
      portone({ amount: AMOUNT }),
      portone({ paymentKey: PAYMENT_KEY }),
      portone({ orderId: ORDER_ID }),
    ];
    for (const body of bodies) {
      fx.reset();
      const r = await post(body);
      expect({ body, status: r.statusCode, type: json(r).type }).toEqual({ body, status: 400, type: 'about:blank' });
      expect(fx.calls).toEqual([]);
    }
  });

  test('PT28_pg가 모르는 값이거나 없으면 400이고 쓰임새를 부르지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const { pg: _pg, ...noPg } = toss();
    for (const body of [toss({ pg: 'KAKAO' }), toss({ pg: 'toss' }), portone({ pg: 'PORTONE_V1' }), noPg]) {
      fx.reset();
      const r = await post(body);
      expect({ body, status: r.statusCode, type: json(r).type }).toEqual({ body, status: 400, type: 'about:blank' });
      expect(fx.calls).toEqual([]);
    }
  });

  test('갈래의 필수 칸이 없거나 형이 틀리면 400이다: 토스 paymentKey·amount 없음, amount 글·소수, 포트원 paymentToken·txId·paymentId 없음, JSON 아님 [ASVS v5.0.0-2.2.1]', async () => {
    const { paymentKey: _k, ...noKey } = toss();
    const { amount: _a, ...noAmount } = toss();
    const { paymentToken: _t, ...noToken } = portone();
    const { txId: _x, ...noTx } = portone();
    const { paymentId: _i, ...noId } = portone();
    const bodies: unknown[] = [noKey, noAmount, toss({ amount: String(AMOUNT) }), toss({ amount: AMOUNT + 0.5 }), noToken, noTx, noId, 'not json'];
    for (const body of bodies) {
      fx.reset();
      const r = await post(body);
      expect({ body, status: r.statusCode }).toEqual({ body, status: 400 });
      expect(fx.calls).toEqual([]);
    }
  });

  // 리뷰 고침 M1(2026-11-05): 결제 참조 칸(paymentKey·paymentId·paymentToken·txId)은 1~200자 [가정]의 보이는 ASCII(0x21~0x7E)만 받는다.
  // 틀리면 받는 층에서 400(about:blank)이고 쓰임새·어댑터까지 가지 않는다(어댑터의 RangeError 500이 되지 않게). 받은 값은 응답·로그에 싣지 않는다
  const BAD_REFS: [string, string][] = [
    ['빈 글', ''],
    ['201자', 'k'.repeat(201)],
    ['공백', 'tgen key'],
    ['제어 문자', 'tgen\u0001key'],
    ['줄바꿈', 'tgen\nkey'],
    ['한글', 'tgen_결제키'],
    ['DEL(0x7F)', 'tgen\u007fkey'],
  ];
  const REF_FIELDS: [string, (v: string) => unknown][] = [
    ['토스 paymentKey', (v) => toss({ paymentKey: v })],
    ['시뮬레이터 paymentKey', (v) => toss({ pg: 'SIMULATOR', paymentKey: v })],
    ['포트원 paymentId', (v) => portone({ paymentId: v })],
    ['포트원 paymentToken', (v) => portone({ paymentToken: v })],
    ['포트원 txId', (v) => portone({ txId: v })],
  ];

  test.each(REF_FIELDS)('%s가 1~200자의 보이는 ASCII가 아니면 400(about:blank)이고 쓰임새를 부르지 않으며 받은 값을 응답에 싣지 않는다 [ASVS v5.0.0-2.2.1]', async (_field, bodyOf) => {
    for (const [label, value] of BAD_REFS) {
      fx.reset();
      fx.attempt = okAttempt({ pg: 'PORTONE' });
      const r = await post(bodyOf(value));
      expect({ label, status: r.statusCode, type: json(r).type }).toEqual({ label, status: 400, type: 'about:blank' });
      expect(fx.calls, label).toEqual([]);
      if (value.length > 3) expect(r.payload, label).not.toContain(value);
    }
  });

  test('[ASVS v5.0.0-2.2.1]_결제 참조 칸의 경계: 200자의 보이는 ASCII(! ~ ~ 포함)는 받는 층을 지난다', async () => {
    const edge = `!~${'k'.repeat(198)}`;
    fx.attempt = okAttempt({ pg: 'TOSS' });
    expect((await post(toss({ paymentKey: edge }))).statusCode).toBe(202);
    fx.reset();
    fx.attempt = okAttempt({ pg: 'PORTONE' });
    expect((await post(portone({ paymentToken: edge, txId: edge }))).statusCode).toBe(202);
    expect(fx.lastInput().refs).toEqual({ pg: 'PORTONE', txId: edge, paymentToken: edge });
  });

  test('FR011_PaymentAcceptRequest(본문 Zod 모양)도 같은 규칙이다: 갈래마다 닫혀 있고 pg는 TOSS·SIMULATOR·PORTONE뿐이다', () => {
    expect(PaymentAcceptRequest.safeParse(toss()).success).toBe(true);
    expect(PaymentAcceptRequest.safeParse(toss({ pg: 'SIMULATOR' })).success).toBe(true);
    expect(PaymentAcceptRequest.safeParse(portone()).success).toBe(true);
    expect(PaymentAcceptRequest.safeParse(toss({ orderId: ORDER_ID })).success).toBe(false);
    expect(PaymentAcceptRequest.safeParse(portone({ amount: AMOUNT })).success).toBe(false);
    expect(PaymentAcceptRequest.safeParse(toss({ pg: 'KAKAO' })).success).toBe(false);
  });
});
