// 본인확인 표(docs/data.md §2 identity_verification·verification_attempt, docs/features/identity.md §5).
import { sql } from 'drizzle-orm';
import { check, customType, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const identityVerification = pgTable('identity_verification', {
  accountId: uuid('account_id').primaryKey(),
  // 1인 1계정: 같은 연계정보 HMAC은 한 계정에만(조회는 보존 중인 모든 키 버전으로, BUILD_ORDER BOT-020)
  ciHmac: bytea('ci_hmac').notNull().unique(),
  ciHmacKeyVersion: integer('ci_hmac_key_version').notNull(),
  pid: bytea('pid').notNull(),
  pidKeyVersion: integer('pid_key_version').notNull(),
  pidPrev: bytea('pid_prev'),
  verifiedAt: at('verified_at').notNull(),
  sourceRecord: text('source_record').notNull(),
});

export const verificationAttempt = pgTable(
  'verification_attempt',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    purpose: text('purpose').notNull(),
    next: text('next').notNull(),
    status: text('status').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: at('created_at').notNull(),
    completedAt: at('completed_at'),
  },
  (t) => [
    index('verification_attempt_account_idx').on(t.accountId),
    check('verification_attempt_purpose_check', sql`${t.purpose} in ('FIRST', 'REVERIFY', 'MINOR_CONTRACT')`),
    check('verification_attempt_status_check', sql`${t.status} in ('PENDING', 'VERIFIED', 'CANCELLED', 'FAILED', 'DUPLICATE_ACCOUNT')`),
  ],
);
