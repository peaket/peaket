// 받는 층: 사전 검증·진입 경로(openapi /v1/queues/{eventId}/pre-verifications·entries, ADR-0065 결정 6, [ASVS v5.0.0-3.5.2])
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import { TestSeedSealer } from '@peaket/shuffle';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { HmacArrivalCookies } from '../src/modules/entry/adapters/arrival-cookie.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, newEvent, newRequest, openSchedule, PID, preverifyToken, recordingRisk, tokens } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const schedules = new MemoryEventSchedules();
const NOW = Date.parse('2026-11-03T03:00:00Z');

beforeAll(async () => {
  svc = await createService({
    name: 'queue-svc',
    module: AppModule.register({ memory: true, schedules, tokens, risk: recordingRisk(), sealer: new TestSeedSealer(Buffer.alloc(32, 4)) }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

const fan = (o: { scope?: string; pid?: string | null } = {}) => ({
  'x-user-id': ACCOUNT,
  'x-session-id': 's-1',
  'x-user-aud': 'fan',
  'x-user-scope': o.scope ?? 'ticket:buy',
  ...(o.pid === null ? {} : { 'x-user-pid': o.pid ?? PID }),
});

async function event(o: Parameters<typeof openSchedule>[1] = {}) {
  const id = newEvent();
  await schedules.set(id, openSchedule(NOW, o));
  return id;
}

const entryBody = (eventId: string, o: Record<string, unknown> = {}) =>
  JSON.stringify({ preverifyToken: preverifyToken(svc.clock, eventId), deviceId: DEVICE, entryRequestId: newRequest(), ...o });

const enter = (eventId: string, payload: string, contentType = 'text/plain;charset=UTF-8', headers: Record<string, string> = fan()) =>
  svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/entries`, headers: { ...headers, 'content-type': contentType }, payload });

describe('진입 경로', () => {
  test('Q-T41③_사전요청없는text/plain본문을_JSON으로검사해_201대기표를준다', async () => {
    const id = await event({ openBatch: false });
    const r = await enter(id, entryBody(id));
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({ seq: 1, generation: 1, segment: 0, verificationReason: null, serverTimeMs: NOW });
    expect(tokens.readTicket(body.queueTicket)).toMatchObject({ e: id, a: ACCOUNT, s: 1 });
  });

  test('[ASVS v5.0.0-3.5.2] 진입은_application/json도받고_그밖의형식은415다', async () => {
    const id = await event({ openBatch: false });
    expect((await enter(id, entryBody(id), 'application/json')).statusCode).toBe(201);
    for (const ct of ['multipart/form-data; boundary=x', 'application/x-www-form-urlencoded']) {
      const r = await enter(id, entryBody(id), ct);
      expect(r.statusCode).toBe(415);
    }
  });

  test('본문이JSON이아니거나_필수칸이없으면400이다', async () => {
    const id = await event({ openBatch: false });
    expect((await enter(id, 'not json')).statusCode).toBe(400);
    expect((await enter(id, JSON.stringify({ deviceId: DEVICE }))).statusCode).toBe(400);
    expect((await enter(id, entryBody(id, { entryRequestId: 'not-uuid' }))).statusCode).toBe(400);
  });

  test('[ASVS v5.0.0-15.3.3] 진입_본문의_정하지않은칸은_400이다(계약처럼닫힌본문, BAS-040)', async () => {
    const id = await event({ openBatch: false });
    const r = await enter(id, entryBody(id, { zzz: 1 }));
    expect({ status: r.statusCode, type: JSON.parse(r.payload).type }).toEqual({ status: 400, type: 'about:blank' });
  });

  test('구매권한(ticket:buy)이나pid가없는팬은_403이다', async () => {
    const id = await event({ openBatch: false });
    expect((await enter(id, entryBody(id), undefined, fan({ scope: '' }))).statusCode).toBe(403);
    const noPid = await enter(id, entryBody(id), undefined, fan({ pid: null }));
    expect(noPid.statusCode).toBe(403);
    expect(JSON.parse(noPid.payload).type).toMatch(/identity-verification-required$/);
  });

  test('[Q-T45] 옛pid머리(X-User-Pid-Prev)가오면_옛pid키로도막고_키에넣을수없는모양이면403본인확인필요다', async () => {
    const id = await event({ openBatch: false });
    const OLD = `pid-old-${newRequest().slice(0, 8)}`;
    const NEW = `pid-new-${newRequest().slice(0, 8)}`;
    expect((await enter(id, entryBody(id), undefined, fan({ pid: OLD }))).statusCode).toBe(201);
    const again = await enter(id, entryBody(id), undefined, { ...fan({ pid: NEW }), 'x-user-pid-prev': OLD });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.payload).type).toMatch(/already-waiting$/);
    const bad = await enter(id, entryBody(id), undefined, { ...fan({ pid: NEW }), 'x-user-pid-prev': 'pid:{x}' });
    expect(bad.statusCode).toBe(403);
    expect(JSON.parse(bad.payload).type).toMatch(/identity-verification-required$/);
  });

  test('오류는_문제상세형식이다_404queue-not-found·403preverify-invalid·409already-waiting·410sale-ended', async () => {
    const missing = newEvent();
    const r404 = await enter(missing, entryBody(missing));
    expect(r404.statusCode).toBe(404);
    expect(JSON.parse(r404.payload).type).toMatch(/queue-not-found$/);

    const id = await event({ openBatch: false });
    const r403 = await enter(id, entryBody(id, { preverifyToken: preverifyToken(svc.clock, newEvent()) }));
    expect(r403.statusCode).toBe(403);
    expect(JSON.parse(r403.payload).type).toMatch(/preverify-invalid$/);

    expect((await enter(id, entryBody(id))).statusCode).toBe(201);
    const r409 = await enter(id, entryBody(id));
    expect(r409.statusCode).toBe(409);
    expect(JSON.parse(r409.payload).type).toMatch(/already-waiting$/);

    const ended = await event({ startsAtMs: NOW + 3600_000 });
    const r410 = await enter(ended, entryBody(ended));
    expect(r410.statusCode).toBe(410);
    expect(JSON.parse(r410.payload).type).toMatch(/sale-ended$/);
  });

  test('오픈전토큰으로묶음구간에오면_202BATCHING본문을준다', async () => {
    const id = await event({ opensAtMs: NOW - 100, openBatch: true, lobbyShuffle: false });
    const r = await enter(id, entryBody(id, { preverifyToken: preverifyToken(svc.clock, id, { i0: NOW - 60_000 }) }));
    expect(r.statusCode).toBe(202);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({ spreadSec: 8, serverTimeMs: NOW });
    expect(body.resultPath).toMatch(new RegExp(`^/v1/queues/${id}/batch-results/[0-9a-f]{3}\\.json$`));
    expect(body.kind).toBeUndefined();
    expect(typeof body.entryRequestId).toBe('string');
  });

  test('묶음구간의503은_Retry-After머리를싣는다', async () => {
    const id = await event({ opensAtMs: NOW - 500, openBatch: true });
    const r = await enter(id, entryBody(id));
    expect(r.statusCode).toBe(503);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

describe('사전 검증 경로', () => {
  const preverify = (eventId: string, contentType = 'application/json', headers = fan()) =>
    svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/pre-verifications`, headers: { ...headers, 'content-type': contentType }, payload: JSON.stringify({ deviceId: DEVICE, humanCheckToken: 't' }) });

  test('201로_사전검증토큰·만료시각·서버시각을준다', async () => {
    const id = await event();
    const r = await preverify(id);
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload);
    expect(tokens.readPreverify(body.preverifyToken)).toMatchObject({ e: id, a: ACCOUNT, d: DEVICE });
    expect(body).toMatchObject({ expiresAt: new Date(NOW + 15 * 60_000).toISOString(), serverTimeMs: NOW });
  });

  test('[ASVS v5.0.0-3.5.2] 사전검증은_text/plain을받지않는다_사전요청이생기는경로다', async () => {
    const id = await event();
    expect((await preverify(id, 'text/plain;charset=UTF-8')).statusCode).toBe(415);
  });

  test('구매권한이없는팬은_403이다', async () => {
    const id = await event();
    expect((await preverify(id, 'application/json', fan({ scope: '' }))).statusCode).toBe(403);
  });

  test('[ASVS v5.0.0-15.3.3] 사전검증_본문의_정하지않은칸은_400이다(계약처럼닫힌본문, BAS-040)', async () => {
    const id = await event();
    const r = await svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/pre-verifications`, headers: { ...fan(), 'content-type': 'application/json' }, payload: JSON.stringify({ deviceId: DEVICE, humanCheckToken: 't', zzz: 1 }) });
    expect(r.statusCode).toBe(400);
  });
});

describe('대기열 Redis 일시 장애', () => {
  test('저장소가일시장애면_503dependency-unavailable과Retry-After1초로답한다', async () => {
    const { QueueStoreUnavailable } = await import('../src/modules/entry/domain/queue.js');
    const down = await createService({
      name: 'queue-svc',
      module: AppModule.register({ memory: true, schedules: { get: async () => Promise.reject(new QueueStoreUnavailable()) }, tokens, risk: recordingRisk() }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet,
    });
    try {
      const id = newEvent();
      for (const r of [
        await down.http.inject({ method: 'POST', url: `/v1/queues/${id}/entries`, headers: { ...fan(), 'content-type': 'text/plain' }, payload: JSON.stringify({ preverifyToken: 'x', deviceId: DEVICE }) }),
        await down.http.inject({ method: 'POST', url: `/v1/queues/${id}/pre-verifications`, headers: { ...fan(), 'content-type': 'application/json' }, payload: JSON.stringify({ deviceId: DEVICE }) }),
      ]) {
        expect(r.statusCode).toBe(503);
        expect(r.headers['retry-after']).toBe('1');
        expect(JSON.parse(r.payload).type).toMatch(/dependency-unavailable$/);
      }
    } finally {
      await down.close();
    }
  });
});

describe('도착 시각 쿠키(받는 층, ADR-0223)', () => {
  const KEY = 'K'.repeat(43);
  let cookieSvc: Awaited<ReturnType<typeof createService>>;
  const signals = { cookie: [] as string[], number: [] as string[] };
  const cookieSchedules = new MemoryEventSchedules();

  beforeAll(async () => {
    cookieSvc = await createService({
      name: 'queue-svc',
      module: AppModule.register({
        memory: true,
        schedules: cookieSchedules,
        tokens,
        risk: recordingRisk(),
        arrivals: new HmacArrivalCookies([{ kid: 'k1', key: KEY }]),
        arrivalSignals: { cookie: (r) => signals.cookie.push(r), number: (p) => signals.number.push(p) },
      }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet,
    });
  });
  afterAll(async () => {
    await cookieSvc?.close();
  });

  const post = (id: string, headers: Record<string, string>) =>
    cookieSvc.http.inject({
      method: 'POST',
      url: `/v1/queues/${id}/entries`,
      headers: { ...fan(), 'content-type': 'text/plain;charset=UTF-8', ...headers },
      payload: JSON.stringify({ preverifyToken: preverifyToken(cookieSvc.clock, id), deviceId: DEVICE, entryRequestId: newRequest() }),
    });
  const cookieFor = (id: string) => {
    const head = `v1.k1.${id}.${NOW}.${Buffer.from('rid-1').toString('base64url')}.s-1`;
    return `${head}.${createHmac('sha256', KEY).update(`PEAKET-arrival-v1.${head}`).digest('base64url')}`;
  };

  test('[Q-T29] 받는층은_Cookie머리의도착시각쿠키를_게이트웨이가확인한세션과함께넘긴다', async () => {
    const id = newEvent();
    await cookieSchedules.set(id, openSchedule(NOW, { openBatch: false }));
    signals.cookie.length = 0;
    const r = await post(id, { cookie: `other=1; __Host-peaket_arr=${cookieFor(id)}` });
    expect(r.statusCode).toBe(201);
    expect(signals.cookie).toEqual(['ok']);
    expect(signals.number).toEqual(['slot']);
  });

  test('[Q-T16] 엣지가서명없이보낸표시머리는_쿠키없음으로센다', async () => {
    const id = newEvent();
    await cookieSchedules.set(id, openSchedule(NOW, { openBatch: false }));
    signals.cookie.length = 0;
    const r = await post(id, { 'x-peaket-arrival': 'unsigned' });
    expect(r.statusCode).toBe(201);
    expect(signals.cookie).toEqual(['absent']);
  });
});

describe('로비 참가 경로(HOT-040, ADR-0231)', () => {
  const lobbySchedule = (o: Partial<EventSchedule> = {}): EventSchedule => ({ opensAtMs: NOW + 5 * 60_000, startsAtMs: NOW + 3 * 24 * 3600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: 10, ...o });
  const join = (eventId: string, contentType = 'application/json', headers = fan(), payload: unknown = { deviceId: DEVICE, humanCheckToken: 't' }) =>
    svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/lobby-participants`, headers: { ...headers, 'content-type': contentType }, payload: JSON.stringify(payload) });

  test('Q-T55 팬이 창 안에서 부르면 201과 참가 토큰, 공시 칸을 주고 응답은 저장하지 않는다', async () => {
    const id = newEvent();
    await schedules.set(id, lobbySchedule());
    const r = await join(id, 'application/json', fan({ pid: 'pid-lobby-1' }));
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload);
    expect(tokens.readLobby(body.lobbyToken)).toMatchObject({ e: id, a: ACCOUNT, d: DEVICE });
    expect(body).toMatchObject({ drandChain: 'quicknet', algorithmVersion: 'v1', shuffleSpreadSec: 8, serverTimeMs: NOW });
  });

  test('Q-T55 같은 사람이 다시 오면 409 already-waiting이고, 창 앞은 queue-not-open, 지나면 lobby-closed, 로비가 없는 회차는 404다', async () => {
    const id = newEvent();
    await schedules.set(id, lobbySchedule());
    const again = fan({ pid: 'pid-lobby-2' });
    expect((await join(id, 'application/json', again)).statusCode).toBe(201);
    const second = await join(id, 'application/json', again);
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.payload).type).toContain('already-waiting');
    const early = newEvent();
    await schedules.set(early, lobbySchedule({ opensAtMs: NOW + 30 * 60_000 }));
    expect(JSON.parse((await join(early, 'application/json', fan({ pid: 'pid-lobby-3' }))).payload).type).toContain('queue-not-open');
    const past = newEvent();
    await schedules.set(past, lobbySchedule({ opensAtMs: NOW - 1 }));
    expect(JSON.parse((await join(past, 'application/json', fan({ pid: 'pid-lobby-4' }))).payload).type).toContain('lobby-closed');
    const none = newEvent();
    await schedules.set(none, lobbySchedule({ lobbyShuffle: false }));
    expect((await join(none, 'application/json', fan({ pid: 'pid-lobby-5' }))).statusCode).toBe(404);
  });

  test('[ASVS v5.0.0-3.5.2] 로비 입장은 text/plain을 받지 않고(사전 요청이 생기는 경로), 정하지 않은 본문 칸은 400이며 본인확인 전은 403이다', async () => {
    const id = newEvent();
    await schedules.set(id, lobbySchedule());
    expect((await join(id, 'text/plain;charset=UTF-8')).statusCode).toBe(415);
    expect((await join(id, 'application/json', fan({ pid: 'pid-lobby-6' }), { deviceId: DEVICE, extra: 1 })).statusCode).toBe(400);
    expect((await join(id, 'application/json', fan({ pid: null }))).statusCode).toBe(403);
  });
});
