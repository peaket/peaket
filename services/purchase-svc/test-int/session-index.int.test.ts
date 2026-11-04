// 구매 세션 정리 색인 s:{event:E}:sessions와 종료 사건 더하기를 실제 Valkey 8.1로 돈다(test/session-index-cases.ts의 사례를 메모리 구현과 똑같이,
// BUILD_ORDER PRF-138, docs/data.md §3 s:{event:E}:stream·sessions, APPEND_SESSION_STARTED_LUA·APPEND_SESSION_ENDED_LUA 계약).
// Stream과 색인은 같은 해시 태그 {event:E}라 한 슬롯이다: 노드 하나짜리 클러스터 모드에서도 Lua 하나가 두 키를 쓴다.
import 'reflect-metadata';
import { PurchaseSessionEnded } from '@peaket/contracts/asyncapi';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  APPEND_SESSION_ENDED_LUA,
  APPEND_SESSION_STARTED_LUA,
  RedisSessionEndedLog,
  RedisSessionIndex,
  RedisSessionStartedLog,
  SESSION_ENDED_TYPE,
  SESSION_IDLE_MS,
  SESSION_STARTED_KEEP_MS,
  SESSION_STARTED_TYPE,
  type SessionEndedEntry,
  seatKeys,
  sessionCheckAt,
  sessionEndedEventKey,
  sessionEndedFields,
  sessionStartedFields,
  slotOf,
  toPurchaseSessionEnded,
} from '../src/modules/inventory/index.js';
import { endedEntry, type IndexHarness, newEvent, newMember, sessionIndexCases, startedEntry } from '../test/session-index-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let cluster: ValkeyContainer | undefined;
let redis: HotRedis;
let clusterRedis: HotRedis;

beforeAll(async () => {
  // 하나가 실패해도 이미 뜬 컨테이너는 afterAll이 지우게, 둘을 따로 받는다
  const [a, b] = await Promise.allSettled([startValkey(), startValkey({ cluster: true, configEpoch: 3 })]);
  if (a.status === 'fulfilled') valkey = a.value;
  if (b.status === 'fulfilled') cluster = b.value;
  if (!valkey || !cluster) throw (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as Error;
  [redis, clusterRedis] = await Promise.all([createHotRedis({ url: valkey.url }), createHotRedis({ url: cluster.url })]);
});

afterAll(async () => {
  await Promise.all([redis?.close(), clusterRedis?.close()]);
  valkey?.stop();
  cluster?.stop();
});

/** HGETALL·XRANGE 항목 본문(RESP2 평평한 배열, RESP3 객체·Map)을 글 사전으로 */
function hash(v: unknown): Record<string, string> {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  if (Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = String(v[i + 1]);
    return o;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  return {};
}
/** ZRANGE … WITHSCORES 응답(RESP2 평평한 배열, RESP3 짝 배열·Map)을 멤버 → 점수로 */
function scores(v: unknown): Map<string, number> {
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [String(k), Number(x)]));
  if (!Array.isArray(v)) return new Map();
  if (v.every((x) => Array.isArray(x))) return new Map((v as unknown[][]).map((p) => [String(p[0]), Number(p[1])]));
  const o = new Map<string, number>();
  for (let i = 0; i + 1 < v.length; i += 2) o.set(String(v[i]), Number(v[i + 1]));
  return o;
}
/** XRANGE 한 항목 → 칸 사전 (RESP3은 [id, [k, v, …]], 객체 꼴이면 그대로) */
const fieldsOf = (e: unknown): Record<string, string> => hash(Array.isArray(e) ? e[1] : (e as { message?: unknown })?.message);

const cmd = (r: HotRedis, key: string, args: string[]) => r.command(args, { key });
/** PEXPIRETIME: 만료 없음 −1, 키 없음 −2 */
const expireAt = async (r: HotRedis, key: string) => Number(await cmd(r, key, ['PEXPIRETIME', key]));
const exists = async (r: HotRedis, key: string) => Number(await cmd(r, key, ['EXISTS', key])) === 1;
const stream = async (r: HotRedis, eventId: string) => {
  const key = seatKeys.stream(eventId);
  return ((await cmd(r, key, ['XRANGE', key, '-', '+'])) as unknown[]).map(fieldsOf);
};

function indexHarness(r: HotRedis = redis): IndexHarness {
  return {
    started: new RedisSessionStartedLog(r),
    ended: new RedisSessionEndedLog(r),
    index: new RedisSessionIndex(r),
    now: () => Date.now(),
    members: async (eventId) => {
      const key = seatKeys.sessions(eventId);
      return scores(await cmd(r, key, ['ZRANGE', key, '0', '-1', 'WITHSCORES']));
    },
    seed: async (eventId, jti, score) => void (await cmd(r, seatKeys.sessions(eventId), ['ZADD', seatKeys.sessions(eventId), String(score), jti])),
    startedItems: async (eventId) =>
      (await stream(r, eventId))
        .filter((f) => f.type === SESSION_STARTED_TYPE)
        .map((f) => ({
          eventId,
          purchaseSessionId: f.purchaseSessionId!,
          admissionJti: f.admissionJti!,
          journeyId: f.journeyId!,
          startedAtMs: Number(f.startedAtMs),
          maxStayUntilMs: Number(f.maxStayUntilMs),
        })),
    endedItems: async (eventId) =>
      (await stream(r, eventId))
        .filter((f) => f.type === SESSION_ENDED_TYPE)
        .map((f) => ({ eventId, purchaseSessionId: f.purchaseSessionId!, admissionJti: f.admissionJti!, reason: f.reason as SessionEndedEntry['reason'], endedAtMs: Number(f.endedAtMs) })),
  };
}

describe('Redis 정리 색인·종료 사건 (계약 사례, 실제 Valkey 8.1)', () => {
  sessionIndexCases(() => indexHarness());
});

describe('Redis 정리 색인·종료 사건 (노드 하나짜리 클러스터 모드)', () => {
  sessionIndexCases(() => indexHarness(clusterRedis));

  test('QT11_회차 Stream s:{event:E}:stream과 정리 색인 s:{event:E}:sessions는 같은 해시 슬롯이다(시작·종료 사건 Lua가 두 키를 함께 쓴다). 세션 키(jti 슬롯)와는 다르다', async () => {
    const e = newEvent();
    const slot = async (key: string) => Number(await clusterRedis.command(['CLUSTER', 'KEYSLOT', key], { key: 'x' }));
    expect(await slot(seatKeys.stream(e))).toBe(await slot(seatKeys.sessions(e)));
    expect(await slot(seatKeys.stream(e))).toBe(slotOf(seatKeys.sessions(e)));
    expect(slotOf(seatKeys.sessions(e))).toBe(slotOf(seatKeys.sessionSweep(e)));
  });
});

describe('RedisSessionStartedLog.appendStarted (Stream 항목과 정리 색인을 Lua 한 번에)', () => {
  test('ADR0183_11_QT11_Stream 칸은 sessionStartedFields 그대로이고, 정리 색인 멤버는 jti, 점수는 sessionCheckAt이며, 새로 만든 Stream·색인의 수명은 둘 다 최대 체류 + 1일 [가정]이다', async () => {
    const h = indexHarness();
    const eventId = newEvent();
    const jti = newMember();
    const e = startedEntry(h, eventId, jti);
    await h.started.appendStarted(e);
    expect(await stream(redis, eventId)).toEqual([Object.fromEntries(chunk(sessionStartedFields(e)))]);
    expect(await h.members(eventId)).toEqual(new Map([[jti, sessionCheckAt(e.startedAtMs, e.maxStayUntilMs)]]));
    expect(await expireAt(redis, seatKeys.stream(eventId))).toBe(e.maxStayUntilMs + SESSION_STARTED_KEEP_MS);
    expect(await expireAt(redis, seatKeys.sessions(eventId))).toBe(e.maxStayUntilMs + SESSION_STARTED_KEEP_MS);
  });

  test('ADR0183_11_이미 더 늦은 수명이 있으면 Stream도 색인도 그대로 두고, 더 이르거나 수명이 없으면 최대 체류 + 1일까지 늘린다(홀드·만료 Lua와 같은 규칙)', async () => {
    const h = indexHarness();
    const far = Date.now() + 30 * 24 * 3600_000;

    // 더 늦은 수명: 둘 다 그대로
    const late = newEvent();
    await cmd(redis, seatKeys.stream(late), ['XADD', seatKeys.stream(late), '*', 'type', 'HELD']);
    await cmd(redis, seatKeys.sessions(late), ['ZADD', seatKeys.sessions(late), '1', 'other']);
    await cmd(redis, seatKeys.stream(late), ['PEXPIREAT', seatKeys.stream(late), String(far)]);
    await cmd(redis, seatKeys.sessions(late), ['PEXPIREAT', seatKeys.sessions(late), String(far)]);
    await h.started.appendStarted(startedEntry(h, late, newMember()));
    expect(await expireAt(redis, seatKeys.stream(late))).toBe(far);
    expect(await expireAt(redis, seatKeys.sessions(late))).toBe(far);
    expect((await h.members(late)).size).toBe(2);
    expect(await stream(redis, late)).toHaveLength(2);

    // 더 이른 수명: 둘 다 늘린다
    const early = newEvent();
    await cmd(redis, seatKeys.stream(early), ['XADD', seatKeys.stream(early), '*', 'type', 'HELD']);
    await cmd(redis, seatKeys.sessions(early), ['ZADD', seatKeys.sessions(early), '1', 'other']);
    await cmd(redis, seatKeys.stream(early), ['PEXPIREAT', seatKeys.stream(early), String(Date.now() + 60_000)]);
    await cmd(redis, seatKeys.sessions(early), ['PEXPIREAT', seatKeys.sessions(early), String(Date.now() + 60_000)]);
    const e = startedEntry(h, early, newMember());
    await h.started.appendStarted(e);
    expect(await expireAt(redis, seatKeys.stream(early))).toBe(e.maxStayUntilMs + SESSION_STARTED_KEEP_MS);
    expect(await expireAt(redis, seatKeys.sessions(early))).toBe(e.maxStayUntilMs + SESSION_STARTED_KEEP_MS);

    // 수명이 없는 색인(시험이 직접 만든 것): 늘린다
    const bare = newEvent();
    await cmd(redis, seatKeys.sessions(bare), ['ZADD', seatKeys.sessions(bare), '1', 'other']);
    expect(await expireAt(redis, seatKeys.sessions(bare))).toBe(-1);
    const b = startedEntry(h, bare, newMember());
    await h.started.appendStarted(b);
    expect(await expireAt(redis, seatKeys.sessions(bare))).toBe(b.maxStayUntilMs + SESSION_STARTED_KEEP_MS);
  });

  test('ADR0183_11_NX: 시작 사건을 다시 더하면(재시도) Stream에는 항목이 한 번 더 쌓이지만 색인 점수는 처음 값이나 점검이 민 값 그대로다', async () => {
    const h = indexHarness();
    const eventId = newEvent();
    const jti = newMember();
    const e = startedEntry(h, eventId, jti);
    await h.started.appendStarted(e);
    await h.index.requeue(eventId, jti, e.startedAtMs + SESSION_IDLE_MS + 123_000);
    await h.started.appendStarted(e);
    expect(await stream(redis, eventId)).toHaveLength(2);
    expect((await h.members(eventId)).get(jti)).toBe(e.startedAtMs + SESSION_IDLE_MS + 123_000);
  });
});

describe('RedisSessionEndedLog.appendEnded (Stream 항목과 정리 색인 빼기를 Lua 한 번에)', () => {
  test('ADR0183_11_QT11_Stream 칸은 sessionEndedFields 그대로(값은 모두 글)이고 PurchaseSessionEnded로 바뀌어 계약의 Zod 스키마(queue-svc 처리기가 읽는 모양)를 통과한다. 정리 색인에서는 그 jti가 빠진다', async () => {
    const h = indexHarness();
    const eventId = newEvent();
    for (const reason of ['COMPLETED', 'LEFT', 'IDLE', 'MAX_STAY'] as const) {
      const jti = newMember();
      await h.seed(eventId, jti, 1_000_000);
      const e = endedEntry(h, eventId, jti, reason);
      await h.ended.appendEnded(e);
      expect((await h.members(eventId)).has(jti)).toBe(false);
      const items = await stream(redis, eventId);
      const f = items[items.length - 1]!;
      expect(f).toEqual(Object.fromEntries(chunk(sessionEndedFields(e))));
      expect(f).toEqual({ type: SESSION_ENDED_TYPE, purchaseSessionId: jti, admissionJti: jti, reason, endedAtMs: String(e.endedAtMs) });
      const m = toPurchaseSessionEnded(eventId, f);
      expect(m).toMatchObject({ eventId, purchaseSessionId: jti, admissionJti: jti, reason, endedAt: new Date(e.endedAtMs).toISOString(), eventKey: sessionEndedEventKey(jti) });
      expect(PurchaseSessionEnded.parse(m)).toEqual(m);
    }
    expect(await stream(redis, eventId)).toHaveLength(4);
  });

  test('ADR0183_11_종료 항목을 처음 만든 Stream의 수명은 끝낸 시각 + 1일 [가정]이고, 더 늦은 수명은 그대로 두며 더 이르거나 없으면 늘린다(시작 사건과 같은 규칙)', async () => {
    const h = indexHarness();
    const fresh = newEvent();
    const e = endedEntry(h, fresh, newMember(), 'MAX_STAY');
    await h.ended.appendEnded(e);
    expect(await expireAt(redis, seatKeys.stream(fresh))).toBe(e.endedAtMs + SESSION_STARTED_KEEP_MS);

    const far = Date.now() + 30 * 24 * 3600_000;
    const late = newEvent();
    await cmd(redis, seatKeys.stream(late), ['XADD', seatKeys.stream(late), '*', 'type', 'HELD']);
    await cmd(redis, seatKeys.stream(late), ['PEXPIREAT', seatKeys.stream(late), String(far)]);
    await h.ended.appendEnded(endedEntry(h, late, newMember()));
    expect(await expireAt(redis, seatKeys.stream(late))).toBe(far);
    expect(await stream(redis, late)).toHaveLength(2);

    const early = newEvent();
    await cmd(redis, seatKeys.stream(early), ['XADD', seatKeys.stream(early), '*', 'type', 'HELD']);
    await cmd(redis, seatKeys.stream(early), ['PEXPIREAT', seatKeys.stream(early), String(Date.now() + 60_000)]);
    const e2 = endedEntry(h, early, newMember());
    await h.ended.appendEnded(e2);
    expect(await expireAt(redis, seatKeys.stream(early))).toBe(e2.endedAtMs + SESSION_STARTED_KEEP_MS);

    const noTtl = newEvent();
    await cmd(redis, seatKeys.stream(noTtl), ['XADD', seatKeys.stream(noTtl), '*', 'type', 'HELD']);
    expect(await expireAt(redis, seatKeys.stream(noTtl))).toBe(-1);
    const e3 = endedEntry(h, noTtl, newMember());
    await h.ended.appendEnded(e3);
    expect(await expireAt(redis, seatKeys.stream(noTtl))).toBe(e3.endedAtMs + SESSION_STARTED_KEEP_MS);
  });

  test('QT11_같은 회차 Stream에 시작 항목과 종료 항목이 더한 차례대로 쌓인다(SESSION_STARTED → SESSION_ENDED). 다른 종류 항목(HELD)이 있어도 건드리지 않는다', async () => {
    const h = indexHarness();
    const eventId = newEvent();
    const jti = newMember();
    await cmd(redis, seatKeys.stream(eventId), ['XADD', seatKeys.stream(eventId), '*', 'type', 'HELD', 'holdId', 'h-1']);
    await h.started.appendStarted(startedEntry(h, eventId, jti));
    await h.ended.appendEnded(endedEntry(h, eventId, jti, 'COMPLETED'));
    expect((await stream(redis, eventId)).map((f) => f.type)).toEqual(['HELD', SESSION_STARTED_TYPE, SESSION_ENDED_TYPE]);
    expect((await stream(redis, eventId))[0]).toEqual({ type: 'HELD', holdId: 'h-1' });
  });
});

describe('RedisSessionIndex (읽기·고치기 명령)', () => {
  test('QT11_due·requeue·drop은 색인 키의 수명을 바꾸지 않고, 색인이 없는 회차에는 키를 만들지 않는다', async () => {
    const h = indexHarness();
    const eventId = newEvent();
    const a = newMember();
    const b = newMember();
    await h.seed(eventId, a, 1_000);
    await h.seed(eventId, b, 2_000);
    const at = Date.now() + 3_600_000;
    await cmd(redis, seatKeys.sessions(eventId), ['PEXPIREAT', seatKeys.sessions(eventId), String(at)]);
    await h.index.due(eventId, 5_000, 10);
    await h.index.requeue(eventId, a, 3_000);
    await h.index.requeue(eventId, newMember(), 3_000);
    await h.index.drop(eventId, newMember());
    expect(await expireAt(redis, seatKeys.sessions(eventId))).toBe(at);
    await h.index.drop(eventId, b);
    expect(await expireAt(redis, seatKeys.sessions(eventId))).toBe(at);

    const bare = newEvent();
    await h.index.due(bare, 5_000, 10);
    await h.index.requeue(bare, a, 3_000);
    await h.index.drop(bare, a);
    expect(await exists(redis, seatKeys.sessions(bare))).toBe(false);
    expect(await exists(redis, seatKeys.stream(bare))).toBe(false);
  });
});

describe('Lua 모양', () => {
  test('ST28_QT11_시작·종료 사건 더하기 Lua는 #!lua로 시작한다(회차 Stream과 정리 색인 두 키를 쓰는 스크립트가 노드 하나짜리 클러스터 모드에서 돈다)', async () => {
    for (const lua of [APPEND_SESSION_STARTED_LUA, APPEND_SESSION_ENDED_LUA]) {
      expect(lua.startsWith('#!lua\n')).toBe(true);
      expect(lua.split('\n')[0]).toBe('#!lua');
    }
    const h = indexHarness(clusterRedis);
    const eventId = newEvent();
    const jti = newMember();
    await h.started.appendStarted(startedEntry(h, eventId, jti));
    expect((await h.members(eventId)).has(jti)).toBe(true);
    await h.ended.appendEnded(endedEntry(h, eventId, jti));
    expect((await h.members(eventId)).size).toBe(0);
  });
});

/** [이름, 값, 이름, 값, …] → [[이름, 값], …] */
function chunk(flat: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}
