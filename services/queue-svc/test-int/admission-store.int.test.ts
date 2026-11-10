// 입장 확정 Lua를 실제 Valkey 8.1로 돈다(test/admission-cases.ts의 사례를 메모리 저장소와 똑같이). 진입 Lua와 한 Redis에서 함께 본다.
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { admissionKeys as k, RedisAdmissionStore } from '../src/modules/admission/adapters/redis-admission-store.js';
import { ConfirmAdmission } from '../src/modules/admission/application/confirm-admission.js';
import { RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { LeaveQueue } from '../src/modules/entry/application/leave-queue.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { admissionCases, recordingSignals, signer } from '../test/admission-cases.js';
import { pidTransitionAdmissionCases } from '../test/pid-transition-cases.js';
import { ACCOUNT, DEVICE, JNY, newEvent, openSchedule, PID, tokens } from '../test/support.js';
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

const cmd = (key: string, args: string[]) => redis.command(args, { key });
/** 다른 대기자의 앞 인원: 내 번호와 serving 사이에서 빠진 번호를 뺀 수(대기 상태 파일과 같은 셈, admission-cases의 aheadOf와 같다) */
const aheadOf = (seq: number, serving: number, removed: readonly number[]) => seq - serving - 1 - removed.filter((n) => n > serving && n < seq).length;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

async function writeSchedule(eventId: string, s: EventSchedule): Promise<void> {
  const key = k.cfg(eventId);
  await cmd(key, ['HSET', key, 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', s.lobbyShuffle ? '1' : '0', 'openBatch', s.openBatch ? '1' : '0', 'rev', '1']);
  if (s.layoutVersion !== undefined) await cmd(key, ['HSET', key, 'layoutVersion', String(s.layoutVersion)]);
}

function harness() {
  const schedules = Object.assign(new RedisEventSchedules(redis, systemClock), { set: writeSchedule });
  return {
    store: new RedisAdmissionStore(redis),
    clock: systemClock,
    schedules,
    setServing: async (e: string, n: number) => void (await cmd(k.serving(e), ['SET', k.serving(e), String(n)])),
    logServing: async (e: string, at: number, n: number) => void (await cmd(k.servingLog(e), ['ZADD', k.servingLog(e), String(n), String(Math.floor(at / 1000))])),
    addCall: async (e: string, last: number, at: number, valid: number) => {
      const m = `${at}:${valid}`;
      await cmd(k.calls(e), ['ZADD', k.calls(e), String(last), m]);
      return m;
    },
    callReq: async (e: string, m: string) => Number((await cmd(k.callReq(e), ['HGET', k.callReq(e), m])) ?? 0),
    setRemoved: async (e: string, seq: number) => void (await cmd(k.removed(e), ['SETBIT', k.removed(e), String(seq), '1'])),
    isRemoved: async (e: string, seq: number) => Number(await cmd(k.removed(e), ['GETBIT', k.removed(e), String(seq)])) === 1,
    setVerify: async (e: string, h: string, v: string) => void (await cmd(k.verify(e), ['HSET', k.verify(e), h, v])),
    verifyOf: async (e: string, h: string) => str(await cmd(k.verify(e), ['HGET', k.verify(e), h])),
    removedList: async (e: string) => {
      // 비트맵을 바이트로 읽어 켜진 번호를 센다(바이트 안 높은 비트부터, SETBIT과 같은 차례)
      const raw = (await redis.command(['GET', k.removed(e)], { key: k.removed(e), binary: true })) as Buffer | null;
      const out: number[] = [];
      if (raw) for (let i = 0; i < raw.length; i++) for (let b = 0; b < 8; b++) if ((raw[i]! >> (7 - b)) & 1) out.push(i * 8 + b);
      return out;
    },
    addSkipped: async (e: string, line: string) => void (await cmd(k.skipped(e), ['RPUSH', k.skipped(e), line])),
    setNotice: async (e: string, f: Record<string, string>) => void (await cmd(k.notice(e), ['HSET', k.notice(e), ...Object.entries(f).flat()])),
    setTarget: async (e: string, n: number) => void (await cmd(k.ctl(e), ['HSET', k.ctl(e), 'targetNow', String(n)])),
    addSlot: async (e: string, jti: string, at: number) => void (await cmd(k.slots(e), ['ZADD', k.slots(e), String(at), jti])),
    slots: async (e: string) => {
      const r = ((await cmd(k.slots(e), ['ZRANGE', k.slots(e), '0', '-1', 'WITHSCORES'])) as unknown[]).flat().map(String);
      const m = new Map<string, number>();
      for (let i = 0; i < r.length; i += 2) m.set(r[i]!, Number(r[i + 1]));
      return m;
    },
    soon: async (e: string) => ((await cmd(k.soon(e), ['ZRANGE', k.soon(e), '0', '-1'])) as unknown[]).map(String),
    soonFirst: async (e: string, h: string) => {
      const v = str(await cmd(k.soonFirst(e), ['HGET', k.soonFirst(e), h]));
      return v === null ? null : Number(v);
    },
    dropSoon: async (e: string, h: string) => {
      await cmd(k.soon(e), ['ZREM', k.soon(e), h]);
      await cmd(k.soonAt(e), ['ZREM', k.soonAt(e), h]);
      await cmd(k.soonFirst(e), ['HDEL', k.soonFirst(e), h]);
    },
    admitted: async (e: string) => Number((await cmd(k.admitted(e), ['GET', k.admitted(e)])) ?? 0),
    setDup: async (p: string, e: string, v: string) => void (await cmd(k.dup(p, e), ['SET', k.dup(p, e), v])),
    setLobbyResult: async (h: string, seq: number, gen: number, expireAtMs: number) => void (await cmd(k.lobbyResult(h), ['SET', k.lobbyResult(h), `${seq}:${gen}`, 'PXAT', String(expireAtMs)])),
    addLobbyMember: async (e: string, h: string) => void (await cmd(k.lobbyMembers(e), ['SADD', k.lobbyMembers(e), h])),
    setLobbyPublished: async (e: string, at: number) => void (await cmd(k.batchDone(e), ['HSET', k.batchDone(e), 'pub:lobby', String(at)])),
    lobbyRepair: async (e: string) => (await cmd(k.batchDone(e), ['HGET', k.batchDone(e), 'repair:lobby'])) as string | null,
    dup: async (p: string, e: string) => str(await cmd(k.dup(p, e), ['GET', k.dup(p, e)])),
    adm: async (p: string, e: string) => str(await cmd(k.adm(p, e), ['GET', k.adm(p, e)])),
    setAdm: async (p: string, e: string, v: string) => void (await cmd(k.adm(p, e), ['SET', k.adm(p, e), v])),
    setIssuedAt: async (e: string, h: string, at: number) => void (await cmd(k.slotOf(e), ['HSET', k.slotOf(e), `${h}:at`, String(at)])),
  };
}

admissionCases('Valkey Lua', async () => harness());
pidTransitionAdmissionCases('Valkey Lua', async () => harness());

test('[Valkey Lua] Q-T35② Q-T68③ 취소한 대기표의 입장 확정은 410 REMOVED이고 곧 입장 대기열에서 빠져 있다', async () => {
  const h = harness();
  const eventId = newEvent();
  const now = Date.now();
  await writeSchedule(eventId, openSchedule(now));
  await h.setServing(eventId, 200);
  await h.logServing(eventId, now - 60_000, 200);
  await h.setTarget(eventId, 0);
  const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, recordingSignals(), systemClock);
  const t = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 150, g: 1, seg: 0, rq: 'rq-1', jny: JNY });
  const hash = tokens.hash(t);
  await h.setDup(PID, eventId, `150:1:rq-1:${JNY}::${hash}`);
  expect((await app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).status).toBe('SOON');
  expect(await h.soon(eventId)).toEqual([hash]);
  await new LeaveQueue(new RedisEntryStore(redis), h.schedules).entry({ eventId, pid: PID });
  expect(await h.soon(eventId)).toEqual([]);
  expect(await h.soonFirst(eventId, hash)).toBeNull();
  await expect(app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).rejects.toMatchObject({ code: 'REMOVED' });
});

test('[Valkey Lua] Q-T34⑦ 추가 검증 중인 대기표도 취소하면 입장 확정이 VERIFYING이 아니라 410 REMOVED다', async () => {
  const h = harness();
  const eventId = newEvent();
  const now = Date.now();
  await writeSchedule(eventId, openSchedule(now));
  await h.setServing(eventId, 200);
  const signals = recordingSignals();
  const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, signals, systemClock);
  const t = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 150, g: 1, seg: 0, rq: 'rq-1', jny: JNY, vr: 'NETWORK' });
  const hash = tokens.hash(t);
  await h.setDup(PID, eventId, `150:1:rq-1:${JNY}:NETWORK:${hash}`);
  await h.setRemoved(eventId, 150);
  await h.setVerify(eventId, hash, `VERIFYING:${now}:NETWORK`);
  // 뒤 대기자 260의 앞 인원(공통 조건). 격리 때 켠 150의 비트는 취소해도 그대로라 앞 인원이 바뀌지 않는다
  const removedBefore = await h.removedList(eventId);
  const aheadBefore = aheadOf(260, 200, removedBefore);
  expect((await app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).status).toBe('VERIFYING');
  await new LeaveQueue(new RedisEntryStore(redis), h.schedules).entry({ eventId, pid: PID });
  await expect(app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).rejects.toMatchObject({ code: 'REMOVED' });
  expect(await h.removedList(eventId)).toEqual(removedBefore);
  expect(aheadOf(260, 200, await h.removedList(eventId))).toBe(aheadBefore);
  expect(await h.admitted(eventId)).toBe(0);
  expect(signals.seen.beforeTurn).toHaveLength(0);
});

test('[Valkey Lua] Q-T34 ⑦ 통과한 대기표도 취소하면 같은 대기표의 입장 확정이 410 REMOVED이고 PASSED 칸이 없다', async () => {
  const h = harness();
  const eventId = newEvent();
  const now = Date.now();
  await writeSchedule(eventId, openSchedule(now));
  // 차례 전(serving 100)이라 취소 전에는 NOT_YET으로 PASSED가 받아들여진 것을 본다
  await h.setServing(eventId, 100);
  const signals = recordingSignals();
  const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, signals, systemClock);
  const t = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 150, g: 1, seg: 0, rq: 'rq-1', jny: JNY, vr: 'NETWORK' });
  const hash = tokens.hash(t);
  await h.setDup(PID, eventId, `150:1:rq-1:${JNY}:NETWORK:${hash}`);
  await h.setRemoved(eventId, 150);
  await h.setVerify(eventId, hash, `PASSED:${now - 1_000}:NETWORK`);
  // 뒤 대기자 160의 앞 인원(공통 조건): 150은 격리 때부터 빠진 번호라 통과·취소 어느 때에도 바뀌지 않는다
  const removedBefore = await h.removedList(eventId);
  const aheadBefore = aheadOf(160, 100, removedBefore);
  // 차례 전 통과자는 확인 Lua가 센 NOT_YET(serving 기록이 없어 상한 60초)이고 자리가 없다
  expect(await app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).toMatchObject({ status: 'NOT_YET', retryAfterMs: 60_000 });
  expect(await h.admitted(eventId)).toBe(0);
  await new LeaveQueue(new RedisEntryStore(redis), h.schedules).entry({ eventId, pid: PID });
  expect(await h.verifyOf(eventId, hash)).toBeNull();
  expect(await h.removedList(eventId)).toEqual(removedBefore);
  expect(aheadOf(160, 100, await h.removedList(eventId))).toBe(aheadBefore);
  await h.setServing(eventId, 200);
  await h.logServing(eventId, now - 10_000, 200);
  await expect(app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).rejects.toMatchObject({ code: 'REMOVED' });
  expect(await h.slots(eventId)).toEqual(new Map());
  expect(await h.admitted(eventId)).toBe(0);
  expect(signals.seen.beforeTurn).toHaveLength(0);
});

test('[Valkey Lua] Q-T68① 목록을 고정하기 전에 취소한 참가 토큰은 게시 뒤 입장 확정이 403이다', async () => {
  const h = harness();
  const eventId = newEvent();
  const now = Date.now();
  await writeSchedule(eventId, { ...openSchedule(now), opensAtMs: now + 60_000 });
  const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, recordingSignals(), systemClock);
  const lobbyToken = tokens.lobby({ e: eventId, a: ACCOUNT, d: DEVICE, iat: now, jny: JNY });
  const hash = tokens.hash(lobbyToken);
  await h.addLobbyMember(eventId, hash);
  await h.setDup(PID, eventId, `LOBBY:${hash}:rq-1`);
  await new LeaveQueue(new RedisEntryStore(redis), h.schedules).lobby({ eventId, pid: PID });
  await h.setLobbyPublished(eventId, now);
  await expect(app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { lobbyToken } })).rejects.toMatchObject({ code: 'TICKET_INVALID' });
});

test('[Valkey Lua] Q-T68② 목록을 고정한 뒤 취소한 참가 토큰은 게시 뒤 입장 확정이 410 REMOVED다', async () => {
  const h = harness();
  const eventId = newEvent();
  const now = Date.now();
  const s = openSchedule(now);
  await writeSchedule(eventId, s);
  await h.setServing(eventId, 200);
  const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, recordingSignals(), systemClock);
  const lobbyToken = tokens.lobby({ e: eventId, a: ACCOUNT, d: DEVICE, iat: now - 600_000, jny: JNY });
  const hash = tokens.hash(lobbyToken);
  await h.addLobbyMember(eventId, hash);
  await h.setDup(PID, eventId, `LOBBY:${hash}:rq-1`);
  await cmd(k.batchDone(eventId), ['HSET', k.batchDone(eventId), 'lobby', '150:1:1']);
  await h.setLobbyResult(hash, 150, 1, s.startsAtMs);
  await h.setLobbyPublished(eventId, now);
  await new LeaveQueue(new RedisEntryStore(redis), h.schedules).entry({ eventId, pid: PID });
  expect(await h.isRemoved(eventId, 150)).toBe(true);
  await expect(app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { lobbyToken } })).rejects.toMatchObject({ code: 'REMOVED' });
});

test('[Valkey Lua] 입장한 사람은 진입 ①이 ADMITTED로 막고, 키 수명이 판매 종료·회차 키 수명을 따른다(Q-T35 ③)', async () => {
  const h = harness();
  const eventId = newEvent();
  const now = Date.now();
  const s = openSchedule(now);
  await writeSchedule(eventId, s);
  await h.setServing(eventId, 200);
  await h.logServing(eventId, now - 60_000, 200);
  const call = await h.addCall(eventId, 200, now - 60_000, 100);
  const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, recordingSignals(), systemClock);
  const t = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 150, g: 1, seg: 0, rq: 'rq-1', jny: JNY });
  expect((await app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).status).toBe('ADMITTED');
  expect(await h.callReq(eventId, call)).toBe(1);
  const entry = new RedisEntryStore(redis);
  expect(await entry.preempt({ pid: PID, eventId, requestId: 'rq-2', pendingTtlMs: 10_000 })).toEqual({ kind: 'ADMITTED' });
  const saleEnd = s.startsAtMs - 24 * 3600_000;
  expect(Number(await cmd(k.adm(PID, eventId), ['PEXPIRETIME', k.adm(PID, eventId)]))).toBe(saleEnd);
  expect(Number(await cmd(k.callReq(eventId), ['PEXPIRETIME', k.callReq(eventId)]))).toBe(saleEnd);
  expect(Number(await cmd(k.slots(eventId), ['PEXPIRETIME', k.slots(eventId)]))).toBe(saleEnd + 24 * 3600_000);
  expect(Number(await cmd(k.admits(eventId), ['PEXPIRETIME', k.admits(eventId)]))).toBe(saleEnd + 24 * 3600_000);
  expect(Number(await cmd(k.slotOf(eventId), ['PEXPIRETIME', k.slotOf(eventId)]))).toBe(saleEnd + 24 * 3600_000);
  expect(Number(await cmd(k.req(eventId), ['PEXPIRETIME', k.req(eventId)]))).toBe(saleEnd);
  // 다른 대기표의 409는 빠진 번호 비트를 회차 키 수명으로 켠다
  const t2 = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 160, g: 1, seg: 0, rq: 'rq-2', jny: JNY });
  await expect(app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t2 } })).rejects.toMatchObject({ code: 'DUPLICATE_ADMISSION' });
  expect(Number(await cmd(k.removed(eventId), ['PEXPIRETIME', k.removed(eventId)]))).toBe(saleEnd + 24 * 3600_000);
});

test('[Valkey Lua] 곧 입장 키 셋의 수명은 판매 종료다', async () => {
  const h = harness();
  const eventId = newEvent();
  const now = Date.now();
  const s = openSchedule(now);
  await writeSchedule(eventId, s);
  await h.setServing(eventId, 200);
  await h.logServing(eventId, now - 60_000, 200);
  await h.setTarget(eventId, 0);
  const app = new ConfirmAdmission(h.store, h.schedules, tokens, signer, recordingSignals(), systemClock);
  const t = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 150, g: 1, seg: 0, rq: 'rq-1', jny: JNY });
  expect((await app.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { queueTicket: t } })).status).toBe('SOON');
  const saleEnd = s.startsAtMs - 24 * 3600_000;
  for (const key of [k.soon(eventId), k.soonAt(eventId), k.soonFirst(eventId)]) expect(Number(await cmd(key, ['PEXPIRETIME', key]))).toBe(saleEnd);
});
