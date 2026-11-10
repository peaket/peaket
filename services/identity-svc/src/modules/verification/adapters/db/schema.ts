// 본인확인 표(docs/data.md §2 identity_verification·verification_attempt, docs/features/identity.md §5).
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, pgSchema, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    // 시작한 세션(고위험 재인증의 재통과 확인, docs/features/identity.md §5, BUILD_ORDER BOT-020). 예전 건은 없다
    sessionId: uuid('session_id'),
    purpose: text('purpose').notNull(),
    next: text('next').notNull(),
    status: text('status').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: at('created_at').notNull(),
    completedAt: at('completed_at'),
    // 결과가 이 계정의 본인과 다른 사람이었다(본인확인한 계정의 다시 본인확인이 FAILED·DUPLICATE_ACCOUNT로 끝난 까닭). 연계정보·HMAC은 두지 않는다.
    // 본인확인 재통과 확인(CheckReverification)의 PERSON_MISMATCH가 읽는다(I-T56 ③, BUILD_ORDER BOT-090)
    personMismatch: boolean('person_mismatch').notNull().default(false),
  },
  (t) => [
    index('verification_attempt_account_idx').on(t.accountId),
    check('verification_attempt_purpose_check', sql`${t.purpose} in ('FIRST', 'REVERIFY', 'MINOR_CONTRACT')`),
    check('verification_attempt_status_check', sql`${t.status} in ('PENDING', 'VERIFIED', 'CANCELLED', 'FAILED', 'DUPLICATE_ACCOUNT', 'PROVIDER_DOWN', 'UNDER_14')`),
  ],
);

// pid 키 전환 기록(docs/data.md pid_key_rotation, docs/features/identity.md §5 'pid 키 전환의 첫 구현', BUILD_ORDER BOT-025).
// 닫지 않은 줄은 하나만 둔다(옛 값을 두 번 옮기면 처음 옛 pid를 잃는다)
export const pidKeyRotation = pgTable(
  'pid_key_rotation',
  {
    toVersion: integer('to_version').primaryKey(),
    startedAt: at('started_at').notNull(),
    transitionEndsAt: at('transition_ends_at').notNull(),
    movedAt: at('moved_at'),
    finishedAt: at('finished_at'),
  },
  () => [uniqueIndex('pid_key_rotation_open_idx').on(sql`(true)`).where(sql`finished_at is null`)],
);

// 같은 본인확인을 다른 계정에서 시도한 기록(docs/data.md identity_conflict_attempt, ADR-0171, I-T65). 연계정보·HMAC은 두지 않는다.
// 1년 [가정] 남기는 연결 신호라 탈퇴로 계정 행이 바뀌어도 남도록 account 외래키를 두지 않는다
export const identityConflictAttempt = pgTable(
  'identity_conflict_attempt',
  {
    id: uuid('id').primaryKey(),
    attemptedAccountId: uuid('attempted_account_id').notNull(),
    existingAccountId: uuid('existing_account_id').notNull(),
    attemptedAt: at('attempted_at').notNull(),
  },
  (t) => [
    index('identity_conflict_attempt_attempted_idx').on(t.attemptedAccountId),
    index('identity_conflict_attempt_existing_idx').on(t.existingAccountId),
    index('identity_conflict_attempt_at_idx').on(t.attemptedAt),
  ],
);

// 탈퇴 회원의 연계정보 처리 기록 보존(docs/data.md §6 '탈퇴 회원 거래 기록의 보존 전용 스키마', identity §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030).
// 연계정보 HMAC·pid는 옮기지 않는다. 처리한 날 + 1년(delete_at)이 지나면 정비가 지운다. 서비스 역할이 읽지 못하게 하는 권한은 DB 역할을 나누는 단계가 한다
export const retention = pgSchema('retention');
export const verificationRecord = retention.table(
  'verification_record',
  {
    accountId: uuid('account_id').primaryKey(),
    sourceRecord: text('source_record').notNull(),
    verifiedAt: at('verified_at').notNull(),
    movedAt: at('moved_at').notNull(),
    deleteAt: at('delete_at').notNull(),
  },
  (t) => [index('verification_record_delete_idx').on(t.deleteAt)],
);

// 이용 제한 중 탈퇴의 대조값 보관(docs/data.md restricted_ci_hold, identity §8 '대조값 보관의 첫 구현', BUILD_ORDER BOT-035).
// 계정 외래키를 두지 않는다(탈퇴해도 until까지 남는다). 이 행은 다른 일(분석·조사·연구)에 쓰지 않는다
export const restrictedCiHold = pgTable(
  'restricted_ci_hold',
  {
    ciHmac: bytea('ci_hmac').notNull(),
    ciHmacKeyVersion: integer('ci_hmac_key_version').notNull(),
    fraudCaseId: uuid('fraud_case_id').notNull(),
    state: text('state').notNull(),
    until: at('until').notNull(),
    sourceAccountId: uuid('source_account_id').notNull(),
    carriedAccountId: uuid('carried_account_id'),
    version: bigint('version', { mode: 'number' }).notNull(),
  },
  (t) => [
    // 멱등 키 (계정, 사건)으로 한 행이다. 같은 사람의 다른 계정이 같은 사건에 들어도 처음 계정의 행을 덮지 않는다(새 맥락 리뷰 M2·다시 보기)
    primaryKey({ columns: [t.sourceAccountId, t.fraudCaseId] }),
    // 다시 가입한 계정에 잇기(보존 중인 모든 판의 연계정보 HMAC으로 찾는다)
    index('restricted_ci_hold_ci_idx').on(t.ciHmac),
    index('restricted_ci_hold_carried_idx').on(t.carriedAccountId),
    index('restricted_ci_hold_until_idx').on(t.until),
    check('restricted_ci_hold_state_check', sql`${t.state} in ('CASE_OPEN', 'RESTRICTED')`),
  ],
);
