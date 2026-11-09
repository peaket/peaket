// 받는 층: 게이트웨이가 넘긴 클라이언트 신호를 위험 판정에 싣고, 축소 운영의 한도를 넘으면 429로 답한다(openapi createQueuePreVerification·createQueueLobbyParticipant, B-T6②).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { TestSeedSealer } from '@peaket/shuffle';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryDegradedLimits } from '../src/modules/entry/adapters/memory-degraded-limits.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { createHmac } from 'node:crypto';
import { HmacFirstVisitCookies } from '../src/modules/entry/adapters/first-visit-cookie.js';
import { ACCOUNT, DEVICE, newEvent, openSchedule, PID, recordingRisk, tokens } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const schedules = new MemoryEventSchedules();
const NOW = Date.parse('2026-11-03T03:00:00Z');
const risk = recordingRisk({ kind: 'UNAVAILABLE' });
const clock = fakeClock({ now: NOW });
const FIRST_VISIT_KEY = 'F'.repeat(43);
const firstVisitCookie = (t: number) => {
  const head = `v1.k1.${t}.${Buffer.from('REQ==').toString('base64url')}`;
  return `${head}.${createHmac('sha256', FIRST_VISIT_KEY).update(`PEAKET-firstvisit-v1.${head}`).digest('base64url')}`;
};

beforeAll(async () => {
  svc = await createService({
    name: 'queue-svc',
    module: AppModule.register({
      memory: true,
      schedules,
      tokens,
      risk,
      degradedLimits: new MemoryDegradedLimits(clock, { classify: () => 'OTHER' }),
      firstVisit: new HmacFirstVisitCookies([{ kid: 'k1', key: FIRST_VISIT_KEY }]),
      sealer: new TestSeedSealer(Buffer.alloc(32, 4)),
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

const fan = () => ({
  'x-user-id': ACCOUNT,
  'x-session-id': 's-1',
  'x-user-aud': 'fan',
  'x-user-scope': 'ticket:buy',
  'x-user-pid': PID,
});

let deviceN = 0;
/** 형식에 맞는 기기 식별값(base64url 22자, docs/frontend.md §3.12) */
const device = () => `AQEBAQEBAQEBAQEB${String(++deviceN).padStart(6, '0')}`;

async function event(o: Parameters<typeof openSchedule>[1] = {}) {
  const id = newEvent();
  await schedules.set(id, openSchedule(NOW, o));
  return id;
}

/** 오픈 5분 전, 로비 창 안의 회차 */
async function lobbyEvent() {
  const id = newEvent();
  await schedules.set(id, { opensAtMs: NOW + 5 * 60_000, startsAtMs: NOW + 3 * 24 * 3_600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: 10 });
  return id;
}

const preverify = (id: string, headers: Record<string, string>, body: object = {}) =>
  svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/pre-verifications`, headers: { ...fan(), ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ humanCheckToken: 't', deviceId: DEVICE, ...body }) });

describe('위험 판정 입력', () => {
  test('[Q-T39] 최초방문쿠키는_사전검증과로비참가의위험판정입력으로넘어가고_응답은그대로다', async () => {
    risk.seen.length = 0;
    const issuedAt = NOW - 3 * 86_400_000;
    const id = await event({ lobbyShuffle: false });
    const r = await preverify(id, { cookie: `other=1; __Host-peaket_fv=${firstVisitCookie(issuedAt)}` });
    expect(r.statusCode).toBe(201);
    expect(risk.seen[0]!.firstVisitAtMs).toBe(issuedAt);
    const lobbyId = await event({ lobbyShuffle: true, opensAtMs: NOW + 5 * 60_000 });
    const lobby = await svc.http.inject({ method: 'POST', url: `/v1/queues/${lobbyId}/lobby-participants`, headers: { ...fan(), 'content-type': 'application/json', cookie: `__Host-peaket_fv=${firstVisitCookie(issuedAt)}` }, payload: JSON.stringify({ humanCheckToken: 't', deviceId: device() }) });
    expect(lobby.statusCode).toBe(201);
    expect(risk.seen[1]).toMatchObject({ context: 'LOBBY', firstVisitAtMs: issuedAt });
  });

  test('[Q-T39] 행동요약은_범위밖값이나정의밖칸이면400이고_맞으면위험판정입력으로넘어간다', async () => {
    const id = await event({ lobbyShuffle: false });
    for (const behaviorSummary of [{ v: 2, windowMs: 1 }, { v: 1, windowMs: 3_600_001 }, { v: 1, windowMs: 1, pointerMoves: -1 }, { v: 1, windowMs: 1, pointerPath: [[1, 2]] }, { v: 1, windowMs: 1, typed: 'abc' }]) {
      const r = await preverify(id, {}, { behaviorSummary });
      expect(r.statusCode, JSON.stringify(behaviorSummary)).toBe(400);
    }
    risk.seen.length = 0;
    const ok = await preverify(id, {}, { behaviorSummary: { v: 1, windowMs: 2_000, pointerMoves: 4, pointerEntropy: 1.2, scrollEvents: 1, scrollDistancePx: 80 } });
    expect(ok.statusCode).toBe(201);
    expect(risk.seen[0]!.behaviorSummary).toEqual({ v: 1, windowMs: 2_000, pointerMoves: 4, pointerEntropy: 1.2, scrollEvents: 1, scrollDistancePx: 80 });
  });

  test('[Q-T39] 틀린쿠키는_없는것으로처리되고_사전검증은그대로201이다', async () => {
    risk.seen.length = 0;
    const id = await event({ lobbyShuffle: false });
    const r = await preverify(id, { cookie: '__Host-peaket_fv=v1.k1.1.a.b' });
    expect(r.statusCode).toBe(201);
    expect(risk.seen[0]!.firstVisitAtMs).toBeUndefined();
  });

  test('BOT-050_게이트웨이가넘긴IP·ASN·UA·ClientHints를위험판정에싣는다', async () => {
    risk.seen.length = 0;
    const id = await event({ lobbyShuffle: false });
    const r = await preverify(id, {
      'x-forwarded-for': '198.51.100.7',
      'user-agent': 'UA-test',
      'cloudfront-viewer-asn': '64512',
      'sec-ch-ua': '"Chromium";v="140"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-full-version-list': '"x";v="1"',
    });
    expect(r.statusCode).toBe(201);
    expect(risk.seen[0]!.client).toEqual({
      ip: '198.51.100.7',
      userAgent: 'UA-test',
      asn: 64512,
      clientHints: { 'sec-ch-ua': '"Chromium";v="140"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' },
    });
  });

  test.each(['abc', '-1', '99999999999999999', ''])('B-T7③_ASN값이숫자가아니면(%s)0으로본다', async (asn) => {
    risk.seen.length = 0;
    const id = await event({ lobbyShuffle: false });
    await preverify(id, { 'cloudfront-viewer-asn': asn }, { deviceId: device() });
    expect(risk.seen[0]!.client!.asn).toBe(0);
  });

  test('X-Forwarded-For가없으면IP는비운다', async () => {
    risk.seen.length = 0;
    const id = await event({ lobbyShuffle: false });
    await preverify(id, {}, { deviceId: device() });
    expect(risk.seen[0]!.client!.ip).toBe('');
  });
});

describe('deviceId·토큰 모양', () => {
  test.each(['abc', 'x'.repeat(23), 'd'.repeat(21) + '!'])('리뷰4_deviceId가base64url22자가아니면400이다: %s', async (deviceId) => {
    const id = await event({ lobbyShuffle: false });
    expect((await preverify(id, {}, { deviceId })).statusCode).toBe(400);
  });

  test('낮음6_사람확인토큰이2048자를넘으면400이다', async () => {
    const id = await event({ lobbyShuffle: false });
    const pid = { 'x-user-pid': 'p-token-limit' };
    expect((await preverify(id, pid, { humanCheckToken: 'x'.repeat(2049), deviceId: device() })).statusCode).toBe(400);
    expect((await preverify(id, pid, { humanCheckToken: 'x'.repeat(2048), deviceId: device() })).statusCode).toBe(201);
  });
});

describe('축소 운영 한도', () => {
  test('시험빈틈_로비참가도한도를넘으면429이고Retry-After와Problem이다', async () => {
    const id = await lobbyEvent();
    const deviceId = device();
    const join = (pid: string) =>
      svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/lobby-participants`, headers: { ...fan(), 'x-user-pid': pid, 'content-type': 'application/json' }, payload: JSON.stringify({ humanCheckToken: 't', deviceId }) });
    for (let i = 0; i < 5; i++) expect((await join(`pl-${i}`)).statusCode).toBe(201);
    const r = await join('pl-9');
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('10');
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/queue-request-limited', status: 429 });
  });

  test('[ASVS v5.0.0-2.4.1] B-T6②_판정을받지못할때기기한도를넘으면429이고_Retry-After와Problem이다', async () => {
    const id = await event({ lobbyShuffle: false });
    const deviceId = device();
    for (let i = 0; i < 5; i++) expect((await preverify(id, { 'x-user-pid': `p${i}` }, { deviceId })).statusCode).toBe(201);
    const r = await preverify(id, { 'x-user-pid': 'p9' }, { deviceId });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('10');
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/queue-request-limited', status: 429 });
  });

  test('B-T6③_판정을받지못해도한도안이면201이고토큰에hd가있다', async () => {
    const id = await event({ lobbyShuffle: false });
    const r = await preverify(id, { 'x-user-pid': `p-${Math.random().toString(36).slice(2)}` }, { deviceId: device() });
    expect(r.statusCode).toBe(201);
    expect(tokens.readPreverify(JSON.parse(r.payload).preverifyToken)!.hd).toBe(true);
  });
});
