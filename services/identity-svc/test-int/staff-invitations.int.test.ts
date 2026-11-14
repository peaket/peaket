// identity-svc 현장 스태프 초대 실제 PostgreSQL 통합 시험(BUILD_ORDER GAT-210, R-548).
// 0031 staff_assignment 표에서 초대 조회·수락·거절 상태 전이, 이메일·동의·중복·만료, 내 배정 목록·커서를 본다.
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { createHash } from 'node:crypto';
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
  invitations = new StaffInvitations(store, clock);
  await seedAccount(ACCOUNT, 'staff@example.com');
  await seedAccount(OTHER, 'other@example.com');
  await seedInvitation({ id: A1, token: TOKEN, eventId: EVENT, role: 'gate_staff', status: 'INVITED', email: 'staff@example.com' });
  await seedInvitation({ id: A2, token: TOKEN_2, eventId: EVENT, role: 'gate_lead', status: 'INVITED', email: 'staff@example.com' });
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
