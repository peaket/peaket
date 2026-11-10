// 받는 층: 추가 검증 제출·이의·상태 읽기(openapi POST·GET /v1/queues/{eventId}/verification, ADR-0259 결정 2~4).
// 서비스 뼈대(createService)와 AppModule 메모리 조립으로 실제 HTTP 처리 줄(신원 머리·역할·본문 검사·응답 스키마·Problem)을 돈다. identity·trust·건 요청은 포트의 가짜다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { QueueVerificationAppealReceipt, QueueVerificationResult, QueueVerificationState } from '@peaket/contracts/openapi/model';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import type { HumanVerdict, ReverificationResult } from '../src/modules/verification/domain/ports.js';
import { ACCOUNT, DEVICE, newEvent, openSchedule, PID, recordingRisk as entryRisk, tokens } from './support.js';
import { hashOf, numberDup, recordingCases, recordingReverification, recordingRisk, TEST_OPTIONS } from './verification-cases.js';

let svc: Awaited<ReturnType<typeof createService>>;
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const schedules = new MemoryEventSchedules();
const NOW = Date.parse('2026-11-10T03:00:00Z');
const clock = fakeClock({ now: NOW });
const store = new MemoryVerificationStore(clock);
let reverify: ReverificationResult = 'PASSED';
let human: HumanVerdict = 'ALLOW';
const reverification = recordingReverification(async () => reverify);
const risk = recordingRisk(async () => human);
const cases = recordingCases('ok');

beforeAll(async () => {
  svc = await createService({
    name: 'queue-svc',
    module: AppModule.register({ memory: true, schedules, tokens, risk: entryRisk(), verification: { store, reverification, risk, cases, options: TEST_OPTIONS } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

const fan = (o: { pid?: string | null; scope?: string } = {}) => ({
  'x-user-id': ACCOUNT,
  'x-session-id': 's-1',
  'x-user-aud': 'fan',
  'x-user-scope': o.scope ?? 'ticket:buy',
  ...(o.pid === null ? {} : { 'x-user-pid': o.pid ?? PID }),
});

/** 추가 검증 중인 대기 참여 하나(번호 7, VERIFYING) */
async function verifying(o: { seq?: number; serving?: number } = {}) {
  const eventId = newEvent();
  await schedules.set(eventId, openSchedule(NOW));
  const ticket = hashOf(`http-${eventId}`);
  store.db.dup.set(`${PID}|${eventId}`, numberDup(o.seq ?? 7, ticket));
  store.db.verifyOf(eventId).set(ticket, `VERIFYING:${NOW - 60_000}:DEVICE_HISTORY`);
  if (o.serving !== undefined) store.db.serving.set(eventId, o.serving);
  return { eventId, ticket };
}

const post = (eventId: string, payload: string | object, o: { headers?: Record<string, string>; contentType?: string } = {}) =>
  svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/verification`, headers: { ...fan(), 'content-type': o.contentType ?? 'application/json', ...o.headers }, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const get = (eventId: string, headers: Record<string, string> = fan()) => svc.http.inject({ method: 'GET', url: `/v1/queues/${eventId}/verification`, headers });
const typeOf = (r: { payload: string }) => String((JSON.parse(r.payload) as { type?: string }).type ?? '');

describe('추가 검증 경로', () => {
  test('B-T11 제출이 통과하면 200 QueueVerificationResult이고 캐시하지 않는다', async () => {
    reverify = 'PASSED';
    human = 'ALLOW';
    const { eventId, ticket } = await verifying({ seq: 7, serving: 3 });
    const r = await post(eventId, { challengeToken: 'verify-ok', deviceId: DEVICE });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload);
    expect(body).toEqual({ result: 'PASSED', queueNumber: 7, graceUntil: null });
    expect(QueueVerificationResult.safeParse(body).success).toBe(true);
    expect(store.db.verify.get(eventId)!.get(ticket)).toMatch(/^PASSED:/);
    // 게이트웨이가 넘긴 요청 정보를 사람 확인 검증에 싣는다
    expect(risk.calls.at(-1)).toMatchObject({ humanCheckToken: 'verify-ok', deviceId: DEVICE, client: expect.objectContaining({ ip: expect.any(String) }) });
  });

  test('B-T11 차례가 지난 뒤 통과하면 200 본문의 graceUntil이 통과 시각 + 유예다(응답 스키마가 날짜를 그대로 싣는다)', async () => {
    reverify = 'PASSED';
    human = 'ALLOW';
    const { eventId, ticket } = await verifying({ seq: 7, serving: 9 });
    const r = await post(eventId, { challengeToken: 'verify-ok' });
    expect(r.statusCode).toBe(200);
    const passedAt = Number(/^PASSED:(\d+):/.exec(store.db.verify.get(eventId)!.get(ticket)!)![1]);
    expect(JSON.parse(r.payload)).toEqual({ result: 'PASSED', queueNumber: 7, graceUntil: new Date(passedAt + TEST_OPTIONS.graceMs).toISOString() });
  });

  test('B-T11 B-T6 ④ 사람 확인 통과 뒤 PASSED 쓰기 전에 대기열 Redis가 끊기면 제출은 503과 Retry-After이고 verify 칸은 VERIFYING 그대로다', async () => {
    reverify = 'PASSED';
    human = 'ALLOW';
    const { eventId, ticket } = await verifying();
    const settle = store.settleVerify.bind(store);
    let cut = 0;
    store.settleVerify = async (...a) => {
      if (cut++ === 0) throw new QueueStoreUnavailable(new Error('쓰기 전 끊김'));
      return settle(...a);
    };
    try {
      const r = await post(eventId, { challengeToken: 'tok-http' });
      expect(r.statusCode).toBe(503);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(cut).toBe(1);
      expect(store.db.verify.get(eventId)!.get(ticket)).toMatch(/^VERIFYING:/);
    } finally {
      store.settleVerify = settle;
    }
  });

  test('B-T11 재통과가 없으면 200 REVERIFY_REQUIRED다', async () => {
    reverify = 'NOT_FOUND';
    const { eventId } = await verifying();
    const r = await post(eventId, { challengeToken: 't' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ result: 'REVERIFY_REQUIRED' });
    reverify = 'PASSED';
  });

  test('B-T10 ① 이의는 202 QueueVerificationAppealReceipt이고 다시 보내면 같은 202다', async () => {
    const { eventId } = await verifying();
    const r = await post(eventId, { appeal: '사람입니다' });
    expect(r.statusCode).toBe(202);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload);
    expect(Object.keys(body).sort()).toEqual(['appealId', 'receivedAt']);
    expect(QueueVerificationAppealReceipt.safeParse(body).success).toBe(true);
    const again = await post(eventId, { appeal: '다시' });
    expect(again.statusCode).toBe(202);
    expect(JSON.parse(again.payload)).toEqual(body);
    // 상태 읽기가 접수를 되살린다
    const state = await get(eventId);
    expect(state.statusCode).toBe(200);
    // 응답 스키마가 새 칸(passedVia·graceUntil·appeal.text)을 지우지 않는다
    expect(JSON.parse(state.payload)).toEqual({ state: 'VERIFYING', passedVia: null, graceUntil: null, verificationReason: 'DEVICE_HISTORY', appeal: { ...body, text: '사람입니다' } });
    expect(QueueVerificationState.safeParse(JSON.parse(state.payload)).success).toBe(true);
  });

  test('B-T10 ③ 통과한 대기 참여의 상태 읽기는 passedVia·graceUntil을 싣고 추가 검증 칸이 없으면 409 not-verifying이다', async () => {
    reverify = 'PASSED';
    human = 'ALLOW';
    const { eventId, ticket } = await verifying({ seq: 7, serving: 9 });
    expect((await post(eventId, { challengeToken: 'verify-ok' })).statusCode).toBe(200);
    const passedAt = Number(/^PASSED:(\d+):/.exec(store.db.verify.get(eventId)!.get(ticket)!)![1]);
    const r = await get(eventId);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ state: 'PASSED', passedVia: 'CHALLENGE', graceUntil: new Date(passedAt + TEST_OPTIONS.graceMs).toISOString(), verificationReason: 'DEVICE_HISTORY', appeal: null });
    store.db.verify.get(eventId)!.delete(ticket);
    const none = await get(eventId);
    expect(none.statusCode).toBe(409);
    expect(typeOf(none)).toContain('not-verifying');
    expect((await get(eventId, { ...fan(), 'x-user-pid': `${PID}-nobody` })).statusCode).toBe(404);
  });

  test('B-T6 ④ AppModule 조립에서 trust-svc가 답하지 않아도 이의는 202이고 trust-svc를 부르지 않는다', async () => {
    human = 'UNAVAILABLE';
    try {
      const { eventId } = await verifying();
      const calls = risk.calls.length;
      const r = await post(eventId, { appeal: 'trust가 멈춘 동안의 이의' });
      expect(r.statusCode).toBe(202);
      expect(risk.calls.length).toBe(calls);
    } finally {
      human = 'ALLOW';
    }
  });

  test('B-T10 ② 발행이 실패하면 503과 Retry-After다', async () => {
    const { eventId } = await verifying();
    const before = cases.attempts;
    const failing = recordingCases('fail');
    // 같은 서비스의 생산자를 잠시 실패시킨다
    const publish = cases.publish;
    cases.publish = failing.publish.bind(failing);
    try {
      const r = await post(eventId, { appeal: '' });
      expect(r.statusCode).toBe(503);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(r.headers['content-type']).toContain('application/problem+json');
    } finally {
      cases.publish = publish;
    }
    expect(cases.attempts).toBe(before);
    expect((await post(eventId, { appeal: '' })).statusCode).toBe(202);
  });

  test('B-T6 ④ trust-svc 서킷이 열리면 제출은 503과 Retry-After다', async () => {
    human = 'UNAVAILABLE';
    const { eventId, ticket } = await verifying();
    const r = await post(eventId, { challengeToken: 't' });
    expect(r.statusCode).toBe(503);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(store.db.verify.get(eventId)!.get(ticket)).toMatch(/^VERIFYING:/);
    human = 'ALLOW';
  });

  test('B-T10 ④ 기각된 대기 참여의 제출은 410 queue-ticket-removed와 removeReason BLOCKED다', async () => {
    const { eventId, ticket } = await verifying();
    store.db.verifyOf(eventId).set(ticket, `BLOCKED:${NOW}:DEVICE_HISTORY`);
    for (const payload of [{ challengeToken: 't' }, { appeal: '기각 뒤' }]) {
      const r = await post(eventId, payload);
      expect(r.statusCode).toBe(410);
      expect(JSON.parse(r.payload)).toMatchObject({ type: expect.stringContaining('queue-ticket-removed'), removeReason: 'BLOCKED' });
    }
    // 상태 읽기는 200 BLOCKED다(계약의 GET은 410이 없다)
    expect(JSON.parse((await get(eventId)).payload)).toMatchObject({ state: 'BLOCKED' });
  });

  test('B-T11 추가 검증 중이 아니면 409 not-verifying, 대기 참여가 없으면 404 queue-entry-not-found다', async () => {
    const { eventId, ticket } = await verifying();
    store.db.verify.get(eventId)!.delete(ticket);
    const r = await post(eventId, { challengeToken: 't' });
    expect(r.statusCode).toBe(409);
    expect(typeOf(r)).toContain('not-verifying');
    const none = await post(eventId, { challengeToken: 't' }, { headers: { 'x-user-pid': `${PID}-other` } });
    expect(none.statusCode).toBe(404);
    expect(typeOf(none)).toContain('queue-entry-not-found');
    const noEvent = await post(newEvent(), { challengeToken: 't' });
    expect(noEvent.statusCode).toBe(404);
    expect(typeOf(noEvent)).toContain('queue-not-found');
    expect((await post('%7Bevil%7D', { challengeToken: 't' })).statusCode).toBe(404);
  });

  test('[ASVS v5.0.0-2.3.2] 제출 한도를 넘으면 429 verification-submit-limited와 Retry-After다', async () => {
    human = 'CHALLENGE';
    const { eventId } = await verifying();
    for (let i = 0; i < TEST_OPTIONS.submitLimit; i++) expect((await post(eventId, { challengeToken: 't' })).statusCode).toBe(200);
    const r = await post(eventId, { challengeToken: 't' });
    expect(r.statusCode).toBe(429);
    expect(typeOf(r)).toContain('verification-submit-limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    human = 'ALLOW';
  });

  test('[ASVS v5.0.0-2.3.1] 본인확인 전(pid 없음·빈 pid·모양이 틀린 pid)이면 403이고 대기 참여를 건드리지 않는다', async () => {
    const { eventId, ticket } = await verifying();
    const as = (headers: Record<string, string>, payload: object) => svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/verification`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    const results = [
      await as(fan({ pid: null }), { challengeToken: 't' }),
      await as(fan({ pid: null }), { appeal: 'x' }),
      await as({ ...fan(), 'x-user-pid': '{bad}' }, { challengeToken: 't' }),
      await get(eventId, fan({ pid: null })),
    ];
    for (const r of results) {
      expect(r.statusCode).toBe(403);
      expect(typeOf(r)).toContain('identity-verification-required');
    }
    expect(store.db.verify.get(eventId)!.get(ticket)).toMatch(/^VERIFYING:/);
    expect(store.db.appeals.has(`${PID}|${eventId}`)).toBe(false);
  });

  test('[ASVS v5.0.0-2.2.1] 이의 글은 NFC 뒤 grapheme 1,000자까지이고 1,001자는 400이다', async () => {
    const { eventId } = await verifying();
    // 1,001 grapheme(합친 글자): UTF-16 길이는 4,000 이하라 계약의 maxLength에는 걸리지 않는다
    const over = await post(eventId, { appeal: `${'👍🏽'.repeat(999)}가a` });
    expect(over.statusCode).toBe(400);
    const nfd1001 = await post(eventId, { appeal: '한'.normalize('NFD').repeat(1_001) });
    expect(nfd1001.statusCode).toBe(400);
    expect(store.db.appeals.has(`${PID}|${eventId}`)).toBe(false);
    // 1,000 grapheme(이모지 1,000개 = UTF-16 4,000단위, 분해 한글 1,000자 = 3,000단위)은 받는다
    expect((await post(eventId, { appeal: '👍🏽'.repeat(1_000) })).statusCode).toBe(202);
    const other = await verifying();
    expect((await post(other.eventId, { appeal: '한'.normalize('NFD').repeat(1_000) })).statusCode).toBe(202);
    // 0자(설명 요구)도 받는다
    const empty = await verifying();
    expect((await post(empty.eventId, { appeal: '' })).statusCode).toBe(202);
  });

  test('[ASVS v5.0.0-2.2.1] 이의 글에 NUL·양방향 제어·0폭 글자가 있으면 400이고 각 범위 바로 바깥 글자는 202다', async () => {
    const { eventId } = await verifying();
    for (const c of [0x0000, 0x202a, 0x202e, 0x2066, 0x2069, 0x200b, 0x200d, 0xfeff]) {
      const r = await post(eventId, { appeal: `사람입니다${String.fromCodePoint(c)}` });
      expect(r.statusCode, c.toString(16)).toBe(400);
    }
    expect(store.db.appeals.has(`${PID}|${eventId}`)).toBe(false);
    const outside = [0x0001, 0x2029, 0x202f, 0x2065, 0x206a, 0x200a, 0x200e, 0xfefe, 0xff00].map((c) => String.fromCodePoint(c)).join('');
    expect((await post(eventId, { appeal: `바깥${outside}` })).statusCode).toBe(202);
  });

  test('[ASVS v5.0.0-3.5.2] 본문은 application/json만 받고 정하지 않은 칸·둘 다·둘 다 없음·틀린 기기 식별값은 400이다', async () => {
    const { eventId, ticket } = await verifying();
    expect((await post(eventId, JSON.stringify({ challengeToken: 't' }), { contentType: 'text/plain;charset=UTF-8' })).statusCode).toBe(415);
    expect((await post(eventId, 'challengeToken=t', { contentType: 'application/x-www-form-urlencoded' })).statusCode).toBe(415);
    for (const bad of [{ challengeToken: 't', appeal: 'x' }, {}, { challengeToken: 't', extra: 1 }, { challengeToken: 't', deviceId: 'short' }, { challengeToken: '' }, { challengeToken: 'x'.repeat(2_049) }, { appeal: 1 }]) {
      const r = await post(eventId, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(store.db.verify.get(eventId)!.get(ticket)).toMatch(/^VERIFYING:/);
  });

  test('[ASVS v5.0.0-3.5.3] 상태를 바꾸는 일은 POST로만 하고 GET은 읽기만 한다(다른 메서드는 없다)', async () => {
    const { eventId, ticket } = await verifying();
    const calls = risk.calls.length + reverification.calls.length;
    const r = await svc.http.inject({ method: 'GET', url: `/v1/queues/${eventId}/verification?challengeToken=t&appeal=x`, headers: fan() });
    expect(r.statusCode).toBe(200);
    expect(store.db.verify.get(eventId)!.get(ticket)).toMatch(/^VERIFYING:/);
    expect(store.db.appeals.has(`${PID}|${eventId}`)).toBe(false);
    expect(risk.calls.length + reverification.calls.length).toBe(calls);
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) expect((await svc.http.inject({ method, url: `/v1/queues/${eventId}/verification`, headers: fan() })).statusCode).toBe(404);
  });

  test('[ASVS v5.0.0-3.2.1] 응답은 JSON(성공 application/json, 오류 application/problem+json)뿐이다', async () => {
    const { eventId } = await verifying();
    expect((await get(eventId)).headers['content-type']).toMatch(/^application\/json/);
    expect((await post(eventId, { challengeToken: 't' })).headers['content-type']).toMatch(/^application\/json/);
    const e = await post(newEvent(), { challengeToken: 't' });
    expect(e.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  test('B-T11 팬 역할·구매 권한이 없으면 처리하지 않는다', async () => {
    const { eventId, ticket } = await verifying();
    const noScope = await post(eventId, { challengeToken: 't' }, { headers: { 'x-user-scope': '' } });
    expect(noScope.statusCode).toBeGreaterThanOrEqual(401);
    expect(noScope.statusCode).toBeLessThan(404);
    expect(store.db.verify.get(eventId)!.get(ticket)).toMatch(/^VERIFYING:/);
  });
});
