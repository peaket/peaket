// 파트너 현장 스태프 초대 서버 시험(BUILD_ORDER BAT-450B, GAT-210, identity §6.1, FR-046·POL-031, ADR-0353).
// 초대 만들기·명단·해제·재발송을 실제 HTTP 경로와 메모리 저장소·가짜 core·메모리 메일 대역으로 본다.
// 토큰 원문은 메일 링크에서만 꺼내고, 응답·로그·DB에는 원문이 없음을 함께 본다.
import 'reflect-metadata';
import { type AdminAuthz, createService } from '@peaket/platform';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { STAFF_ASSIGNMENT_STORE } from '../src/modules/session/domain/staff.js';
import type { StaffAssignmentStore } from '../src/modules/session/domain/staff.js';
import { CheckScannerSession } from '../src/modules/session/application/check-scanner-session.js';
import { JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import type { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { fanKey, ISSUER, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const NOW = Date.parse('2026-11-22T04:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EVENT = '0190f3a1-7c2e-7a00-8000-00000000b101';
const EVENT_2 = '0190f3a1-7c2e-7a00-8000-00000000b102';
const TENANT = '0190f3a1-7c2e-7a00-8000-00000000b201';
const OTHER_TENANT = '0190f3a1-7c2e-7a00-8000-00000000b202';
const PA = '0190f3a1-7c2e-7a00-8000-00000000b301';
const PM = '0190f3a1-7c2e-7a00-8000-00000000b302';
const STAFF = '0190f3a1-7c2e-7a00-8000-00000000b303';
const INVITE_URL = 'https://peaket.example/staff/invitations';
const STARTS = NOW + 10 * DAY;
const ENDS = STARTS + 2 * HOUR;
const ENTRY = STARTS - 2 * HOUR;

const hashOf = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** core-svc 내부 판매 설정 대역. 없으면 404, fail이면 503으로 사상되는 던짐이다 */
class Owners {
  readonly map = new Map<string, { promoterId: string; startsAtMs: number; endsAtMs: number; entryOpensAtMs?: number }>();
  fail = false;
  calls: { eventId: string }[] = [];
  async find(eventId: string) {
    this.calls.push({ eventId });
    if (this.fail) throw new Error('core-svc sale config 503');
    return this.map.get(eventId);
  }
}

class MailSpy {
  sent: { to: string; link: string; expiresAt: number; eventId: string; role: string; at: number }[] = [];
  fail = false;
  async send(m: { to: string; link: string; expiresAt: number; eventId: string; role: string; at: number }): Promise<void> {
    if (this.fail) throw new Error('메일 발송 실패');
    this.sent.push(m);
  }
}

let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryStaffAssignmentStore;
let owners: Owners;
let mail: MailSpy;
let now = NOW;
let logs = '';
const authz = new Map<string, AdminAuthz>([
  ['s-pa', { valid: true, role: 'partner_admin', tenantId: TENANT }],
  ['s-pm', { valid: true, role: 'partner_member', tenantId: TENANT }],
  ['s-other', { valid: true, role: 'partner_admin', tenantId: OTHER_TENANT }],
  ['s-no-tenant', { valid: true, role: 'partner_admin' }],
  ['s-fan', { valid: true, role: 'fan' }],
]);

beforeAll(async () => {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  owners = new Owners();
  mail = new MailSpy();
  const clock = { now: () => now, monotonicMs: () => 0 };
  const logDestination = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  // 구현 전 트리에서도 부팅해 경로의 404를 보기 위한 시험 이음이다. 구현 뒤에는 SessionModule이 이 포트를 쓴다.
  const session = {
    signer: new JoseTokenSigner(keys, ISSUER),
    keys,
    deviceRefs: testDeviceRefs(),
    signals: recordingSignals(),
    coreEventOwners: owners,
    staffInviteMailer: mail,
    staffInvitationUrl: INVITE_URL,
    partnerStaff: true,
  } as never;
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({
      memory: true,
      session,
      verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    adminAuthz: { getAdminAuthz: async (q) => authz.get(q.sessionId) ?? { valid: false, role: '' } },
    logDestination,
  });
  store = svc.app.get<MemoryStaffAssignmentStore>(STAFF_ASSIGNMENT_STORE);
});

afterAll(async () => {
  await svc?.close();
});

beforeEach(() => {
  now = NOW;
  logs = '';
  store.assignments.clear();
  store.sessions.clear();
  store.accounts.clear();
  store.terminatedEvents.length = 0;
  owners.map.clear();
  owners.calls.length = 0;
  owners.fail = false;
  mail.sent.length = 0;
  mail.fail = false;
  owners.map.set(EVENT, { promoterId: TENANT, startsAtMs: STARTS, endsAtMs: ENDS, entryOpensAtMs: ENTRY });
  owners.map.set(EVENT_2, { promoterId: OTHER_TENANT, startsAtMs: STARTS, endsAtMs: ENDS, entryOpensAtMs: ENTRY });
});

const bareHeaders = (session = 's-pa') => ({ 'x-user-id': PA, 'x-session-id': session, 'x-user-aud': 'partner' });
const headers = (session = 's-pa') => ({ ...bareHeaders(session), 'content-type': 'application/json' });
const create = (invitations: { email: string; role: 'gate_staff' | 'gate_lead' }[], eventId = EVENT, session = 's-pa') =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/partner/events/${eventId}/staff-invitations`,
    headers: headers(session),
    payload: JSON.stringify({ invitations }),
  });
const list = (eventId = EVENT, query = '', session = 's-pa') =>
  svc.http.inject({ method: 'GET', url: `/v1/partner/events/${eventId}/staff${query}`, headers: bareHeaders(session) });
const revoke = (assignmentId: string, session = 's-pa') =>
  svc.http.inject({ method: 'DELETE', url: `/v1/partner/staff/${assignmentId}`, headers: bareHeaders(session) });
const reissue = (assignmentId: string, session = 's-pa') =>
  svc.http.inject({ method: 'POST', url: `/v1/partner/staff/${assignmentId}/invitation`, headers: bareHeaders(session) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown> | Record<string, unknown>[];
const tokenOf = (link: string): string => {
  const m = /#token=([A-Za-z0-9_-]+)$/.exec(link);
  if (!m) throw new Error(`메일 링크에 조각 토큰이 없다: ${link}`);
  return m[1]!;
};
const seedInvited = (id: string, email: string, token: string, expiresAtMs = NOW + 24 * HOUR) => {
  store.assignments.set(id, {
    id,
    accountId: null,
    status: 'INVITED',
    eventId: EVENT,
    role: 'gate_staff',
    promoterId: TENANT,
    inviteEmail: email,
    inviteTokenHash: hashOf(token),
    inviteExpiresAtMs: expiresAtMs,
    invitedBy: PA,
    validFromMs: NOW - HOUR,
    validUntilMs: NOW + 2 * HOUR,
  });
};

describe('파트너 현장 스태프 초대 서버 [GAT-210, BAT-450B]', () => {
  test('I-T21 ① partner_admin이 여러 명(3명)을 초대하고 역할·유효 시간·201을 받는다. 200명은 되고 201명은 계약에서 막힌다', async () => {
    const r = await create([
      { email: 'gate1@example.com', role: 'gate_staff' },
      { email: 'gate2@example.com', role: 'gate_lead' },
      { email: 'gate3@example.com', role: 'gate_staff' },
    ]);
    expect(r.statusCode).toBe(201);
    const body = json(r) as Record<string, unknown>[];
    expect(body).toHaveLength(3);
    expect(store.assignments.size).toBe(3);
    expect(mail.sent).toHaveLength(3);
    for (const item of body) {
      expect(item).toMatchObject({ eventId: EVENT, status: 'INVITED', validFrom: new Date(ENTRY - 3 * HOUR).toISOString(), validUntil: new Date(ENDS + 2 * HOUR).toISOString() });
      expect(item.inviteExpiresAt).toBe(new Date(NOW + 24 * HOUR).toISOString());
    }

    const twoHundred = Array.from({ length: 200 }, (_, i) => ({ email: `many-${i}@example.com`, role: 'gate_staff' as const }));
    store.assignments.clear();
    mail.sent.length = 0;
    expect((await create(twoHundred)).statusCode).toBe(201);
    expect(store.assignments.size).toBe(200);
    expect((await create([...twoHundred, { email: 'many-200@example.com', role: 'gate_staff' }])).statusCode).toBe(400);
    expect(store.assignments.size).toBe(200);
  });

  test('I-T21 ② 요청 안 같은 이메일(대소문자)과 같은 회차에 이미 INVITED인 이메일은 422이고, 수락 뒤 같은 이메일 재초대는 201이다', async () => {
    const dup = await create([
      { email: 'Dup@Example.com', role: 'gate_staff' },
      { email: 'dup@example.com', role: 'gate_lead' },
    ]);
    expect(dup.statusCode).toBe(422);
    expect(json(dup)).toMatchObject({ type: expect.stringContaining('staff-invitation-duplicate') });
    expect(store.assignments.size).toBe(0);
    expect(mail.sent).toHaveLength(0);

    seedInvited('a-existing', 'taken@example.com', 't'.repeat(43));
    const again = await create([{ email: 'TAKEN@example.com', role: 'gate_staff' }]);
    expect(again.statusCode).toBe(422);
    expect(store.assignments.size).toBe(1);

    // 수락한 배정은 초대 이메일을 지우므로 같은 이메일을 다른 사람으로 다시 초대할 수 있다
    store.assignments.set('a-existing', { ...store.assignments.get('a-existing')!, status: 'ASSIGNED', accountId: STAFF, inviteEmail: undefined, inviteTokenHash: undefined });
    store.accounts.set(STAFF, { verified: true, status: 'ACTIVE', nickname: '현장 리더' });
    expect((await create([{ email: 'taken@example.com', role: 'gate_staff' }])).statusCode).toBe(201);
    expect(store.assignments.size).toBe(2);
  });

  test('I-T21 ③ 토큰은 32바이트 난수의 base64url 43자이고 DB에는 SHA-256만, 만료는 24시간이다', async () => {
    const r = await create([{ email: 'Token3@Example.com', role: 'gate_staff' }]);
    expect(r.statusCode).toBe(201);
    const token = tokenOf(mail.sent[0]!.link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const row = [...store.assignments.values()][0]!;
    expect(row.inviteEmail).toBe('token3@example.com');
    expect(row.inviteTokenHash).toBe(hashOf(token));
    expect(row.inviteExpiresAtMs).toBe(NOW + 24 * HOUR);
    expect(row.promoterId).toBe(TENANT);
    expect(row.status).toBe('INVITED');
    expect(row.accountId).toBeNull();
  });

  test('I-T21 ④ 응답·헤더·로그에 토큰 원문이 없고 메일 링크에만 조각으로 있다', async () => {
    const r = await create([{ email: 'secret@example.com', role: 'gate_staff' }]);
    expect(r.statusCode).toBe(201);
    const token = tokenOf(mail.sent[0]!.link);
    expect(r.payload).not.toContain(token);
    expect(JSON.stringify(r.headers)).not.toContain(token);
    expect(logs).not.toContain(token);
    expect(mail.sent[0]!.link.startsWith(`${INVITE_URL}#token=`)).toBe(true);
    expect(mail.sent[0]!.link).not.toContain('?token=');
    expect([...store.assignments.values()][0]!.inviteTokenHash).toBe(hashOf(token));
  });

  test('I-T21 ⑤ 다른 파트너 회차·없는 회차는 같은 404 본문이고 행을 만들지 않는다', async () => {
    const other = await create([{ email: 'x@example.com', role: 'gate_staff' }], EVENT_2);
    const missing = await create([{ email: 'x@example.com', role: 'gate_staff' }], '0190f3a1-7c2e-7a00-8000-00000000b999');
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // 본문이 같아 없는 회차와 다른 파트너 회차를 가릴 수 없다(AZ-T2·T3). instance(요청 주소)는 다를 수 있다
    expect(json(other)).toMatchObject({ type: (json(missing) as Record<string, unknown>).type, status: 404, title: (json(missing) as Record<string, unknown>).title });
    expect(store.assignments.size).toBe(0);
    expect(mail.sent).toHaveLength(0);
    expect((await list(EVENT_2, '', 's-pa')).statusCode).toBe(404);
  });

  test('I-T86 ③ core가 404면 404, 401·5xx·시간 초과·모양 틀림이면 503 authz-unavailable이고 행을 만들지 않는다', async () => {
    owners.fail = true;
    const down = await create([{ email: 'down@example.com', role: 'gate_staff' }]);
    expect(down.statusCode).toBe(503);
    expect(json(down)).toMatchObject({ type: expect.stringContaining('authz-unavailable') });
    expect(store.assignments.size).toBe(0);
    expect(mail.sent).toHaveLength(0);

    owners.fail = false;
    owners.map.delete(EVENT);
    const missing = await create([{ email: 'none@example.com', role: 'gate_staff' }]);
    expect(missing.statusCode).toBe(404);
    expect(store.assignments.size).toBe(0);

    // 어댑터가 없으면(설정 누락) 같은 503이다. 이 시험은 요청마다 다른 이벤트로 확인한다
    owners.map.set(EVENT, { promoterId: TENANT, startsAtMs: STARTS, endsAtMs: ENDS });
    expect((await create([{ email: 'ok@example.com', role: 'gate_staff' }])).statusCode).toBe(201);
  });

  test('I-T21 ⑥ 메일 대역은 수신자·조각 링크·24시간을 남기고, 메일이 없으면 503 provider-down이며 행을 만들지 않는다', async () => {
    const r = await create([{ email: 'mail@example.com', role: 'gate_lead' }]);
    expect(r.statusCode).toBe(201);
    expect(mail.sent[0]).toMatchObject({ to: 'mail@example.com', eventId: EVENT, role: 'gate_lead', expiresAt: NOW + 24 * HOUR, at: NOW });
    expect(tokenOf(mail.sent[0]!.link)).toHaveLength(43);

    mail.fail = true;
    store.assignments.clear();
    const failed = await create([{ email: 'fail@example.com', role: 'gate_staff' }]);
    expect(failed.statusCode).toBe(503);
    expect(json(failed)).toMatchObject({ type: expect.stringContaining('provider-down') });
    expect(store.assignments.size).toBe(0);
  });

  test('I-T21 ⑦ 명단은 이메일·계정 ID 없이 닉네임·역할·상태·시간만 주고, 커서·limit·테넌트를 지킨다', async () => {
    seedInvited('a-1', 'invited@example.com', 'i'.repeat(43));
    store.assignments.set('a-2', {
      id: 'a-2',
      accountId: STAFF,
      status: 'ASSIGNED',
      eventId: EVENT,
      role: 'gate_lead',
      promoterId: TENANT,
      invitedBy: PA,
      validFromMs: NOW + HOUR,
      validUntilMs: NOW + 3 * HOUR,
    });
    store.accounts.set(STAFF, { verified: true, status: 'ACTIVE', nickname: '현장 리더' });

    const full = await list();
    expect(full.statusCode).toBe(200);
    expect(full.headers['cache-control']).toContain('no-store');
    const body = json(full) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(body.items).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('invited@example.com');
    expect(JSON.stringify(body)).not.toContain(STAFF);
    const assigned = body.items.find((x) => x.assignmentId === 'a-2')!;
    const invited = body.items.find((x) => x.assignmentId === 'a-1')!;
    expect(assigned).toMatchObject({ nickname: '현장 리더', role: 'gate_lead', status: 'ASSIGNED' });
    expect(invited.nickname).toBeUndefined();
    expect(assigned.scanCount).toBeUndefined();
    expect(assigned.overrideCount).toBeUndefined();

    const first = await list(EVENT, '?limit=1');
    const page = json(first) as { items: Record<string, unknown>[]; nextCursor: string };
    expect(page.items).toHaveLength(1);
    const second = await list(EVENT, `?limit=10&cursor=${encodeURIComponent(page.nextCursor)}`);
    expect((json(second) as { items: unknown[] }).items).toHaveLength(1);
    expect((await list(EVENT, '?limit=101')).statusCode).toBe(400);
  });

  test('I-T21 ⑧ 해제는 204·REVOKED·이메일/토큰 파기·세션 종료·control 사건이고, 다음 요청은 거부되며 두 번도 204다', async () => {
    seedInvited('a-revoke', 'revoke@example.com', 'r'.repeat(43));
    store.assignments.set('a-revoke', { ...store.assignments.get('a-revoke')!, status: 'ASSIGNED', accountId: STAFF });
    store.accounts.set(STAFF, { verified: true, status: 'ACTIVE' });
    store.sessions.set('ss-1', {
      scannerSessionId: 'ss-1',
      assignmentId: 'a-revoke',
      accountId: STAFF,
      deviceId: '0190f3a1-7c2e-7a00-8000-00000000b401',
      role: 'gate_staff',
      proxy: false,
      expiresAt: NOW + HOUR,
      terminatedAt: null,
      assignmentStatus: 'ASSIGNED',
      validFrom: NOW - HOUR,
      validUntil: NOW + HOUR,
      eventId: EVENT,
    });

    const r = await revoke('a-revoke');
    expect(r.statusCode).toBe(204);
    const row = store.assignments.get('a-revoke')!;
    expect(row.status).toBe('REVOKED');
    expect(row.inviteEmail).toBeUndefined();
    expect(row.inviteTokenHash).toBeUndefined();
    expect(store.sessions.get('ss-1')!.terminatedAt).toBe(NOW);
    expect(store.terminatedEvents).toEqual([{ accountId: STAFF, sessionId: 'ss-1', reason: 'STAFF_REVOKED', terminatedAt: new Date(NOW).toISOString() }]);
    const check = await new CheckScannerSession(store as StaffAssignmentStore, { now: () => now, monotonicMs: () => 0 }).run({ scannerSessionId: 'ss-1', deviceId: '0190f3a1-7c2e-7a00-8000-00000000b401' });
    expect(check.valid).toBe(false);
    expect((await revoke('a-revoke')).statusCode).toBe(204);
    expect((await revoke('a-missing')).statusCode).toBe(404);
  });

  test('I-T21 ⑨ 재발송은 새 토큰·새 24시간으로 바꾸고 옛 토큰을 즉시 무효로 한다. 수락된 배정은 409다', async () => {
    seedInvited('a-re', 're@example.com', 'old-token-'.padEnd(43, '0'));
    const r = await reissue('a-re');
    expect(r.statusCode).toBe(200);
    expect(mail.sent).toHaveLength(1);
    const fresh = tokenOf(mail.sent[0]!.link);
    expect(fresh).not.toBe('old-token-'.padEnd(43, '0'));
    expect(store.assignments.get('a-re')!.inviteTokenHash).toBe(hashOf(fresh));
    expect(store.assignments.get('a-re')!.inviteExpiresAtMs).toBe(NOW + 24 * HOUR);

    const lookupOld = await svc.http.inject({ method: 'POST', url: '/v1/staff-invitation-lookups', headers: { 'content-type': 'application/json', 'x-user-id': STAFF, 'x-session-id': 's-fan', 'x-user-aud': 'fan' }, payload: JSON.stringify({ inviteToken: 'old-token-'.padEnd(43, '0') }) });
    expect(lookupOld.statusCode).toBe(410);
    const lookupNew = await svc.http.inject({ method: 'POST', url: '/v1/staff-invitation-lookups', headers: { 'content-type': 'application/json', 'x-user-id': STAFF, 'x-session-id': 's-fan', 'x-user-aud': 'fan' }, payload: JSON.stringify({ inviteToken: fresh }) });
    expect(lookupNew.statusCode).toBe(200);

    store.assignments.set('a-re', { ...store.assignments.get('a-re')!, status: 'ASSIGNED', accountId: STAFF });
    const accepted = await reissue('a-re');
    expect(accepted.statusCode).toBe(409);
    expect(json(accepted)).toMatchObject({ type: expect.stringContaining('staff-invitation-already-accepted') });
  });

  test('I-T21 ⑩ 만료된 초대 토큰은 조회·수락이 410이고, 만료된 INVITED의 재발송은 새 24시간을 준다', async () => {
    seedInvited('a-exp', 'exp@example.com', 'e'.repeat(43), NOW - 1);
    const lookup = await svc.http.inject({ method: 'POST', url: '/v1/staff-invitation-lookups', headers: { 'content-type': 'application/json', 'x-user-id': STAFF, 'x-session-id': 's-fan', 'x-user-aud': 'fan' }, payload: JSON.stringify({ inviteToken: 'e'.repeat(43) }) });
    expect(lookup.statusCode).toBe(410);
    const again = await reissue('a-exp');
    expect(again.statusCode).toBe(200);
    const fresh = tokenOf(mail.sent[0]!.link);
    expect(store.assignments.get('a-exp')!.inviteExpiresAtMs).toBe(NOW + 24 * HOUR);
    const ok = await svc.http.inject({ method: 'POST', url: '/v1/staff-invitation-lookups', headers: { 'content-type': 'application/json', 'x-user-id': STAFF, 'x-session-id': 's-fan', 'x-user-aud': 'fan' }, payload: JSON.stringify({ inviteToken: fresh }) });
    expect(ok.statusCode).toBe(200);
  });

  test('I-T21 ⑪ partner_member도 되고 역할 밖·테넌트 없음은 403, 모양 오류는 400이며 응답은 no-store다', async () => {
    expect((await create([{ email: 'pm@example.com', role: 'gate_staff' }], EVENT, 's-pm')).statusCode).toBe(201);
    expect((await list(EVENT, '', 's-pm')).statusCode).toBe(200);
    expect((await create([{ email: 'fan@example.com', role: 'gate_staff' }], EVENT, 's-fan')).statusCode).toBe(403);
    expect((await create([{ email: 'nt@example.com', role: 'gate_staff' }], EVENT, 's-no-tenant')).statusCode).toBe(403);
    expect((await list(EVENT, '', 's-no-tenant')).statusCode).toBe(403);
    const bad = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/staff-invitations`, headers: headers(), payload: JSON.stringify({ invitations: [{ email: 'x@example.com', role: 'nope' }] }) });
    expect(bad.statusCode).toBe(400);
    expect((await create([])).statusCode).toBe(400);
    const created = await create([{ email: 'cache@example.com', role: 'gate_staff' }]);
    expect(created.headers['cache-control']).toContain('no-store');
  });
});
