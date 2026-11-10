// 추가 검증 Lua를 실제 Valkey 8.1로 돈다(test/verification-cases.ts의 사례를 메모리 저장소와 똑같이, docs/data.md §3·§5 경합 ①②③, ADR-0259).
// 키의 수명(판매 종료 + 보관 기간, 제출 창)과 건드리지 않아야 하는 키(빠진 번호 비트)는 Valkey에서 직접 읽어 본다.
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { RedisVerificationStore, verificationKeys as vk } from '../src/modules/verification/adapters/redis-verification-store.js';
import { SubmitAppeal } from '../src/modules/verification/application/submit-appeal.js';
import { SubmitVerification } from '../src/modules/verification/application/submit-verification.js';
import { saleEndOf } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, newEvent, openSchedule, PID } from '../test/support.js';
import { hashOf, numberDup, recordingCases, recordingReverification, recordingRisk, recordingSignals, TEST_OPTIONS, type VerificationWorld, verificationCases } from '../test/verification-cases.js';
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

const cmd = (key: string, args: string[]) => redis.command(args, { key, deadlineMs: 5_000 });

async function writeSchedule(eventId: string, s: EventSchedule): Promise<void> {
  const key = keys.cfg(eventId);
  await cmd(key, ['HSET', key, 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', s.lobbyShuffle ? '1' : '0', 'openBatch', s.openBatch ? '1' : '0', 'rev', '1']);
}

const valkeyWorld = async (): Promise<VerificationWorld> => {
  const schedules = new RedisEventSchedules(redis, systemClock);
  return {
    store: new RedisVerificationStore(redis),
    schedules: Object.assign(schedules, { set: writeSchedule }),
    clock: systemClock,
    setDup: async (pid, e, v) => void (await cmd(keys.dup(pid, e), ['SET', keys.dup(pid, e), v])),
    setVerify: async (e, h, v) => void (await cmd(keys.verify(e), ['HSET', keys.verify(e), h, v])),
    verifyOf: async (e, h) => {
      const v = await cmd(keys.verify(e), ['HGET', keys.verify(e), h]);
      return v === null ? null : String(v);
    },
    setServing: async (e, n) => void (await cmd(keys.serving(e), ['SET', keys.serving(e), String(n)])),
    setServingLog: async (e, sec, n) => void (await cmd(keys.servingLog(e), ['ZADD', keys.servingLog(e), String(n), String(sec)])),
    setLobbyResult: async (h, seq, gen) => void (await cmd(keys.lobbyResult(h), ['SET', keys.lobbyResult(h), `${seq}:${gen}`])),
    appealRaw: async (pid, e) => {
      const k = vk.appeal(pid, e);
      // 응답은 칸·값을 번갈아 둔 배열이거나 객체다(연결 프로토콜에 따라)
      const raw = (await cmd(k, ['HGETALL', k])) as unknown;
      const pairs: [string, string][] = Array.isArray(raw)
        ? Array.from({ length: raw.length / 2 }, (_, i) => [String(raw[2 * i]), String(raw[2 * i + 1])] as [string, string])
        : Object.entries((raw ?? {}) as Record<string, unknown>).map(([f, v]) => [f, String(v)] as [string, string]);
      return Object.fromEntries(pairs.filter(([f]) => !['pc', 'pv', 'po'].includes(f)));
    },
    passTime: (ms) => new Promise((r) => setTimeout(r, ms)),
    vsubOf: async (pid, e) => {
      const v = await cmd(vk.vsub(pid, e), ['GET', vk.vsub(pid, e)]);
      return v === null ? null : Number(String(v));
    },
    setRemoved: async (e, seq) => void (await cmd(keys.removed(e), ['SETBIT', keys.removed(e), String(seq), '1'])),
    removedOf: async (e, seq) => Number(await cmd(keys.removed(e), ['GETBIT', keys.removed(e), String(seq)])) === 1,
  };
};

verificationCases('Valkey', valkeyWorld);

test('B-T10 ① 이의 키·이의 ID 색인·건 ID 색인의 수명은 판매 종료 + 보관 기간이고 제출 수 키는 창 수명이다', async () => {
  const w = await valkeyWorld();
  const eventId = newEvent();
  const schedule = openSchedule(Date.now());
  await writeSchedule(eventId, schedule);
  const ticket = hashOf(`ttl-${eventId}`);
  await w.setDup(PID, eventId, numberDup(3, ticket));
  await w.setVerify(eventId, ticket, `VERIFYING:${Date.now() - 1_000}:NETWORK`);
  const appeal = new SubmitAppeal(w.store, w.schedules, recordingCases('ok'), TEST_OPTIONS, systemClock, recordingSignals());
  const r = await appeal.run({ eventId, accountId: ACCOUNT, pid: PID, text: '수명' });
  if (r.kind !== 'RECEIVED') throw new Error('접수되지 않았다');
  const expireAt = saleEndOf(schedule) + TEST_OPTIONS.appealKeepAfterSaleEndMs;
  const at = async (k: string) => Number(await cmd(k, ['PEXPIRETIME', k]));
  expect(await at(vk.appeal(PID, eventId))).toBe(expireAt);
  expect(await at(vk.appealId(r.appealId))).toBe(expireAt);
  expect(String(await cmd(vk.appealId(r.appealId), ['GET', vk.appealId(r.appealId)]))).toBe(`${eventId}:${PID}`);
  const caseId = `case-ttl-${eventId}`;
  await w.store.claimCase(caseId, r.appealId, expireAt);
  expect(await at(vk.appealCase(caseId))).toBe(expireAt);
  // 제출 수 키(trust-svc 검증을 부른 제출만 센다): 첫 제출이 창 수명으로 만들고 뒤 제출은 늘리지 않는다
  const submit = new SubmitVerification(w.store, w.schedules, recordingReverification('PASSED'), recordingRisk('CHALLENGE'), TEST_OPTIONS, systemClock, recordingSignals());
  await submit.run({ eventId, accountId: ACCOUNT, pid: PID, challengeToken: 't' });
  const first = Number(await cmd(vk.vsub(PID, eventId), ['PTTL', vk.vsub(PID, eventId)]));
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(TEST_OPTIONS.submitWindowMs);
  await new Promise((res) => setTimeout(res, 150));
  await submit.run({ eventId, accountId: ACCOUNT, pid: PID, challengeToken: 't' });
  expect(Number(await cmd(vk.vsub(PID, eventId), ['PTTL', vk.vsub(PID, eventId)]))).toBeLessThan(first);
  // verify 칸 HSET은 회차 키의 수명을 바꾸지 않는다
  await cmd(keys.verify(eventId), ['PEXPIREAT', keys.verify(eventId), String(saleEndOf(schedule))]);
  await new SubmitVerification(w.store, w.schedules, recordingReverification('PASSED'), recordingRisk('ALLOW'), { ...TEST_OPTIONS, submitLimit: 10 }, systemClock, recordingSignals()).run({ eventId, accountId: ACCOUNT, pid: PID, challengeToken: 't' });
  expect(await at(keys.verify(eventId))).toBe(saleEndOf(schedule));
});

test('B-T11 통과 Lua는 Valkey 서버 시각으로 PASSED를 쓰고 사유 범주를 그대로 둔다', async () => {
  const w = await valkeyWorld();
  const eventId = newEvent();
  const ticket = hashOf(`time-${eventId}`);
  await w.setVerify(eventId, ticket, 'VERIFYING:1000:HUMAN_CHECK');
  const t = (await redis.command(['TIME'], { deadlineMs: 5_000 })) as unknown[];
  const serverNow = Number(String(t[0])) * 1000 + Math.floor(Number(String(t[1])) / 1000);
  const r = await w.store.settleVerify(eventId, ticket, 'PASSED');
  expect(r.kind).toBe('APPLIED');
  const m = /^PASSED:(\d+):HUMAN_CHECK$/.exec(r.kind === 'GONE' ? '' : r.value);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeGreaterThanOrEqual(serverNow);
  expect(Number(m![1])).toBeLessThan(serverNow + 5_000);
  expect(await w.verifyOf(eventId, ticket)).toBe(r.kind === 'GONE' ? null : r.value);
  // 두 번째는 바꾸지 않고 지금 값을 준다
  expect(await w.store.settleVerify(eventId, ticket, 'BLOCKED')).toEqual({ kind: 'CURRENT', value: r.kind === 'GONE' ? '' : r.value, serving: 0 });
  expect(await w.store.settleVerify(eventId, hashOf('없음'), 'PASSED')).toEqual({ kind: 'GONE', serving: 0 });
});

test('[ASVS v5.0.0-2.3.2] B-T6 ④ 제출 수 되돌리기 Lua는 하나만 내리고 0 아래로 가지 않으며 창 수명을 그대로 둔다', async () => {
  const w = await valkeyWorld();
  const eventId = newEvent();
  const key = vk.vsub(PID, eventId);
  await w.store.countSubmit(PID, eventId, 5_000);
  await w.store.countSubmit(PID, eventId, 5_000);
  const ttl = Number(await cmd(key, ['PTTL', key]));
  await w.store.uncountSubmit(PID, eventId);
  expect(String(await cmd(key, ['GET', key]))).toBe('1');
  await w.store.uncountSubmit(PID, eventId);
  await w.store.uncountSubmit(PID, eventId);
  expect(String(await cmd(key, ['GET', key]))).toBe('0');
  const after = Number(await cmd(key, ['PTTL', key]));
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(ttl);
  // 키가 없으면 아무것도 만들지 않는다
  await w.store.uncountSubmit(PID, newEvent());
  expect(await cmd(vk.vsub(PID, 'none'), ['EXISTS', vk.vsub(PID, 'none')])).toBe(0);
});
