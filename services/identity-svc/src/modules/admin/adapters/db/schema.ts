// 관리 계정 컨텍스트의 표(docs/data.md admin_account, identity §6, BUILD_ORDER BOT-110). 칸은 data.md 그대로이고, 쓰는 길은 단계마다 붙인다
// (비밀번호 BOT-110, 로그인 실패 제한 BOT-111, TOTP BOT-120, 해제 링크 BOT-121, 초대·역할·삭제 BOT-150).
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const adminAccount = pgTable(
  'admin_account',
  {
    id: uuid('id').primaryKey(),
    role: text('role').notNull(),
    // partner_admin·partner_member만. core 논리 DB라 외래키 없음
    promoterId: uuid('promoter_id'),
    status: text('status').notNull(),
    // 업무 이메일(소문자·앞뒤 빈칸 제거). 삭제하지 않은 계정 사이에서 UNIQUE. 삭제 때 바로 파기(널)
    email: text('email'),
    displayName: text('display_name'),
    inviteTokenHash: bytea('invite_token_hash'),
    inviteExpiresAt: at('invite_expires_at'),
    lastLoginAt: at('last_login_at'),
    removedAt: at('removed_at'),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    // $pbkdf2-sha256$i=…,k=…$솔트$MAC(identity §6 '관리 계정 비밀번호 저장과 정책의 첫 구현')
    passwordPhc: text('password_phc'),
    totpSeedEnc: bytea('totp_seed_enc'),
    // 등록 중인 시드(같은 꼴)와 마지막으로 받은 TOTP 시간 칸(BOT-120)
    totpPendingEnc: bytea('totp_pending_enc'),
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    secondFactorFailures: integer('second_factor_failures').notNull().default(0),
    passwordFailureTotal: integer('password_failure_total').notNull().default(0),
    breachCheckedAt: at('breach_checked_at'),
    passwordChangeRequired: boolean('password_change_required').notNull().default(false),
    lockKind: text('lock_kind').notNull().default('NONE'),
    lockedUntil: at('locked_until'),
    recentLockAt: jsonb('recent_lock_at').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lockedAt: at('locked_at'),
    lockReason: text('lock_reason'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('admin_account_email_live_key').on(t.email).where(sql`${t.status} <> 'REMOVED'`),
    check('admin_account_role_check', sql`${t.role} in ('partner_admin', 'partner_member', 'viewer', 'operator', 'commander', 'cs_agent', 'cs_lead')`),
    check('admin_account_status_check', sql`${t.status} in ('INVITED', 'ACTIVE', 'INVITE_EXPIRED', 'REMOVED')`),
    check('admin_account_lock_kind_check', sql`${t.lockKind} in ('NONE', 'TIMED', 'PROTECT')`),
    check('admin_account_lock_reason_check', sql`${t.lockReason} is null or ${t.lockReason} in ('FAILED_ATTEMPTS', 'SECOND_FACTOR_FAILURES', 'PASSWORD_FAILURE_TOTAL')`),
    check('admin_account_partner_check', sql`(${t.role} in ('partner_admin', 'partner_member')) = (${t.promoterId} is not null)`),
  ],
);

/** 1단계(비밀번호)를 통과한 로그인. 2단계(TOTP, BOT-120)가 loginStep 토큰의 SHA-256으로 찾는다(identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현') */
export const adminLoginStep = pgTable(
  'admin_login_step',
  {
    id: uuid('id').primaryKey(),
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => adminAccount.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    aud: text('aud').notNull(),
    pairRef: text('pair_ref').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
    // 1단계 통과 때 익숙한 출발지였는지와 비밀번호만 맞은 로그인으로 알린 때(BOT-123)
    knownSource: boolean('known_source').notNull().default(false),
    passwordOnlyNoticedAt: at('password_only_noticed_at'),
  },
  (t) => [
    uniqueIndex('admin_login_step_token_key').on(t.tokenHash),
    index('admin_login_step_account_idx').on(t.adminAccountId, t.createdAt),
    // 비밀번호만 맞은 로그인 찾기(쓰이지 않은 익숙하지 않은 알리지 않은 행만, BOT-123이 넘긴 것)
    index('admin_login_step_password_only_idx')
      .on(t.createdAt)
      .where(sql`${t.usedAt} is null and ${t.knownSource} = false and ${t.passwordOnlyNoticedAt} is null`),
    check('admin_login_step_aud_check', sql`${t.aud} in ('partner', 'ops')`),
  ],
);

/** 계정 주인에게 보낼 보안 알림(auth-controls §3.4). 셈과 같은 트랜잭션으로 적고, 메일 대행 단계가 읽어 보낸다 */
export const adminSecurityNotice = pgTable(
  'admin_security_notice',
  {
    id: uuid('id').primaryKey(),
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => adminAccount.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    createdAt: at('created_at').notNull(),
    sentAt: at('sent_at'),
    // 보내지 못한 횟수와 다음에 해 볼 때(앞의 실패 행이 뒤의 알림을 막지 않게, BOT-121)
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: at('next_attempt_at'),
  },
  (t) => [
    index('admin_security_notice_unsent_idx').on(t.createdAt).where(sql`${t.sentAt} is null`),
    check('admin_security_notice_kind_check', sql`${t.kind} in ('TIMED_LOCK', 'PASSWORD_FAILURE_NOTICE', 'MULTI_SOURCE_ALERT', 'PROTECT_LOCK', 'SESSION_LIMIT', 'UNLOCK_LINK', 'UNLOCKED', 'PASSWORD_ONLY_LOGIN', 'INVITATION')`),
  ],
);

/** 관리 계정 로그인 세션(POL-019: 최대 24시간, 유휴 1시간, 동시 2개, identity §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', BOT-120) */
export const adminSession = pgTable(
  'admin_session',
  {
    id: uuid('id').primaryKey(),
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => adminAccount.id, { onDelete: 'cascade' }),
    aud: text('aud').notNull(),
    refreshHash: bytea('refresh_hash').notNull(),
    // 바로 앞 리프레시 토큰·마지막 회전·지금 토큰 쓰임(팬 session과 같은 판정, BOT-130)
    prevRefreshHash: bytea('prev_refresh_hash'),
    rotatedAt: at('rotated_at'),
    refreshUsed: boolean('refresh_used').notNull().default(false),
    refreshFamily: uuid('refresh_family').notNull(),
    pairRef: text('pair_ref').notNull(),
    createdAt: at('created_at').notNull(),
    absoluteExpiresAt: at('absolute_expires_at').notNull(),
    idleExpiresAt: at('idle_expires_at').notNull(),
    terminatedAt: at('terminated_at'),
    terminationReason: text('termination_reason'),
  },
  (t) => [
    uniqueIndex('admin_session_refresh_key').on(t.refreshHash),
    index('admin_session_prev_refresh_idx').on(t.prevRefreshHash).where(sql`${t.prevRefreshHash} is not null`),
    index('admin_session_family_idx').on(t.refreshFamily),
    index('admin_session_live_idx').on(t.adminAccountId, t.idleExpiresAt).where(sql`${t.terminatedAt} is null`),
    check('admin_session_aud_check', sql`${t.aud} in ('partner', 'ops')`),
  ],
);

/** 관리 계정 지정(docs/data.md admin_designation, BOT-151, ADR-0171 결정 7). 살아 있는 행은 (계정, 종류)마다 하나 */
export const adminDesignation = pgTable(
  'admin_designation',
  {
    id: uuid('id').primaryKey(),
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => adminAccount.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    basis: text('basis').notNull(),
    designatedBy: uuid('designated_by').notNull(),
    designatedAt: at('designated_at').notNull(),
    revokedAt: at('revoked_at'),
  },
  (t) => [
    uniqueIndex('admin_designation_live_key').on(t.adminAccountId, t.kind).where(sql`${t.revokedAt} is null`),
    index('admin_designation_account_idx').on(t.adminAccountId, t.revokedAt),
    check('admin_designation_kind_check', sql`${t.kind} in ('ACCESS_REVIEWER', 'PSEUDONYM_HANDLER', 'FRAUD_INVESTIGATOR')`),
  ],
);

/** 관리 계정 관리 호출의 멱등 기록(docs/data.md admin_account_request, BOT-150). 30일 [가정] 뒤 정비가 지운다 */
export const adminAccountRequest = pgTable(
  'admin_account_request',
  {
    requestId: text('request_id').primaryKey(),
    kind: text('kind').notNull(),
    // 대상 계정(초대는 만든 계정). 외래키 없음(삭제한 계정 행도 남는다)
    adminAccountId: uuid('admin_account_id').notNull(),
    result: text('result').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('admin_account_request_created_idx').on(t.createdAt), check('admin_account_request_kind_check', sql`${t.kind} in ('INVITE', 'CHANGE_ROLE', 'REINVITE', 'REMOVE', 'DESIGNATE', 'REVOKE_DESIGNATION')`)],
);

/** 발급한 관리 리프레시 토큰 해시(docs/data.md admin_refresh_token_hash, BOT-130). 예전 토큰이 다시 오면 그 패밀리를 끝낸다. 절대 만료가 지나면 정비가 지운다 */
export const adminRefreshTokenHash = pgTable(
  'admin_refresh_token_hash',
  {
    hash: bytea('hash').primaryKey(),
    adminSessionId: uuid('admin_session_id')
      .notNull()
      .references(() => adminSession.id, { onDelete: 'cascade' }),
    refreshFamily: uuid('refresh_family').notNull(),
    issuedAt: at('issued_at').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (t) => [index('admin_refresh_token_hash_expires_idx').on(t.expiresAt), index('admin_refresh_token_hash_session_idx').on(t.adminSessionId)],
);

/** 복구 코드(docs/data.md admin_recovery_code, BOT-120). 쓰거나 다시 만들면 바로 지운다 */
export const adminRecoveryCode = pgTable(
  'admin_recovery_code',
  {
    id: uuid('id').primaryKey(),
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => adminAccount.id, { onDelete: 'cascade' }),
    codePhc: text('code_phc').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('admin_recovery_code_account_idx').on(t.adminAccountId)],
);

/** 본인 해제 링크(docs/data.md admin_unlock_link, BOT-121). 토큰은 해시만, 30분·한 번·코드 3번 틀리면 무효 */
export const adminUnlockLink = pgTable(
  'admin_unlock_link',
  {
    id: uuid('id').primaryKey(),
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => adminAccount.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    codeFailures: integer('code_failures').notNull().default(0),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
    revokedAt: at('revoked_at'),
  },
  (t) => [uniqueIndex('admin_unlock_link_token_key').on(t.tokenHash), index('admin_unlock_link_live_idx').on(t.adminAccountId).where(sql`${t.usedAt} is null and ${t.revokedAt} is null`)],
);

/** 익숙한 출발지(docs/data.md admin_known_source, auth-controls §3.1, BOT-123). 30일 [가정] 지나면 매일 정비가 지운다 */
export const adminKnownSource = pgTable(
  'admin_known_source',
  {
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => adminAccount.id, { onDelete: 'cascade' }),
    pairRef: text('pair_ref').notNull(),
    lastSuccessAt: at('last_success_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.adminAccountId, t.pairRef] }), index('admin_known_source_last_idx').on(t.lastSuccessAt)],
);
