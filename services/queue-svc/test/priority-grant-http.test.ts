// 우선 구매 입장 HTTP 시험(BUILD_ORDER GAT-135, Q-T62, openapi POST /v1/queues/{eventId}/admission).
// 본문 우선순위는 대기표·참가 토큰·우선 구매 권리 ID 가운데 하나만 받고, 사본이 OFFERED·만료 전이면 prio 클레임을 준다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAdmissionStore } from '../src/modules/admission/adapters/memory-admission-store.js';
import { MemoryPriorityGrantStore } from '../src/modules/admission/adapters/memory-priority-grants.js';
import { SetPriorityGrant } from '../src/modules/admission/application/set-priority-grant.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { readAdmissionToken, signer } from './admission-cases.js';
import { ACCOUNT, newEvent, openSchedule, PID, recordingRisk, tokens } from './support.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const clock = fakeClock({ now: NOW });
const schedules = new MemoryEventSchedules();
const store = new MemoryAdmissionStore(clock);
const grants = new MemoryPriorityGrantStore();
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'queue-svc-priority-http',
    module: AppModule.register({
      memory: true,
      schedules,
      tokens,
      risk: recordingRisk(),
      admission: { store, signer, priorityGrants: grants },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

const fan = { 'x-user-id': ACCOUNT, 'x-session-id': 's-1', 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': PID };
const admit = (eventId: string, body: unknown) =>
  svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/admission`, headers: { ...fan, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

async function grantFor(eventId: string): Promise<string> {
  await schedules.set(eventId, openSchedule(NOW));
  const grantId = crypto.randomUUID();
  await new SetPriorityGrant(grants, clock).run({ accountId: ACCOUNT, eventId, grantId, state: 'OFFERED', expiresAtMs: NOW + 48 * 3600_000, version: 1 });
  return grantId;
}

describe('우선 구매 입장 HTTP [GAT-135, Q-T62]', () => {
  test('OFFERED 사본이면 200 ADMITTED와 prio 클레임을 주고, 입장 자리 수에는 세지 않는다', async () => {
    const eventId = newEvent();
    const grantId = await grantFor(eventId);
    const r = await admit(eventId, { priorityGrantId: grantId });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload) as { status: string; admissionToken: string };
    expect(body.status).toBe('ADMITTED');
    const { claims } = readAdmissionToken(body.admissionToken);
    expect(claims).toMatchObject({ sub: ACCOUNT, event: eventId, prio: grantId });
    expect(store.db.ev(eventId).get('admitted') ?? 0).toBe(0);
  });

  test('없는 권리는 404 priority-grant-not-found이고, 본문에 두 가지 입장 수단을 함께 보내면 400이다', async () => {
    const eventId = newEvent();
    await schedules.set(eventId, openSchedule(NOW));
    const missing = await admit(eventId, { priorityGrantId: crypto.randomUUID() });
    expect(missing.statusCode).toBe(404);
    expect((JSON.parse(missing.payload) as { type: string }).type).toMatch(/priority-grant-not-found$/);

    const grantId = await grantFor(eventId);
    expect((await admit(eventId, { priorityGrantId: grantId, lobbyToken: 'x' })).statusCode).toBe(400);
    expect((await admit(eventId, {})).statusCode).toBe(400);
  });
});
