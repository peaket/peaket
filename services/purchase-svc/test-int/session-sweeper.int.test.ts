// 구매 세션 정리 반복(SessionSweeper)을 실제 Valkey 8.1 위의 실제 어댑터로 돈다(BUILD_ORDER PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리').
// RedisPurchaseSessionStore(점검·끝내기)·RedisSessionIndex(정리 색인)·RedisSessionStartedLog/RedisSessionEndedLog(Stream·색인)·RedisSweepLeases(정리 임대 줄)를 한데 묶는다.
// 앱 쪽 시각은 주입한 가짜 시계, 점검 Lua의 시각은 Redis TIME이라 유휴 시한은 세션 해시의 idle 칸을 과거로 써서 만든다.
import 'reflect-metadata';
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  EndPurchaseSession,
  RedisPurchaseSessionStore,
  RedisSeatStore,
  RedisSessionEndedLog,
  RedisSessionIndex,
  RedisSessionStartedLog,
  RedisSweepLeases,
  SESSION_IDLE_MS,
  SessionSweeper,
  seatKeys,
  sessionKeys,
  toPurchaseSessionEnded,
} from '../src/modules/inventory/index.js';
import { JOURNEY, newJti, openInput } from '../test/purchase-session-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const MIN = 60_000;

/** 실제 어댑터 조립. 앱 시계는 Redis 시각에 가깝게 둔다(index.due의 지금) */
function setup() {
  const clock = fakeClock({ now: Date.now(), monotonic: 0 });
  const store = new RedisPurchaseSessionStore(redis);
  const started = new RedisSessionStartedLog(redis);
  const ended = new RedisSessionEndedLog(redis);
  const index = new RedisSessionIndex(redis);
  const seats = new RedisSeatStore(redis, undefined, clock);
  const ending = new EndPurchaseSession({ store, ended, clock });
  const sweeper = new SessionSweeper({ store, index, expiries: seats, leases: new RedisSweepLeases(redis), ending, clock, podId: 'pod-int' });
  const eventId = `ev-${newJti()}`;
  /** 구매 세션을 열고 시작 사건(정리 색인 포함)을 더한다 */
  async function open(over: { maxStayMs?: number } = {}): Promise<string> {
    const jti = newJti();
    const now = Date.now();
    const maxStayUntilMs = now + (over.maxStayMs ?? 45 * MIN);
    const r = await store.open(openInput({ now: () => now }, jti, { eventId, expiresAtMs: maxStayUntilMs, reissueUntilMs: maxStayUntilMs + 45 * MIN, firstUseDeadlineMs: now + 5 * MIN }));
    if (r.kind !== 'CREATED') throw new Error('CREATED여야 한다');
    await started.appendStarted({ eventId, purchaseSessionId: jti, admissionJti: jti, journeyId: JOURNEY, startedAtMs: r.startedAtMs, maxStayUntilMs });
    return jti;
  }
  const score = async (jti: string) => {
    const key = seatKeys.sessions(eventId);
    const v = await redis.command(['ZSCORE', key, jti], { key });
    return v === null || v === undefined ? undefined : Number(String(v));
  };
  const entries = async () => {
    const key = seatKeys.stream(eventId);
    return ((await redis.command(['XRANGE', key, '-', '+'], { key })) as unknown[]).length;
  };
  return { clock, store, index, sweeper, eventId, open, score, entries };
}

describe('SessionSweeper (실제 Valkey 위의 세 갈래: 끝냄·살아 있음·없음)', () => {
  test('QT11_POL009_ADR0183_11_색인에 든 세션 셋 중 유휴 시한이 지난 것은 IDLE로 끝나 SESSION_ENDED가 Stream에 한 건 쌓이고 색인에서 빠지며, 살아 있는 것은 점수가 다음 점검 시각으로 바뀌고, 세션이 이미 없는 것은 색인에서 빠진다', async () => {
    const w = setup();
    // 해당 회차는 판매 중인 회차 목록에 올린다
    await redis.command(['SADD', seatKeys.ctlEvents(), w.eventId], { key: seatKeys.ctlEvents() });
    const idle = await w.open();
    const live = await w.open();
    const gone = await w.open();
    // 점검 시각이 되도록 색인 점수를 과거로, idle 칸도 과거로 쓴다
    const key = seatKeys.sessions(w.eventId);
    for (const j of [idle, live, gone]) await redis.command(['ZADD', key, String(Date.now() - 1000), j], { key });
    await redis.command(['HSET', sessionKeys.session(idle), 'idle', String(Date.now() - 1000)], { key: sessionKeys.session(idle) });
    await redis.command(['DEL', sessionKeys.session(gone)], { key: sessionKeys.session(gone) });
    const startedStream = await w.entries();

    const t = await w.sweeper.tick();
    const mine = t.events.find((e) => e.eventId === w.eventId)!;
    expect(mine).toMatchObject({ outcome: 'DRAINED', checked: 3, ended: 1, gone: 1 });

    // 끝난 것: 세션 상태 없음, 표지 남음, 색인에서 빠짐, 종료 사건 한 건
    expect(await w.store.read(idle)).toBeUndefined();
    expect(await w.score(idle)).toBeUndefined();
    expect(await w.entries()).toBe(startedStream + 1);
    const streamKey = seatKeys.stream(w.eventId);
    const raw = (await redis.command(['XRANGE', streamKey, '-', '+'], { key: streamKey })) as unknown[];
    const last = raw[raw.length - 1] as unknown;
    const body = (Array.isArray(last) ? last[1] : (last as { message?: unknown })?.message) as unknown;
    const fields: Record<string, string> = {};
    if (body instanceof Map) for (const [k, v] of body) fields[String(k)] = String(v);
    else if (Array.isArray(body)) for (let i = 0; i + 1 < body.length; i += 2) fields[String(body[i])] = String(body[i + 1]);
    else if (body && typeof body === 'object') for (const [k, v] of Object.entries(body)) fields[k] = String(v);
    expect(toPurchaseSessionEnded(w.eventId, fields)).toMatchObject({ eventId: w.eventId, purchaseSessionId: idle, admissionJti: idle, reason: 'IDLE' });
    // 살아 있는 것: 세션 그대로, 점수는 다음 점검 시각(유휴 시한)으로
    expect(await w.store.read(live)).toBeDefined();
    const next = await w.score(live);
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.now() + SESSION_IDLE_MS + 5000);
    // 이미 없던 것은 색인에서만 빠졌다(사건 없음)
    expect(await w.score(gone)).toBeUndefined();
    // 같은 틱을 되풀이해도 더 끝나는 것이 없고 사건이 늘지 않는다
    const again = await w.sweeper.tick();
    expect(again.events.find((e) => e.eventId === w.eventId)).toMatchObject({ checked: 0, ended: 0 });
    expect(await w.entries()).toBe(startedStream + 1);
  });

  test('POL009_T10_최대 체류에 닿은 세션은 Paying이어도 MAX_STAY로 끝난다. 정리 임대는 만료 임대와 다른 키다', async () => {
    const w = setup();
    await redis.command(['SADD', seatKeys.ctlEvents(), w.eventId], { key: seatKeys.ctlEvents() });
    const jti = await w.open({ maxStayMs: 1500 });
    expect(await w.store.setPaying(jti, true)).toBe(true);
    const key = seatKeys.sessions(w.eventId);
    await redis.command(['ZADD', key, '0', jti], { key });
    // 최대 체류 앞이라 Paying은 LIVE다(앱 시계는 가짜라 점수 0으로 점검 시각이 지난 것으로 만든다)
    const first = await w.sweeper.tick();
    expect(first.events.find((e) => e.eventId === w.eventId)).toMatchObject({ outcome: 'DRAINED', checked: 1, ended: 0 });
    await new Promise((r) => setTimeout(r, 1700));
    await redis.command(['ZADD', key, '0', jti], { key });
    const second = await w.sweeper.tick();
    expect(second.events.find((e) => e.eventId === w.eventId)).toMatchObject({ checked: 1, ended: 1 });
    expect(await w.store.read(jti)).toBeUndefined();
    // 정리 임대 키는 sesweep, 만료 임대 키 sweep은 만들어지지 않았다
    const ses = seatKeys.sessionSweep(w.eventId);
    const exp = seatKeys.sweep(w.eventId);
    expect(String(await redis.command(['GET', ses], { key: ses }))).toBe('pod-int');
    expect(await redis.command(['GET', exp], { key: exp })).toBeNull();
  });
});
