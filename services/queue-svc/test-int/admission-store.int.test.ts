// 입장 확정 Lua를 실제 Valkey 8.1로 돈다(test/admission-cases.ts의 사례를 메모리 저장소와 똑같이). 진입 Lua와 한 Redis에서 함께 본다.
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { admissionKeys as k, RedisAdmissionStore } from '../src/modules/admission/adapters/redis-admission-store.js';
import { ConfirmAdmission } from '../src/modules/admission/application/confirm-admission.js';
import { RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
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
