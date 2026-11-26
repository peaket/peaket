// F-06-8 N-T27: purchase-svc 내부 GET /internal/v1/orders/{orderId}/notice-view.
// 내부 토큰이 없거나 틀리면 401, 없으면 404, 있으면 예매번호·상태·알림 허용·회차·등급 ID만 준다.
// 실제 DB를 쓰지 않고 booking 포트를 흉내 낸다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { fakeClock, createService } from '@peaket/platform';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import * as booking from '../src/modules/booking/index.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { AcceptFakes } from './accept-cases.js';
import { ACCOUNT, CONSENT_VERSION, EVENT, JOURNEY, LOGIN, NOW, OrderFakes, PID, PSID } from './order-cases.js';

const TOKEN = 'f068-notice-view-internal';
const ORDER = '0190f3a1-7c2e-7f00-8000-0000000000f1';
const UNKNOWN = '0190f3a1-7c2e-7f00-8000-0000000000ff';
const KEY = Buffer.alloc(32, 7);
const quiet = new Writable({
  write: (_c, _e, cb) => cb(),
});
const clock = fakeClock({ now: NOW });
const fx = new OrderFakes(clock);
const sessions = new MemoryPurchaseSessions();
sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY, loginSessionId: LOGIN, key: KEY });

const notice = {
  bookingNo: '2026101400001',
  status: 'CONFIRMED',
  noticeAllowed: true,
  // 정본 §4.9.1: 내부 응답에만 있는 번호. 작업·기록·로그·vars에는 넣지 않는다(F-06-9가 쓴다)
  phoneE164: '+821012345678',
  eventId: EVENT,
  tierIds: ['R', 'S'],
};
const noticeViews = {
  calls: [] as string[],
  async get(orderId: string) {
    this.calls.push(orderId);
    return orderId === ORDER ? notice : undefined;
  },
};

let svc: Awaited<ReturnType<typeof createService>>;
let previousToken: string | undefined;
beforeAll(async () => {
  previousToken = process.env.PEAKET_INTERNAL_TOKEN;
  process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      booking: {
        ...fx.ports(),
        ...new AcceptFakes().bookingPorts(),
        consentVersion: CONSENT_VERSION,
        clock,
        noticeViews,
      } as never,
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: TOKEN },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
  if (previousToken === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
  else process.env.PEAKET_INTERNAL_TOKEN = previousToken;
});
afterEach(() => {
  noticeViews.calls = [];
});

const get = (orderId: string, token: string | null = TOKEN) =>
  svc.http.inject({
    method: 'GET',
    url: `/internal/v1/orders/${orderId}/notice-view`,
    headers: token === null ? {} : { 'x-peaket-internal-token': token },
  });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('F-06-8 notice-view', () => {
  test('N-T27 ② notice-view는 내부 토큰이 없거나 틀리면 401, 없으면 404, 있으면 예매번호·상태·허용·번호·회차·등급 ID만 준다', async () => {
    expect((await get(ORDER, null)).statusCode).toBe(401);
    expect((await get(ORDER, 'wrong-token')).statusCode).toBe(401);
    expect((await get(UNKNOWN)).statusCode).toBe(404);
    expect(json(await get(UNKNOWN))).toMatchObject({ status: 404 });

    const ok = await get(ORDER);
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toEqual(notice);
    for (const key of ['buyerName', 'buyerPhone', 'name', 'phone', 'seatNumber', 'seatIds', 'bookingNoFull', 'password']) {
      expect(json(ok)).not.toHaveProperty(key);
    }
    expect(noticeViews.calls).toEqual([UNKNOWN, UNKNOWN, ORDER]);

    // noticeAllowed 네 경우: 정상·CONFIRMED 아님·주문 취소 진행·회차 취소 승인 전
    const noticeAllowedOf = (booking as unknown as {
      noticeAllowedOf?: (o: { status: string; orderCancellationActive: boolean; eventCancellationApprovalPending: boolean }) => boolean;
    }).noticeAllowedOf;
    expect(noticeAllowedOf).toBeTypeOf('function');
    expect(noticeAllowedOf!({ status: 'CONFIRMED', orderCancellationActive: false, eventCancellationApprovalPending: false })).toBe(true);
    expect(noticeAllowedOf!({ status: 'PARTIALLY_REFUNDED', orderCancellationActive: false, eventCancellationApprovalPending: false })).toBe(false);
    expect(noticeAllowedOf!({ status: 'CONFIRMED', orderCancellationActive: true, eventCancellationApprovalPending: false })).toBe(false);
    expect(noticeAllowedOf!({ status: 'CONFIRMED', orderCancellationActive: false, eventCancellationApprovalPending: true })).toBe(false);
  });

  test('IR068-02 내부 토큰이 없으면 운영에서 시작을 막는다(fail-closed)', () => {
    const Guard = booking.NoticeViewTokenGuard as unknown as new (expected?: string, required?: boolean) => { onModuleInit(): void };
    const guard = new Guard(undefined, true);
    expect(typeof guard.onModuleInit).toBe('function');
    expect(() => guard.onModuleInit()).toThrow();
  });
});
