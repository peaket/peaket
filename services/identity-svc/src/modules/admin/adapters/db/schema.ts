// 관리 계정 컨텍스트의 표(docs/data.md admin_account, identity §6, BUILD_ORDER BOT-110). 칸은 data.md 그대로이고, 쓰는 길은 단계마다 붙인다
// (비밀번호 BOT-110, 로그인 실패 제한 BOT-111, TOTP BOT-120, 해제 링크 BOT-121, 초대·역할·삭제 BOT-150).
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
