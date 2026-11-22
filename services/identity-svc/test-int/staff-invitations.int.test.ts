// identity-svc 현장 스태프 초대 실제 PostgreSQL 통합 시험(BUILD_ORDER GAT-210, R-548).
// 0031 staff_assignment 표에서 초대 조회·수락·거절 상태 전이, 이메일·동의·중복·만료, 내 배정 목록·커서를 본다.
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleStaffAssignmentStore } from '../src/modules/session/adapters/db/drizzle-staff-assignment-store.js';
import { StaffInvitations, STAFF_CONSENT_VERSION } from '../src/modules/session/application/staff-invitations.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const HOUR = 3_600_000;
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT_2 = '0190f3a1-7c2e-7a00-8000-000000000002';
const EVENT_3 = '0190f3a1-7c2e-7a00-8000-000000000006';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000004';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000005';
const A1 = '0190f3a1-7c2e-7a00-8000-000000000011';
const A2 = '0190f3a1-7c2e-7a00-8000-000000000012';
const A3 = '0190f3a1-7c2e-7a00-8000-000000000013';
const A4 = '0190f3a1-7c2e-7a00-8000-000000000014';
const A5 = '0190f3a1-7c2e-7a00-8000-000000000015';
const EVENT_NEW = '0190f3a1-7c2e-7a00-8000-000000000007';
const EVENT_NEW_2 = '0190f3a1-7c2e-7a00-8000-000000000008';
const EVENT_LIST = '0190f3a1-7c2e-7a00-8000-000000000009';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-00000000000e';
const A6 = '0190f3a1-7c2e-7a00-8000-000000000016';
const A7 = '0190f3a1-7c2e-7a00-8000-000000000017';
const A8 = '0190f3a1-7c2e-7a00-8000-000000000018';
const A9 = '0190f3a1-7c2e-7a00-8000-000000000019';
const A10 = '0190f3a1-7c2e-7a00-8000-00000000001a';
const A11 = '0190f3a1-7c2e-7a00-8000-00000000001d';
const A12 = '0190f3a1-7c2e-7a00-8000-00000000001e';
const A13 = '0190f3a1-7c2e-7a00-8000-00000000001f';
const A14 = '0190f3a1-7c2e-7a00-8000-00000000002a';
const EVENT_DUP = '0190f3a1-7c2e-7a00-8000-00000000000a';
const SS = '0190f3a1-7c2e-7a00-8000-00000000001b';
const DEVICE = '0190f3a1-7c2e-7a00-8000-00000000001c';
const TOKEN = 'db-invite-token-1';
const TOKEN_2 = 'db-invite-token-2';
const TOKEN_3 = 'db-invite-token-3';
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

let pg: PostgresContainer;
let database: Database;
let store: DrizzleStaffAssignmentStore;
let invitations: StaffInvitations;
let clock: ReturnType<typeof fakeClock>;

const seedAccount = (id: string, email: string) =>
  database.pool.query("insert into account (id, status, email, email_verified, created_at) values ($1, 'ACTIVE', $2, true, now()) on conflict (id) do nothing", [id, email]);

const seedInvitation = (o: {
  id: string;
  token: string;
  eventId: string;
  role: string;
  status: string;
  accountId?: string | null;
  email?: string;
  expiresAt?: Date;
  validFrom?: Date;
}) =>
  database.pool.query(
    `insert into staff_assignment (id, account_id, event_id, role, invite_email, invite_token_hash, invite_expires_at, invited_by, valid_from, valid_until, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      o.id,
      o.accountId ?? null,
      o.eventId,
      o.role,
      o.email ?? null,
      Buffer.from(hash(o.token), 'hex'),
      o.expiresAt ?? new Date(NOW + HOUR),
      ADMIN,
      o.validFrom ?? new Date(NOW - HOUR),
      new Date(NOW + 3 * HOUR),
      o.status,
    ],
  );

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-staff-invitations-test', max: 8 });
  clock = fakeClock({ now: NOW });
  store = new DrizzleStaffAssignmentStore(database, clock);
  invitations = new StaffInvitations(store, clock, { statusOf: async () => 'VERIFIED' });
  await seedAccount(ACCOUNT, 'staff@example.com');
  await seedAccount(OTHER, 'other@example.com');
  await seedInvitation({ id: A1, token: TOKEN, eventId: EVENT, role: 'gate_staff', status: 'INVITED', email: 'staff@example.com' });
  // 같은 회차·같은 이메일 INVITED는 0036 부분 유일 인덱스가 막는다. 중복 배정 시험은 A1이 수락된 뒤 이메일을 맞춘다
  await seedInvitation({ id: A2, token: TOKEN_2, eventId: EVENT, role: 'gate_lead', status: 'INVITED', email: 'lead@example.com' });
  await seedInvitation({ id: A3, token: TOKEN_3, eventId: EVENT_2, role: 'gate_staff', status: 'INVITED', email: 'staff@example.com', expiresAt: new Date(NOW - 1) });
});

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

const accept = (over: Partial<Parameters<StaffInvitations['accept']>[0]> = {}) => ({
  inviteToken: TOKEN,
  accountId: ACCOUNT,
  consentCollection: true,
  consentProvision: true,
  consentVersion: STAFF_CONSENT_VERSION,
  ...over,
});

describe('staff 초대 PostgreSQL [GAT-210]', () => {
  test('0001~0031 마이그레이션을 다시 적용해도 같고 staff_assignment가 있다', async () => {
    await migrateIdentity(pg.url);
    const r = await database.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name = 'staff_assignment'");
    expect(r.rows).toEqual([{ table_name: 'staff_assignment' }]);
  });

  test('조회는 만료된 초대를 410으로 닫고, 수락은 이메일·동의·중복을 가른 뒤 ASSIGNED로 바꾼다', async () => {
    await expect(invitations.lookup(TOKEN_3)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await expect(invitations.accept(accept({ accountId: OTHER }))).rejects.toMatchObject({ code: 'EMAIL_MISMATCH' });
    await expect(invitations.accept(accept({ consentCollection: false }))).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(invitations.accept(accept({ consentVersion: 'old' }))).rejects.toMatchObject({ code: 'CONSENT_OUTDATED' });
    const r = await invitations.accept(accept());
    expect(r).toMatchObject({ assignmentId: A1, eventId: EVENT, status: 'ASSIGNED' });
    const row = (await database.pool.query('select account_id, status, accepted_at, consent_version, invite_email, invite_token_hash from staff_assignment where id = $1', [A1])).rows[0];
    expect(row).toMatchObject({ account_id: ACCOUNT, status: 'ASSIGNED', consent_version: STAFF_CONSENT_VERSION, invite_email: null, invite_token_hash: null });
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await expect(store.hasAssigned(ACCOUNT)).resolves.toBe(true);
  });

  test('같은 회차 중복 배정은 409이고, 거절은 EXPIRED로 끝내며 다시 보내도 같다', async () => {
    // A1이 수락돼 invite_email이 비었으므로 이제 A2의 이메일을 같은 값으로 맞출 수 있다(0036 인덱스는 INVITED끼리만 본다)
    await database.pool.query("update staff_assignment set invite_email = 'staff@example.com' where id = $1", [A2]);
    await expect(invitations.accept(accept({ inviteToken: TOKEN_2 }))).rejects.toMatchObject({ code: 'ASSIGNMENT_EXISTS' });
    await invitations.reject(TOKEN_2);
    expect((await database.pool.query('select status, invite_email, invite_token_hash from staff_assignment where id = $1', [A2])).rows[0]).toMatchObject({ status: 'EXPIRED', invite_email: null, invite_token_hash: null });
    await expect(invitations.reject(TOKEN_2)).resolves.toBeUndefined();
    await expect(invitations.lookup(TOKEN_2)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  test('내 배정 목록은 ASSIGNED·ENDED·REVOKED만 유효 시작 늦은 순으로 주고 커서로 나눈다', async () => {
    await database.pool.query("update staff_assignment set status = 'ENDED' where id = $1", [A1]);
    await seedInvitation({ id: A4, token: 'db-invite-token-4', eventId: EVENT_3, role: 'gate_staff', status: 'ASSIGNED', accountId: ACCOUNT, validFrom: new Date(NOW + HOUR) });
    await seedInvitation({ id: A5, token: 'db-invite-token-5', eventId: EVENT_2, role: 'gate_lead', status: 'REVOKED', accountId: ACCOUNT, validFrom: new Date(NOW - 2 * HOUR) });
    const first = await invitations.listSelf({ accountId: ACCOUNT, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ assignmentId: A4, status: 'ASSIGNED', activeScannerDeviceName: null });
    const second = await invitations.listSelf({ accountId: ACCOUNT, cursor: first.nextCursor, limit: 10 });
    expect(second.items.map((x) => x.assignmentId)).toEqual([A1, A5]);
  });
});

describe('파트너 초대 만들기·명단·해제·재발송 PostgreSQL [BAT-450B]', () => {
  test('I-T21 ② 0036 부분 유일 인덱스는 같은 회차·같은 이메일(대소문자 무시) INVITED를 막고, 수락 뒤에는 다시 허용한다', async () => {
    await seedInvitation({ id: A6, token: 'db-new-1', eventId: EVENT_NEW, role: 'gate_staff', status: 'INVITED', email: 'Case@Example.com' });
    await expect(
      seedInvitation({ id: A7, token: 'db-new-2', eventId: EVENT_NEW, role: 'gate_lead', status: 'INVITED', email: 'case@example.com' }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'staff_assignment_event_invite_email_key' });
    // 수락은 이메일·토큰을 지우므로 같은 이메일의 새 INVITED를 막지 않는다
    await database.pool.query("update staff_assignment set status = 'ASSIGNED', account_id = $2, invite_email = null, invite_token_hash = null where id = $1", [A6, ACCOUNT]);
    await seedInvitation({ id: A7, token: 'db-new-2', eventId: EVENT_NEW, role: 'gate_lead', status: 'INVITED', email: 'case@example.com' });
    expect((await database.pool.query('select count(*)::int as n from staff_assignment where event_id = $1', [EVENT_NEW])).rows[0].n).toBe(2);
  });

  test('I-T21 ③ createInvitations는 여러 행을 넣고, findInvitedEmails는 소문자로 걸러 중복을 알린다', async () => {
    const made = await store.createInvitations([
      { assignmentId: A8, eventId: EVENT_NEW_2, promoterId: PROMOTER, role: 'gate_staff', email: 'a@example.com', tokenHash: hash('db-new-8'), expiresAtMs: NOW + HOUR, invitedBy: ADMIN, validFromMs: NOW - HOUR, validUntilMs: NOW + 3 * HOUR },
      { assignmentId: A9, eventId: EVENT_NEW_2, promoterId: PROMOTER, role: 'gate_lead', email: 'B@Example.com', tokenHash: hash('db-new-9'), expiresAtMs: NOW + HOUR, invitedBy: ADMIN, validFromMs: NOW - HOUR, validUntilMs: NOW + 3 * HOUR },
    ]);
    expect(made.result).toBe('OK');
    if (made.result !== 'OK') throw new Error('OK가 아니다');
    expect(made.created.map((r) => [r.assignmentId, r.inviteEmail, r.promoterId, r.status])).toEqual([
      [A8, 'a@example.com', PROMOTER, 'INVITED'],
      [A9, 'b@example.com', PROMOTER, 'INVITED'],
    ]);
    expect(await store.findInvitedEmails(EVENT_NEW_2, ['A@EXAMPLE.COM'])).toEqual(['a@example.com']);
    const dup = await store.createInvitations([
      { assignmentId: A10, eventId: EVENT_NEW_2, promoterId: PROMOTER, role: 'gate_staff', email: 'a@example.com', tokenHash: hash('db-new-10'), expiresAtMs: NOW + HOUR, invitedBy: ADMIN, validFromMs: NOW - HOUR, validUntilMs: NOW + 3 * HOUR },
    ]);
    expect(dup).toEqual({ result: 'DUPLICATE_EMAIL', emails: ['a@example.com'] });
    expect((await database.pool.query('select count(*)::int as n from staff_assignment where event_id = $1', [EVENT_NEW_2])).rows[0].n).toBe(2);
  });

  test('I-T21 ⑦ listByEvent는 이메일·계정 ID 없이 수락한 계정의 닉네임과 역할·상태·시간만 준다', async () => {
    await database.pool.query("update account set nickname = '현장 리더' where id = $1", [ACCOUNT]);
    await seedInvitation({ id: A10, token: 'db-new-10b', eventId: EVENT_LIST, role: 'gate_lead', status: 'ASSIGNED', accountId: ACCOUNT });
    const page = await store.listByEvent({ eventId: EVENT_LIST, limit: 10 });
    expect(page.items).toEqual([
      {
        assignmentId: A10,
        eventId: EVENT_LIST,
        nickname: '현장 리더',
        role: 'gate_lead',
        status: 'ASSIGNED',
        inviteExpiresAt: new Date(NOW + HOUR).toISOString(),
        validFrom: new Date(NOW - HOUR).toISOString(),
        validUntil: new Date(NOW + 3 * HOUR).toISOString(),
      },
    ]);
    expect(JSON.stringify(page)).not.toContain('staff@example.com');
    expect(JSON.stringify(page)).not.toContain(ACCOUNT);
  });

  test('I-T21 ⑧ revokeAssignment는 REVOKED·이메일/토큰 파기·세션 종료·control 사건을 한 트랜잭션에 남기고 두 번째는 바꾸지 않는다', async () => {
    await seedInvitation({ id: A11, token: 'db-revoke', eventId: EVENT_NEW_2, role: 'gate_staff', status: 'ASSIGNED', accountId: ACCOUNT, email: 'revoke@example.com' });
    await database.pool.query(
      `insert into scanner_session (id, staff_assignment_id, staff_account_id, scanner_device_id, role, proxy, approved_at, expires_at)
       values ($1, $2, $3, $4, 'gate_staff', false, $5, $6)`,
      [SS, A11, ACCOUNT, DEVICE, new Date(NOW), new Date(NOW + HOUR)],
    );
    const r = await store.revokeAssignment({ assignmentId: A11, nowMs: NOW + 1 });
    expect(r).toEqual({ found: true, changed: true, sessions: 1 });
    const row = (await database.pool.query('select status, invite_email, invite_token_hash from staff_assignment where id = $1', [A11])).rows[0];
    expect(row).toMatchObject({ status: 'REVOKED', invite_email: null, invite_token_hash: null });
    expect((await database.pool.query('select terminated_at from scanner_session where id = $1', [SS])).rows[0].terminated_at).toEqual(new Date(NOW + 1));
    const outbox = await database.pool.query("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1 order by id desc limit 1", [ACCOUNT]);
    expect(JSON.parse(Buffer.from(outbox.rows[0].payload).toString('utf8'))).toMatchObject({ accountId: ACCOUNT, sessionId: SS, reason: 'STAFF_REVOKED', terminatedAt: new Date(NOW + 1).toISOString() });
    expect(await store.revokeAssignment({ assignmentId: A11, nowMs: NOW + 2 })).toEqual({ found: true, changed: false, sessions: 0 });
    expect(await store.revokeAssignment({ assignmentId: '0190f3a1-7c2e-7a00-8000-0000000000ff', nowMs: NOW + 2 })).toEqual({ found: false, changed: false, sessions: 0 });
  });

  test('I-T21 ⑨ reissueInvitation는 새 해시·만료로 바꾸고 옛 토큰을 찾지 못하게 하며, 수락된 배정은 ALREADY_ACCEPTED다', async () => {
    await seedInvitation({ id: A9, token: 'db-old', eventId: EVENT_NEW_2, role: 'gate_lead', status: 'INVITED', email: 'b@example.com' });
    const r = await store.reissueInvitation({ assignmentId: A9, tokenHash: hash('db-fresh'), expiresAtMs: NOW + 2 * HOUR });
    expect(r.result).toBe('OK');
    await expect(store.findInvitationByTokenHash(hash('db-old'))).resolves.toBeNull();
    const found = await store.findInvitationByTokenHash(hash('db-fresh'));
    expect(found).toMatchObject({ assignmentId: A9, inviteExpiresAtMs: NOW + 2 * HOUR });
    await database.pool.query("update staff_assignment set status = 'ASSIGNED', account_id = $2 where id = $1", [A9, ACCOUNT]);
    await expect(store.reissueInvitation({ assignmentId: A9, tokenHash: hash('db-fresh-2'), expiresAtMs: NOW + 3 * HOUR })).resolves.toEqual({ result: 'ALREADY_ACCEPTED' });
    await expect(store.reissueInvitation({ assignmentId: '0190f3a1-7c2e-7a00-8000-0000000000ff', tokenHash: hash('x'), expiresAtMs: NOW })).resolves.toEqual({ result: 'NOT_FOUND' });
  });

  test('I-T21 ② 0036은 옛 중복 INVITED를 만료가 늦은 하나만 남기고 EXPIRED로 정리한 뒤 인덱스를 만든다(RV-01)', async () => {
    await database.pool.query('drop index if exists staff_assignment_event_invite_email_key');
    await seedInvitation({ id: A12, token: 'db-dup-old', eventId: EVENT_DUP, role: 'gate_staff', status: 'INVITED', email: 'dup@example.com', expiresAt: new Date(NOW + HOUR) });
    await seedInvitation({ id: A13, token: 'db-dup-new', eventId: EVENT_DUP, role: 'gate_lead', status: 'INVITED', email: 'DUP@example.com', expiresAt: new Date(NOW + 2 * HOUR) });
    const sql = readFileSync(new URL('../migrations/0036_staff_invitation_email_unique.sql', import.meta.url), 'utf8');
    await database.pool.query(sql);
    const rows = (await database.pool.query('select id, status, invite_email, invite_token_hash from staff_assignment where event_id = $1 order by id', [EVENT_DUP])).rows;
    expect(rows).toEqual([
      { id: A12, status: 'EXPIRED', invite_email: null, invite_token_hash: null },
      { id: A13, status: 'INVITED', invite_email: 'DUP@example.com', invite_token_hash: Buffer.from(hash('db-dup-new'), 'hex') },
    ]);
    const idx = await database.pool.query("select indexname from pg_indexes where schemaname = 'public' and tablename = 'staff_assignment' and indexname = 'staff_assignment_event_invite_email_key'");
    expect(idx.rows).toEqual([{ indexname: 'staff_assignment_event_invite_email_key' }]);
    // 인덱스가 다시 서면 같은 이메일의 INVITED를 또 넣을 수 없다
    await expect(seedInvitation({ id: A14, token: 'db-dup-again', eventId: EVENT_DUP, role: 'gate_staff', status: 'INVITED', email: 'dup@example.com' })).rejects.toMatchObject({ code: '23505', constraint: 'staff_assignment_event_invite_email_key' });
  });
});
