// 탈퇴 계정의 사람 키 만료 당기기의 Valkey 통합 시험(실제 Valkey 8.1, docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', BUILD_ORDER BOT-037, I-T27).
// 진행 중인 회차 목록(q:{admission}:events)을 읽고 한 pid의 q:dup·q:adm에 PEXPIREAT … LT를 거는 Lua를 실제로 돈다.
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys, RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { EVENTS_KEY } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { RedisWithdrawnDue, wdrKeys } from '../src/modules/entry/adapters/redis-withdrawn-due.js';
import { RedisWithdrawnKeys } from '../src/modules/entry/adapters/redis-withdrawn-keys.js';
import { PurgeWithdrawnKeys } from '../src/modules/entry/application/purge-withdrawn-keys.js';
import { newEvent } from '../test/support.js';
import { withdrawnDueCases } from '../test/withdrawn-due-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const DAY = 86_400_000;
const cmd = (key: string, args: string[]) => redis.command(args, { key });
const expireTime = async (key: string) => Number(await cmd(key, ['PEXPIRETIME', key]));
const pid = (n: number) => Buffer.alloc(32, n).toString('base64url');

/** 지금 Valkey 시각(밀리초). 키 만료는 서버 시계로 센다 */
async function serverNow(): Promise<number> {
  const [s, us] = (await cmd('t', ['TIME'])) as [string, string];
  return Number(s) * 1000 + Math.floor(Number(us) / 1000);
}

async function world() {
  const now = await serverNow();
  const clock = fakeClock({ now });
  const purge = new PurgeWithdrawnKeys(new RedisWithdrawnKeys(redis), clock);
  const live = newEvent();
  const other = newEvent();
  const gone = newEvent();
  // 진행 중인 회차 둘(점수 = 회차 키 수명)과 이미 지난 회차 하나
  await cmd(EVENTS_KEY, ['ZADD', EVENTS_KEY, String(now + 30 * DAY), live, String(now + 10 * DAY), other, String(now - DAY), gone]);
  return { now, purge, live, other, gone };
}

test('I-T27_Valkey에서_진행중인회차마다그pid의두키만료를purgeBy로당기고_더이른만료와다른pid와지난회차는그대로이며_다시받아도같다', async () => {
  const w = await world();
  const p = pid(21);
  const someoneElse = pid(22);
  const purgeBy = w.now + 4 * DAY;
  // 판매 종료까지 남은 대기 기록, 만료 없는 입장 기록, 기한보다 일찍 지워질 키
  await cmd(keys.dup(p, w.live), ['SET', keys.dup(p, w.live), '1:1:req:jny:', 'PXAT', String(w.now + 29 * DAY)]);
  await cmd(keys.adm(p, w.live), ['SET', keys.adm(p, w.live), 'hash:mark']);
  await cmd(keys.dup(p, w.other), ['SET', keys.dup(p, w.other), '2:1:req:jny:', 'PXAT', String(w.now + DAY)]);
  await cmd(keys.dup(p, w.gone), ['SET', keys.dup(p, w.gone), '3:1:req:jny:', 'PXAT', String(w.now + 40 * DAY)]);
  await cmd(keys.dup(someoneElse, w.live), ['SET', keys.dup(someoneElse, w.live), '4:1:req:jny:', 'PXAT', String(w.now + 29 * DAY)]);

  const r = await w.purge.run({ pids: [p], purgeBy });
  expect(r.events).toBeGreaterThanOrEqual(2);
  expect(await expireTime(keys.dup(p, w.live))).toBe(purgeBy);
  expect(await expireTime(keys.adm(p, w.live))).toBe(purgeBy);
  // 이미 더 일찍 지워질 키는 그대로, 없는 키는 만들지 않는다
  expect(await expireTime(keys.dup(p, w.other))).toBe(w.now + DAY);
  expect(Number(await cmd(keys.adm(p, w.other), ['EXISTS', keys.adm(p, w.other)]))).toBe(0);
  // 목록에서 지난 회차와 다른 사람의 키는 건드리지 않는다
  expect(await expireTime(keys.dup(p, w.gone))).toBe(w.now + 40 * DAY);
  expect(await expireTime(keys.dup(someoneElse, w.live))).toBe(w.now + 29 * DAY);
  // 그 사이 키는 남아 같은 회차의 다시 줄 서기를 막는다(값 그대로)
  expect(String(await cmd(keys.dup(p, w.live), ['GET', keys.dup(p, w.live)]))).toBe('1:1:req:jny:');
  // 같은 사건을 다시 받아도 결과가 같다
  await w.purge.run({ pids: [p], purgeBy });
  expect(await expireTime(keys.dup(p, w.live))).toBe(purgeBy);
  // 기한 전에는 같은 pid(다시 가입한 같은 사람)가 같은 회차에 새로 선점하지 못한다(진입 Lua, I-T27)
  const store = new RedisEntryStore(redis);
  expect((await store.preempt({ pid: p, eventId: w.live, requestId: 'again-1', pendingTtlMs: 10_000 })).kind).toBe('ADMITTED');
  // 입장 기록이 없는 회차는 다른 요청의 대기 기록이 있어 '이미 대기 중'(BUSY → 409)이다
  expect((await store.preempt({ pid: p, eventId: w.other, requestId: 'again-2', pendingTtlMs: 10_000 })).kind).toBe('BUSY');
});

test('I-T27_Valkey에서_purgeBy가이미지났으면_두키를바로지우고_옛pid도같다', async () => {
  const w = await world();
  const p = pid(31);
  const prev = pid(32);
  for (const x of [p, prev]) {
    await cmd(keys.dup(x, w.live), ['SET', keys.dup(x, w.live), '1:1:req:jny:', 'PXAT', String(w.now + 29 * DAY)]);
    await cmd(keys.adm(x, w.live), ['SET', keys.adm(x, w.live), 'hash:mark', 'PXAT', String(w.now + 29 * DAY)]);
  }
  await w.purge.run({ pids: [p, prev], purgeBy: w.now - 1_000 });
  for (const x of [p, prev]) {
    expect(Number(await cmd(keys.dup(x, w.live), ['EXISTS', keys.dup(x, w.live)]))).toBe(0);
    expect(Number(await cmd(keys.adm(x, w.live), ['EXISTS', keys.adm(x, w.live)]))).toBe(0);
  }
  // 기한이 지나면 같은 사람이 그 회차에 다시 선점할 수 있다(5일 뒤는 남는 한계, identity §8)
  const store = new RedisEntryStore(redis);
  expect((await store.preempt({ pid: p, eventId: w.live, requestId: 'again-3', pendingTtlMs: 10_000 })).kind).toBe('PROCEED');
});

test('I-T27_Valkey에서_진행중인회차가한번에읽는수보다많아도_모두건다', async () => {
  const now = await serverNow();
  const p = pid(41);
  const many = Array.from({ length: 520 }, () => newEvent());
  for (let i = 0; i < many.length; i += 100) {
    const part = many.slice(i, i + 100).flatMap((e) => [String(now + 20 * DAY), e]);
    await cmd(EVENTS_KEY, ['ZADD', EVENTS_KEY, ...part]);
  }
  const last = many[many.length - 1]!;
  await cmd(keys.dup(p, last), ['SET', keys.dup(p, last), '9:1:req:jny:', 'PXAT', String(now + 19 * DAY)]);
  const purge = new PurgeWithdrawnKeys(new RedisWithdrawnKeys(redis), fakeClock({ now }));
  expect((await purge.run({ pids: [p], purgeBy: now + 4 * DAY })).events).toBeGreaterThanOrEqual(many.length);
  expect(await expireTime(keys.dup(p, last))).toBe(now + 4 * DAY);
});

// 처리할 때 집합은 지금 시각을 앱 시계로 넘긴다(Lua의 TIME을 쓰지 않는다). 값의 만료(PXAT purgeBy)는 실제 시각이라, 기한이 지난 값은 앱이 purgeBy로도 거른다
withdrawnDueCases('Valkey Lua', async () => {
  const clock = fakeClock({ now: Date.now() });
  return { due: new RedisWithdrawnDue(redis, clock), clock, dropValue: async (k) => void (await redis.command(['DEL', wdrKeys.value(k)], { key: wdrKeys.value(k) })) };
});
