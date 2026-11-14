// 우선 구매 권리 사본과 우선 입장 시험(BUILD_ORDER GAT-135, Q-T62, ADR-0171, queue-admission §6 '우선 구매 입장').
// 사본은 판 번호가 클 때만 바뀌고, 입장 확정은 같은 권리 ID의 OFFERED·만료 전 사본만 받아 새 여정과 prio 클레임을 준다.
import { randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { readAdmissionToken, recordingSignals, signer } from './admission-cases.js';
import { MemoryAdmissionStore } from '../src/modules/admission/adapters/memory-admission-store.js';
import { MemoryBookingRestrictions } from '../src/modules/admission/adapters/memory-booking-restrictions.js';
import { MemoryPriorityGrantStore } from '../src/modules/admission/adapters/memory-priority-grants.js';
import { AdmissionError } from '../src/modules/admission/application/admission-error.js';
import { ConfirmAdmission } from '../src/modules/admission/application/confirm-admission.js';
import { SetPriorityGrant } from '../src/modules/admission/application/set-priority-grant.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import type { PriorityGrantStore } from '../src/modules/admission/domain/ports.js';
import { ACCOUNT, JNY, newEvent, openSchedule, OTHER_ACCOUNT, PID, tokens } from './support.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const HOUR = 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let clock: ReturnType<typeof fakeClock>;
let store: MemoryAdmissionStore;
let schedules: MemoryEventSchedules;
let grants: MemoryPriorityGrantStore;
let restrictions: MemoryBookingRestrictions;
let set: SetPriorityGrant;
let app: ConfirmAdmission;
let eventId: string;

beforeEach(async () => {
  clock = fakeClock({ now: NOW });
  store = new MemoryAdmissionStore(clock);
  schedules = new MemoryEventSchedules();
  grants = new MemoryPriorityGrantStore();
  restrictions = new MemoryBookingRestrictions();
  set = new SetPriorityGrant(grants, clock);
  app = new ConfirmAdmission(store, schedules, tokens, signer, recordingSignals(), clock, undefined, grants, restrictions);
  eventId = newEvent();
  await schedules.set(eventId, openSchedule(NOW));
});

const offered = (over: Partial<Parameters<SetPriorityGrant['run']>[0]> = {}) => ({
  accountId: ACCOUNT,
  eventId,
  grantId: randomUUID(),
  state: 'OFFERED' as const,
  expiresAtMs: NOW + 48 * HOUR,
  version: 1,
  ...over,
});

const confirm = (grantId: string, accountId = ACCOUNT) => app.run({ accountId, pid: PID, sessionId: 'sess-1', eventId, body: { priorityGrantId: grantId } });

describe('우선 구매 권리 사본 [GAT-135]', () => {
  test('판 번호가 클 때만 반영하고, 낮은 판·같은 판은 바꾸지 않는다', async () => {
    const i = offered();
    expect(await set.run(i)).toEqual({ changed: true });
    expect(await grants.get(i)).toMatchObject({ grantId: i.grantId, state: 'OFFERED', version: 1 });
    expect(await set.run(i)).toEqual({ changed: false });
    expect(await set.run({ ...i, state: 'WITHDRAWN', version: 2 })).toEqual({ changed: true });
    expect((await grants.get(i))?.state).toBe('WITHDRAWN');
    expect(await set.run({ ...i, state: 'OFFERED', version: 1 })).toEqual({ changed: false });
    expect((await grants.get(i))?.state).toBe('WITHDRAWN');
  });

  test('계정·회차·권리 ID·상태·만료·판 번호의 모양이 틀리면 INVALID다', async () => {
    const i = offered();
    for (const bad of [
      { ...i, accountId: '' },
      { ...i, eventId: 'x'.repeat(65) },
      { ...i, grantId: 'not-a-uuid' },
      { ...i, state: 'USED' as unknown as 'OFFERED' },
      { ...i, expiresAtMs: 0 },
      { ...i, expiresAtMs: 1.5 },
      { ...i, version: -1 },
      { ...i, version: 1.5 },
    ]) {
      await expect(set.run(bad)).rejects.toMatchObject({ code: 'INVALID' });
    }
  });
});

describe('우선 구매 입장 [GAT-135, Q-T62]', () => {
  test('Q-T62 ①_OFFERED·만료 전 사본이면 대기 번호 없이 ADMITTED하고 새 여정 ID와 prio 클레임을 준다', async () => {
    const i = offered();
    await set.run(i);
    const r = await confirm(i.grantId);
    expect(r.status).toBe('ADMITTED');
    if (r.status !== 'ADMITTED') return;
    const { claims } = readAdmissionToken(r.admissionToken);
    expect(claims).toMatchObject({ sub: ACCOUNT, aud: 'purchase', event: eventId, prio: i.grantId });
    expect(claims.jny).toMatch(UUID);
    expect(claims.jny).not.toBe(JNY);
    expect(claims.jti).toMatch(UUID);
    expect(r.purchaseSessionExpiresAt).toBe(new Date(NOW + 45 * 60_000).toISOString());
    // 입장 자리 수에는 세지 않는다
    expect(store.db.ev(eventId).get('admitted') ?? 0).toBe(0);
  });

  test('결제 실패로 다시 입장하면 같은 prio·다른 새 여정을 준다', async () => {
    const i = offered();
    await set.run(i);
    const a = await confirm(i.grantId);
    const b = await confirm(i.grantId);
    if (a.status !== 'ADMITTED' || b.status !== 'ADMITTED') throw new Error('ADMITTED가 아니다');
    const ca = readAdmissionToken(a.admissionToken).claims;
    const cb = readAdmissionToken(b.admissionToken).claims;
    expect(ca.prio).toBe(i.grantId);
    expect(cb.prio).toBe(i.grantId);
    expect(ca.jny).not.toBe(cb.jny);
    expect(ca.jti).not.toBe(cb.jti);
  });

  test('판매 종료·매진 뒤에도 사본만 보므로 ADMITTED한다', async () => {
    const ended = newEvent();
    await schedules.set(ended, openSchedule(NOW, { startsAtMs: NOW - HOUR }));
    const i = offered({ eventId: ended });
    await set.run(i);
    const r = await app.run({ accountId: ACCOUNT, pid: PID, sessionId: 'sess-1', eventId: ended, body: { priorityGrantId: i.grantId } });
    expect(r.status).toBe('ADMITTED');
  });

  test('Q-T62 ②③④_없는 권리·남의 계정·WITHDRAWN·만료는 모두 404 PRIORITY_GRANT_NOT_FOUND다', async () => {
    const missing = randomUUID();
    await expect(confirm(missing)).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });

    const i = offered();
    await set.run(i);
    await expect(confirm(i.grantId, OTHER_ACCOUNT)).rejects.toBeInstanceOf(AdmissionError);

    const withdrawn = offered({ grantId: randomUUID(), state: 'WITHDRAWN' });
    await set.run(withdrawn);
    await expect(confirm(withdrawn.grantId)).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });

    const expiring = offered({ grantId: randomUUID(), expiresAtMs: NOW + 1_000 });
    await set.run(expiring);
    clock.advance(2_000);
    await expect(confirm(expiring.grantId)).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });
  });

  test('다른 권리 ID로 같은 계정·회차 사본을 부르면 404다', async () => {
    const i = offered();
    await set.run(i);
    await expect(confirm(randomUUID())).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });
  });

  test('저장소가 다른 권리 ID의 사본을 돌려줘도 도메인이 404로 막는다', async () => {
    const asked = randomUUID();
    const other = randomUUID();
    const mismatched: PriorityGrantStore = {
      set: async () => ({ changed: false }),
      get: async () => ({ grantId: other, state: 'OFFERED', expiresAtMs: NOW + HOUR, version: 1 }),
    };
    const guarded = new ConfirmAdmission(store, schedules, tokens, signer, recordingSignals(), clock, undefined, mismatched);
    await expect(
      guarded.run({ accountId: ACCOUNT, pid: PID, sessionId: 'sess-1', eventId, body: { priorityGrantId: asked } }),
    ).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });
  });

  test('GAT310_예매_제한_ACTIVE이고_끝_전이면_우선_구매_입장도_403_BOOKING_RESTRICTED다', async () => {
    const i = offered();
    await set.run(i);
    restrictions.rows.set(ACCOUNT, { st: 'ACTIVE' as const });
    await expect(confirm(i.grantId)).rejects.toMatchObject({ code: 'BOOKING_RESTRICTED' });
    restrictions.rows.set(ACCOUNT, { st: 'ACTIVE' as const, untilMs: NOW - 1 });
    expect(await confirm(i.grantId)).toMatchObject({ status: 'ADMITTED' });
    restrictions.rows.set(ACCOUNT, { st: 'LIFTED' as const });
    expect(await confirm(i.grantId)).toMatchObject({ status: 'ADMITTED' });
  });
});
