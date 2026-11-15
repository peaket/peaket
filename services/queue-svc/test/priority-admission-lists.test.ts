// B2-2 회귀 시험: 우선 구매 입장의 입장 토큰 `lst`(GAT-135, ADR-0265 결정 7, docs/features/queue-admission.md §6 '우선 구매 입장').
// 정본: 후보 명단 키(eligLists와 모든 창 lists의 합, 최대 10개) 가운데 그 계정이 든 키만 글자 차례·중복 없이 1~10개를 `lst`에 싣고,
// 후보가 없거나 계정이 어느 명단에도 없으면 싣지 않는다. 우선 구매 입장도 일반 입장과 같은 규칙이다.
// 명단 사본을 읽지 못하면 `lst`를 조용히 빼고 입장을 열지 않고, 받는 층이 503 dependency-unavailable로 닫는다(닫힌 쪽).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, systemClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAdmissionStore } from '../src/modules/admission/adapters/memory-admission-store.js';
import { MemoryPriorityGrantStore } from '../src/modules/admission/adapters/memory-priority-grants.js';
import type { AdmissionStore } from '../src/modules/admission/domain/ports.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { readAdmissionToken, signer } from './admission-cases.js';
import { ACCOUNT, newEvent, openSchedule, PID, recordingRisk, tokens } from './support.js';

const HOUR = 3600_000;
/** 정본이 정한 후보 명단 키 상한(docs/features/queue-admission.md §6, ADR-0265 결정 6) */
const LISTS = ['list-01', 'list-02', 'list-03', 'list-04', 'list-05', 'list-06', 'list-07', 'list-08', 'list-09', 'list-10'];

const quiet = new Writable({ write: (_c, _e, cb) => cb() });
let opened: Awaited<ReturnType<typeof createService>> | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const fan = { 'x-user-id': ACCOUNT, 'x-session-id': 's-1', 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': PID };

async function start(o: { store: AdmissionStore; grants: MemoryPriorityGrantStore; schedules: MemoryEventSchedules }) {
  opened = await createService({
    name: 'queue-svc',
    module: AppModule.register({
      memory: true,
      schedules: o.schedules,
      tokens,
      risk: recordingRisk(),
      state: { autoTick: false },
      admission: { store: o.store, signer, priorityGrants: o.grants },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock: systemClock,
    logDestination: quiet,
  });
  return opened;
}

/** GATED 일정(후보 명단 키를 eligLists 앞 5개·창 뒤 5개로 나눈다)과 그 계정이 든 명단 사본, 쓸 수 있는 우선 구매 권리 사본 하나 */
async function gatedWorld(store: MemoryAdmissionStore, grants: MemoryPriorityGrantStore, o: { lists: string[] }) {
  const now = Date.now();
  const schedules = new MemoryEventSchedules();
  const eventId = newEvent();
  const gateLists = o.lists.slice(5);
  await schedules.set(
    eventId,
    openSchedule(now, {
      eligibility: {
        kind: 'GATED',
        lists: o.lists.slice(0, 5),
        gates: gateLists.length > 0 ? [{ fromMs: now - HOUR, toMs: now + HOUR, lists: gateLists }] : [],
      },
    }),
  );
  for (const listKey of o.lists) store.db.elig(eventId).set(listKey, new Set([ACCOUNT]));
  const grantId = randomUUID();
  await grants.set({ accountId: ACCOUNT, eventId, grantId, state: 'OFFERED', expiresAtMs: now + HOUR, version: 1, nowMs: now });
  return { schedules, eventId, grantId };
}

const post = (svc: Awaited<ReturnType<typeof start>>, eventId: string, grantId: string) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/queues/${eventId}/admission`,
    headers: { ...fan, 'content-type': 'application/json' },
    payload: JSON.stringify({ priorityGrantId: grantId }),
  });

// 서비스를 조립해 HTTP로 보내므로 다른 시험과 함께 돌 때 기본 5초를 넘길 수 있다
describe('B2-2 우선 구매 입장 `lst` [GAT-135, ADR-0265]', { timeout: 30_000 }, () => {
  test('후보 상한 10개까지 계정이 든 명단 키만 글자 차례·중복 없이 싣고 prio와 함께 준다', async () => {
    const store = new MemoryAdmissionStore(systemClock);
    const grants = new MemoryPriorityGrantStore();
    const { schedules, eventId, grantId } = await gatedWorld(store, grants, { lists: LISTS });
    const res = await post(await start({ store, grants, schedules }), eventId, grantId);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { status: string; admissionToken: string };
    expect(body.status).toBe('ADMITTED');
    const claims = readAdmissionToken(body.admissionToken).claims;
    expect(claims.lst).toEqual(LISTS);
    expect(claims.prio).toBe(grantId);
  });

  test('명단 사본 읽기가 실패하면 lst를 조용히 빼지 않고 503 dependency-unavailable로 닫는다', async () => {
    const store = new MemoryAdmissionStore(systemClock);
    const grants = new MemoryPriorityGrantStore();
    const { schedules, eventId, grantId } = await gatedWorld(store, grants, { lists: ['member'] });
    const failing: AdmissionStore = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'eligibilityLists') return async () => Promise.reject(new QueueStoreUnavailable(new Error('down')));
        const v = Reflect.get(target, key, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await post(await start({ store: failing, grants, schedules }), eventId, grantId);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    const body = JSON.parse(res.payload) as { type: string; status: number };
    expect(body.status).toBe(503);
    expect(body.type).toMatch(/dependency-unavailable$/);
    expect(body).not.toHaveProperty('admissionToken');
  });
});
