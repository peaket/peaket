// 추가 검증 모듈이 쓴 PASSED·BLOCKED를 입장 확정이 그대로 읽는지 실제 Valkey 하나로 끝까지 본다(Q-T34 ②③④⑥, docs/features/queue-admission.md §6·§7, ADR-0259).
// 입장 확정 시험(admission-store.int)은 verify 칸을 시험이 직접 쓰고, 추가 검증 시험(verification-store.int)은 입장 확정을 부르지 않는다. 두 모듈의 약속
// (값 `PASSED:{통과 시각}:{사유}`·`BLOCKED:…`, 빠진 번호 비트는 끄지 않음, 유예는 차례와 통과 가운데 늦은 때부터)이 어긋나면 이 파일이 잡는다.
// 격리는 실제 진입(사전 검증 토큰의 vr)으로 만들고, 통과는 제출(사람 확인·재통과 가짜)과 이의 인정(결과 반영)으로 만든다.
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { admissionKeys as k, RedisAdmissionStore } from '../src/modules/admission/adapters/redis-admission-store.js';
import { AdmissionError } from '../src/modules/admission/application/admission-error.js';
import { ConfirmAdmission } from '../src/modules/admission/application/confirm-admission.js';
import { RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { DEFAULT_ENTRY_OPTIONS, EnterQueue, type EnterResult } from '../src/modules/entry/application/enter-queue.js';
import { RedisVerificationStore } from '../src/modules/verification/adapters/redis-verification-store.js';
import { ResolveVerificationAppeal } from '../src/modules/verification/application/appeals.js';
import { SubmitAppeal } from '../src/modules/verification/application/submit-appeal.js';
import { SubmitVerification } from '../src/modules/verification/application/submit-verification.js';
import { recordingSignals as admissionSignals, signer } from '../test/admission-cases.js';
import { ACCOUNT, DEVICE, newEvent, newRequest, OTHER_ACCOUNT, openSchedule, PID, preverifyToken, tokens } from '../test/support.js';
import { recordingCases, recordingReverification, recordingRisk, recordingSignals, TEST_OPTIONS } from '../test/verification-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
}, 120_000);

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key, deadlineMs: 5_000 });
/** 유예는 코드 상수(15분)·추가 검증 시험 값(7분)과 다른 11분으로 두 모듈에 같이 준다 */
const GRACE_MS = 11 * 60_000;
const OPTIONS = { ...TEST_OPTIONS, graceMs: GRACE_MS };

async function openEvent(): Promise<string> {
  const eventId = newEvent();
  const s = openSchedule(Date.now(), { lobbyShuffle: false, openBatch: true, batchWindowMs: 1 });
  await cmd(k.cfg(eventId), ['HSET', k.cfg(eventId), 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', '0', 'openBatch', '1', 'batchWindowMs', '1', 'rev', '1']);
  await cmd(k.batchDone(eventId), ['HSET', k.batchDone(eventId), '1', '1:0:1']);
  return eventId;
}

/** 실제 진입. vr이 있으면 진입이 빠진 번호 비트와 VERIFYING을 쓴다 */
async function enter(eventId: string, pid: string, account: string, vr?: 'DEVICE_HISTORY'): Promise<EnterResult> {
  const run = new EnterQueue(new RedisEntryStore(redis), new RedisEventSchedules(redis, systemClock), tokens, systemClock, DEFAULT_ENTRY_OPTIONS);
  return (await run.run({ accountId: account, sessionId: 's', pid, eventId, body: { preverifyToken: preverifyToken(systemClock, eventId, { a: account, ...(vr ? { vr } : {}) }), deviceId: DEVICE, entryRequestId: newRequest() } })) as EnterResult;
}

const confirm = () => new ConfirmAdmission(new RedisAdmissionStore(redis), new RedisEventSchedules(redis, systemClock), tokens, signer, admissionSignals(), systemClock, { turnGraceMs: GRACE_MS });
const admit = (eventId: string, pid: string, account: string, ticket: string) => confirm().run({ accountId: account, pid, sessionId: 's', eventId, body: { queueTicket: ticket } });
const verifyStore = () => new RedisVerificationStore(redis);
const isRemoved = async (e: string, seq: number) => Number(await cmd(k.removed(e), ['GETBIT', k.removed(e), String(seq)])) === 1;
const verifyOf = async (e: string, ticket: string) => {
  const v = await cmd(k.verify(e), ['HGET', k.verify(e), tokens.hash(ticket)]);
  return v === null || v === undefined ? null : String(v);
};
/** serving을 올리고 그 칸의 차례 시각을 적는다(리더 ADVANCE가 하는 일) */
async function advance(e: string, serving: number, atMs: number): Promise<void> {
  await cmd(k.serving(e), ['SET', k.serving(e), String(serving)]);
  await cmd(k.servingLog(e), ['ZADD', k.servingLog(e), String(serving), String(Math.floor(atMs / 1000))]);
}

async function appealAndResolve(eventId: string, pid: string, outcome: 'ACCEPTED' | 'REJECTED', version: number): Promise<string> {
  const out = await new SubmitAppeal(verifyStore(), new RedisEventSchedules(redis, systemClock), recordingCases('ok'), OPTIONS, systemClock, recordingSignals()).run({ eventId, accountId: ACCOUNT, pid, text: '재검토 바랍니다' });
  if (out.kind !== 'RECEIVED') throw new Error('이의가 접수되지 않았다');
  const r = await new ResolveVerificationAppeal(verifyStore(), systemClock).run({ appealId: out.appealId, caseId: `case-${eventId}`, caseVersion: version, outcome });
  expect(r).toBe('APPLIED');
  return out.appealId;
}

test('Q-T34 ②④ 실제 Valkey에서 이의 인정이 쓴 PASSED로 원래 번호의 차례에 ADMITTED이고 그 전에는 NOT_YET이며, 빠진 번호 비트와 뒤 대기자는 그대로다', async () => {
  const eventId = await openEvent();
  const pid = `${PID}-q4`;
  const iso = await enter(eventId, pid, ACCOUNT, 'DEVICE_HISTORY');
  const other = await enter(eventId, `${PID}-o4`, OTHER_ACCOUNT);
  expect(iso).toMatchObject({ verification: 'REQUIRED', verificationReason: 'DEVICE_HISTORY' });
  expect(other.seq).toBeGreaterThan(iso.seq);
  expect(await isRemoved(eventId, iso.seq)).toBe(true);
  // 격리 중: 차례가 와도 VERIFYING
  await advance(eventId, iso.seq - 1, Date.now());
  expect(await admit(eventId, pid, ACCOUNT, iso.queueTicket)).toMatchObject({ status: 'VERIFYING', verificationReason: 'DEVICE_HISTORY' });

  // 이의 인정(판 10): 추가 검증 모듈이 PASSED와 통과 시각을 쓴다
  await appealAndResolve(eventId, pid, 'ACCEPTED', 10);
  expect(await verifyOf(eventId, iso.queueTicket)).toMatch(/^PASSED:\d+:DEVICE_HISTORY$/);
  // 차례 전(serving = 번호 − 1): 입장 0건
  expect(await admit(eventId, pid, ACCOUNT, iso.queueTicket)).toMatchObject({ status: 'NOT_YET' });
  expect(Number((await cmd(k.admitted(eventId), ['GET', k.admitted(eventId)])) ?? 0)).toBe(0);
  // 원래 번호의 차례
  await advance(eventId, iso.seq, Date.now());
  expect(await admit(eventId, pid, ACCOUNT, iso.queueTicket)).toMatchObject({ status: 'ADMITTED' });
  // 빠진 번호 비트는 끄지 않았다(다른 대기자의 앞 인원 계산이 바뀌지 않는다). 뒤 대기자는 아직 차례 전이다
  expect(await isRemoved(eventId, iso.seq)).toBe(true);
  expect(await isRemoved(eventId, other.seq)).toBe(false);
  expect(await admit(eventId, `${PID}-o4`, OTHER_ACCOUNT, other.queueTicket)).toMatchObject({ status: 'NOT_YET' });
}, 60_000);

test('Q-T34 ③ 실제 Valkey에서 차례가 지난 뒤 제출로 통과하면 graceUntil이 통과 시각 + 유예이고 입장 확정도 같은 때부터 유예를 센다', async () => {
  const eventId = await openEvent();
  const pid = `${PID}-q3`;
  const iso = await enter(eventId, pid, ACCOUNT, 'DEVICE_HISTORY');
  // 차례는 20분 전에 지났다(유예 11분을 넘음)
  const turnAt = Date.now() - 20 * 60_000;
  await advance(eventId, iso.seq, turnAt);
  const before = Date.now();
  const r = await new SubmitVerification(verifyStore(), new RedisEventSchedules(redis, systemClock), recordingReverification('PASSED'), recordingRisk('ALLOW'), OPTIONS, systemClock, recordingSignals()).run({
    eventId,
    pid,
    accountId: ACCOUNT,
    challengeToken: 'tok-verify',
    deviceId: DEVICE,
  });
  const after = Date.now();
  if (r.result !== 'PASSED' || r.graceUntil === null) throw new Error(`통과가 아니다: ${JSON.stringify(r)}`);
  expect(r.queueNumber).toBe(iso.seq);
  const passedAt = Number(/^PASSED:(\d+):/.exec((await verifyOf(eventId, iso.queueTicket)) ?? '')?.[1]);
  // 통과 시각은 Valkey TIME이다. graceUntil = 통과 시각 + 유예(같은 값)
  expect(passedAt).toBeGreaterThanOrEqual(before - 1_000);
  expect(passedAt).toBeLessThanOrEqual(after + 1_000);
  expect(Date.parse(r.graceUntil)).toBe(passedAt + GRACE_MS);
  // 차례 + 유예는 지났지만 통과 + 유예 안이라 바로 입장한다
  expect(await admit(eventId, pid, ACCOUNT, iso.queueTicket)).toMatchObject({ status: 'ADMITTED' });
}, 60_000);

test('Q-T34 ③ 실제 Valkey에서 차례 전에 통과하고 차례가 통과 + 유예보다 뒤에 오면 유예를 차례부터 센다(차례 + 유예 안은 ADMITTED, 지나면 410)', async () => {
  // 두 회차에서 같은 일을 하고 차례 시각만 다르게 둔다: 차례 + 11분의 3초 전(ADMITTED)·3초 뒤(410)
  for (const [label, turnAgoMs, want] of [
    ['in', GRACE_MS - 3_000, 'ADMITTED'],
    ['out', GRACE_MS + 3_000, 'EXPIRED'],
  ] as const) {
    const eventId = await openEvent();
    const pid = `${PID}-q3${label}`;
    const iso = await enter(eventId, pid, ACCOUNT, 'DEVICE_HISTORY');
    const back = await enter(eventId, `${PID}-b3${label}`, OTHER_ACCOUNT);
    expect(back.seq).toBeGreaterThan(iso.seq);
    // 차례 전 통과(serving 0): graceUntil이 없고 원래 번호의 차례에 입장한다
    const submit = () =>
      new SubmitVerification(verifyStore(), new RedisEventSchedules(redis, systemClock), recordingReverification('PASSED'), recordingRisk('ALLOW'), OPTIONS, systemClock, recordingSignals()).run({
        eventId,
        pid,
        accountId: ACCOUNT,
        challengeToken: 'tok-verify',
        deviceId: DEVICE,
      });
    expect(await submit()).toMatchObject({ result: 'PASSED', queueNumber: iso.seq, graceUntil: null });
    const value = (await verifyOf(eventId, iso.queueTicket)) ?? '';
    const m = /^PASSED:(\d+):(DEVICE_HISTORY)$/.exec(value);
    if (!m) throw new Error(`추가 검증 모듈이 쓴 값이 약속과 다르다: ${value}`);
    // 시계를 돌릴 수 없어 '통과한 지 30분이 지났다'를 만든다: 모듈이 쓴 값의 모양·사유는 두고 통과 시각만 과거로 옮긴다. 차례 시각은 serving_log로 만든다
    const passedAt = Date.now() - 30 * 60_000;
    await cmd(k.verify(eventId), ['HSET', k.verify(eventId), tokens.hash(iso.queueTicket), `PASSED:${passedAt}:${m[2]}`]);
    const removedBefore = [await isRemoved(eventId, iso.seq), await isRemoved(eventId, back.seq)];
    const turnAt = Date.now() - turnAgoMs;
    expect(turnAt).toBeGreaterThan(passedAt + GRACE_MS);
    await advance(eventId, iso.seq, turnAt);
    // 통과한 참여에 다시 보낸 제출은 같은 PASSED이고, 마감은 늦은 쪽(차례) + 유예다
    const again = await submit();
    expect(again).toMatchObject({ result: 'PASSED', queueNumber: iso.seq });
    expect(again.result === 'PASSED' && again.graceUntil).toBe(new Date(Math.floor(turnAt / 1000) * 1000 + GRACE_MS).toISOString());
    if (want === 'ADMITTED') {
      expect(await admit(eventId, pid, ACCOUNT, iso.queueTicket)).toMatchObject({ status: 'ADMITTED' });
    } else {
      const e = await admit(eventId, pid, ACCOUNT, iso.queueTicket).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AdmissionError);
      expect(e).toMatchObject({ code: 'EXPIRED' });
    }
    // 공통 조건: 빠진 번호 비트(격리한 번호만 켜짐)는 그대로이고 뒤 대기자는 아직 차례 전이다
    expect([await isRemoved(eventId, iso.seq), await isRemoved(eventId, back.seq)]).toEqual(removedBefore);
    expect(removedBefore).toEqual([true, false]);
    expect(await admit(eventId, `${PID}-b3${label}`, OTHER_ACCOUNT, back.queueTicket)).toMatchObject({ status: 'NOT_YET' });
    expect(Number((await cmd(k.admitted(eventId), ['GET', k.admitted(eventId)])) ?? 0)).toBe(want === 'ADMITTED' ? 1 : 0);
  }
}, 60_000);

test('Q-T34 ⑥ 실제 Valkey에서 이의 기각이 쓴 BLOCKED는 입장 확정 410 queue-ticket-removed와 removeReason BLOCKED이고 제출도 410이다', async () => {
  const eventId = await openEvent();
  const pid = `${PID}-q6`;
  const iso = await enter(eventId, pid, ACCOUNT, 'DEVICE_HISTORY');
  await advance(eventId, iso.seq, Date.now());
  await appealAndResolve(eventId, pid, 'REJECTED', 9);
  expect(await verifyOf(eventId, iso.queueTicket)).toMatch(/^BLOCKED:\d+:DEVICE_HISTORY$/);
  const e = await admit(eventId, pid, ACCOUNT, iso.queueTicket).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(AdmissionError);
  expect(e).toMatchObject({ code: 'REMOVED', removeReason: 'BLOCKED' });
  const s = await new SubmitVerification(verifyStore(), new RedisEventSchedules(redis, systemClock), recordingReverification('PASSED'), recordingRisk('ALLOW'), OPTIONS, systemClock, recordingSignals())
    .run({ eventId, pid, accountId: ACCOUNT, challengeToken: 'tok-verify', deviceId: DEVICE })
    .catch((x: unknown) => x);
  expect(s).toMatchObject({ code: 'BLOCKED' });
  expect(await isRemoved(eventId, iso.seq)).toBe(true);
}, 60_000);
