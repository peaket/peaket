// 받는 층: 좌석 홀드 POST /v1/events/{eventId}/holds(openapi seats, docs/features/seat-hold.md §3 '홀드 요청의 HTTP 처리').
// AppModule을 메모리 조립으로 띄워 fastify inject로 부른다. 신원은 게이트웨이 내부 머리, 구매 세션 요청 서명은 시험 대역 키로 단다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { contractRouteSchema, createService, DEADLINE_HEADER, fakeClock, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput } from '@peaket/platform';
import { CreateEventHoldBody, CreateEventHoldParams, CreateEventHoldResponse } from '@peaket/contracts/openapi/seats';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  HOLD_PROBLEMS,
  HOLD_TTL_MS,
  type HoldInput,
  HoldParams,
  HoldRequest,
  HoldResponseBody,
  KEEP_AFTER_SALE_END_MS,
  KEY_PART,
  MemoryPurchaseSessions,
  MemorySeatMap,
  MemorySeatStore,
  RecordingHoldAttempts,
  type SeatCallOptions,
  type SeatStore,
  SeatStoreUnavailable,
} from '../src/modules/inventory/index.js';
import { account, DAY, newEvent, ref, type ReplayInput, type ReplayPort, replayOf, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const KEY = Buffer.alloc(32, 9);
/** 서비스 로그(한 줄에 JSON 하나). 계정 ID가 든 키 이름이 로그에 남지 않는지 본다(ASVS 16.2.5) */
const logLines: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    for (const l of String(c).split('\n')) if (l) logLines.push(l);
    cb();
  },
});
const clock = fakeClock({ now: NOW });
const inner = new MemorySeatStore(clock);
const seatMap = new MemorySeatMap();
const sessions = new MemoryPurchaseSessions();
const attempts = new RecordingHoldAttempts();
/** 홀드 Lua 호출 수(S-T30: 잘못된 입력은 저장소에 닿지 않는다) */
const holdCalls: HoldInput[] = [];
/** 홀드 Lua 호출의 둘째 인자(호출 마감, PRF-135) */
const holdOptions: (SeatCallOptions | undefined)[] = [];
let failWith: unknown;
/** 재생 읽기 호출(앱 쪽 거절 전, 추천 적용 2026-11-04) */
const replays: ReplayInput[] = [];
/** 재생 읽기에 끼울 실패(PRF-135 재생 읽기 일시 장애) */
let replayFailWith: unknown;
const store: SeatStore & ReplayPort = {
  hold: async (i: HoldInput, o?: SeatCallOptions) => {
    holdCalls.push(i);
    holdOptions.push(o);
    if (failWith !== undefined) throw failWith;
    return inner.hold(i);
  },
  openSale: (i) => inner.openSale(i),
  replay: async (i: ReplayInput) => {
    replays.push(i);
    if (replayFailWith !== undefined) throw replayFailWith;
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
function post(
  eventId: string,
  payload: string,
  f: Fan,
  o: { key?: string | null; url?: string; macKey?: Buffer; login?: string; on?: Awaited<ReturnType<typeof createService>>; headers?: Record<string, string> } = {},
) {
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
  Object.assign(headers, o.headers);
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

describe('좌석 Redis 호출 마감(guidelines §5, seat-hold.md §3 좌석 Redis 호출 마감, PRF-135)', () => {
  test('NFR003_ 남은 시간 머리(x-peaket-deadline-ms)가 4ms면 좌석 Redis를 부르지 않고 504 deadline-exceeded(문제 상세, Retry-After 없음, 캐시하지 않음)이며 시도 기록 ERROR 하나다. 5ms면 잡는다', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const calls = holdCalls.length;
    const recs = attempts.records.length;
    const r = await post(eventId, seats('A01'), f, { headers: { [DEADLINE_HEADER]: '4' } });
    expect(r.statusCode).toBe(504);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['retry-after']).toBeUndefined();
    expect(json(r)).toMatchObject({ type: problem('deadline-exceeded'), status: 504, title: HOLD_PROBLEMS.DEADLINE_EXCEEDED.title });
    expect(holdCalls.length).toBe(calls);
    expect(attempts.records.slice(recs).map((a) => a.result)).toEqual(['ERROR']);
    untouched(ev());
    const ok = await post(eventId, seats('A01'), f, { headers: { [DEADLINE_HEADER]: '5' } });
    expect(ok.statusCode).toBe(201);
  });

  test('NFR003_ 홀드 Lua를 부를 때 마감은 min(남은 시간, 100ms)이다(머리 60 → 60ms, 머리 없음 → 서비스 상한 15초라 100ms)', async () => {
    const { eventId, fan } = await world();
    const f = fan(1);
    const from = holdOptions.length;
    expect((await post(eventId, seats('A01'), f, { headers: { [DEADLINE_HEADER]: '60' } })).statusCode).toBe(201);
    expect((await post(eventId, seats('A02'), f)).statusCode).toBe(201);
    expect(holdOptions.slice(from)).toEqual([{ deadlineMs: 60 }, { deadlineMs: 100 }]);
  });
});

describe('메모리 부족과 재생 읽기 일시 장애(503, seat-hold.md §3·§9, PRF-135)', () => {
  test('NFR015_ 좌석 Redis 메모리 부족이면 503 seat-store-unavailable과 Retry-After 2이고, 본문·머리는 일시 장애와 같다(까닭 oom을 응답에 싣지 않는다) [ASVS v5.0.0-16.3.4]', async () => {
    const { eventId, fan } = await world();
    const answer = async (err: unknown, k: number) => {
      failWith = err;
      try {
        return await post(eventId, seats('A01'), fan(k));
      } finally {
        failWith = undefined;
      }
    };
    const oom = await answer(new SeatStoreUnavailable(new Error("OOM command not allowed when used memory > 'maxmemory'."), 'oom'), 1);
    const down = await answer(new SeatStoreUnavailable(new Error('down')), 2);
    for (const r of [oom, down]) {
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('2');
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    }
    const shape = (r: { payload: string }) => {
      const { type, status, title, detail } = json(r);
      return { keys: Object.keys(json(r)).sort(), type, status, title, detail };
    };
    expect(shape(oom)).toEqual(shape(down));
    expect(json(oom)).toMatchObject({ type: problem('seat-store-unavailable'), status: 503, title: HOLD_PROBLEMS.STORE_UNAVAILABLE.title });
    expect(oom.payload).not.toMatch(/oom|maxmemory|reason/i);
    expect(Object.keys(oom.headers).filter((h) => /reason/i.test(h))).toEqual([]);
  });

  test('NFR015_ 재생 읽기가 일시 장애면 판매 종료 410·좌석맵에 없는 좌석 422 대신 503 seat-store-unavailable과 Retry-After다(같은 키로 다시 보내 처음 201을 받게)', async () => {
    const ended = await world({ saleEndsAtMs: NOW });
    const open = await world();
    replayFailWith = new SeatStoreUnavailable(new Error('down'));
    try {
      for (const [w, ids] of [
        [ended, ['A01']],
        [open, ['Z99']],
      ] as const) {
        const before = replays.length;
        const r = await post(w.eventId, seats(...ids), w.fan(1));
        expect({ ids, status: r.statusCode }).toEqual({ ids, status: 503 });
        expect(r.headers['retry-after']).toBe('2');
        expect(json(r).type).toBe(problem('seat-store-unavailable'));
        expect(replays.length).toBe(before + 1);
      }
    } finally {
      replayFailWith = undefined;
    }
  });
});

describe('좌석 Lua 오류의 500(로그에는 키 종류만, seat-hold.md §3 쓰기 전 지킴, BUILD_ORDER PRF-135)', () => {
  test('ST4_ 홀드 Lua가 쓰기 전 지킴 오류(PEAKET_CORRUPT_KEY 보유 수 키)로 끝나면 500이고, 응답과 서비스 로그 어디에도 계정 ID가 든 키 이름이 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const { eventId, fan, ev } = await world();
    const f = fan(1);
    const key = `s:{event:${eventId}}:quota:${f.accountId}`;
    const from = logLines.length;
    failWith = new Error(`ERR PEAKET_CORRUPT_KEY ${key}`);
    let r: Awaited<ReturnType<typeof post>>;
    try {
      r = await post(eventId, seats('A01'), f);
    } finally {
      failWith = undefined;
    }
    expect(r.statusCode).toBe(500);
    expect(r.payload).not.toContain(f.accountId);
    expect(r.payload).not.toContain('s:{');
    const lines = logLines.slice(from);
    // 그 요청의 정규 로그 줄은 남는다(5xx는 표본과 관계없이)
    expect(lines.filter((l) => /"status":500/.test(l))).toHaveLength(1);
    for (const l of lines) {
      expect.soft(l).not.toContain(f.accountId);
      expect.soft(l).not.toContain(key);
    }
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
  // 계약은 요청 본문을 모든 층에서 닫는다(BAS-040, docs/api/guidelines.md §1 '요청은 닫고 응답은 연다'). 정하지 않은 칸 표본도 셋이 같게 거절한다
  const ids = (k: number) => Array.from({ length: k }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
  const judge = (route: { safeParse(v: unknown): { success: boolean } }, contract: { safeParse(v: unknown): { success: boolean } }, samples: [string, unknown][]) =>
    samples.map(([what, v]) => ({ what, route: route.safeParse(v).success, contract: contract.safeParse(v).success }));

  test('FR010_ 요청 본문: 좌석 0·1·10·11개, 좌석 ID 모양·형이 틀린 것, auto·behavior 모양을 계약과 같게 받고 거절한다 [ASVS v5.0.0-1.3.3] [ASVS v5.0.0-15.3.5] [ASVS v5.0.0-15.3.3]', () => {
    const v = judge(HoldRequest, CreateEventHoldBody, [
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
      ['정하지 않은 위층 칸', { seatIds: ids(1), zzz: 1 }],
      ['auto 정하지 않은 칸', { auto: { firstTierId: 'R', count: 2, zzz: 1 } }],
    ]);
    expect(v.filter((x) => x.route !== x.contract)).toEqual([]);
    expect(v.filter((x) => x.what.includes('정하지 않은')).map((x) => x.route)).toEqual([false, false]);
    // 표본이 받는 쪽·거절하는 쪽을 모두 지난다
    expect(Object.fromEntries(v.filter((x) => x.what.startsWith('좌석 ') && x.what.endsWith('개')).map((x) => [x.what, x.route]))).toEqual({ '좌석 0개': false, '좌석 1개': true, '좌석 10개': true, '좌석 11개': false });
  });

  /**
   * Fastify가 실제로 쓰는 판정: 계약 Zod로 만든 경로 스키마(contractRouteSchema)를 서비스에 설치된 플랫폼 검사기(platformValidatorCompiler, Ajv)로 굳힌 것.
   * 본문은 참·거짓, 경로·쿼리·머리는 { value } 또는 { error }를 돌려준다. useDefaults가 값을 채우므로 표본마다 사본을 넘긴다
   */
  function fastifyJudge(part: 'body' | 'params', schema: unknown) {
    const compile = svc.http.validatorCompiler;
    expect(typeof compile).toBe('function');
    const validate = compile!({ schema, method: 'POST', url: '/v1/events/:eventId/holds', httpPart: part }) as (data: unknown) => unknown;
    return {
      safeParse: (v: unknown) => {
        const r = validate(v === undefined ? v : structuredClone(v));
        return { success: r === true || (typeof r === 'object' && r !== null && !('error' in r && (r as { error?: unknown }).error)) };
      },
    };
  }
  const routeSchema = contractRouteSchema({ params: HoldParams, body: HoldRequest }) as { params: unknown; body: unknown };

  test('FR010_ 요청 본문: Fastify가 쓰는 JSON Schema 판정(contractRouteSchema + 플랫폼 검사기)도 Zod 경로 스키마·계약과 같게 받고 거절한다 [ASVS v5.0.0-1.3.3] [ASVS v5.0.0-15.3.5] [ASVS v5.0.0-15.3.3]', () => {
    const json = fastifyJudge('body', routeSchema.body);
    const samples: [string, unknown][] = [
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
      ['auto 매수 무한대(JSON 1e400)', { auto: { firstTierId: 'R', count: Number.POSITIVE_INFINITY } }],
      ['auto 1순위 등급 없음', { auto: { count: 1 } }],
      ['auto 휠체어가 글', { auto: { firstTierId: 'R', count: 1, wheelchair: 'yes' } }],
      ['behavior 정상', { seatIds: ids(1), behavior: { v: 1, windowMs: 1_000, pointerMoves: 3 } }],
      ['behavior 판 2', { seatIds: ids(1), behavior: { v: 2, windowMs: 1_000 } }],
      ['behavior 구간 넘음', { seatIds: ids(1), behavior: { v: 1, windowMs: 3_600_001 } }],
      ['behavior 음수 이동 수', { seatIds: ids(1), behavior: { v: 1, windowMs: 1, pointerMoves: -1 } }],
      ['behavior 정하지 않은 칸', { seatIds: ids(1), behavior: { v: 1, windowMs: 1, x: 1 } }],
      ['clientEphemeralPublicKey가 수', { seatIds: ids(1), clientEphemeralPublicKey: 1 }],
      ['정하지 않은 위층 칸', { seatIds: ids(1), zzz: 1 }],
      ['auto 정하지 않은 칸', { auto: { firstTierId: 'R', count: 2, zzz: 1 } }],
    ];
    const zodVsJson = judge(HoldRequest, json, samples);
    expect(zodVsJson.filter((x) => x.route !== x.contract)).toEqual([]);
    const jsonVsContract = judge(json, CreateEventHoldBody, samples);
    expect(jsonVsContract.filter((x) => x.route !== x.contract)).toEqual([]);
    expect(Object.fromEntries(jsonVsContract.filter((x) => x.what.startsWith('좌석 ') && x.what.endsWith('개')).map((x) => [x.what, x.route]))).toEqual({ '좌석 0개': false, '좌석 1개': true, '좌석 10개': true, '좌석 11개': false });
  });

  test('FR010_ 주소 회차 ID: 경로 스키마(Zod·JSON Schema 모두)는 키 조각 모양(KEY_PART)만 받아 계약(모양 없는 string)보다 엄격하다(알려진 차이). 키 조각 모양은 셋 모두 받는다', () => {
    const json = fastifyJudge('params', routeSchema.params);
    const fine = ['ev-1', 'A_b-9', 'x'.repeat(64)];
    const strict = ['ev:1', 'ev{x}', 'ev}', 'x'.repeat(65), '', 'ev 1', 'ev/1', '회차'];
    const samples: [string, unknown][] = [...fine, ...strict].map((id) => [id, { eventId: id }]);
    for (const id of [...fine, ...strict]) expect({ id, keyPart: KEY_PART.test(id) }).toEqual({ id, keyPart: fine.includes(id) });
    // Zod 경로 스키마와 Fastify 판정은 같다
    expect(judge(HoldParams, json, samples).filter((x) => x.route !== x.contract)).toEqual([]);
    // 계약과의 차이는 키 조각 밖의 회차 ID뿐이다(경로 스키마만 거절)
    expect(judge(json, CreateEventHoldParams, samples)).toEqual([...fine.map((what) => ({ what, route: true, contract: true })), ...strict.map((what) => ({ what, route: false, contract: true }))]);
  });

  const OK = { holdId: '0190f3a1-7c2e-7a00-8000-00000000f001', seatIds: ['A01'], expiresAt: '2026-11-04T03:07:00.000Z', extendable: true, fencingToken: NOW * 1000 };
  const without = (k: keyof typeof OK) => {
    const { [k]: _gone, ...rest } = OK;
    return rest;
  };

  test('FR010_ 응답 Hold: 칸 누락·형이 틀린 것·배정 결과 값을 계약과 같게 받고 거절한다 [ASVS v5.0.0-15.3.1]', () => {
    const v = judge(HoldResponseBody, CreateEventHoldResponse, [
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
      judge(HoldResponseBody, CreateEventHoldResponse, [
        ['fencingToken 0', { ...OK, fencingToken: 0 }],
        ['fencingToken 음수', { ...OK, fencingToken: -1 }],
      ]),
    ).toEqual([
      { what: 'fencingToken 0', route: false, contract: false },
      { what: 'fencingToken 음수', route: false, contract: false },
    ]);
    // 알려진 차이(추천 적용 2026-11-04): 서버는 expiresAt을 늘 'Z'(UTC)로 내므로 경로 스키마는 시간대 표기를 받지 않고, 계약(offset 허용)은 받는다.
    // 차이가 바뀌면(어느 쪽이든) 이 시험이 드러낸다
    expect(judge(HoldResponseBody, CreateEventHoldResponse, [['expiresAt +09:00', { ...OK, expiresAt: '2026-11-04T12:07:00.000+09:00' }]])).toEqual([
      { what: 'expiresAt +09:00', route: false, contract: true },
    ]);
  });
});
