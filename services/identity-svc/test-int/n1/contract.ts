// identity-svc N-1 앱(713b522a, 0037까지)이 DB에 보내던 SQL 모양을 옮긴 계약(F-09-2 D-T8, docs/devops.md §7.3 적용 시험 ③).
//
// N-1 = 마이그레이션 직전 develop 커밋 `713b522a7f4566a7b9ef047012783f9be50bf675`(2026-11-23, 0037까지).
// migration = 그다음 커밋 `0346eded88e7de8ba108c4288f5aa1c9cd478ffe`(0038_scanner_session_device_name.sql).
// 왜 실제 앱을 띄우지 않는가: 출시 이미지·태그가 없고, 그 트리를 설치해 시험 묶음을 돌리려면 별도 설치와
// 38개 마이그레이션 기록을 N 실행기 기록과 맞추는 작업이 필요하다. 이번 동결 로컬 턴은 Docker도 F-08-5가 쥐고 있어
// 그 실행을 `미실행`으로 두고, DB 계약만 먼저 고정한다.
//
// 이 파일이 보장하는 것: 713b522a 앱의 저장소 경로(로그인·세션 갱신/종료·관리 계정 로그인·pid/연락처 키 회전)가 쓰던
// 표와 칸·값만 쓴다. `n1-compat.int.test.ts`가 0000~0037 스키마에서 먼저 돌려 그 사실을 확인한 뒤 N 스키마에서 다시 돈다.
// 보장하지 않는 것: 앱 프로세스 기동, gRPC/HTTP 처리, 업무 규칙, KMS·Valkey 호출, 트랜잭션 순서. 계획 §9에 남긴다.

import { randomBytes, randomUUID } from 'node:crypto';

/** 713b522a 앱의 저장소 코드가 쓰는 표. 다른 서비스 표나 뒤에 생긴 표가 섞이면 n1-baseline 시험이 막는다. */
export const N1_TABLES = [
  'account',
  'account_provider',
  'account_contact_ref',
  'device',
  'session',
  'refresh_token_hash',
  'session_create_key',
  'identity_verification',
  'pid_key_rotation',
  'admin_account',
  'admin_login_step',
  'admin_security_notice',
  'admin_session',
  'admin_refresh_token_hash',
  'admin_known_source',
] as const;

export interface N1Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export const N1_SQL = {
  // session/adapters/db/drizzle-session-store.ts(713b522a) findAccountByProvider·createAccount·touchProviderLogin
  accountByProvider:
    'select a.id, a.status from account_provider p join account a on a.id = p.account_id where p.provider = $1 and p.provider_user_id = $2',
  createAccount: "insert into account (id, status, email, email_verified, locale, created_at) values ($1, 'ACTIVE', $2, $3, 'ko', $4)",
  createProvider: 'insert into account_provider (account_id, provider, provider_user_id, linked_at) values ($1, $2, $3, $4)',
  touchProviderLogin: 'update account_provider set last_login_at = $3 where provider = $1 and provider_user_id = $2',
  // 같은 파일 createDevice·insertSession·saveCreateKey·recordRefreshHash
  createDevice: 'insert into device (id, account_id, device_ref, bound_at) values ($1, $2, $3, $4)',
  createSession:
    'insert into session (id, account_id, device_id, refresh_hash, refresh_family, absolute_expires_at, idle_expires_at, login_verdict, login_verdict_at, device_label, last_active_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
  recordRefresh:
    'insert into refresh_token_hash (hash, session_id, refresh_family, issued_at, expires_at) values ($1, $2, $3, $4, $5)',
  saveCreateKey:
    'insert into session_create_key (key, provider, provider_user_id, session_id, new_account, created_at) values ($1, $2, $3, $4, $5, $6)',
  // 같은 파일 findByRefreshHash·rotateRefresh·endIn
  findRefresh:
    'select id, account_id, prev_refresh_hash, rotated_at, refresh_used from session where refresh_hash = $1 or prev_refresh_hash = $1 order by (refresh_hash = $1) desc limit 1',
  findRefreshHistory: 'select session_id from refresh_token_hash where hash = $1',
  rotateRefresh:
    'update session set prev_refresh_hash = refresh_hash, refresh_hash = $2, rotated_at = $3, last_active_at = $3, refresh_used = false, idle_expires_at = $4 where id = $1',
  terminateSession: 'update session set terminated_at = $2, terminated_reason = $3 where id = $1',
  readSession:
    'select id, account_id, device_id, refresh_hash, refresh_family, absolute_expires_at, idle_expires_at, login_verdict, device_label, last_active_at, terminated_at, terminated_reason from session where id = $1',

  // admin/adapters/db/drizzle-admin-account-store.ts(713b522a) create·findForLogin·touchLogin·login step·#openSession·touchKnownSource·addNotice
  createAdmin:
    'insert into admin_account (id, role, promoter_id, status, email, display_name, created_at, updated_at) values ($1, $2, null, $3, $4, $5, $6, $6)',
  findAdminForLogin:
    "select id, role, status, password_phc, failed_attempts, second_factor_failures, password_failure_total, lock_kind, locked_until from admin_account where email = $1 and status <> 'REMOVED'",
  touchAdminLogin: 'update admin_account set last_login_at = $2, updated_at = $2 where id = $1',
  createAdminLoginStep:
    'insert into admin_login_step (id, admin_account_id, token_hash, aud, pair_ref, created_at, expires_at, known_source) values ($1, $2, $3, $4, $5, $6, $7, $8)',
  findAdminLoginStep: 'select id, admin_account_id, aud, pair_ref, used_at from admin_login_step where token_hash = $1',
  createAdminSession:
    'insert into admin_session (id, admin_account_id, aud, refresh_hash, refresh_family, pair_ref, created_at, absolute_expires_at, idle_expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
  recordAdminRefresh:
    'insert into admin_refresh_token_hash (hash, admin_session_id, refresh_family, issued_at, expires_at) values ($1, $2, $3, $4, $5)',
  touchKnownSource:
    'insert into admin_known_source (admin_account_id, pair_ref, last_success_at) values ($1, $2, $3) on conflict (admin_account_id, pair_ref) do update set last_success_at = excluded.last_success_at',
  addAdminNotice:
    'insert into admin_security_notice (id, admin_account_id, kind, created_at) values ($1, $2, $3, $4)',
  readAdmin: 'select id, role, status, email, last_login_at from admin_account where id = $1',

  // verification/adapters/db/drizzle-verification-store.ts(713b522a) saveVerification·pid 회전, session writeContactRef
  saveVerification:
    'insert into identity_verification (account_id, ci_hmac, ci_hmac_key_version, pid, pid_key_version, verified_at, source_record) values ($1, $2, $3, $4, $5, $6, $7)',
  beginPidRotation: 'insert into pid_key_rotation (to_version, started_at, transition_ends_at) values ($1, $2, $3)',
  openPidRotation: 'select to_version, started_at, transition_ends_at, moved_at from pid_key_rotation where finished_at is null',
  movePid:
    'update identity_verification set pid_prev = pid, pid = $2, pid_key_version = $3 where account_id = $1 and pid_key_version < $3 and pid_prev is null',
  markPidMoved: 'update pid_key_rotation set moved_at = $2 where to_version = $1 and finished_at is null',
  clearPidPrev: 'update identity_verification set pid_prev = null where account_id = $1',
  finishPidRotation: 'update pid_key_rotation set finished_at = $2 where to_version = $1 and finished_at is null',
  readClaims: 'select pid, pid_prev from identity_verification where account_id = $1',
  pidVersions: 'select distinct pid_key_version from identity_verification order by pid_key_version',
  upsertContactRef:
    "insert into account_contact_ref (account_id, kind, ref, ref_prev, updated_at) values ($1, $2, $3, $4, $5) on conflict (account_id, kind) do update set ref = excluded.ref, ref_prev = case when split_part(account_contact_ref.ref, '.', 1) <> split_part(excluded.ref, '.', 1) then account_contact_ref.ref else account_contact_ref.ref_prev end, updated_at = excluded.updated_at",
  readContactRef: 'select ref, ref_prev from account_contact_ref where account_id = $1 and kind = $2',
} as const;

export interface N1Fixture {
  accountId: string;
  deviceId: string;
  sessionId: string;
  refreshFamily: string;
  firstRefreshHash: Buffer;
  currentRefreshHash: Buffer;
  adminAccountId: string;
  adminEmail: string;
  adminSessionId: string;
  adminRefreshHash: Buffer;
  adminLoginStepId: string;
  verifiedAccountId: string;
  oldPid: Buffer;
  newPid: Buffer;
  contactRef: string;
  contactRefPrev: string;
}

export interface N1ContractResult {
  fixture: N1Fixture;
  providerRowsBefore: number;
  providerRowsAfter: number;
  currentRefreshRows: number;
  previousRefreshRows: number;
  historyRefreshRows: number;
  adminByEmailRows: number;
  loginStepRows: number;
  openRotationRows: number;
  claims: { pid: string; pidPrev: string | null };
  contact: { ref: string; refPrev: string | null };
  pidVersions: number[];
}

const bytes = (value: unknown): Buffer => (Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'base64'));
const iso = (ms: number): string => new Date(ms).toISOString();

/** 계정과 기기·세션·리프레시 기록을 713b522a 로그인 경로 모양으로 만든다. 관리 계정·키 회전도 같은 계정에 잇는다. */
export async function runN1Contract(db: N1Queryable, now = Date.UTC(2026, 10, 27, 1, 0, 0)): Promise<N1ContractResult> {
  const accountId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const refreshFamily = randomUUID();
  const firstRefreshHash = randomBytes(32);
  const currentRefreshHash = randomBytes(32);
  const providerUserId = `n1-${randomUUID()}`;

  const before = await db.query(N1_SQL.accountByProvider, ['google', providerUserId]);
  await db.query(N1_SQL.createAccount, [accountId, 'n1-fan@peaket.test', true, iso(now)]);
  await db.query(N1_SQL.createProvider, [accountId, 'google', providerUserId, iso(now)]);
  const after = await db.query(N1_SQL.accountByProvider, ['google', providerUserId]);
  await db.query(N1_SQL.touchProviderLogin, ['google', providerUserId, iso(now + 1_000)]);
  await db.query(N1_SQL.createDevice, [deviceId, accountId, 'k1.device-n1', iso(now)]);
  await db.query(N1_SQL.createSession, [
    sessionId,
    accountId,
    deviceId,
    firstRefreshHash,
    refreshFamily,
    iso(now + 86_400_000),
    iso(now + 3_600_000),
    'ALLOW',
    iso(now),
    '브라우저 · Windows',
    iso(now),
  ]);
  await db.query(N1_SQL.recordRefresh, [firstRefreshHash, sessionId, refreshFamily, iso(now), iso(now + 86_400_000)]);
  await db.query(N1_SQL.saveCreateKey, [`key-${randomUUID()}`, 'google', providerUserId, sessionId, true, iso(now)]);

  const currentBeforeRotate = await db.query(N1_SQL.findRefresh, [firstRefreshHash]);
  await db.query(N1_SQL.rotateRefresh, [sessionId, currentRefreshHash, iso(now + 2_000), iso(now + 3_600_000)]);
  await db.query(N1_SQL.recordRefresh, [currentRefreshHash, sessionId, refreshFamily, iso(now + 2_000), iso(now + 86_400_000)]);
  const rotated = await db.query(N1_SQL.findRefresh, [currentRefreshHash]);
  const previous = await db.query(N1_SQL.findRefresh, [firstRefreshHash]);
  const history = await db.query(N1_SQL.findRefreshHistory, [firstRefreshHash]);

  const adminAccountId = randomUUID();
  const adminEmail = `n1-admin-${randomUUID()}@peaket.test`;
  const adminSessionId = randomUUID();
  const adminRefreshHash = randomBytes(32);
  const adminLoginStepId = randomUUID();
  const adminLoginTokenHash = randomBytes(32);
  await db.query(N1_SQL.createAdmin, [adminAccountId, 'operator', 'INVITED', adminEmail, 'N-1 관리자', iso(now)]);
  const adminByEmail = await db.query(N1_SQL.findAdminForLogin, [adminEmail]);
  await db.query(N1_SQL.touchAdminLogin, [adminAccountId, iso(now + 3_000)]);
  await db.query(N1_SQL.createAdminLoginStep, [
    adminLoginStepId,
    adminAccountId,
    adminLoginTokenHash,
    'ops',
    'k1.pair-n1',
    iso(now),
    iso(now + 300_000),
    false,
  ]);
  const loginStep = await db.query(N1_SQL.findAdminLoginStep, [adminLoginTokenHash]);
  await db.query(N1_SQL.createAdminSession, [
    adminSessionId,
    adminAccountId,
    'ops',
    adminRefreshHash,
    randomUUID(),
    'k1.pair-n1',
    iso(now),
    iso(now + 86_400_000),
    iso(now + 3_600_000),
  ]);
  await db.query(N1_SQL.recordAdminRefresh, [adminRefreshHash, adminSessionId, randomUUID(), iso(now), iso(now + 86_400_000)]);
  await db.query(N1_SQL.touchKnownSource, [adminAccountId, 'k1.pair-n1', iso(now)]);
  await db.query(N1_SQL.touchKnownSource, [adminAccountId, 'k1.pair-n1', iso(now + 60_000)]);
  await db.query(N1_SQL.addAdminNotice, [randomUUID(), adminAccountId, 'TIMED_LOCK', iso(now)]);

  const verifiedAccountId = randomUUID();
  const ciHmac = randomBytes(32);
  const oldPid = randomBytes(32);
  const newPid = randomBytes(32);
  // 0.3.0도 본인확인은 이미 있는 계정에만 쓴다(identity_verification.account_id -> account.id 외래 키).
  await db.query(N1_SQL.createAccount, [verifiedAccountId, null, false, iso(now)]);
  await db.query(N1_SQL.saveVerification, [verifiedAccountId, ciHmac, 1, oldPid, 1, iso(now), `migration-${randomUUID()}`]);
  await db.query(N1_SQL.beginPidRotation, [2, iso(now), iso(now + 7 * 86_400_000)]);
  const openRotation = await db.query(N1_SQL.openPidRotation);
  await db.query(N1_SQL.movePid, [verifiedAccountId, newPid, 2]);
  await db.query(N1_SQL.markPidMoved, [2, iso(now + 1_000)]);
  await db.query(N1_SQL.clearPidPrev, [verifiedAccountId]);
  await db.query(N1_SQL.finishPidRotation, [2, iso(now + 2_000)]);
  const claims = await db.query(N1_SQL.readClaims, [verifiedAccountId]);
  const pidVersions = await db.query(N1_SQL.pidVersions);

  await db.query(N1_SQL.upsertContactRef, [accountId, 'EMAIL', 'k1.contact-aaaa', null, iso(now)]);
  await db.query(N1_SQL.upsertContactRef, [accountId, 'EMAIL', 'k2.contact-bbbb', null, iso(now + 1_000)]);
  const contact = await db.query(N1_SQL.readContactRef, [accountId, 'EMAIL']);

  const readClaimsRow = claims.rows[0]!;
  const readContactRow = contact.rows[0]!;
  return {
    fixture: {
      accountId,
      deviceId,
      sessionId,
      refreshFamily,
      firstRefreshHash,
      currentRefreshHash,
      adminAccountId,
      adminEmail,
      adminSessionId,
      adminRefreshHash,
      adminLoginStepId,
      verifiedAccountId,
      oldPid,
      newPid,
      contactRef: 'k2.contact-bbbb',
      contactRefPrev: 'k1.contact-aaaa',
    },
    providerRowsBefore: before.rows.length,
    providerRowsAfter: after.rows.length,
    currentRefreshRows: rotated.rows.length,
    previousRefreshRows: previous.rows.length,
    historyRefreshRows: history.rows.length,
    adminByEmailRows: adminByEmail.rows.length,
    loginStepRows: loginStep.rows.length,
    openRotationRows: openRotation.rows.length,
    claims: {
      pid: bytes(readClaimsRow.pid).toString('base64url'),
      pidPrev: readClaimsRow.pid_prev === null || readClaimsRow.pid_prev === undefined ? null : bytes(readClaimsRow.pid_prev).toString('base64url'),
    },
    contact: {
      ref: String(readContactRow.ref),
      refPrev: readContactRow.ref_prev === null || readContactRow.ref_prev === undefined ? null : String(readContactRow.ref_prev),
    },
    pidVersions: pidVersions.rows.map((row) => Number(row.pid_key_version)),
  };
}

/** 713b522a 앱처럼 세션을 끝낸다(로그아웃·기기 정리 경로). */
export async function terminateN1Session(db: N1Queryable, sessionId: string, now: number): Promise<void> {
  await db.query(N1_SQL.terminateSession, [sessionId, iso(now), 'LOGOUT']);
}

/** 713b522a 앱처럼 지금(또는 바로 앞) 리프레시 해시로 세션을 찾는다. */
export async function readN1Refresh(db: N1Queryable, hash: Buffer): Promise<Record<string, unknown> | undefined> {
  return (await db.query(N1_SQL.findRefresh, [hash])).rows[0];
}

/** 713b522a 앱처럼 세션 한 행을 읽는다(N 앱이 쓴 행을 N-1이 읽는지 볼 때). */
export async function readN1Session(db: N1Queryable, sessionId: string): Promise<Record<string, unknown> | undefined> {
  return (await db.query(N1_SQL.readSession, [sessionId])).rows[0];
}

/** 713b522a 앱처럼 관리 계정 한 행을 읽는다. */
export async function readN1Admin(db: N1Queryable, adminAccountId: string): Promise<Record<string, unknown> | undefined> {
  return (await db.query(N1_SQL.readAdmin, [adminAccountId])).rows[0];
}

/** 713b522a 앱처럼 본인확인 pid·옛 pid를 읽는다. */
export async function readN1Claims(db: N1Queryable, accountId: string): Promise<{ pid: string; pidPrev: string | null }> {
  const row = (await db.query(N1_SQL.readClaims, [accountId])).rows[0]!;
  return {
    pid: bytes(row.pid).toString('base64url'),
    pidPrev: row.pid_prev === null || row.pid_prev === undefined ? null : bytes(row.pid_prev).toString('base64url'),
  };
}

/** 713b522a 앱처럼 계정 한 행을 읽는다(다른 표가 참조할 계정이 있는지). */
export async function readN1Account(db: N1Queryable, accountId: string): Promise<Record<string, unknown> | undefined> {
  return (await db.query('select id, status, email, email_verified from account where id = $1', [accountId])).rows[0];
}

