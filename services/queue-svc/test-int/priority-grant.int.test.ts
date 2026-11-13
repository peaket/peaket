// queue-svc 우선 구매 권리 실제 Valkey 통합 시험(BUILD_ORDER GAT-135, Q-T62, R-561).
// SetPriorityGrant 판 번호·TTL 사본과 priorityGrantId 입장 확정(같은 계정·OFFERED·만료 전, 없음/남의 것/만료 404)을 본다.
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { admissionKeys as k, RedisAdmissionStore } from '../src/modules/admission/adapters/redis-admission-store.js';
import { RedisPriorityGrantStore } from '../src/modules/admission/adapters/redis-priority-grants.js';
import { ConfirmAdmission } from '../src/modules/admission/application/confirm-admission.js';
import { SetPriorityGrant } from '../src/modules/admission/application/set-priority-grant.js';
import { priorityGrantKeyOf } from '../src/modules/admission/domain/priority-grant.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { readAdmissionToken, recordingSignals, signer } from '../test/admission-cases.js';
import { ACCOUNT, newEvent, openSchedule, OTHER_ACCOUNT, PID, tokens } from '../test/support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const HOUR = 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let valkey: ValkeyContainer;
let redis: HotRedis;
let priorityGrants: RedisPriorityGrantStore;
let set: SetPriorityGrant;
let app: ConfirmAdmission;

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const writeSchedule = async (eventId: string, s: EventSchedule): Promise<void> => {
  const key = k.cfg(eventId);
  await cmd(key, ['HSET', key, 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', s.lobbyShuffle ? '1' : '0', 'openBatch', s.openBatch ? '1' : '0', 'rev', '1']);
};

const grant = (over: Partial<Parameters<SetPriorityGrant['run']>[0]> = {}) => ({
  accountId: ACCOUNT,
  eventId: newEvent(),
  grantId: randomUUID(),
  state: 'OFFERED' as const,
  expiresAtMs: Date.now() + 48 * HOUR,
  version: 1,
  ...over,
});

const admit = (eventId: string, grantId: string, accountId = ACCOUNT) => app.run({ accountId, pid: PID, sessionId: 'sess-1', eventId, body: { priorityGrantId: grantId } });

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  priorityGrants = new RedisPriorityGrantStore(redis);
  set = new SetPriorityGrant(priorityGrants, systemClock);
  const schedules = Object.assign(new RedisEventSchedules(redis, systemClock), { set: writeSchedule });
  app = new ConfirmAdmission(new RedisAdmissionStore(redis), schedules, tokens, signer, recordingSignals(), systemClock, undefined, priorityGrants);
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

describe('우선 구매 권리 Valkey [GAT-135]', () => {
  test('판 번호가 클 때만 바뀌고, TTL은 권리 만료와 같으며 만료 뒤에는 사본이 없다', async () => {
    const i = grant();
    expect(await set.run(i)).toEqual({ changed: true });
    expect(await set.run(i)).toEqual({ changed: false });
    expect(await set.run({ ...i, version: 0, state: 'WITHDRAWN' })).toEqual({ changed: false });
    expect(await set.run({ ...i, version: 2, state: 'WITHDRAWN' })).toEqual({ changed: true });
    expect(await priorityGrants.get(i)).toMatchObject({ grantId: i.grantId, state: 'WITHDRAWN', version: 2 });

    const key = priorityGrantKeyOf(i.accountId, i.eventId);
    const pttl = Number(await cmd(key, ['PTTL', key]));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(48 * HOUR);

    const short = grant({ expiresAtMs: Date.now() + 150 });
    expect(await set.run(short)).toEqual({ changed: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await priorityGrants.get(short)).toBeUndefined();
  });

  test('OFFERED·만료 전 사본이면 새 jny와 prio 클레임을 주고, 반복 입장은 새 여정을 만든다', async () => {
    const eventId = newEvent();
    await writeSchedule(eventId, openSchedule(Date.now()));
    const i = grant({ eventId });
    await set.run(i);

    const first = await admit(eventId, i.grantId);
    expect(first.status).toBe('ADMITTED');
    if (first.status !== 'ADMITTED') return;
    const claims = readAdmissionToken(first.admissionToken).claims;
    expect(claims).toMatchObject({ sub: ACCOUNT, aud: 'purchase', event: eventId, prio: i.grantId });
    expect(claims.jny).toMatch(UUID);
    expect(claims.jti).toMatch(UUID);
    expect(await cmd(k.admitted(eventId), ['GET', k.admitted(eventId)])).toBeNull();

    const second = await admit(eventId, i.grantId);
    expect(second.status).toBe('ADMITTED');
    if (second.status !== 'ADMITTED') return;
    const again = readAdmissionToken(second.admissionToken).claims;
    expect(again.prio).toBe(i.grantId);
    expect(again.jny).not.toBe(claims.jny);
    expect(again.jti).not.toBe(claims.jti);
  });

  test('판매 종료 뒤에도 사본만 보므로 ADMITTED한다', async () => {
    const eventId = newEvent();
    const now = Date.now();
    await writeSchedule(eventId, openSchedule(now, { startsAtMs: now - HOUR }));
    const i = grant({ eventId });
    await set.run(i);
    expect((await admit(eventId, i.grantId)).status).toBe('ADMITTED');
  });

  test('없는 권리·남의 계정·WITHDRAWN·만료·다른 권리 ID는 모두 404 PRIORITY_GRANT_NOT_FOUND다', async () => {
    const eventId = newEvent();
    const now = Date.now();
    await writeSchedule(eventId, openSchedule(now));
    await expect(admit(eventId, randomUUID())).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });

    const i = grant({ eventId });
    await set.run(i);
    await expect(admit(eventId, i.grantId, OTHER_ACCOUNT)).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });
    await expect(admit(eventId, randomUUID())).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });

    await set.run({ ...i, state: 'WITHDRAWN', version: 2 });
    await expect(admit(eventId, i.grantId)).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });

    const expiredEvent = newEvent();
    await writeSchedule(expiredEvent, openSchedule(now));
    const expired = grant({ eventId: expiredEvent, expiresAtMs: now + 150 });
    await set.run(expired);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(admit(expiredEvent, expired.grantId)).rejects.toMatchObject({ code: 'PRIORITY_GRANT_NOT_FOUND' });
  });
});
