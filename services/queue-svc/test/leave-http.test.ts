// 받는 층: 대기 취소·로비 참가 취소 경로(openapi DELETE /v1/queues/{eventId}/entries/me·lobby-participants/me, ADR-0060·0233)
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { TestSeedSealer } from '@peaket/shuffle';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, newEvent, newRequest, openSchedule, PID, preverifyToken, recordingRisk, tokens } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const schedules = new MemoryEventSchedules();
const NOW = Date.parse('2026-11-09T03:00:00Z');

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

const fan = (o: { pid?: string | null } = {}) => ({
  'x-user-id': ACCOUNT,
  'x-session-id': 's-1',
  'x-user-aud': 'fan',
  'x-user-scope': 'ticket:buy',
  ...(o.pid === null ? {} : { 'x-user-pid': o.pid ?? PID }),
});

async function event(o: Partial<EventSchedule> = {}) {
  const id = newEvent();
  await schedules.set(id, openSchedule(NOW, o));
  return id;
}

const call = (method: 'DELETE' | 'GET' | 'POST', url: string, headers: Record<string, string> = fan()) => svc.http.inject({ method, url, headers });

describe('대기 취소·로비 참가 취소 경로', () => {
  test('Q-T35② Q-T68③ 대기 취소는 204이고 캐시하지 않으며 다시 진입하면 맨 뒤 번호다', async () => {
    const id = await event({ openBatch: false, lobbyShuffle: true });
    const enter = () => svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/entries`, headers: { ...fan(), 'content-type': 'text/plain;charset=UTF-8' }, payload: JSON.stringify({ preverifyToken: preverifyToken(svc.clock, id), deviceId: DEVICE, entryRequestId: newRequest() }) });
    const first = await enter();
    expect(first.statusCode).toBe(201);
    const blocked = await enter();
    expect(blocked.statusCode).toBe(409);
    const r = await call('DELETE', `/v1/queues/${id}/entries/me`);
    expect(r.statusCode).toBe(204);
    expect(r.headers['cache-control']).toBe('no-store');
    const again = await enter();
    expect(again.statusCode).toBe(201);
    expect(JSON.parse(again.payload).seq).toBe(JSON.parse(first.payload).seq + 1);
  });

  test('Q-T68⑩ 취소한 대기의 같은 요청 ID 재전송은 410 queue-ticket-removed이고 새 번호를 주지 않는다', async () => {
    const id = await event({ openBatch: false, lobbyShuffle: true });
    const payload = JSON.stringify({ preverifyToken: preverifyToken(svc.clock, id), deviceId: DEVICE, entryRequestId: newRequest() });
    const send = () => svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/entries`, headers: { ...fan(), 'content-type': 'text/plain;charset=UTF-8' }, payload });
    expect((await send()).statusCode).toBe(201);
    expect((await call('DELETE', `/v1/queues/${id}/entries/me`)).statusCode).toBe(204);
    const again = await send();
    expect(again.statusCode).toBe(410);
    expect(JSON.parse(again.payload).type).toContain('queue-ticket-removed');
  });

  test('Q-T68⑥ 줄에 없어도 대기 취소는 204다', async () => {
    const id = await event();
    expect((await call('DELETE', `/v1/queues/${id}/entries/me`)).statusCode).toBe(204);
  });

  test('Q-T68① 로비 참가 취소는 204이고, 참가 기록이 없으면 404 lobby-participant-not-found다', async () => {
    const id = newEvent();
    await schedules.set(id, { opensAtMs: NOW + 5 * 60_000, startsAtMs: NOW + 3 * 24 * 3600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: 10 });
    const join = await svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/lobby-participants`, headers: { ...fan(), 'content-type': 'application/json' }, payload: JSON.stringify({ humanCheckToken: 'ok', deviceId: DEVICE }) });
    expect(join.statusCode).toBe(201);
    const r = await call('DELETE', `/v1/queues/${id}/lobby-participants/me`);
    expect(r.statusCode).toBe(204);
    expect(r.headers['cache-control']).toBe('no-store');
    const again = await call('DELETE', `/v1/queues/${id}/lobby-participants/me`);
    expect(again.statusCode).toBe(404);
    expect(JSON.parse(again.payload).type).toContain('lobby-participant-not-found');
  });

  test('Q-T52⑤ 로비가 닫힌 뒤의 로비 참가 취소는 409 lobby-closed다', async () => {
    const id = newEvent();
    await schedules.set(id, { opensAtMs: NOW + 5 * 60_000, startsAtMs: NOW + 3 * 24 * 3600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: 10 });
    await svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/lobby-participants`, headers: { ...fan(), 'content-type': 'application/json' }, payload: JSON.stringify({ humanCheckToken: 'ok', deviceId: DEVICE }) });
    await schedules.set(id, { opensAtMs: NOW - 1_000, startsAtMs: NOW + 3 * 24 * 3600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: 10 });
    const r = await call('DELETE', `/v1/queues/${id}/lobby-participants/me`);
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.payload).type).toContain('lobby-closed');
  });

  test('Q-T68⑥ 없는 회차와 모양이 틀린 회차 ID는 404 queue-not-found다', async () => {
    const a = await call('DELETE', `/v1/queues/${newEvent()}/entries/me`);
    expect(a.statusCode).toBe(404);
    expect(JSON.parse(a.payload).type).toContain('queue-not-found');
    expect((await call('DELETE', '/v1/queues/%7Bevil%7D/entries/me')).statusCode).toBe(404);
  });

  test('Q-T68⑥ 본인확인 전(pid 없음)이면 403 identity-verification-required다', async () => {
    const id = await event();
    const r = await call('DELETE', `/v1/queues/${id}/entries/me`, fan({ pid: null }));
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.payload).type).toContain('identity-verification-required');
  });

  test('[ASVS v5.0.0-3.5.2] 취소 경로는 사전 요청이 없는 POST를 받지 않는다', async () => {
    const id = await event();
    for (const path of ['entries/me', 'lobby-participants/me']) expect((await svc.http.inject({ method: 'POST', url: `/v1/queues/${id}/${path}`, headers: { ...fan(), 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(404);
  });

  test('[ASVS v5.0.0-3.5.3] 취소 경로는 안전 메서드(GET)로 부를 수 없다', async () => {
    const id = await event();
    for (const path of ['entries/me', 'lobby-participants/me']) expect((await call('GET', `/v1/queues/${id}/${path}`)).statusCode).toBe(404);
  });
});
