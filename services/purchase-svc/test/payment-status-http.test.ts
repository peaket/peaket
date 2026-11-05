// 받는 층: 결제 결과 long polling GET /v1/orders/{orderId}/payment-status(openapi getOrderPaymentStatus, docs/features/payment.md §2 '결제 결과 long polling의 첫 구현', BUILD_ORDER PRF-166).
// accept-http.test.ts와 같은 꼴: AppModule을 메모리 조립으로 띄워 fastify inject로 부른다. 신원은 게이트웨이 내부 머리(팬 쿠키를 게이트웨이가 바꾼 것)다.
// long polling 포트(읽기·기다림)는 이 파일의 메모리 가짜다. 쓰임새 자체의 차례는 get-payment-status.test.ts가, 기다림 표는 payment-status-waiters.test.ts가 본다.
// 여기는 HTTP 모양·플랫폼 가드(팬만, 구매 세션 서명·멱등 키 없음)·대응표·no-store·이 경로만의 남은 시간 상한 27초 [가정]을 본다.
//
// 정본 모호:
// - 남은 시간 상한(architecture 시간 초과 표 'long polling' 행 27초 [가정])은 처리기가 받는 요청 맥락의 deadline으로 본다(가짜 읽기가 부를 때의 남은 시간).
//   앱 시계는 가짜라 흐르지 않으므로 남은 시간은 min(머리 값, 상한) 그대로다.
// - 쓰임새가 조립되지 않았으면(BookingModuleDeps.paymentStatus 없음) 404 not-found다(orders.controller.ts [정함]).
// - 409 둘은 정상 분기로 세지 않는다(PAYMENT_STATUS_PROBLEMS [정함]).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createService, DEADLINE_HEADER, fakeClock, PROBLEM_TYPE_BASE, ProblemError, purchaseMac, purchaseMacInput, requestContext, ROUTE_DEADLINE_KEY } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { OrderSessions, PaymentStatusReads, PaymentStatusView, PaymentStatusWaitOptions, PaymentStatusWaiters, PaymentStatusWake, PaymentStatusWakeUp } from '../src/modules/booking/index.js';
import {
  clientGoneSignal,
  OrdersController,
  PAYMENT_STATUS_LOG_SLO_MS,
  PAYMENT_STATUS_PROBLEMS,
  type PaymentStatusRejection,
  throwPaymentStatusProblem,
} from '../src/modules/booking/inbound/orders.controller.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { AcceptFakes, ORDER_ID, OTHER_ACCOUNT, PAYMENT_KEY } from './accept-cases.js';
import { ACCOUNT, AMOUNT, CONSENT_VERSION, EVENT, IDEM_KEY, JOURNEY, LOGIN, NOW, OrderFakes, PID, PSID } from './order-cases.js';

const KEY = Buffer.alloc(32, 9);
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const clock = fakeClock({ now: NOW });

/** 가짜 읽기: 주문 모습 표. 부를 때 요청 맥락의 남은 시간을 적는다 */
class RecordingReads implements PaymentStatusReads {
  views = new Map<string, PaymentStatusView>();
  reads: string[] = [];
  remainingAtRead: (number | undefined)[] = [];
  async read(orderId: string): Promise<PaymentStatusView | undefined> {
    this.reads.push(orderId);
    this.remainingAtRead.push(requestContext()?.deadline?.remainingMs());
    return this.views.get(orderId);
  }
  async readMany(orderIds: readonly string[]): Promise<PaymentStatusView[]> {
    return orderIds.flatMap((id) => (this.views.has(id) ? [this.views.get(id)!] : []));
  }
}
/** 가짜 기다림: 부른 값을 적고 곧바로 then(기본 TIMEOUT)으로 끝낸다. before가 있으면 끝내기 전에 부른다(그사이 상태 바꾸기) */
class InstantWaiters implements PaymentStatusWaiters {
  waits: { orderId: string; deadlineMs: number; aborted: boolean | undefined }[] = [];
  then: PaymentStatusWake = 'TIMEOUT';
  before: (() => void) | undefined;
  async wait(orderId: string, deadlineMs: number, o: PaymentStatusWaitOptions = {}): Promise<PaymentStatusWakeUp> {
    this.waits.push({ orderId, deadlineMs, aborted: o.signal?.aborted });
    this.before?.();
    return { wake: this.then };
  }
  notify(): void {}
}

const reads = new RecordingReads();
const waiters = new InstantWaiters();
const orders = new OrderFakes(clock);
const fx = new AcceptFakes();
const sessions = new MemoryPurchaseSessions();
sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY, loginSessionId: LOGIN, key: KEY });
/** 결제 접수 경로의 구매 세션 읽기가 볼 때의 남은 시간(다른 경로는 15초 그대로인지 본다) */
const acceptRemaining: (number | undefined)[] = [];
const recordingSessions: OrderSessions = {
  get: async (id) => {
    acceptRemaining.push(requestContext()?.deadline?.remainingMs());
    return fx.sessions.get(id);
  },
  markPaying: (...a) => fx.sessions.markPaying(...a),
};

let svc: Awaited<ReturnType<typeof createService>>;
/** long polling 쓰임새를 조립하지 않은 앱 */
let bare: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      booking: { ...orders.ports(), sessions: recordingSessions, ...fx.bookingPorts(), consentVersion: CONSENT_VERSION, clock, paymentStatus: { reads, waiters } },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
  bare = await createService({
    name: 'purchase-svc',
    module: AppModule.register({ memory: true, sessions, booking: { ...new OrderFakes(clock).ports(), ...new AcceptFakes().bookingPorts(), consentVersion: CONSENT_VERSION, clock } }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
  await bare?.close();
});
beforeEach(() => {
  reads.views.clear();
  reads.reads = [];
  reads.remainingAtRead = [];
  waiters.waits = [];
  waiters.then = 'TIMEOUT';
  waiters.before = undefined;
  fx.reset();
  acceptRemaining.length = 0;
});

const pathOf = (orderId: string) => `/v1/orders/${orderId}/payment-status`;
/** 팬 신원 머리(게이트웨이가 팬 쿠키를 확인하고 넣는 것)만. 스코프·구매 세션 서명·멱등 키는 싣지 않는다 */
const FAN: Record<string, string> = { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': 'fan', 'x-user-pid': PID };
function get(o: { orderId?: string; headers?: Record<string, string>; identity?: Record<string, string> | null; app?: typeof svc } = {}) {
  const headers: Record<string, string> = { ...(o.identity === null ? {} : (o.identity ?? FAN)), ...o.headers };
  return (o.app ?? svc).http.inject({ method: 'GET', url: pathOf(o.orderId ?? ORDER_ID), headers });
}
const put = (over: Partial<PaymentStatusView> = {}) => reads.views.set(ORDER_ID, { orderId: ORDER_ID, accountId: ACCOUNT, status: 'CONFIRMED', pg: 'TOSS', ...over });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;

/** openapi x-peaket-problem-types(이름 → status·title)를 계약 파일에서 읽는다(accept-http.test.ts와 같다) */
function contractProblemTypes(): Map<string, { status: number; title: string }> {
  const yaml = readFileSync(fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url)), 'utf8');
  const out = new Map<string, { status: number; title: string }>();
  for (const m of yaml.matchAll(/^ {4}([a-z0-9-]+): \{ status: (\d+), title: "([^"]*)"/gm)) out.set(m[1]!, { status: Number(m[2]), title: m[3]! });
  return out;
}

describe('200 PaymentStatus', () => {
  test('FR011_팬 신원 머리만으로(스코프·구매 세션 서명·멱등 키 없이) 200이고 Cache-Control no-store, application/json이다', async () => {
    put({ status: 'CONFIRMED' });
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(json(r)).toEqual({ status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' });
    expect(reads.reads).toEqual([ORDER_ID]);
  });

  test('FR011_구매 세션 서명 머리를 틀리게 실어도 보지 않는다(결제창에서 돌아온 탭이 묻는다)', async () => {
    put({ status: 'CONFIRMED' });
    const r = await get({ headers: { 'x-purchase-seq': '1', 'x-purchase-mac': 'wrong', 'x-user-scope': 'ticket:read' } });
    expect(r.statusCode).toBe(200);
  });

  test('FR011_FAILED는 reason(failure_reason 값)을 싣고, 환불 상태는 CONFIRMED로 기다리지 않고 답한다', async () => {
    put({ status: 'FAILED', failureReason: 'CARD_DECLINED' });
    expect(json(await get())).toEqual({ status: 'FAILED', reason: 'CARD_DECLINED', issueDelayed: false, pg: 'TOSS' });
    put({ status: 'REFUNDED' });
    expect(json(await get())).toEqual({ status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' });
    expect(waiters.waits).toEqual([]);
  });

  test('M2_늦어지는 APPROVED(60초 지남·다시 시도 중)도 기다렸다가(가짜는 곧바로 TIMEOUT) issueDelayed true로 답한다', async () => {
    put({ status: 'APPROVED', issueJobCreatedAtMs: NOW - 60_000, issueJobAttempts: 0 });
    expect(json(await get())).toEqual({ status: 'APPROVED', issueDelayed: true, pg: 'TOSS' });
    put({ status: 'APPROVED', issueJobCreatedAtMs: NOW, issueJobAttempts: 1, issueJobLastError: 'UNAVAILABLE' });
    expect(json(await get())).toEqual({ status: 'APPROVED', issueDelayed: true, pg: 'TOSS' });
    expect(waiters.waits.map((w) => w.orderId)).toEqual([ORDER_ID, ORDER_ID]);
  });

  test('FR011_기다릴 상태면 기다렸다가(가짜는 곧바로 TIMEOUT) 그때의 상태로 200이다. pg가 없으면 칸이 없다', async () => {
    put({ status: 'RESERVED', pg: undefined });
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ status: 'RESERVED', issueDelayed: false });
    expect('pg' in json(r)).toBe(false);
    expect(waiters.waits.map((w) => w.orderId)).toEqual([ORDER_ID]);
  });

  test('FR011_기다리는 사이 결과가 정해져 깨면(CHANGED) 다시 읽은 상태로 답한다', async () => {
    put({ status: 'ACCEPTED' });
    waiters.then = 'CHANGED';
    waiters.before = () => put({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' });
    const r = await get();
    expect(json(r)).toEqual({ status: 'FAILED', reason: 'INSUFFICIENT_FUNDS', issueDelayed: false, pg: 'TOSS' });
    expect(reads.reads).toEqual([ORDER_ID, ORDER_ID]);
  });

  test('FR011_기다림에 넘긴 signal은 응답 전에는 끊기지 않았다(브라우저가 닫을 때만 끊긴다)', async () => {
    put({ status: 'ACCEPTED' });
    await get();
    expect(waiters.waits[0]!.aborted).toBe(false);
  });
});

describe('남은 시간 상한(이 경로만 27초 [가정])', () => {
  test('NFR006_머리 x-peaket-deadline-ms 30000을 보내도 처리기가 받는 남은 시간은 27초이고, 기다림은 25초다', async () => {
    put({ status: 'ACCEPTED' });
    const r = await get({ headers: { [DEADLINE_HEADER]: '30000' } });
    expect(r.statusCode).toBe(200);
    expect(reads.remainingAtRead[0]).toBe(27_000);
    expect(reads.remainingAtRead.every((n) => n !== undefined && n <= 27_000)).toBe(true);
    expect(waiters.waits.map((w) => w.deadlineMs)).toEqual([25_000]);
  });

  test('NFR006_머리가 없으면 남은 시간은 이 경로 상한 27초다(서비스 기본 15초가 아니다)', async () => {
    put({ status: 'ACCEPTED' });
    await get();
    expect(reads.remainingAtRead[0]).toBe(27_000);
    expect(waiters.waits[0]!.deadlineMs).toBe(25_000);
  });

  test('NFR006_머리가 상한보다 짧으면 그 값이다(20초 → 기다림 19초, 10초 → 9초)', async () => {
    put({ status: 'ACCEPTED' });
    await get({ headers: { [DEADLINE_HEADER]: '20000' } });
    await get({ headers: { [DEADLINE_HEADER]: '10000' } });
    expect(reads.remainingAtRead.filter((_, i) => i % 2 === 0)).toEqual([20_000, 10_000]);
    expect(waiters.waits.map((w) => w.deadlineMs)).toEqual([19_000, 9_000]);
  });

  test('NFR006_다른 경로(결제 접수)는 머리 30000이어도 서비스 기본 상한 15초 그대로다', async () => {
    const url = '/v1/orders/' + ORDER_ID + '/payment-acceptance';
    const payload = JSON.stringify({ pg: 'TOSS', paymentKey: PAYMENT_KEY, amount: AMOUNT });
    const headers: Record<string, string> = {
      ...FAN,
      'x-user-scope': 'ticket:buy',
      'content-type': 'application/json',
      'x-purchase-seq': '1',
      'x-purchase-mac': purchaseMac(KEY, purchaseMacInput('POST', url, 1, Buffer.from(payload, 'utf8'))),
      'idempotency-key': IDEM_KEY,
      [DEADLINE_HEADER]: '30000',
    };
    const r = await svc.http.inject({ method: 'POST', url, headers, payload });
    expect(r.statusCode).toBe(202);
    expect(acceptRemaining).toEqual([15_000]);
  });
});

/** Nest의 FASTIFY_ROUTE_CONFIG_METADATA 값(purchase-svc는 @nestjs/platform-fastify를 직접 들이지 않아 글로 적는다) */
const FASTIFY_ROUTE_CONFIG_METADATA = '__fastify_route_config__';

describe('경로 설정(로그 SLO, 리뷰 고침 M5)', () => {
  test('M5_이 경로는 남은 시간 상한 27초와 함께 로그 SLO 26초(@LogPolicy sloLatencyMs)를 단다(기다린 응답이 SLO 초과로 전부 남지 않게)', () => {
    expect(PAYMENT_STATUS_LOG_SLO_MS).toBe(26_000);
    const config = Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, OrdersController.prototype.paymentStatus) as Record<string, unknown>;
    expect(config[ROUTE_DEADLINE_KEY]).toBe(27_000);
    expect(config.peaketLog).toEqual({ sloLatencyMs: 26_000 });
    // 다른 경로(결제 접수)에는 이 로그 정책이 없다
    const accept = Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, OrdersController.prototype.accept) as Record<string, unknown> | undefined;
    expect(accept?.peaketLog).toBeUndefined();
  });
});

describe('clientGoneSignal(브라우저 끊김 신호, 리뷰 고침 L2)', () => {
  /** reply 모양 대역: raw는 close를 낼 수 있는 이벤트 객체, request.raw.socket은 끊김 표시만 */
  const fakeReply = (o: { replyDestroyed?: boolean; socketDestroyed?: boolean; noSocket?: boolean } = {}) => {
    const raw = Object.assign(new EventEmitter(), { destroyed: o.replyDestroyed ?? false });
    const socket = o.noSocket ? null : { destroyed: o.socketDestroyed ?? false };
    return { raw, request: { raw: { socket } } };
  };

  test('L2_연결이 살아 있으면 끊기지 않았고, 응답 객체의 close에 끊긴다', () => {
    const reply = fakeReply();
    const signal = clientGoneSignal(reply);
    expect(signal.aborted).toBe(false);
    reply.raw.emit('close');
    expect(signal.aborted).toBe(true);
  });

  test('L2_만들 때 이미 응답 객체가 부서졌거나(destroyed) 요청 소켓이 부서졌으면 곧바로 끊긴 신호다', () => {
    expect(clientGoneSignal(fakeReply({ replyDestroyed: true })).aborted).toBe(true);
    expect(clientGoneSignal(fakeReply({ socketDestroyed: true })).aborted).toBe(true);
    expect(clientGoneSignal(fakeReply({ noSocket: true })).aborted).toBe(false);
  });
});

/** 거절 까닭마다 그 거절이 나게 하는 준비 */
const REJECTIONS: Record<PaymentStatusRejection, () => void> = {
  NOT_FOUND: () => reads.views.clear(),
  NOT_ACCEPTED: () => put({ status: 'CREATED' }),
  ORDER_EXPIRED: () => put({ status: 'EXPIRED' }),
};

describe('거절 → 문제 상세(PAYMENT_STATUS_PROBLEMS)', () => {
  test('FR011_대응표는 404 not-found·409 payment-not-accepted·409 order-expired이고 status·title은 계약 x-peaket-problem-types와 같다', () => {
    expect(Object.keys(PAYMENT_STATUS_PROBLEMS).sort()).toEqual(Object.keys(REJECTIONS).sort());
    expect(PAYMENT_STATUS_PROBLEMS.NOT_FOUND).toMatchObject({ status: 404, type: 'not-found' });
    expect(PAYMENT_STATUS_PROBLEMS.NOT_ACCEPTED).toMatchObject({ status: 409, type: 'payment-not-accepted' });
    expect(PAYMENT_STATUS_PROBLEMS.ORDER_EXPIRED).toMatchObject({ status: 409, type: 'order-expired' });
    const contract = contractProblemTypes();
    for (const [reason, spec] of Object.entries(PAYMENT_STATUS_PROBLEMS)) {
      expect({ reason, got: { status: spec.status, title: spec.title } }).toEqual({ reason, got: contract.get(spec.type) });
      expect(spec.normalBranch, reason).toBeUndefined();
      expect(spec.retryAfterSeconds, reason).toBeUndefined();
    }
  });

  test.each(Object.keys(REJECTIONS) as PaymentStatusRejection[])('FR011_%s → 대응표의 상태 코드·type·title, application/problem+json, Cache-Control no-store이고 기다리지 않는다', async (reason) => {
    REJECTIONS[reason]();
    const spec = PAYMENT_STATUS_PROBLEMS[reason];
    const r = await get();
    expect(r.statusCode).toBe(spec.status);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(json(r)).toMatchObject({ type: problem(spec.type), status: spec.status, title: spec.title });
    expect(waiters.waits).toEqual([]);
  });

  test('FR011_남의 주문과 없는 주문은 같은 404 본문(type·status·title)이다 [ASVS v5.0.0-8.2.2]', async () => {
    const strip = (b: Record<string, unknown>) => ({ type: b.type, status: b.status, title: b.title, detail: b.detail });
    const missing = await get();
    put({ accountId: OTHER_ACCOUNT, status: 'ACCEPTED' });
    const others = await get();
    const notUuid = await get({ orderId: 'not-a-uuid' });
    expect(missing.statusCode).toBe(404);
    expect(others.statusCode).toBe(404);
    expect(notUuid.statusCode).toBe(404);
    expect(strip(json(others))).toEqual(strip(json(missing)));
    expect(strip(json(notUuid))).toEqual(strip(json(missing)));
    expect(waiters.waits).toEqual([]);
  });

  test('FR011_경로 값은 글 그대로 쓰임새에 넘긴다(대문자 UUID도 모양을 보지 않는다)', async () => {
    await get({ orderId: ORDER_ID.toUpperCase() });
    expect(reads.reads).toEqual([ORDER_ID.toUpperCase()]);
  });

  test('FR011_쓰임새가 조립되지 않은 앱(paymentStatus 없음)은 404 not-found·no-store다', async () => {
    const r = await get({ app: bare });
    expect(r.statusCode).toBe(404);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(json(r)).toMatchObject({ type: problem('not-found'), status: 404 });
  });

  test('FR011_throwPaymentStatusProblem은 대응표의 ProblemError를 던진다', () => {
    for (const reason of Object.keys(PAYMENT_STATUS_PROBLEMS) as PaymentStatusRejection[]) {
      let err: unknown;
      try {
        throwPaymentStatusProblem(reason);
      } catch (e) {
        err = e;
      }
      expect({ reason, isProblem: err instanceof ProblemError }).toEqual({ reason, isProblem: true });
      expect((err as ProblemError).status, reason).toBe(PAYMENT_STATUS_PROBLEMS[reason].status);
      expect((err as ProblemError).type, reason).toBe(problem(PAYMENT_STATUS_PROBLEMS[reason].type));
    }
  });
});

describe('플랫폼 가드(쓰임새에 닿기 전)', () => {
  test('FR011_신원 머리가 없으면 401이고 읽지 않는다', async () => {
    put();
    const r = await get({ identity: null });
    expect(r.statusCode).toBe(401);
    expect(reads.reads).toEqual([]);
    // 대조: 같은 요청에 팬 신원을 실으면 읽고 200이다
    expect((await get()).statusCode).toBe(200);
    expect(reads.reads).toEqual([ORDER_ID]);
  });

  test('FR011_팬이 아닌 신원(ops·partner·scanner)은 거절이고 읽지 않는다', async () => {
    put();
    for (const aud of ['ops', 'partner', 'scanner']) {
      const r = await get({ identity: { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': aud } });
      expect({ aud, ok: r.statusCode >= 400 && r.statusCode < 500 }).toEqual({ aud, ok: true });
    }
    expect(reads.reads).toEqual([]);
    // 대조: 팬이면 읽고 200이다
    expect((await get()).statusCode).toBe(200);
    expect(reads.reads).toEqual([ORDER_ID]);
  });

  test('FR011_쓰임새의 DB 오류는 500 about:blank이고 오류 글을 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const orig = reads.read.bind(reads);
    let reached = false;
    reads.read = async () => {
      reached = true;
      throw new Error('DBSECRET connection terminated');
    };
    try {
      const r = await get();
      // 처리기가 쓰임새의 읽기까지 갔다(뼈대의 '미구현' 500과 가른다)
      expect(reached).toBe(true);
      expect(r.statusCode).toBe(500);
      expect(json(r)).toMatchObject({ type: 'about:blank', status: 500 });
      expect(r.payload).not.toContain('DBSECRET');
      expect(r.headers['cache-control']).toBe('no-store');
    } finally {
      reads.read = orig;
    }
  });
});
