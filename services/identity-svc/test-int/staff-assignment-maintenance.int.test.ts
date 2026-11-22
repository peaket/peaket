// 현장 스태프 배정 만료 정비·시간 필터·promoter 정본화 PostgreSQL 통합 시험
// (BUILD_ORDER BAT-450C, GAT-210, C2-10·C2-11).
// 실제 PostgreSQL에서 0037 부분 인덱스, 정비 SQL의 경계·멱등, 읽기 필터, promoter_id NULL 정리를 본다.
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleStaffAssignmentStore } from '../src/modules/session/adapters/db/drizzle-staff-assignment-store.js';
import { StaffInvitations, STAFF_CONSENT_VERSION } from '../src/modules/session/application/staff-invitations.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-22T05:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ADMIN = '0190f3a1-7c2e-7a00-8000-0000000d0001';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000d0002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000d0011';
const OTHER = '0190f3a1-7c2e-7a00-8000-0000000d0012';
const EDGE = '0190f3a1-7c2e-7a00-8000-0000000d0013';
const FUTURE = '0190f3a1-7c2e-7a00-8000-0000000d0014';
const E1 = '0190f3a1-7c2e-7a00-8000-0000000d0101';
const E2 = '0190f3a1-7c2e-7a00-8000-0000000d0102';
const E3 = '0190f3a1-7c2e-7a00-8000-0000000d0103';
const E4 = '0190f3a1-7c2e-7a00-8000-0000000d0104';
const E5 = '0190f3a1-7c2e-7a00-8000-0000000d0105';
const E6 = '0190f3a1-7c2e-7a00-8000-0000000d0106';
const E7 = '0190f3a1-7c2e-7a00-8000-0000000d0107';
const E8 = '0190f3a1-7c2e-7a00-8000-0000000d0108';
const E9 = '0190f3a1-7c2e-7a00-8000-0000000d0109';
const EA = '0190f3a1-7c2e-7a00-8000-0000000d010a';
const EB = '0190f3a1-7c2e-7a00-8000-0000000d010b';
const EC = '0190f3a1-7c2e-7a00-8000-0000000d010c';
const ED = '0190f3a1-7c2e-7a00-8000-0000000d010d';
const EE = '0190f3a1-7c2e-7a00-8000-0000000d010e';
const EF = '0190f3a1-7c2e-7a00-8000-0000000d010f';
const EG = '0190f3a1-7c2e-7a00-8000-0000000d0110';
const I1 = '0190f3a1-7c2e-7a00-8000-0000000d0201';
const I2 = '0190f3a1-7c2e-7a00-8000-0000000d0202';
const I3 = '0190f3a1-7c2e-7a00-8000-0000000d0203';
const I4 = '0190f3a1-7c2e-7a00-8000-0000000d0204';
const I5 = '0190f3a1-7c2e-7a00-8000-0000000d0205';
const I6 = '0190f3a1-7c2e-7a00-8000-0000000d0206';
const A1 = '0190f3a1-7c2e-7a00-8000-0000000d0301';
const A2 = '0190f3a1-7c2e-7a00-8000-0000000d0302';
const A3 = '0190f3a1-7c2e-7a00-8000-0000000d0303';
const A4 = '0190f3a1-7c2e-7a00-8000-0000000d0304';
const A5 = '0190f3a1-7c2e-7a00-8000-0000000d0305';
const A6 = '0190f3a1-7c2e-7a00-8000-0000000d0306';
const L1 = '0190f3a1-7c2e-7a00-8000-0000000d0401';
const L2 = '0190f3a1-7c2e-7a00-8000-0000000d0402';
const L3 = '0190f3a1-7c2e-7a00-8000-0000000d0403';
const L4 = '0190f3a1-7c2e-7a00-8000-0000000d0404';
const L5 = '0190f3a1-7c2e-7a00-8000-0000000d0405';
const L6 = '0190f3a1-7c2e-7a00-8000-0000000d0406';
const L7 = '0190f3a1-7c2e-7a00-8000-0000000d0407';
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

let pg: PostgresContainer;
let database: Database;
let store: DrizzleStaffAssignmentStore;
let invitations: StaffInvitations;

const seedAccount = (id: string, email: string) =>
  database.pool.query("insert into account (id, status, email, email_verified, created_at) values ($1, 'ACTIVE', $2, true, now()) on conflict (id) do nothing", [id, email]);

const seed = (o: {
  id: string;
  status: string;
  eventId: string;
  accountId?: string | null;
  role?: string;
  promoterId?: string | null;
  token?: string;
  email?: string | null;
  expiresAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
}) =>
  database.pool.query(
    `insert into staff_assignment (id, account_id, event_id, promoter_id, role, invite_email, invite_token_hash, invite_expires_at, invited_by, valid_from, valid_until, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      o.id,
      o.accountId ?? null,
      o.eventId,
      o.promoterId === undefined ? PROMOTER : o.promoterId,
      o.role ?? 'gate_staff',
      o.email === undefined ? null : o.email,
      o.token === undefined ? null : Buffer.from(hash(o.token), 'hex'),
      o.expiresAt ?? new Date(NOW + HOUR),
      ADMIN,
      o.validFrom ?? new Date(NOW - HOUR),
      o.validUntil ?? new Date(NOW + 3 * HOUR),
      o.status,
    ],
  );

const rowOf = async (id: string) =>
  (
    await database.pool.query('select status, invite_email, invite_token_hash from staff_assignment where id = $1', [id])
  ).rows[0] as { status: string; invite_email: string | null; invite_token_hash: Buffer | null };

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-staff-maintenance-test', max: 8 });
  const clock = fakeClock({ now: NOW });
  store = new DrizzleStaffAssignmentStore(database, clock);
  invitations = new StaffInvitations(store, clock, { statusOf: async () => 'VERIFIED' });
  await seedAccount(ACCOUNT, 'staff@example.com');
  await seedAccount(OTHER, 'other@example.com');
  await seedAccount(EDGE, 'edge@example.com');
  await seedAccount(FUTURE, 'future@example.com');
});

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('배정 만료·promoter 정본화 PostgreSQL [BAT-450C]', () => {
  test('I-T87 ① 24시간이 지난 INVITED는 EXPIRED로 끝내고 이메일·토큰을 파기한다(경계·멱등)', async () => {
    await seed({ id: I1, status: 'INVITED', eventId: E1, token: 'int-expired', email: 'a@example.com', expiresAt: new Date(NOW) });
    await seed({ id: I2, status: 'INVITED', eventId: E2, token: 'int-edge', email: 'b@example.com', expiresAt: new Date(NOW + 1) });
    await seed({ id: I3, status: 'INVITED', eventId: E3, token: 'int-window', email: 'c@example.com', expiresAt: new Date(NOW + 12 * HOUR), validUntil: new Date(NOW - 1) });

    await expect(store.expireDueAssignments(NOW)).resolves.toEqual({ invitations: 2, assignments: 0 });
    await expect(rowOf(I1)).resolves.toEqual({ status: 'EXPIRED', invite_email: null, invite_token_hash: null });
    await expect(rowOf(I2)).resolves.toMatchObject({ status: 'INVITED', invite_email: 'b@example.com' });
    await expect(rowOf(I3)).resolves.toEqual({ status: 'EXPIRED', invite_email: null, invite_token_hash: null });
    await expect(store.findInvitationByTokenHash(hash('int-expired'))).resolves.toBeNull();
    await expect(store.expireDueAssignments(NOW)).resolves.toEqual({ invitations: 0, assignments: 0 });

    const indexes = await database.pool.query(
      "select indexname from pg_indexes where schemaname = 'public' and tablename = 'staff_assignment' and indexname in ('staff_assignment_invite_expiry_idx', 'staff_assignment_assigned_valid_until_idx') order by indexname",
    );
    expect(indexes.rows).toEqual([{ indexname: 'staff_assignment_assigned_valid_until_idx' }, { indexname: 'staff_assignment_invite_expiry_idx' }]);
  });

  test('I-T87 ② 역할 유효 끝이 지난 ASSIGNED는 ENDED로 끝내고 이메일·토큰을 파기한다(정각은 그대로·멱등)', async () => {
    await seed({ id: A1, status: 'ASSIGNED', eventId: E4, accountId: EDGE, validUntil: new Date(NOW) });
    await seed({ id: A2, status: 'ASSIGNED', eventId: E5, accountId: ACCOUNT, token: 'int-assigned', email: 'p@example.com', validUntil: new Date(NOW - 1) });
    await seed({ id: A3, status: 'ASSIGNED', eventId: E6, accountId: OTHER, validUntil: new Date(NOW + HOUR) });
    // 이미 끝난 행에 남은 초대 이메일·토큰도 정비가 지운다(RV-01)
    await seed({ id: L6, status: 'REVOKED', eventId: EF, accountId: FUTURE, token: 'int-terminal-revoked', email: 'tr@example.com' });
    await seed({ id: L7, status: 'ENDED', eventId: EG, accountId: FUTURE, token: 'int-terminal-ended', email: 'te@example.com' });

    await expect(store.expireDueAssignments(NOW)).resolves.toEqual({ invitations: 0, assignments: 1 });
    await expect(rowOf(A1)).resolves.toMatchObject({ status: 'ASSIGNED' });
    await expect(rowOf(A2)).resolves.toEqual({ status: 'ENDED', invite_email: null, invite_token_hash: null });
    await expect(rowOf(A3)).resolves.toMatchObject({ status: 'ASSIGNED' });
    await expect(rowOf(L6)).resolves.toEqual({ status: 'REVOKED', invite_email: null, invite_token_hash: null });
    await expect(rowOf(L7)).resolves.toEqual({ status: 'ENDED', invite_email: null, invite_token_hash: null });
    await expect(store.hasAssigned(ACCOUNT, NOW)).resolves.toBe(false);
    await expect(store.hasAssigned(EDGE, NOW)).resolves.toBe(true);
    await expect(store.expireDueAssignments(NOW)).resolves.toEqual({ invitations: 0, assignments: 0 });
  });

  test('I-T87 ③ hasAssigned는 지금 창 안의 ASSIGNED만 센다(미래·지난·취소 false, 시작·끝 정각 true)', async () => {
    await seed({ id: A4, status: 'ASSIGNED', eventId: E7, accountId: ACCOUNT, validFrom: new Date(NOW - 1), validUntil: new Date(NOW + 1) });
    await seed({ id: A5, status: 'ASSIGNED', eventId: E8, accountId: FUTURE, validFrom: new Date(NOW + 1), validUntil: new Date(NOW + HOUR) });
    await seed({ id: A6, status: 'ASSIGNED', eventId: E9, accountId: FUTURE, validFrom: new Date(NOW - 2 * HOUR), validUntil: new Date(NOW - 1) });
    await seed({ id: L1, status: 'REVOKED', eventId: EA, accountId: FUTURE, validFrom: new Date(NOW - 1), validUntil: new Date(NOW + 1) });
    await seed({ id: L2, status: 'ASSIGNED', eventId: EB, accountId: EDGE, validFrom: new Date(NOW), validUntil: new Date(NOW) });

    await expect(store.hasAssigned(ACCOUNT, NOW)).resolves.toBe(true);
    await expect(store.hasAssigned(FUTURE, NOW)).resolves.toBe(false);
    await expect(store.hasAssigned(FUTURE, NOW + 1)).resolves.toBe(true);
    await expect(store.hasAssigned(EDGE, NOW)).resolves.toBe(true);
  });

  test('I-T87 ④ listSelf·명단은 정비 전에도 지난 ASSIGNED를 ENDED로 보이고, 역할 유효 끝이 지난 초대는 410이다', async () => {
    await seed({ id: L3, status: 'ASSIGNED', eventId: EC, accountId: ACCOUNT, validUntil: new Date(NOW - 1) });
    const self = await invitations.listSelf({ accountId: ACCOUNT, limit: 10 });
    expect(self.items.find((x) => x.assignmentId === L3)).toMatchObject({ status: 'ENDED' });
    await expect(rowOf(L3)).resolves.toMatchObject({ status: 'ASSIGNED' });
    const page = await store.listByEvent({ eventId: EC, limit: 10, nowMs: NOW });
    expect(page.items.find((x) => x.assignmentId === L3)).toMatchObject({ status: 'ENDED' });

    await seed({ id: I4, status: 'INVITED', eventId: ED, token: 'int-late', email: 'late@example.com', expiresAt: new Date(NOW + 12 * HOUR), validUntil: new Date(NOW - 1) });
    await expect(invitations.lookup('int-late')).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await expect(
      invitations.accept({ inviteToken: 'int-late', accountId: ACCOUNT, consentCollection: true, consentProvision: true, consentVersion: STAFF_CONSENT_VERSION }),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await expect(rowOf(I4)).resolves.toMatchObject({ status: 'INVITED' });
  });

  test('I-T88 ① promoter_id가 없는 옛 INVITED·ASSIGNED를 정본화해 끝내고 promoter가 있는 행은 그대로 둔다', async () => {
    await seed({ id: I5, status: 'INVITED', eventId: EE, promoterId: null, token: 'int-legacy', email: 'legacy@example.com' });
    await seed({ id: L4, status: 'ASSIGNED', eventId: E1, accountId: OTHER, promoterId: null, token: 'int-legacy-2', email: 'legacy2@example.com' });
    await seed({ id: L5, status: 'REVOKED', eventId: E2, promoterId: null });
    await seed({ id: I6, status: 'INVITED', eventId: E3, promoterId: PROMOTER, email: 'kept@example.com' });

    await expect(store.closeLegacyAssignments()).resolves.toEqual({ invitations: 1, assignments: 1 });
    await expect(rowOf(I5)).resolves.toEqual({ status: 'EXPIRED', invite_email: null, invite_token_hash: null });
    await expect(rowOf(L4)).resolves.toEqual({ status: 'ENDED', invite_email: null, invite_token_hash: null });
    await expect(rowOf(L5)).resolves.toMatchObject({ status: 'REVOKED' });
    await expect(rowOf(I6)).resolves.toMatchObject({ status: 'INVITED', invite_email: 'kept@example.com' });
    await expect(store.closeLegacyAssignments()).resolves.toEqual({ invitations: 0, assignments: 0 });
  });
});
