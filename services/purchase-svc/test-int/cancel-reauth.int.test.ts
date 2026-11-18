// 팬 예매 취소의 재인증 한 번 쓰기를 실제 좌석 Redis(Valkey 8.1)로 본다(R-T39 ③, BAT-415-reauth, 시험 담당 l3-b415r-test).
// 정본: docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'('한 번 쓰기'), docs/data.md §3 `reauth:jti:{jti}`(값 1, 수명은 토큰의 남은 시간·5분 이하).
// 단위 시험(test/cancel-reauth-http.test.ts)의 가짜 명령 대신 실제 SET NX PX가 두 번째를 막는지, 키의 값·남은 시간이 맞는지 본다.
// Saga 쪽(ticket-svc·payment-svc·purchase DB)은 메모리 대역이다(이 시험은 jti 저장소만 실제로 바꾼다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createHotRedis, createService, fakeClock, type HotRedis, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput, RedisReauthJtiStore } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { JwksFanReauthGate, WeekendBusinessCalendar, type CancellationOrderView } from '../src/modules/refund/index.js';
import { fakeJwksFetch, fanKey, ISS, JWKS_URL, reauthClaims, signReauth } from '../test/fan-reauth-fixtures.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
const KEY = Buffer.alloc(32, 5);
const ACCOUNT = '0193a400-0000-7000-8000-000000000001';
const LOGIN = '0193a400-0000-7000-8000-000000000002';
const PSID = '0193a400-0000-7000-8000-000000000003';
const EVENT = '0193a400-0000-7000-8000-000000000004';
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const fan = fanKey('fan-int-1');

const viewOf = (ticketId: string): CancellationOrderView => ({
  orderId: '0193a400-0000-7000-8000-000000000007',
  eventId: EVENT,
  ticketId,
  seatId: '0193a400-0000-7000-8000-000000000006',
  payerAccountId: ACCOUNT,
  ticketPrice: 33_333,
  bookedAtMs: Date.parse('2026-11-01T10:00:00+09:00'),
  saleEndsAtMs: Date.parse('2026-11-19T19:00:00+09:00'),
  entryOpensAtMs: Date.parse('2026-11-20T18:00:00+09:00'),
  orderStatus: 'CONFIRMED',
});

let valkey: ValkeyContainer | undefined;
let redis: HotRedis | undefined;
let svc: Awaited<ReturnType<typeof createService>> | undefined;
const ticketCalls: unknown[] = [];
const created: unknown[] = [];
let seq = 0;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  const sessions = new MemoryPurchaseSessions();
  sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: 'journey', loginSessionId: LOGIN, key: KEY });
  const clock = fakeClock({ now: NOW });
  const gate = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock, fetch: fakeJwksFetch([fan]).fetch });
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      refund: {
        orders: { findByTicket: async (id) => viewOf(id), findCancellation: async () => undefined },
        tickets: {
          cancel: async (q) => {
            ticketCalls.push(q);
            return 'REFUND_NOW';
          },
        },
        payments: { cancel: async () => 'CANCELLED' },
        writes: {
          create: async (q) => {
            created.push(q);
            return { status: 'CREATED' };
          },
          updateStatus: async () => undefined,
          scheduleRefundRetry: async () => undefined,
          markRefundFailed: async () => undefined,
          dueRefunds: async () => [],
        },
        calendar: new WeekendBusinessCalendar(),
        reauth: gate,
      },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});

afterAll(async () => {
  await svc?.close();
  await redis?.close();
  valkey?.stop();
});

const cancel = (token: string) => {
  const url = `/v1/tickets/${randomUUID()}/cancellation`;
  const payload = '{}';
  seq += 1;
  return svc!.http.inject({
    method: 'POST',
    url,
    headers: {
      'x-user-id': ACCOUNT,
      'x-session-id': LOGIN,
      'x-user-aud': 'fan',
      'x-user-scope': 'ticket:buy',
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-purchase-seq': String(seq),
      'x-purchase-mac': purchaseMac(KEY, purchaseMacInput('POST', url, seq, Buffer.from(payload, 'utf8'))),
      'x-reauth-token': token,
    },
    payload,
  });
};

describe('팬 취소 재인증 jti 한 번 쓰기(실제 좌석 Redis) [BAT-415-reauth]', () => {
  test('R-T39 ③ 같은 재인증 토큰으로 다른 표를 두 번째 취소하면 실제 좌석 Redis가 막아 403 reauth-required다', async () => {
    const claims = reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN, lifeS: 180 });
    const token = signReauth(fan, claims);
    const key = `reauth:jti:${claims.jti as string}`;

    const first = await cancel(token);
    expect(first.statusCode).toBe(202);
    expect(await redis!.command(['GET', key], { key })).toBe('1');
    const pttl = Number(await redis!.command(['PTTL', key], { key }));
    // 수명 = min(5분, exp − 지금) = 180초(실제 Redis의 남은 시간은 그보다 조금 짧다)
    expect(pttl).toBeGreaterThan(170_000);
    expect(pttl).toBeLessThanOrEqual(180_000);

    const second = await cancel(token);
    expect(second.statusCode).toBe(403);
    expect((JSON.parse(second.payload) as { type: string }).type).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
    expect(ticketCalls).toHaveLength(1);
    expect(created).toHaveLength(1);
  });
});
