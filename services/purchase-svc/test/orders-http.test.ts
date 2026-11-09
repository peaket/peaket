// 받는 층: 주문 생성 POST /v1/orders(openapi createOrder, docs/features/payment.md §2 '주문 생성의 첫 구현', BUILD_ORDER PRF-161).
// http.test.ts(좌석 홀드)와 같은 꼴: AppModule을 메모리 조립(inventory memory + booking 조립 값)으로 띄워 fastify inject로 부른다.
// 신원은 게이트웨이 내부 머리, 구매 세션 요청 서명은 MemoryPurchaseSessions의 시험 키로 단다. booking 포트는 test/order-cases.ts의 메모리 가짜다
// (쓰임새 자체의 검사 차례는 create-order.test.ts가 본다. 여기는 HTTP 모양·플랫폼 가드·조립을 본다).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createService, DEADLINE_HEADER, fakeClock, PROBLEM_TYPE_BASE, ProblemError, purchaseMac, purchaseMacInput } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { type CreateOrderRejection, ORDER_PROBLEMS, orderResponseOf } from '../src/modules/booking/index.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { AcceptFakes } from './accept-cases.js';
import {
  ACCOUNT,
  AMOUNT,
  COMMITTED_VIEW,
  CONSENT_VERSION,
  DAY,
  EVENT,
  HOLD_ID,
  IDEM_KEY,
  JOURNEY,
  LOGIN,
  NOW,
  okBody,
  OrderFakes,
  PID,
  PSID,
  TIER_PRICES,
} from './order-cases.js';

const KEY = Buffer.alloc(32, 9);
const logLines: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    for (const l of String(c).split('\n')) if (l) logLines.push(l);
    cb();
  },
});
const clock = fakeClock({ now: NOW });
const fx = new OrderFakes(clock);
const sessions = new MemoryPurchaseSessions();
sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY, loginSessionId: LOGIN, key: KEY });

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  // 뼈대 단계에서는 BookingModule.register가 '미구현'을 던져 여기서 멈춘다(이 파일의 시험이 모두 그 까닭으로 실패한다)
  svc = await createService({
    name: 'purchase-svc',
    // 결제 접수 칸(accepts·slots, PRF-162)은 결제 접수 가짜로 채운다(이 파일은 주문 생성만 본다. 결제 접수는 accept-http.test.ts)
    module: AppModule.register({ memory: true, sessions, booking: { ...fx.ports(), ...new AcceptFakes().bookingPorts(), consentVersion: CONSENT_VERSION, clock } }),
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
});

const URL_PATH = '/v1/orders';
let seq = 0;
interface PostOptions {
  /** null이면 Idempotency-Key를 싣지 않는다 */
  key?: string | null;
  /** null이면 X-Purchase-Mac을 싣지 않는다 */
  mac?: string | null;
  macKey?: Buffer;
  seq?: number;
  /** null이면 x-user-pid를 싣지 않는다 */
  pid?: string | null;
  scope?: string;
  headers?: Record<string, string>;
}
/** 서명한 주문 생성 요청 */
function post(body: unknown, o: PostOptions = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const n = o.seq ?? ++seq;
  const headers: Record<string, string> = {
    'x-user-id': ACCOUNT,
    'x-session-id': LOGIN,
    'x-user-aud': 'fan',
    'x-user-scope': o.scope ?? 'ticket:buy',
    'content-type': 'application/json',
    'x-purchase-seq': String(n),
  };
  if (o.pid !== null) headers['x-user-pid'] = o.pid ?? PID;
  if (o.mac !== null) headers['x-purchase-mac'] = o.mac ?? purchaseMac(o.macKey ?? KEY, purchaseMacInput('POST', URL_PATH, n, Buffer.from(payload, 'utf8')));
  if (o.key !== null) headers['idempotency-key'] = o.key ?? IDEM_KEY;
  Object.assign(headers, o.headers);
  return svc.http.inject({ method: 'POST', url: URL_PATH, headers, payload });
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;

/** 201 본문의 항목(unitPrice는 price로) */
const priced = (items: readonly { seatId: string; tierId: string; sectionId: string; unitPrice: number }[]) =>
  items.map((i) => ({ seatId: i.seatId, tierId: i.tierId, sectionId: i.sectionId, price: i.unitPrice }));

describe('201 Order', () => {
  test('FR011_201 본문은 Order 모양(orderId·amount·status CREATED·items의 seatId·tierId·sectionId·price)이고 그 밖의 칸이 없으며 Cache-Control no-store다', async () => {
    const r = await post(okBody());
    expect(r.statusCode).toBe(201);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers['cache-control']).toBe('no-store');
    const o = fx.lastOrder();
    expect(json(r)).toEqual({ orderId: o.id, amount: AMOUNT, status: 'CREATED', items: priced(o.items) });
    // 예매자 번호·성명·멱등 키 같은 저장 칸은 응답에 싣지 않는다
    expect(r.payload).not.toMatch(/buyer|phone|idempotency|holdId|contactRef|journey/i);
  });

  test('FR011_받는 층이 쓰임새에 넘기는 값: 신원의 계정·로그인 세션, 구매 세션 참조(jti), 멱등 요청(계정 × CREATE_ORDER × 소문자 키, 지문 32바이트), 본문', async () => {
    const r = await post(okBody(), { key: IDEM_KEY.toUpperCase() });
    expect(r.statusCode).toBe(201);
    expect(fx.sessionGets).toEqual([PSID]);
    const once = fx.committedQueries[0]!;
    expect({ accountRef: once.accountRef, operation: once.operation, key: once.key }).toEqual({ accountRef: ACCOUNT, operation: 'CREATE_ORDER', key: IDEM_KEY });
    expect(once.requestHash).toHaveLength(32);
    expect(fx.recheckQueries).toEqual([{ accountId: ACCOUNT, sessionId: LOGIN, deadlineMs: 150 }]);
    expect(fx.holdQueries).toEqual([{ eventId: EVENT, purchaseSessionId: PSID, accountId: ACCOUNT, holdId: HOLD_ID }]);
    expect(fx.lastOrder()).toMatchObject({ idempotencyKey: IDEM_KEY, buyerName: '홍길동', buyerPhone: '+821012345678', holdId: HOLD_ID, purchaseSessionId: PSID });
  });

  test('PT35_토큰 판정 값은 게이트웨이 머리의 pid(x-user-pid)와 스코프다: 재확인이 답하지 않을 때 pid가 있으면 201, 없으면 403 identity-verification-required', async () => {
    fx.recheck = { status: 'FAILED', reason: 'deadline' };
    expect((await post(okBody())).statusCode).toBe(201);
    fx.reset();
    fx.recheck = { status: 'FAILED', reason: 'deadline' };
    const r = await post(okBody(), { pid: null });
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: problem('identity-verification-required'), status: 403 });
  });

  test('FR011_남은 시간 머리(x-peaket-deadline-ms) 100이면 재확인 데드라인 100ms, contactRef 50ms다(요청 맥락의 deadline을 넘긴다)', async () => {
    const r = await post(okBody(), { headers: { [DEADLINE_HEADER]: '100' } });
    expect(r.statusCode).toBe(201);
    expect(fx.recheckQueries[0]!.deadlineMs).toBe(100);
    expect(fx.contactCalls[0]!.deadlineMs).toBe(50);
  });

  test('PT45_①_커밋된 같은 요청이 있으면 처음 주문을 그대로 201로 돌려준다', async () => {
    fx.committed = { status: 'COMMITTED', order: COMMITTED_VIEW };
    const r = await post(okBody());
    expect(r.statusCode).toBe(201);
    expect(json(r)).toEqual({ orderId: COMMITTED_VIEW.orderId, amount: COMMITTED_VIEW.amount, status: 'CREATED', items: priced(COMMITTED_VIEW.items) });
    expect(fx.created).toHaveLength(0);
  });

  test('FR011_orderResponseOf: 주문 모습을 응답 본문으로(items의 unitPrice → price)', () => {
    expect(orderResponseOf(COMMITTED_VIEW)).toEqual({
      orderId: COMMITTED_VIEW.orderId,
      amount: COMMITTED_VIEW.amount,
      status: 'CREATED',
      items: priced(COMMITTED_VIEW.items),
    });
  });
});

/** 거절 까닭마다 그 거절이 나게 하는 준비(가짜 포트 값 또는 본문) */
const REJECTIONS: Record<CreateOrderRejection, { arrange?: () => void; body?: () => unknown; headers?: Record<string, string> }> = {
  SESSION_NOT_FOUND: { arrange: () => (fx.session = undefined) },
  IDEM_REUSED: { arrange: () => (fx.committed = { status: 'MISMATCH' }) },
  HOLD_NOT_FOUND: { arrange: () => (fx.hold = { status: 'NOT_FOUND' }) },
  SALE_ENDED: {
    arrange: () => {
      fx.sale = { saleEndsAtMs: NOW - 1, tierPrices: TIER_PRICES };
      fx.hold = { status: 'NOT_FOUND' };
    },
  },
  SEAT_STORE_UNAVAILABLE: { arrange: () => (fx.hold = { status: 'STORE_UNAVAILABLE' }) },
  CONSENT_REQUIRED: { body: () => okBody({ consents: undefined }) },
  CONSENT_VERSION_OUTDATED: { body: () => okBody({ consents: { provisionToSeller: true, salesTerms: true, consentVersion: 'v2' } }) },
  BUYER_INVALID: { body: () => okBody({ buyer: { name: '홍길동', phone: 'SECRETPHONE-1234' } }) },
  IDENTITY_DENIED: { arrange: () => (fx.recheck = { status: 'DENIED' }) },
  IDENTITY_MISCONFIGURED: { arrange: () => (fx.recheck = { status: 'FAILED', reason: 'permission_denied' }) },
  BOOKING_RESTRICTED: { arrange: () => (fx.restriction = { st: 'ACTIVE' }) },
  PRICE_MISSING: {
    arrange: () => {
      fx.sale = { saleEndsAtMs: NOW + DAY, tierPrices: {} };
      fx.hold = { status: 'OK', heldAtMs: NOW - 1, seats: [{ seatId: 'A01', tierId: 'TIERSECRET-9', sectionId: 'SEC-A' }] };
    },
  },
  HOLD_ALREADY_ORDERED: { arrange: () => (fx.outcome = { status: 'HOLD_ALREADY_ORDERED' }) },
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

describe('거절 → 문제 상세(ORDER_PROBLEMS 전부)', () => {
  test('FR011_대응표는 거절 까닭 열셋 모두를 덮고, 이름 있는 줄의 status·title은 계약 x-peaket-problem-types와 같다', () => {
    expect(Object.keys(ORDER_PROBLEMS).sort()).toEqual(Object.keys(REJECTIONS).sort());
    const contract = contractProblemTypes();
    for (const [reason, spec] of Object.entries(ORDER_PROBLEMS)) {
      if (spec.type === 'about:blank') continue;
      expect({ reason, got: { status: spec.status, title: spec.title } }).toEqual({ reason, got: contract.get(spec.type) });
    }
  });

  test('FR011_대응표의 상태 코드·이름은 openapi POST /v1/orders 응답 설명대로다(503 둘은 Retry-After 2초, 409는 정상 분기)', () => {
    const want: Record<CreateOrderRejection, [number, string]> = {
      SESSION_NOT_FOUND: [401, 'purchase-session-ended'],
      IDEM_REUSED: [422, 'idempotency-key-reused'],
      HOLD_NOT_FOUND: [404, 'not-found'],
      SALE_ENDED: [410, 'sale-ended'],
      SEAT_STORE_UNAVAILABLE: [503, 'seat-store-unavailable'],
      CONSENT_REQUIRED: [422, 'consent-required'],
      CONSENT_VERSION_OUTDATED: [422, 'consent-version-outdated'],
      BUYER_INVALID: [400, 'about:blank'],
      IDENTITY_DENIED: [403, 'identity-verification-required'],
      IDENTITY_MISCONFIGURED: [503, 'dependency-unavailable'],
      BOOKING_RESTRICTED: [403, 'booking-restricted'],
      PRICE_MISSING: [500, 'about:blank'],
      HOLD_ALREADY_ORDERED: [409, 'hold-already-ordered'],
      DEADLINE_EXCEEDED: [504, 'deadline-exceeded'],
    };
    for (const [reason, [status, type]] of Object.entries(want)) expect({ reason, status: ORDER_PROBLEMS[reason as CreateOrderRejection].status, type: ORDER_PROBLEMS[reason as CreateOrderRejection].type }).toEqual({ reason, status, type });
    expect(ORDER_PROBLEMS.SEAT_STORE_UNAVAILABLE.retryAfterSeconds).toBe(2);
    expect(ORDER_PROBLEMS.IDENTITY_MISCONFIGURED.retryAfterSeconds).toBe(2);
    expect(ORDER_PROBLEMS.HOLD_ALREADY_ORDERED.normalBranch).toBe(true);
  });

  test.each(Object.keys(REJECTIONS) as CreateOrderRejection[])(
    'PT37_PT45_PT49_PT35_%s → 대응표의 상태 코드·문제 상세(type·title)·Retry-After, application/problem+json, Cache-Control no-store이고 주문이 없다',
    async (reason) => {
      const spec = ORDER_PROBLEMS[reason];
      const setup = REJECTIONS[reason];
      setup.arrange?.();
      const r = await post(setup.body ? setup.body() : okBody(), setup.headers ? { headers: setup.headers } : {});
      expect(r.statusCode).toBe(spec.status);
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(r.headers['cache-control']).toBe('no-store');
      if (spec.type === 'about:blank') {
        expect(json(r)).toMatchObject({ type: 'about:blank', status: spec.status });
      } else {
        expect(json(r)).toMatchObject({ type: problem(spec.type), status: spec.status, title: spec.title });
      }
      expect(r.headers['retry-after']).toBe(spec.retryAfterSeconds === undefined ? undefined : String(spec.retryAfterSeconds));
      if (reason !== 'HOLD_ALREADY_ORDERED') expect(fx.created).toHaveLength(0);
      expect(fx.payingCalls).toEqual([]);
    },
  );

  test('FR011_구매 세션이 끝났으면(쓰임새의 세션 읽기가 비면) 401 purchase-session-ended와 WWW-Authenticate: Cookie realm="peaket"이다', async () => {
    fx.session = undefined;
    const r = await post(okBody());
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    expect(json(r)).toMatchObject({ type: problem('purchase-session-ended'), status: 401, title: '예매 시간이 끝났습니다' });
  });

  test('FR011_예매자 400은 어느 칸이 틀렸는지·받은 번호를 싣지 않는다(detail 없음) [ASVS v5.0.0-16.2.5]', async () => {
    const r = await post(REJECTIONS.BUYER_INVALID.body!());
    expect(r.statusCode).toBe(400);
    expect(r.payload).not.toContain('SECRETPHONE');
    expect(json(r).detail).toBeUndefined();
  });

  test('FR011_예매자 성명·번호에 제어 문자(C0·C1)가 있으면 400(about:blank)이고 주문이 없다 [ASVS v5.0.0-2.2.1]', async () => {
    for (const buyer of [{ name: '홍\u0000길동', phone: '010-1234-5678' }, { name: '홍길동\u0085', phone: '010-1234-5678' }, { name: '홍길동', phone: '010-1234-5678\n' }]) {
      fx.reset();
      const r = await post(okBody({ buyer }));
      expect({ buyer, status: r.statusCode, type: json(r).type }).toEqual({ buyer, status: 400, type: 'about:blank' });
      expect(fx.created).toHaveLength(0);
    }
  });

  test('FR011_가격 없는 등급의 500은 등급 ID를 응답에 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    REJECTIONS.PRICE_MISSING.arrange!();
    const r = await post(okBody());
    expect(r.statusCode).toBe(500);
    expect(r.payload).not.toContain('TIERSECRET');
  });

  test('PT35_재확인 실패가 정본 목록 밖(unexpected: UNIMPLEMENTED·UNAUTHENTICATED 등, gRPC가 아닌 예외)이면 토큰이 있어도 503 dependency-unavailable(Retry-After 2)이다 [ASVS v5.0.0-16.5.3]', async () => {
    fx.recheck = { status: 'FAILED', reason: 'unexpected' };
    const r = await post(okBody());
    expect(r.statusCode).toBe(503);
    expect(json(r)).toMatchObject({ type: problem('dependency-unavailable'), status: 503 });
    expect(r.headers['retry-after']).toBe('2');
    expect(fx.created).toHaveLength(0);
    expect(fx.configErrors).toEqual([{ what: 'identity_misconfigured', reason: 'unexpected' }]);
  });

  test('PT45_③_쓰기가 던진 409 idempotency-request-in-progress는 그대로 나간다(Retry-After 1)', async () => {
    fx.outcome = new ProblemError({ type: 'idempotency-request-in-progress', status: 409, title: '같은 요청을 아직 처리하고 있습니다', retryAfterSeconds: 1, normalBranch: true });
    const r = await post(okBody());
    expect(r.statusCode).toBe(409);
    expect(r.headers['retry-after']).toBe('1');
    expect(json(r)).toMatchObject({ type: problem('idempotency-request-in-progress'), status: 409 });
  });

  test('FR011_쓰기의 DB 오류는 500 about:blank이고 오류 글을 응답에 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    fx.outcome = new Error('DBSECRET connection terminated');
    const r = await post(okBody());
    expect(r.statusCode).toBe(500);
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 500 });
    expect(r.payload).not.toContain('DBSECRET');
  });
});

describe('플랫폼 가드(쓰임새에 닿기 전)', () => {
  test('PT45_⑦_Idempotency-Key가 없거나 UUID v4가 아니거나 따옴표로 감쌌으면 400 idempotency-key-invalid이고 쓰임새를 부르지 않는다', async () => {
    for (const key of [null, 'not-a-uuid', `"${IDEM_KEY}"`]) {
      fx.reset();
      const r = await post(okBody(), { key });
      expect({ key, status: r.statusCode, type: json(r).type }).toEqual({ key, status: 400, type: problem('idempotency-key-invalid') });
      expect(r.headers['cache-control']).toBe('no-store');
      expect(fx.calls).toEqual([]);
    }
  });

  test('FR011_구매 세션 요청 서명 머리가 없거나 키가 틀리면 401 purchase-signature-invalid(WWW-Authenticate)이고 쓰임새를 부르지 않는다', async () => {
    for (const o of [{ mac: null }, { macKey: Buffer.alloc(32, 1) }] as PostOptions[]) {
      fx.reset();
      const r = await post(okBody(), o);
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(json(r)).toMatchObject({ type: problem('purchase-signature-invalid'), status: 401 });
      expect(fx.calls).toEqual([]);
    }
  });

  test('FR011_같은 일련번호를 다시 보내면 401 purchase-seq-reused이고 쓰임새를 한 번만 불렀다', async () => {
    const n = ++seq;
    expect((await post(okBody(), { seq: n })).statusCode).toBe(201);
    const again = await post(okBody(), { seq: n });
    expect(again.statusCode).toBe(401);
    expect(json(again)).toMatchObject({ type: problem('purchase-seq-reused') });
    expect(fx.sessionGets).toEqual([PSID]);
  });

  test('FR011_ticket:buy 스코프가 없으면 403이고 쓰임새를 부르지 않는다', async () => {
    const r = await post(okBody(), { scope: 'ticket:read' });
    expect(r.statusCode).toBe(403);
    expect(fx.calls).toEqual([]);
  });

  test('FR011_본문 모양이 틀리면 400(about:blank)이고 쓰임새를 부르지 않는다: holdId 없음·글 아님, buyer 없음, 모르는 칸(맨 위·buyer·consents), 동의 형 틀림, 판 모양 틀림(빈칸·33자), JSON 아님 [ASVS v5.0.0-1.3.3]', async () => {
    const good = okBody() as unknown as Record<string, unknown>;
    const bodies: unknown[] = [
      { buyer: good.buyer, consents: good.consents },
      { ...good, holdId: 123 },
      { holdId: HOLD_ID, consents: good.consents },
      { ...good, amount: 1 },
      { ...good, buyer: { name: '홍길동', phone: '010-1234-5678', email: 'a@b.c' } },
      { ...good, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT_VERSION, marketing: true } },
      { ...good, consents: { provisionToSeller: 'yes', salesTerms: true, consentVersion: CONSENT_VERSION } },
      { ...good, consents: { provisionToSeller: true, salesTerms: true, consentVersion: 'v 3' } },
      { ...good, consents: { provisionToSeller: true, salesTerms: true, consentVersion: 'v'.repeat(33) } },
      'not json',
    ];
    for (const body of bodies) {
      fx.reset();
      const r = await post(body);
      expect({ body, status: r.statusCode }).toEqual({ body, status: 400 });
      if (body !== 'not json') expect({ body, type: json(r).type }).toEqual({ body, type: 'about:blank' });
      expect(fx.calls).toEqual([]);
    }
  });

  test('FR011_금액(amount)을 본문에 실어 보내도 받지 않는다(400): 금액은 서버가 계산한다', async () => {
    const r = await post({ ...(okBody() as unknown as Record<string, unknown>), amount: 1 });
    expect(r.statusCode).toBe(400);
    expect(fx.created).toHaveLength(0);
  });

  test('FR011_판 모양 경계: consentVersion 32자는 모양 검사를 지나 쓰임새가 판을 견준다(422 consent-version-outdated)', async () => {
    const r = await post(okBody({ consents: { provisionToSeller: true, salesTerms: true, consentVersion: 'v'.repeat(32) } }));
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: problem('consent-version-outdated') });
  });
});
