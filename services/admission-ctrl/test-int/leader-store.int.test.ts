// 리더의 대기열 Redis Lua를 실제 Valkey 8.1로 돈다(docs/features/queue-admission.md §5, ADR-0056·0058·0104·0182).
// 이름은 명세 specs/queue.qnt의 동작 이름(acquire의 BUMP, plan·applyWrite의 ADVANCE·CLOSE)이다. Lua는 서버 시각을 쓰므로 시각은 Date.now() 기준으로 둔다.
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisLeaderStore, keys } from '../src/modules/leader/adapters/redis-leader-store.js';
import type { TickInput } from '../src/modules/leader/domain/ports.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let redis: HotRedis;
let store: RedisLeaderStore;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  store = new RedisLeaderStore(redis);
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

let n = 0;
const newEvent = () => `evt-lead-${process.pid}-${Date.now().toString(36)}-${n++}`;
const cmd = (key: string, args: string[]) => redis.command(args, { key });
const DAY = 86_400_000;

function tickOf(eventId: string, gen: number, o: Partial<TickInput> = {}): TickInput {
  return { eventId, gen, target: 5_000, ratioFloor: 0.2, saleStateFallback: 'ON_SALE', windowMs: 5_000, maxAdvance: 200, keepUntilMs: Date.now() + 2 * DAY, saleEndMs: Date.now() + DAY, lobbyShuffle: false, openBatch: false, closeAtMs: 0, ...o };
}
const serving = async (e: string) => Number((await cmd(keys.serving(e), ['GET', keys.serving(e)])) ?? 0);
const seqTo = (e: string, s: number) => cmd(keys.seq(e), ['SET', keys.seq(e), String(s)]);

test('[Q-T30] 새리더가세대를올리면_옛세대의전진은FENCED이고아무것도쓰지않는다', async () => {
  const e = newEvent();
  await seqTo(e, 1_000);
  expect(await store.bump(e, 1, Date.now() + DAY)).toBe('OK');
  expect((await store.tick(tickOf(e, 1))).kind).toBe('OK');
  expect(await serving(e)).toBe(200);
  expect(await store.bump(e, 2, Date.now() + DAY)).toBe('OK');
  expect((await store.tick(tickOf(e, 1))).kind).toBe('FENCED');
  expect(await store.bump(e, 1, Date.now() + DAY)).toBe('FENCED');
  expect(await serving(e)).toBe(200);
  expect(Number(await cmd(keys.leader(e), ['GET', keys.leader(e)]))).toBe(2);
});

test('[Q-T12] 리더가바뀌며옛리더와새리더가번갈아전진해도_serving은한번씩만오른다', async () => {
  const e = newEvent();
  await seqTo(e, 10_000);
  await store.bump(e, 1, Date.now() + DAY);
  await store.tick(tickOf(e, 1, { maxAdvance: 100 }));
  await store.bump(e, 2, Date.now() + DAY);
  for (let i = 0; i < 3; i++) {
    await store.tick(tickOf(e, 1, { maxAdvance: 100 }));
    await store.tick(tickOf(e, 2, { maxAdvance: 100 }));
  }
  expect(await serving(e)).toBe(400);
  // 전진 기록도 네 번(옛 리더의 거절된 전진은 남지 않는다)
  expect(Number(await cmd(keys.calls(e), ['ZCARD', keys.calls(e)]))).toBe(4);
});

test('serving은유효번호를센다_빠진번호와건너뛴구간은건너뛰고_발급된번호를넘지않으며_전진기록과차례시각기록을남긴다', async () => {
  const e = newEvent();
  await seqTo(e, 400);
  for (const s of [2, 3, 5]) await cmd(keys.removed(e), ['SETBIT', keys.removed(e), String(s), '1']);
  await cmd(keys.skipped(e), ['RPUSH', keys.skipped(e), '10:300:1']);
  await store.bump(e, 1, Date.now() + DAY);
  const r = await store.tick(tickOf(e, 1, { maxAdvance: 10 }));
  // 유효 번호 1,4,6,7,8,9, 그다음 10~300을 건너뛰고 301~304
  expect(r).toMatchObject({ kind: 'OK', serving: 304, advanced: 10 });
  const sec = Math.floor(Date.now() / 1000);
  // 클라이언트에 따라 [값, 점수]의 쌍이거나 펼친 배열이다
  const log = ((await cmd(keys.servingLog(e), ['ZRANGE', keys.servingLog(e), '0', '-1', 'WITHSCORES'])) as unknown[]).flat();
  expect(Math.abs(Number(log[0]) - sec)).toBeLessThanOrEqual(1);
  expect(Number(log[1])).toBe(304);
  const calls = ((await cmd(keys.calls(e), ['ZRANGE', keys.calls(e), '0', '-1', 'WITHSCORES'])) as unknown[]).flat();
  expect(String(calls[0])).toMatch(/^\d{13}:10$/);
  expect(Number(calls[1])).toBe(304);
  // 발급된 번호(400)를 넘지 않는다
  const r2 = await store.tick(tickOf(e, 1, { maxAdvance: 200 }));
  expect(r2).toMatchObject({ kind: 'OK', serving: 400, advanced: 96 });
});

test('빈자리는목표에서입장자리·곧입장·오는중을뺀만큼이고_지난자리와낡은곧입장항목은먼저정리한다', async () => {
  const e = newEvent();
  const now = Date.now();
  await seqTo(e, 100_000);
  // 쓰는 자리 2(하나는 지남), 곧 입장 3(하나는 9초 전 마지막 시도라 낡음)
  await cmd(keys.slots(e), ['ZADD', keys.slots(e), String(now + 60_000), 'a', String(now + 60_000), 'b', String(now - 1), 'c']);
  await cmd(keys.soon(e), ['ZADD', keys.soon(e), '10', 'x', '11', 'y', '12', 'z']);
  await cmd(keys.soonAt(e), ['ZADD', keys.soonAt(e), String(now - 1_000), 'x', String(now - 2_000), 'y', String(now - 9_000), 'z']);
  // 2초 전 전진(유효 30, 요청 10)은 오는 중 20, 7초 전 전진(창 5초 밖)은 세지 않는다, 61초 전 기록은 지운다
  await cmd(keys.calls(e), ['ZADD', keys.calls(e), '50', `${now - 61_000}:5`, '80', `${now - 7_000}:30`, '110', `${now - 2_000}:30`]);
  await cmd(keys.callReq(e), ['HSET', keys.callReq(e), `${now - 2_000}:30`, '10', `${now - 61_000}:5`, '5']);
  await store.bump(e, 1, now + DAY);
  const r = await store.tick(tickOf(e, 1, { target: 100, maxAdvance: 200 }));
  expect(r).toMatchObject({ kind: 'OK', slots: 2, soon: 2, inFlight: 20, dropped: 1, advanced: 100 - 2 - 2 - 20 });
  expect(Number(await cmd(keys.soonAt(e), ['ZSCORE', keys.soonAt(e), 'z']) ?? -1)).toBe(-1);
  expect(await cmd(keys.soon(e), ['ZSCORE', keys.soon(e), 'z'])).toBeNull();
  expect(Number(await cmd(keys.calls(e), ['ZCARD', keys.calls(e)]))).toBe(3);
  expect(await cmd(keys.callReq(e), ['HGET', keys.callReq(e), `${now - 61_000}:5`])).toBeNull();
});

test('리더는주기마다쓴목표를ctl의targetNow에남기고_낡은곧입장항목의처음SOON시각(soon_first)도함께지운다(ADR-0183)', async () => {
  const e = newEvent();
  const now = Date.now();
  await seqTo(e, 100);
  await cmd(keys.soon(e), ['ZADD', keys.soon(e), '10', 'x', '12', 'z']);
  await cmd(keys.soonAt(e), ['ZADD', keys.soonAt(e), String(now - 1_000), 'x', String(now - 9_000), 'z']);
  await cmd(keys.soonFirst(e), ['HSET', keys.soonFirst(e), 'x', String(now - 1_000), 'z', String(now - 20_000)]);
  await store.bump(e, 1, now + DAY);
  await store.tick(tickOf(e, 1, { target: 321 }));
  expect(await cmd(keys.ctl(e), ['HGET', keys.ctl(e), 'targetNow'])).toBe('321');
  expect(await cmd(keys.soonFirst(e), ['HGET', keys.soonFirst(e), 'z'])).toBeNull();
  expect(await cmd(keys.soonFirst(e), ['HGET', keys.soonFirst(e), 'x'])).toBe(String(now - 1_000));
  // 옛 세대의 전진은 목표도 쓰지 않는다
  await store.bump(e, 2, now + DAY);
  expect((await store.tick(tickOf(e, 1, { target: 7 }))).kind).toBe('FENCED');
  expect(await cmd(keys.ctl(e), ['HGET', keys.ctl(e), 'targetNow'])).toBe('321');
});

test('[Q-T33] 묶음표시가있으면_게시뒤분산창8초가지나기전에는serving이묶음첫번호를넘지않는다_게시가늦었으면21초다', async () => {
  const e = newEvent();
  const now = Date.now();
  await seqTo(e, 700);
  // 묶음 101~600, 그 앞 100은 묶음 전(로비 없음, 오픈 뒤 첫 진입이 아니라 앞 회차 시험값)
  await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), '1', '101:500:1']);
  await store.bump(e, 1, now + DAY);
  const t = (closeAtMs: number) => tickOf(e, 1, { openBatch: true, closeAtMs, maxAdvance: 200 });
  // 구간 끝은 12초 전이라 공개 예정(구간 끝 + 11초)은 1초 전이다
  expect(await store.tick(t(now - 12_000))).toMatchObject({ serving: 100, batchMarked: 1, batchPublished: 0 });
  // 공개 예정 전에 게시했고 7초가 지났다: 아직
  await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'pub:1', String(now - 7_000)]);
  expect(await store.tick(t(now - 12_000))).toMatchObject({ serving: 100, batchPublished: 1 });
  // 9초가 지났다: 오른다
  await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'pub:1', String(now - 9_000)]);
  expect(await store.tick(t(now - 12_000))).toMatchObject({ serving: 300 });
  // 다른 회차: 게시가 공개 예정보다 늦었으면 21초를 기다린다
  const f = newEvent();
  await seqTo(f, 700);
  await cmd(keys.batchDone(f), ['HSET', keys.batchDone(f), '1', '1:500:1', 'pub:1', String(now - 15_000)]);
  await store.bump(f, 1, now + DAY);
  const lateClose = now - 15_000 - 11_000 - 5_000;
  expect(await store.tick(tickOf(f, 1, { openBatch: true, closeAtMs: lateClose }))).toMatchObject({ serving: 0 });
  await cmd(keys.batchDone(f), ['HSET', keys.batchDone(f), 'pub:1', String(now - 22_000)]);
  expect(await store.tick(tickOf(f, 1, { openBatch: true, closeAtMs: now - 22_000 - 11_000 - 5_000 }))).toMatchObject({ serving: 200 });
});

test('로비셔플회차는로비표시가있는데로비게시가없으면_로비첫번호를넘지않는다', async () => {
  const e = newEvent();
  await seqTo(e, 50);
  await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'lobby', '1:40:1']);
  await store.bump(e, 1, Date.now() + DAY);
  expect(await store.tick(tickOf(e, 1, { lobbyShuffle: true }))).toMatchObject({ serving: 0, lobbyMarked: 1 });
  await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'pub:lobby', String(Date.now() - 9_000)]);
  expect(await store.tick(tickOf(e, 1, { lobbyShuffle: true }))).toMatchObject({ serving: 50 });
});

test('리더는오픈이지나면로비표시를_구간끝이지나면묶음표시를진입Lua와같은모양으로쓰고_인원만큼카운터를뗀다', async () => {
  const e = newEvent();
  const now = Date.now();
  await cmd(keys.lobbyMembers(e), ['SADD', keys.lobbyMembers(e), 'l1', 'l2', 'l3', 'l4']);
  await cmd(keys.batchMembers(e), ['SADD', keys.batchMembers(e), 'b1', 'b2', 'b3']);
  await store.bump(e, 1, now + DAY);
  const c = { eventId: e, gen: 1, keepUntilMs: now + DAY, opensAtMs: now - 1_000, lobbyShuffle: true, openBatch: true };
  // 구간 안: 로비만
  expect(await store.close({ ...c, closeAtMs: now + 60_000 })).toBe('OK');
  expect(String(await cmd(keys.batchDone(e), ['HGET', keys.batchDone(e), 'lobby']))).toBe('1:4:1');
  expect(await cmd(keys.batchDone(e), ['HGET', keys.batchDone(e), '1'])).toBeNull();
  // 구간 끝 뒤: 묶음
  expect(await store.close({ ...c, closeAtMs: now - 1 })).toBe('OK');
  expect(String(await cmd(keys.batchDone(e), ['HGET', keys.batchDone(e), '1']))).toBe('5:3:1');
  expect(Number(await cmd(keys.seq(e), ['GET', keys.seq(e)]))).toBe(7);
  // 다 섰으면 아무것도 하지 않는다
  expect(await store.close({ ...c, closeAtMs: now - 1 })).toBe('NONE');
  // 옛 세대는 쓰지 않는다
  await store.bump(e, 2, now + DAY);
  expect(await store.close({ ...c, closeAtMs: now - 1 })).toBe('FENCED');
});

test('리더의닫기도세대키를보고_장애전환뒤면쓰지않고RB05를돌려준다_RB05가건너뛴뒤에닫는다', async () => {
  const e = newEvent();
  const now = Date.now();
  await seqTo(e, 30);
  await cmd(keys.batchMembers(e), ['SADD', keys.batchMembers(e), 'b1', 'b2']);
  await cmd(keys.epoch(e), ['HSET', keys.epoch(e), 'node', 'old-primary']);
  await store.bump(e, 1, now + DAY);
  const c = { eventId: e, gen: 1, keepUntilMs: now + DAY, opensAtMs: now - 5_000, closeAtMs: now - 1, lobbyShuffle: false, openBatch: true };
  expect(await store.close(c)).toBe('RB05');
  expect(await cmd(keys.batchDone(e), ['HGET', keys.batchDone(e), '1'])).toBeNull();
  const r = await store.rb05({ eventId: e, expireAtMs: now + DAY, skippedExpireAtMs: now + DAY, skipBase: 10, opensAtMs: c.opensAtMs, closeAtMs: c.closeAtMs, lobbyShuffle: false, openBatch: true });
  // 묶음 표시가 없고 구간 끝이 지났으니 묶음 인원 2를 더 건너뛴다
  expect(r).toEqual({ kind: 'SKIPPED', start: 31, end: 42, gen: 2 });
  expect(await store.close(c)).toBe('OK');
  expect(String(await cmd(keys.batchDone(e), ['HGET', keys.batchDone(e), '1']))).toBe('43:2:2');
});

test('진행중인회차목록은점수(판매종료+1일)가지난회차를지우고_남은회차를준다', async () => {
  const a = newEvent();
  const b = newEvent();
  const now = Date.now();
  await cmd(keys.events(), ['ZADD', keys.events(), String(now + DAY), a, String(now - 1), b]);
  const ids = await store.activeEvents(now);
  expect(ids).toContain(a);
  expect(ids).not.toContain(b);
  expect(await cmd(keys.events(), ['ZSCORE', keys.events(), b])).toBeNull();
});

test('리더상태는운영자목표와수동고정만료_입장일시정지·판매일시정지·판매중지를읽는다', async () => {
  const e = newEvent();
  const now = Date.now();
  expect(await store.control(e, now)).toEqual({ paused: false });
  await cmd(keys.ctl(e), ['HSET', keys.ctl(e), 'target', '800', 'targetUntil', String(now + 60_000), 'admitPaused', '1']);
  expect(await store.control(e, now)).toEqual({ target: 800, paused: true });
  await cmd(keys.ctl(e), ['HSET', keys.ctl(e), 'targetUntil', String(now - 1), 'admitPaused', '0']);
  expect(await store.control(e, now)).toEqual({ paused: false });
  // 판매 일시정지(명령 3)·판매 중지도 하나라도 참이면 serving 전진을 멈춘다(ADR-0123)
  for (const f of ['paused', 'suspended']) {
    await cmd(keys.ctl(e), ['HSET', keys.ctl(e), f, '1']);
    expect(await store.control(e, now)).toEqual({ paused: true });
    await cmd(keys.ctl(e), ['HDEL', keys.ctl(e), f]);
  }
});

test('전진기록은판매종료까지_차례시각기록과serving은판매종료+1일까지둔다', async () => {
  const e = newEvent();
  const keep = Date.now() + 2 * DAY;
  const saleEnd = Date.now() + DAY;
  await seqTo(e, 10);
  await store.bump(e, 1, keep);
  await store.tick(tickOf(e, 1, { keepUntilMs: keep, saleEndMs: saleEnd }));
  const at = async (k: string) => Number(await cmd(k, ['PEXPIRETIME', k]));
  expect(await at(keys.calls(e))).toBe(saleEnd);
  expect(await at(keys.servingLog(e))).toBe(keep);
  expect(await at(keys.serving(e))).toBe(keep);
});

test('닫기는인원이0이면카운터를떼지않고표시만쓰며_할일이없어도리더키수명을둔다', async () => {
  const e = newEvent();
  const now = Date.now();
  const c = { eventId: e, gen: 1, keepUntilMs: now + DAY, opensAtMs: now - 5_000, closeAtMs: now - 1, lobbyShuffle: false, openBatch: true };
  expect(await store.close(c)).toBe('OK');
  expect(String(await cmd(keys.batchDone(e), ['HGET', keys.batchDone(e), '1']))).toBe('1:0:1');
  expect(await cmd(keys.seq(e), ['GET', keys.seq(e)])).toBeNull();
  // 새 세대의 첫 쓰기가 할 일 없는 닫기여도 리더 키에 수명이 있다
  expect(await store.close({ ...c, gen: 2 })).toBe('NONE');
  expect(Number(await cmd(keys.leader(e), ['PEXPIRETIME', keys.leader(e)]))).toBe(now + DAY);
});

test('일정사본은queue-svc와같이읽는다_묶음구간길이가1~60초밖이거나셔플·묶음을둘다끈사본은없는회차로본다', async () => {
  const e = newEvent();
  const k = keys.cfg(e);
  const base = ['opensAtMs', '1', 'startsAtMs', '2', 'rev', '1'];
  await cmd(k, ['HSET', k, ...base, 'lobbyShuffle', '0', 'openBatch', '1', 'batchWindowMs', '0']);
  expect(await store.schedule(e)).toBeNull();
  await cmd(k, ['HSET', k, 'batchWindowMs', '60001']);
  expect(await store.schedule(e)).toBeNull();
  await cmd(k, ['HSET', k, 'batchWindowMs', '1500', 'openBatch', '0']);
  expect(await store.schedule(e)).toBeNull();
  await cmd(k, ['HSET', k, 'openBatch', '1']);
  expect(await store.schedule(e)).toEqual({ opensAtMs: 1, startsAtMs: 2, lobbyShuffle: false, openBatch: true, batchWindowMs: 1500 });
});

test('입장일시정지는만료시각이지나면풀린다', async () => {
  const e = newEvent();
  const now = Date.now();
  await cmd(keys.ctl(e), ['HSET', keys.ctl(e), 'admitPaused', '1', 'admitPausedUntil', String(now + 60_000)]);
  expect(await store.control(e, now)).toEqual({ paused: true });
  await cmd(keys.ctl(e), ['HSET', keys.ctl(e), 'admitPausedUntil', String(now - 1)]);
  expect(await store.control(e, now)).toEqual({ paused: false });
});

describe('입장 비율(ADR-0104 결정 3)', () => {
  /** at초 전 전진(유효 valid, 처음 요청 req) */
  const call = async (e: string, agoMs: number, valid: number, req: number, last: number) => {
    const m = `${Date.now() - agoMs}:${valid}`;
    await cmd(keys.calls(e), ['ZADD', keys.calls(e), String(last), m]);
    if (req > 0) await cmd(keys.callReq(e), ['HSET', keys.callReq(e), m, String(req)]);
  };

  test('[Q-T8] 빈자리80_입장비율80%면serving이정확히100오르고_도착전다음주기에는오는중80을빼서더올리지않는다', async () => {
    const e = newEvent();
    await seqTo(e, 10_000);
    // 30초 전 전진: 유효 100 가운데 80이 입장 확정을 요청했다(비율 80%). 오는 중 창(5초) 밖이다
    await call(e, 30_000, 100, 80, 100);
    await cmd(keys.serving(e), ['SET', keys.serving(e), '100']);
    await store.bump(e, 1, Date.now() + DAY);
    const r1 = await store.tick(tickOf(e, 1, { target: 80 }));
    expect(r1).toMatchObject({ kind: 'OK', serving: 200, advanced: 100, ratio: 0.8 });
    const r2 = await store.tick(tickOf(e, 1, { target: 80 }));
    expect(r2).toMatchObject({ kind: 'OK', serving: 200, advanced: 0, inFlight: 80 });
  });

  test('[Q-T8] 불린지10초미만이거나60초를넘은전진은비율의모수에서빠지고_처음요청수(call_req,SOON포함)가분자다', async () => {
    const e = newEvent();
    await seqTo(e, 10_000);
    // 1초 전(오는 중 창 5초 안, 비율 창 밖), 30초 전(비율 창 안, 요청 25 = 입장 20 + SOON 5), 70초 전(창 밖, 지운다)
    await call(e, 1_000, 100, 0, 300);
    await call(e, 30_000, 50, 25, 200);
    await call(e, 70_000, 100, 100, 100);
    await cmd(keys.serving(e), ['SET', keys.serving(e), '300']);
    await store.bump(e, 1, Date.now() + DAY);
    const r = await store.tick(tickOf(e, 1, { target: 100 }));
    // 비율 0.5, 오는 중 = 100 × 0.5 - 0 = 50, 빈자리 50 ÷ 0.5 = 100
    expect(r).toMatchObject({ kind: 'OK', ratio: 0.5, inFlight: 50, advanced: 100 });
  });

  test('p는하한0.2를쓰고_비율은전진마다100%를넘지않으며_표본이없으면100%다', async () => {
    const low = newEvent();
    await seqTo(low, 10_000);
    await call(low, 30_000, 100, 5, 100);
    await store.bump(low, 1, Date.now() + DAY);
    expect(await store.tick(tickOf(low, 1, { target: 10 }))).toMatchObject({ ratio: 0.05, advanced: 50 });
    const high = newEvent();
    await seqTo(high, 10_000);
    // 건너뛴 구간의 옛 세대 번호까지 요청해 요청이 유효 수보다 많아도 그 전진은 100%로 자른다
    await call(high, 30_000, 10, 15, 10);
    await store.bump(high, 1, Date.now() + DAY);
    expect(await store.tick(tickOf(high, 1, { target: 10 }))).toMatchObject({ ratio: 1, advanced: 10 });
    const none = newEvent();
    await seqTo(none, 10_000);
    await store.bump(none, 1, Date.now() + DAY);
    expect(await store.tick(tickOf(none, 1, { target: 10 }))).toMatchObject({ ratio: 1, advanced: 10 });
  });
});

describe('판매 상태(ADR-0122)', () => {
  const notice = (e: string, ...kv: string[]) => cmd(`q:{event:${e}}:notice`, ['HSET', `q:{event:${e}}:notice`, ...kv]);

  test('[Q-T51] 일시매진·매진이면serving을올리지않고_매진이풀리면serving을매진때의마지막발급번호로옮긴뒤새로들어온사람부터부른다', async () => {
    const e = newEvent();
    await seqTo(e, 1_000);
    await cmd(keys.serving(e), ['SET', keys.serving(e), '100']);
    await store.bump(e, 1, Date.now() + DAY);
    for (const state of ['ALL_HELD', 'SOLD_OUT']) {
      await notice(e, 'saleState', state);
      expect(await store.tick(tickOf(e, 1))).toMatchObject({ kind: 'OK', serving: 100, advanced: 0, saleState: state });
    }
    // 매진 때의 마지막 발급 번호 500. 매진이 풀렸다
    await notice(e, 'saleState', 'ON_SALE', 'soldOutLastSeq', '500');
    const r = await store.tick(tickOf(e, 1, { maxAdvance: 50 }));
    expect(r).toMatchObject({ kind: 'OK', serving: 550, advanced: 50, saleState: 'ON_SALE' });
    // 옮긴 몫(101~500)은 부른 것이 아니라 전진 기록에는 이번 50만 남는다
    const calls = ((await cmd(keys.calls(e), ['ZRANGE', keys.calls(e), '0', '-1'])) as unknown[]).map(String);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/:50$/);
    // 이미 옮겼으면 다시 옮기지 않는다
    expect(await store.tick(tickOf(e, 1, { maxAdvance: 50 }))).toMatchObject({ serving: 600 });
  });

  test('옮기기는발급된번호와첫전진문을넘지않고_입장일시정지(전진0)중에는옮기지않으며_soldOutLastSeq가숫자가아니면옮기지않는다', async () => {
    const e = newEvent();
    await seqTo(e, 300);
    await store.bump(e, 1, Date.now() + DAY);
    await notice(e, 'saleState', 'ON_SALE', 'soldOutLastSeq', '500');
    // 일시정지(최대 전진 0): 순번은 그대로 둔다
    expect(await store.tick(tickOf(e, 1, { maxAdvance: 0 }))).toMatchObject({ serving: 0 });
    // 묶음 표시가 있고 게시 전이면 첫 번호 − 1(100)까지만
    await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), '1', '101:100:1']);
    expect(await store.tick(tickOf(e, 1, { openBatch: true, closeAtMs: Date.now() - 60_000 }))).toMatchObject({ serving: 100 });
    // 게시 뒤에는 발급된 번호(300)까지
    await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'pub:1', String(Date.now() - 60_000)]);
    expect(await store.tick(tickOf(e, 1, { openBatch: true, closeAtMs: Date.now() - 120_000, maxAdvance: 0 }))).toMatchObject({ serving: 100 });
    expect(await store.tick(tickOf(e, 1, { openBatch: true, closeAtMs: Date.now() - 120_000, maxAdvance: 1 }))).toMatchObject({ serving: 300 });
    const f = newEvent();
    await seqTo(f, 300);
    await store.bump(f, 1, Date.now() + DAY);
    await notice(f, 'saleState', 'ON_SALE', 'soldOutLastSeq', 'x');
    expect(await store.tick(tickOf(f, 1, { maxAdvance: 10 }))).toMatchObject({ kind: 'OK', serving: 10 });
  });

  test('판매상태를모르는동안(키나칸이없음)에는_리더가마지막으로본상태를쓴다', async () => {
    const e = newEvent();
    await seqTo(e, 1_000);
    await store.bump(e, 1, Date.now() + DAY);
    expect(await store.tick(tickOf(e, 1, { saleStateFallback: 'ALL_HELD' }))).toMatchObject({ serving: 0, advanced: 0, saleState: 'ALL_HELD' });
    expect(await store.tick(tickOf(e, 1))).toMatchObject({ serving: 200, saleState: 'ON_SALE' });
    // 키는 있는데 판매 상태 칸이 없다
    await notice(e, 'suspended', '0');
    expect(await store.tick(tickOf(e, 1, { saleStateFallback: 'SOLD_OUT' }))).toMatchObject({ serving: 200, saleState: 'SOLD_OUT' });
  });
});

test('[Q-T10] 한1초칸에여러번전진하고리더가바뀌어도_차례시각기록(serving_log)이칸마다마지막serving으로이어진다', async () => {
  const e = newEvent();
  await seqTo(e, 10_000);
  await store.bump(e, 1, Date.now() + DAY);
  // 한 1초 칸에 여러 번 전진한다(그 칸의 마지막 serving이 남는다)
  await store.tick(tickOf(e, 1, { maxAdvance: 10 }));
  await store.tick(tickOf(e, 1, { maxAdvance: 20 }));
  await store.bump(e, 2, Date.now() + DAY);
  await new Promise((r) => setTimeout(r, 1_100));
  await store.tick(tickOf(e, 2, { maxAdvance: 30 }));
  const log = ((await cmd(keys.servingLog(e), ['ZRANGE', keys.servingLog(e), '0', '-1', 'WITHSCORES'])) as unknown[]).flat().map(Number);
  // 1초 칸 둘: 앞 리더의 30, 새 리더의 60
  expect(log.filter((_, i) => i % 2 === 1)).toEqual([30, 60]);
  expect(log[2]! - log[0]!).toBeGreaterThanOrEqual(1);
});
