// 받는 층: 좌석 홀드 POST /v1/events/{eventId}/holds(openapi seats, docs/features/seat-hold.md §3 '홀드 요청의 HTTP 처리').
// AppModule을 메모리 조립으로 띄워 fastify inject로 부른다. 신원은 게이트웨이 내부 머리, 구매 세션 요청 서명은 시험 대역 키로 단다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput } from '@peaket/platform';
import { PostV1EventsEventIdHoldsBody, PostV1EventsEventIdHoldsResponse } from '@peaket/contracts/openapi/seats';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  HOLD_PROBLEMS,
  HOLD_TTL_MS,
  type HoldInput,
  HoldRequest,
  HoldResponseBody,
  KEEP_AFTER_SALE_END_MS,
  MemoryPurchaseSessions,
  MemorySeatMap,
  MemorySeatStore,
  RecordingHoldAttempts,
  type SeatStore,
  SeatStoreUnavailable,
} from '../src/modules/inventory/index.js';
import { account, DAY, newEvent, ref, type ReplayInput, type ReplayPort, replayOf, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const KEY = Buffer.alloc(32, 9);
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const clock = fakeClock({ now: NOW });
const inner = new MemorySeatStore(clock);
const seatMap = new MemorySeatMap();
const sessions = new MemoryPurchaseSessions();
const attempts = new RecordingHoldAttempts();
/** 홀드 Lua 호출 수(S-T30: 잘못된 입력은 저장소에 닿지 않는다) */
const holdCalls: HoldInput[] = [];
let failWith: unknown;
/** 재생 읽기 호출(앱 쪽 거절 전, 추천 적용 2026-11-04) */
const replays: ReplayInput[] = [];
const store: SeatStore & ReplayPort = {
  hold: async (i) => {
    holdCalls.push(i);
    if (failWith !== undefined) throw failWith;
    return inner.hold(i);
  },
  openSale: (i) => inner.openSale(i),
  replay: async (i) => {
    replays.push(i);
    return replayOf(inner)(i);
  },
};
/** 409 seat-already-held의 제목: 내 좌석을 새 키로 다시 누른 경우도 있어 '다른 분이 먼저'가 아닌 중립 문구다(추천 적용 2026-11-04) */
const CONFLICT_TITLE = '이미 잡힌 좌석이 있습니다';

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({ memory: true, store, seatMap, attempts, sessions }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

interface Fan {
  accountId: string;
  login: string;
  sessionId: string;
}

/** 회차 하나(좌석맵 판·판매 열기)와 그 회차의 팬(구매 세션) */
async function world(o: { saleEndsAtMs?: number; limit?: number; map?: boolean; open?: boolean } = {}) {
  const eventId = newEvent();
  const saleEndsAtMs = o.saleEndsAtMs ?? NOW + DAY;
  if (o.map !== false) seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: o.limit ?? 4, saleEndsAtMs }, SEAT_DEFS);
  if (o.open !== false) await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
  const fan = (k: number, sessionEvent = eventId): Fan => {
    const f = { accountId: account(k), login: `ls-${eventId}-${k}`, sessionId: `ps-${eventId}-${k}` };
    sessions.open({ sessionId: f.sessionId, accountId: f.accountId, eventId: sessionEvent, journeyId: randomUUID(), loginSessionId: f.login, key: KEY });
    return f;
  };
  return { eventId, fan, ev: () => inner.db.event(eventId) };
}

let seq = 0;
/** 서명한 홀드 요청. key가 null이면 Idempotency-Key를 싣지 않는다 */
function post(eventId: string, payload: string, f: Fan, o: { key?: string | null; url?: string; macKey?: Buffer; login?: string; on?: Awaited<ReturnType<typeof createService>> } = {}) {
  const url = o.url ?? `/v1/events/${eventId}/holds`;
  seq += 1;
  const mac = purchaseMac(o.macKey ?? KEY, purchaseMacInput('POST', url, seq, Buffer.from(payload, 'utf8')));
  const headers: Record<string, string> = {
    'x-user-id': f.accountId,
    'x-session-id': o.login ?? f.login,
    'x-user-aud': 'fan',
    'x-user-scope': 'ticket:buy',
    'content-type': 'application/json',
    'x-purchase-seq': String(seq),
    'x-purchase-mac': mac,
  };
  if (o.key !== null) headers['idempotency-key'] = o.key ?? randomUUID();
  return (o.on ?? svc).http.inject({ method: 'POST', url, headers, payload });
}
const seats = (...ids: string[]) => JSON.stringify({ seatIds: ids });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;

/** 그 회차 좌석 키에 아무것도 쓰이지 않았는지 */
function untouched(ev: ReturnType<typeof inner.db.event>) {
  expect(ev.bits.size).toBe(0);
  expect(ev.quota.size).toBe(0);
  expect(ev.stream).toHaveLength(0);
}

describe('201 홀드', () => {
  test('FR010_POL012_ 201 본문은 holdId·seatIds(오름차순)·expiresAt(ISO 8601 Z)·extendable·fencingToken(JSON 정수)뿐이고 캐시하지 않는다 [ASVS v5.0.0-15.3.1] [ASVS v5.0.0-4.1.1]', async () => {
    const { eventId, fan } = await world();
    const r = await post(eventId, seats('A03', 'A01'), fan(1));
    expect(r.statusCode).toBe(201);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = json(r);
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'extendable', 'fencingToken', 'holdId', 'seatIds']);
    expect(body).toMatchObject({ holdId: holdCalls.at(-1)!.holdId, seatIds: ['A01', 'A03'], expiresAt: new Date(NOW + HOLD_TTL_MS).toISOString(), extendable: true });
    // 16자리 토큰이 따옴표 없는 JSON 정수로, 자릿수를 잃지 않고 실린다(메모리 저장소: µs = 시계 × 1000)
    expect(String(NOW * 1000)).toHaveLength(16);
    expect(r.payload).toContain(`"fencingToken":${NOW * 1000}`);
    expect(body.fencingToken).toBe(NOW * 1000);
    expect(String(body.expiresAt)).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('ST24_① 같은 키로 다시 보내면 같은 201이고(행동 요약이 달라도) 좌석·보유 수·Stream·시도 기록이 늘지 않는다', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const key = randomUUID();
    const before = attempts.records.length;
    const a = await post(eventId, seats('A01', 'A02'), f, { key });
    expect(a.statusCode).toBe(201);
    const b = await post(eventId, JSON.stringify({ seatIds: ['A02', 'A01'], behavior: { v: 1, windowMs: 1_000, pointerMoves: 3 } }), f, { key });
    expect(b.statusCode).toBe(201);
    expect(json(b)).toEqual(json(a));
    expect(ev().quota.get(f.accountId)).toBe(2);
    expect(ev().stream).toHaveLength(2);
    expect(attempts.records.length - before).toBe(1);
  });

  test('ST1_ 같은 좌석에 열 계정이 동시에 보내면 201은 하나이고 나머지는 409 seat-already-held다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]', async () => {
    const { eventId, fan, ev } = await world();
    const fans = Array.from({ length: 10 }, (_, k) => fan(k + 1));
    const rs = await Promise.all(fans.map((f) => post(eventId, seats('A05'), f)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    for (const r of rs) if (r.statusCode === 409) expect(json(r)).toMatchObject({ type: problem('seat-already-held'), title: CONFLICT_TITLE });
    expect([...ev().quota.values()]).toEqual([1]);
  });
});

describe('400 모양 검사(저장소에 닿기 전)', () => {
  test('FR010_ 좌석 0개·11개, 좌석 ID 모양, 형이 틀린 seatIds는 400(about:blank)이고 저장소에 닿지 않으며 시도 기록도 없다. 10개는 모양 검사를 지난다 [ASVS v5.0.0-1.3.3] [ASVS v5.0.0-1.4.2] [ASVS v5.0.0-15.3.5]', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const eleven = Array.from({ length: 11 }, (_, k) => `A${String(k + 1).padStart(2, '0')}`);
    const calls = holdCalls.length;
    const recs = attempts.records.length;
    for (const payload of [
      seats(),
      JSON.stringify({ seatIds: eleven }),
      seats('A 1'),
      seats('A/1'),
      seats('x'.repeat(65)),
      seats('s:{event:x}'),
      JSON.stringify({ seatIds: 'A01' }),
      JSON.stringify({ seatIds: [1] }),
      JSON.stringify({ seatIds: [['A01']] }),
      JSON.stringify({ seatIds: ['A01'], behavior: { v: 2, windowMs: 1 } }),
      'not json',
    ]) {
      const r = await post(eventId, payload, f);
      expect({ payload, status: r.statusCode }).toEqual({ payload, status: 400 });
      if (payload !== 'not json') expect({ payload, type: json(r).type }).toEqual({ payload, type: 'about:blank' });
    }
    expect(holdCalls.length).toBe(calls);
    expect(attempts.records.length).toBe(recs);
    untouched(ev());
    // 경계: 10개는 모양 검사를 지나 1인 한도(4)에 걸린다
    const ten = await post(eventId, JSON.stringify({ seatIds: eleven.slice(0, 10) }), f);
    expect(ten.statusCode).toBe(422);
    expect(json(ten).type).toBe(problem('purchase-limit-exceeded'));
  });

  test('FR010_ auto를 보내면 seatIds가 함께 있어도 400 auto-assign-not-supported와 detail(지금은 좌석 지정만 받는다)이다', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const calls = holdCalls.length;
    const auto = { firstTierId: 'R', count: 2 };
    for (const payload of [JSON.stringify({ auto }), JSON.stringify({ seatIds: ['A01'], auto })]) {
      const r = await post(eventId, payload, f);
      expect(r.statusCode).toBe(400);
      expect(json(r)).toMatchObject({ type: problem('auto-assign-not-supported'), status: 400, title: HOLD_PROBLEMS.AUTO_NOT_SUPPORTED.title, detail: '지금은 좌석 지정(seatIds)만 받습니다' });
    }
    expect(holdCalls.length).toBe(calls);
    untouched(ev());
  });

  test('FR010_ seatIds도 auto도 없으면 400(about:blank, detail 없음)이다', async () => {
    const { eventId, fan } = await world();
    const r = await post(eventId, '{}', fan(1));
    expect(r.statusCode).toBe(400);
    expect(json(r).type).toBe('about:blank');
    expect(json(r).detail).toBeUndefined();
  });

  test('FR010_ Idempotency-Key가 없거나 UUID v4 모양이 아니면 400 idempotency-key-invalid이고 저장소에 닿지 않는다', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const calls = holdCalls.length;
    for (const key of [null, 'abc', '0190f3a1-7c2e-7a00-8000-000000000001', `{${randomUUID()}}`]) {
      const r = await post(eventId, seats('A01'), f, { key });
      expect({ key, status: r.statusCode, type: json(r).type }).toEqual({ key, status: 400, type: problem('idempotency-key-invalid') });
    }
    expect(holdCalls.length).toBe(calls);
    untouched(ev());
  });

  test('FR010_ 본문의 __proto__·constructor.prototype 키는 400이고 저장소에 닿지 않으며 원형이 오염되지 않는다 [ASVS v5.0.0-1.5.2] [ASVS v5.0.0-15.3.6]', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const calls = holdCalls.length;
    for (const payload of ['{"seatIds":["A01"],"__proto__":{"polluted":1}}', '{"seatIds":["A01"],"constructor":{"prototype":{"polluted":1}}}', '{"__proto__":{"seatIds":["A01"]}}']) {
      const r = await post(eventId, payload, f);
      expect({ payload, status: r.statusCode }).toEqual({ payload, status: 400 });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(holdCalls.length).toBe(calls);
    untouched(ev());
  });

  test('FR010_ 주소의 회차 ID가 키 조각 모양이 아니면(해시 태그를 깨는 글자) 400이고 저장소에 닿지 않는다', async () => {
    const { fan } = await world();
    const f = fan(1);
    const calls = holdCalls.length;
    for (const id of ['ev%7Bx%7D', 'ev%3Ax', 'x'.repeat(65)]) {
      const r = await post(id, seats('A01'), f, { url: `/v1/events/${id}/holds` });
      expect({ id, status: r.statusCode }).toEqual({ id, status: 400 });
    }
    expect(holdCalls.length).toBe(calls);
  });
});

describe('업무 거절', () => {
  test('ST30_①~⑤ 좌석맵 판에 없는 좌석·다른 회차의 좌석·판매 제외석·같은 좌석 두 번·정상 좌석과 섞은 요청은 422 invalid-seat이고 홀드 Lua 호출이 0번이다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.2.2] [ASVS v5.0.0-8.3.1] [ASVS v5.0.0-1.2.4]', async () => {
    const other = await world();
    seatMap.put({ eventId: other.eventId, layoutVersion: 'v1', seatCount: 10, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, [{ seatId: 'C01', index: 0, sectionId: 'SEC-C', sectionIndex: 0, seatOffset: 0, tierId: 'R' }]);
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const calls = holdCalls.length;
    for (const ids of [['Z99'], ['C01'], ['X01'], ['A01', 'A01'], ['A01', 'Z99'], ['A01', 'X01', 'A02'], ['A02', 'A01', 'A02']]) {
      const r = await post(eventId, seats(...ids), f);
      expect({ ids, status: r.statusCode }).toEqual({ ids, status: 422 });
      expect(json(r)).toMatchObject({ type: problem('invalid-seat'), status: 422, title: HOLD_PROBLEMS.INVALID_SEAT.title });
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    }
    expect(holdCalls.length).toBe(calls);
    untouched(ev());
  });

  test('ST4_ 좌석 하나라도 남이 잡았으면 409 seat-already-held(문제 상세, 캐시하지 않음)이고 부분 홀드가 0이다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-2.3.3]', async () => {
    const { eventId, fan, ev } = await world();
    const a = fan(1);
    const b = fan(2);
    expect((await post(eventId, seats('A02'), b)).statusCode).toBe(201);
    const r = await post(eventId, seats('A01', 'A02', 'A03'), a);
    expect(r.statusCode).toBe(409);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(json(r)).toMatchObject({ type: problem('seat-already-held'), status: 409, title: CONFLICT_TITLE });
    expect(ev().bits.has(ref('A01').index)).toBe(false);
    expect(ev().bits.has(ref('A03').index)).toBe(false);
    expect(ev().quota.get(a.accountId)).toBeUndefined();
  });

  test('ST33_④ 방금 놓은 좌석이 섞이면 409 seat-recently-released와 recentlyReleasedSeats·reholdAvailableAt(ISO Z)이고 아무 좌석도 잡지 않는다', async () => {
    const { eventId, fan, ev } = await world();
    const a = fan(1);
    ev().rel.set(a.accountId, new Map([[ref('A01').index, NOW + 30_000]]));
    const r = await post(eventId, seats('A02', 'A01'), a);
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({
      type: problem('seat-recently-released'),
      status: 409,
      title: HOLD_PROBLEMS.REHOLD_WAIT.title,
      recentlyReleasedSeats: ['A01'],
      reholdAvailableAt: new Date(NOW + 30_000).toISOString(),
    });
    untouched(ev());
  });

  test('ST33_⑦ 놓은 좌석에 남의 홀드가 걸려 있으면 409 seat-already-held가 먼저다', async () => {
    const { eventId, fan, ev } = await world();
    const a = fan(1);
    ev().rel.set(a.accountId, new Map([[ref('A01').index, NOW + 30_000]]));
    expect((await post(eventId, seats('A01'), fan(2))).statusCode).toBe(201);
    const r = await post(eventId, seats('A01'), a);
    expect(r.statusCode).toBe(409);
    expect(json(r).type).toBe(problem('seat-already-held'));
  });

  test('POL011_ 1인 한도를 넘으면 422 purchase-limit-exceeded이고 아무 좌석도 잡지 않는다', async () => {
    const { eventId, fan, ev } = await world({ limit: 2 });
    const a = fan(1);
    expect((await post(eventId, seats('A01'), a)).statusCode).toBe(201);
    const r = await post(eventId, seats('A02', 'A03'), a);
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: problem('purchase-limit-exceeded'), status: 422, title: HOLD_PROBLEMS.QUOTA_EXCEEDED.title });
    expect(ev().quota.get(a.accountId)).toBe(1);
    expect(ev().bits.has(ref('A02').index)).toBe(false);
  });

  test('ST24_② 같은 키로 다른 좌석을 보내면 422 idempotency-key-reused이고 좌석을 잡지 않는다', async () => {
    const { eventId, fan, ev } = await world();
    const a = fan(1);
    const key = randomUUID();
    expect((await post(eventId, seats('A01'), a, { key })).statusCode).toBe(201);
    const r = await post(eventId, seats('A02'), a, { key });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: problem('idempotency-key-reused'), status: 422, title: HOLD_PROBLEMS.IDEM_REUSED.title });
    expect(ev().bits.has(ref('A02').index)).toBe(false);
  });

  test('FR010_ 판매 일시정지·판매 중지·전체 정지면 423 sale-paused다', async () => {
    for (const field of ['paused', 'suspended', 'allPaused']) {
      const { eventId, fan, ev } = await world();
      ev().ctl.set(field, '1');
      const r = await post(eventId, seats('A01'), fan(1));
      expect({ field, status: r.statusCode }).toEqual({ field, status: 423 });
      expect(json(r)).toMatchObject({ type: problem('sale-paused'), status: 423, title: HOLD_PROBLEMS.PAUSED.title });
      untouched(ev());
    }
  });

  test('ST26_③ 세대 키가 없으면 503 seat-store-unavailable과 Retry-After 2이고 좌석을 잡지 않는다', async () => {
    const { eventId, fan, ev } = await world();
    ev().epoch = undefined;
    const r = await post(eventId, seats('A01'), fan(1));
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('2');
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(json(r)).toMatchObject({ type: problem('seat-store-unavailable'), status: 503, title: HOLD_PROBLEMS.NOT_READY.title });
    untouched(ev());
  });

  test('FR010_ 회차 좌석맵 판이 없으면 503 seat-store-unavailable과 Retry-After 2이고 저장소에 닿지 않는다', async () => {
    const { eventId, fan } = await world({ map: false, open: false });
    const calls = holdCalls.length;
    const r = await post(eventId, seats('A01'), fan(1));
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('2');
    expect(json(r).type).toBe(problem('seat-store-unavailable'));
    expect(holdCalls.length).toBe(calls);
  });

  test('FR010_ 좌석 Redis 일시 장애면 503 seat-store-unavailable과 Retry-After 2다', async () => {
    const { eventId, fan } = await world();
    failWith = new SeatStoreUnavailable(new Error('down'));
    try {
      const r = await post(eventId, seats('A01'), fan(1));
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('2');
      expect(json(r).type).toBe(problem('seat-store-unavailable'));
    } finally {
      failWith = undefined;
    }
  });

  test('ST28_③ 구매 세션의 회차와 주소의 회차가 다르면 403이고 저장소에 닿지 않으며 그 회차 좌석에 변화가 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const first = await world();
    const target = await world();
    const f = first.fan(1);
    const calls = holdCalls.length;
    const r = await post(target.eventId, seats('A01'), f);
    expect(r.statusCode).toBe(403);
    // 게이트웨이의 회차 대조 403과 같은 이름 없는 본문(hold-error.ts 대응표)
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 403 });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(holdCalls.length).toBe(calls);
    untouched(target.ev());
  });

  test('FR010_ 판매 종료 뒤의 새 홀드는 410 sale-ended이고 저장소에 닿지 않는다', async () => {
    const { eventId, fan, ev } = await world({ saleEndsAtMs: NOW });
    const calls = holdCalls.length;
    const r = await post(eventId, seats('A01'), fan(1));
    expect(r.statusCode).toBe(410);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(json(r)).toMatchObject({ type: problem('sale-ended'), status: 410, title: HOLD_PROBLEMS.SALE_ENDED.title });
    expect(holdCalls.length).toBe(calls);
    untouched(ev());
  });

  test('FR010_ 구매 세션이 없거나 서명 키가 틀리면 401이고 저장소에 닿지 않는다', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const calls = holdCalls.length;
    const none = await post(eventId, seats('A01'), f, { login: 'ls-nobody' });
    expect(none.statusCode).toBe(401);
    const wrong = await post(eventId, seats('A01'), f, { macKey: Buffer.alloc(32, 1) });
    expect(wrong.statusCode).toBe(401);
    expect(holdCalls.length).toBe(calls);
    untouched(ev());
  });

  test('FR010_ 인증 훅을 지난 뒤 구매 세션이 끝났으면 쓰임새의 401이고 WWW-Authenticate(Cookie realm="peaket")·이름 없는 본문이며 시도 기록이 없다', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    // 인증 훅(resolve·advance)은 지나고 쓰임새의 세션 읽기(get)만 비게 한다
    const get = sessions.get.bind(sessions);
    sessions.get = async () => undefined;
    const calls = holdCalls.length;
    const recs = attempts.records.length;
    try {
      const r = await post(eventId, seats('A01'), f);
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(json(r)).toMatchObject({ type: 'about:blank', status: 401 });
    } finally {
      sessions.get = get;
    }
    expect(holdCalls.length).toBe(calls);
    expect(attempts.records.length).toBe(recs);
    untouched(ev());
  });
});

describe('앱 쪽 거절 전 멱등 재생(ST24, guidelines §4, 추천 적용 2026-11-04)', () => {
  test('ST24_ 재현: 201 뒤 판매 종료가 지나 같은 키·같은 본문을 다시 보내면 410이 아니라 같은 201이고 시도 기록이 늘지 않는다. 새 키는 410이다', async () => {
    // 판매 종료를 지나게 시계를 밀어야 해서, 다른 시험과 시계를 나누지 않는 서비스를 따로 띄운다
    const c = fakeClock({ now: NOW });
    const mem = new MemorySeatStore(c);
    const map = new MemorySeatMap();
    const ss = new MemoryPurchaseSessions();
    const rec = new RecordingHoldAttempts();
    const own = await createService({
      name: 'purchase-svc',
      module: AppModule.register({ memory: true, store: mem, seatMap: map, attempts: rec, sessions: ss }),
      purchaseSessions: ss,
      env: { PEAKET_ENV: 'ci' },
      clock: c,
      logDestination: quiet,
    });
    try {
      const eventId = newEvent();
      const saleEndsAtMs = NOW + 60_000;
      map.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs }, SEAT_DEFS);
      await mem.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
      const f: Fan = { accountId: account(1), login: `ls-${eventId}`, sessionId: `ps-${eventId}` };
      ss.open({ sessionId: f.sessionId, accountId: f.accountId, eventId, journeyId: randomUUID(), loginSessionId: f.login, key: KEY });
      const key = randomUUID();
      const a = await post(eventId, seats('A01', 'A02'), f, { key, on: own });
      expect(a.statusCode).toBe(201);
      c.advance(60_000);
      const b = await post(eventId, seats('A02', 'A01'), f, { key, on: own });
      expect(b.statusCode).toBe(201);
      expect(json(b)).toEqual(json(a));
      const fresh = await post(eventId, seats('A03'), f, { on: own });
      expect(fresh.statusCode).toBe(410);
      expect(json(fresh).type).toBe(problem('sale-ended'));
      expect(rec.records.map((x) => x.result)).toEqual(['HELD', 'ERROR']);
    } finally {
      await own.close();
    }
  });

  test('ST24_ 좌석맵 판이 바뀌어 좌석이 사라진 뒤 같은 키·같은 본문은 같은 201이고, 같은 키에 다른 좌석은 422 idempotency-key-reused, 새 키는 422 invalid-seat다', async () => {
    const { eventId, fan } = await world();
    const f = fan(1);
    const key = randomUUID();
    const a = await post(eventId, seats('A01', 'A02'), f, { key });
    expect(a.statusCode).toBe(201);
    seatMap.put({ eventId, layoutVersion: 'v2', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS.filter((d) => d.seatId !== 'A01'));
    const calls = holdCalls.length;
    const b = await post(eventId, seats('A01', 'A02'), f, { key });
    expect(b.statusCode).toBe(201);
    expect(json(b)).toEqual(json(a));
    const reused = await post(eventId, seats('A01', 'A03'), f, { key });
    expect(reused.statusCode).toBe(422);
    expect(json(reused).type).toBe(problem('idempotency-key-reused'));
    const fresh = await post(eventId, seats('A01'), f);
    expect(fresh.statusCode).toBe(422);
    expect(json(fresh).type).toBe(problem('invalid-seat'));
    expect(holdCalls.length).toBe(calls);
  });
});

describe('경로 스키마와 계약(@peaket/contracts 생성물)이 같은 표본을 같게 판정한다(ADR-0176 결정 4)', () => {
  // 알려진 차이(BAS-040): 계약은 정하지 않은 위층 칸(추가 칸)을 받고 경로 스키마는 막을 수 있다. 추가 칸 표본은 견주지 않는다
  const ids = (k: number) => Array.from({ length: k }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
  const judge = (route: { safeParse(v: unknown): { success: boolean } }, contract: { safeParse(v: unknown): { success: boolean } }, samples: [string, unknown][]) =>
    samples.map(([what, v]) => ({ what, route: route.safeParse(v).success, contract: contract.safeParse(v).success }));

  test('FR010_ 요청 본문: 좌석 0·1·10·11개, 좌석 ID 모양·형이 틀린 것, auto·behavior 모양을 계약과 같게 받고 거절한다 [ASVS v5.0.0-1.3.3] [ASVS v5.0.0-15.3.5]', () => {
    const v = judge(HoldRequest, PostV1EventsEventIdHoldsBody, [
      ['좌석 0개', { seatIds: [] }],
      ['좌석 1개', { seatIds: ids(1) }],
      ['좌석 10개', { seatIds: ids(10) }],
      ['좌석 11개', { seatIds: ids(11) }],
      ['좌석 ID 빈칸', { seatIds: ['A 1'] }],
      ['좌석 ID 64자', { seatIds: ['x'.repeat(64)] }],
      ['좌석 ID 65자', { seatIds: ['x'.repeat(65)] }],
      ['좌석 ID 해시 태그 글자', { seatIds: ['s:{e}'] }],
      ['seatIds가 글', { seatIds: 'A01' }],
      ['seatIds 안에 수', { seatIds: [1] }],
      ['빈 본문', {}],
      ['본문이 배열', []],
      ['본문이 null', null],
      ['auto 정상', { auto: { firstTierId: 'R', count: 2 } }],
      ['auto 매수 0', { auto: { firstTierId: 'R', count: 0 } }],
      ['auto 매수 1.5', { auto: { firstTierId: 'R', count: 1.5 } }],
      ['auto 1순위 등급 없음', { auto: { count: 1 } }],
      ['behavior 정상', { seatIds: ids(1), behavior: { v: 1, windowMs: 1_000, pointerMoves: 3 } }],
      ['behavior 판 2', { seatIds: ids(1), behavior: { v: 2, windowMs: 1_000 } }],
      ['behavior 구간 넘음', { seatIds: ids(1), behavior: { v: 1, windowMs: 3_600_001 } }],
      ['behavior 음수 이동 수', { seatIds: ids(1), behavior: { v: 1, windowMs: 1, pointerMoves: -1 } }],
      ['clientEphemeralPublicKey가 수', { seatIds: ids(1), clientEphemeralPublicKey: 1 }],
    ]);
    expect(v.filter((x) => x.route !== x.contract)).toEqual([]);
    // 표본이 받는 쪽·거절하는 쪽을 모두 지난다
    expect(Object.fromEntries(v.filter((x) => x.what.startsWith('좌석 ') && x.what.endsWith('개')).map((x) => [x.what, x.route]))).toEqual({ '좌석 0개': false, '좌석 1개': true, '좌석 10개': true, '좌석 11개': false });
  });

  const OK = { holdId: '0190f3a1-7c2e-7a00-8000-00000000f001', seatIds: ['A01'], expiresAt: '2026-11-04T03:07:00.000Z', extendable: true, fencingToken: NOW * 1000 };
  const without = (k: keyof typeof OK) => {
    const { [k]: _gone, ...rest } = OK;
    return rest;
  };

  test('FR010_ 응답 Hold: 칸 누락·형이 틀린 것·배정 결과 값을 계약과 같게 받고 거절한다 [ASVS v5.0.0-15.3.1]', () => {
    const v = judge(HoldResponseBody, PostV1EventsEventIdHoldsResponse, [
      ['정상', OK],
      ['배정 결과 FIRST', { ...OK, assignResult: 'FIRST' }],
      ['배정 결과 모르는 값', { ...OK, assignResult: 'BEST' }],
      ['holdId 없음', without('holdId')],
      ['seatIds 없음', without('seatIds')],
      ['expiresAt 없음', without('expiresAt')],
      ['extendable 없음', without('extendable')],
      ['fencingToken 없음', without('fencingToken')],
      ['fencingToken이 글', { ...OK, fencingToken: String(NOW * 1000) }],
      ['fencingToken 1.5', { ...OK, fencingToken: 1.5 }],
      ['fencingToken 2^53', { ...OK, fencingToken: 2 ** 53 }],
      ['expiresAt이 날짜가 아님', { ...OK, expiresAt: 'soon' }],
      ['extendable이 글', { ...OK, extendable: 'yes' }],
      ['seatIds가 글', { ...OK, seatIds: 'A01' }],
      ['holdId가 수', { ...OK, holdId: 1 }],
    ]);
    expect(v.filter((x) => x.route !== x.contract)).toEqual([]);
    expect(v.find((x) => x.what === '정상')?.route).toBe(true);
  });

  test('FR010_ 응답 Hold: 펜싱 토큰 0·음수는 계약과 경로 스키마가 모두 거절하고, 시간대가 붙은 expiresAt은 알려진 차이다(경로 스키마만 거절)', () => {
    // 계약 Hold.fencingToken은 minimum 1(추천 적용 2026-11-04). 0·음수는 둘 다 거절해야 한다
    expect(
      judge(HoldResponseBody, PostV1EventsEventIdHoldsResponse, [
        ['fencingToken 0', { ...OK, fencingToken: 0 }],
        ['fencingToken 음수', { ...OK, fencingToken: -1 }],
      ]),
    ).toEqual([
      { what: 'fencingToken 0', route: false, contract: false },
      { what: 'fencingToken 음수', route: false, contract: false },
    ]);
    // 알려진 차이(추천 적용 2026-11-04): 서버는 expiresAt을 늘 'Z'(UTC)로 내므로 경로 스키마는 시간대 표기를 받지 않고, 계약(offset 허용)은 받는다.
    // 차이가 바뀌면(어느 쪽이든) 이 시험이 드러낸다
    expect(judge(HoldResponseBody, PostV1EventsEventIdHoldsResponse, [['expiresAt +09:00', { ...OK, expiresAt: '2026-11-04T12:07:00.000+09:00' }]])).toEqual([
      { what: 'expiresAt +09:00', route: false, contract: true },
    ]);
  });
});
