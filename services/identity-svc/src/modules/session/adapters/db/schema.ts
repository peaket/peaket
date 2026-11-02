// identity DB의 계정·로그인 수단·기기·세션 표(docs/data.md §2 identity, docs/features/identity.md §11).
// 이 단계(BUILD_ORDER PRF-020)가 쓰는 표만 둔다. 본인확인·병합·관리 계정 표는 그 단계가 더한다.
import { sql } from 'drizzle-orm';
import { boolean, check, customType, index, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey(),
    status: text('status').notNull(),
    mergedIntoAccountId: uuid('merged_into_account_id'),
    nickname: text('nickname'),
    email: text('email'),
    phone: text('phone'),
    // 회원 코드는 가입 완료(SCR-005)에서 매긴다. 형식은 그 단계가 정한다
    memberCode: text('member_code').unique(),
    savedBookerName: text('saved_booker_name'),
    savedBookerPhone: text('saved_booker_phone'),
    ageVerified: boolean('age_verified').notNull().default(false),
    locale: text('locale').notNull().default('ko'),
    createdAt: at('created_at').notNull(),
    deletedAt: at('deleted_at'),
  },
  (t) => [
    check('account_status_check', sql`${t.status} in ('ACTIVE', 'WITHDRAWAL_PENDING', 'MERGED', 'DELETED')`),
    check('account_locale_check', sql`${t.locale} in ('ko', 'en', 'ja', 'zh')`),
    check('account_merged_check', sql`(${t.status} = 'MERGED') = (${t.mergedIntoAccountId} is not null)`),
  ],
);

export const accountProvider = pgTable(
  'account_provider',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    linkedAt: at('linked_at').notNull(),
  },
  (t) => [
    // (제공자, 제공자 사용자 ID) 복합 키(ASVS v5.0.0-6.8.1·10.5.2)
    primaryKey({ name: 'account_provider_pkey', columns: [t.provider, t.providerUserId] }),
    index('account_provider_account_idx').on(t.accountId),
    check('account_provider_provider_check', sql`${t.provider} in ('kakao', 'naver', 'google')`),
  ],
);

export const device = pgTable(
  'device',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    // 기기 가명 invRef("device", deviceId). 원문 deviceId는 두지 않는다(docs/data.md device)
    deviceRef: text('device_ref').notNull(),
    deviceRefPrev: text('device_ref_prev'),
    boundAt: at('bound_at').notNull(),
  },
  (t) => [unique('device_account_ref_key').on(t.accountId, t.deviceRef)],
);

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: uuid('device_id').references(() => device.id, { onDelete: 'set null' }),
    refreshHash: bytea('refresh_hash').notNull(),
    refreshFamily: uuid('refresh_family').notNull(),
    prevRefreshHash: bytea('prev_refresh_hash'),
    rotatedAt: at('rotated_at'),
    refreshUsed: boolean('refresh_used').notNull().default(false),
    absoluteExpiresAt: at('absolute_expires_at').notNull(),
    idleExpiresAt: at('idle_expires_at').notNull(),
    terminatedAt: at('terminated_at'),
    loginVerdict: text('login_verdict').notNull(),
    loginVerdictReason: text('login_verdict_reason'),
    loginVerdictAt: at('login_verdict_at'),
  },
  (t) => [
    index('session_account_active_idx').on(t.accountId).where(sql`${t.terminatedAt} is null`),
    // 리프레시 토큰은 256비트 난수의 해시라 겹치지 않는다. 겹치면 쓰기가 실패해 다른 세션으로 잘못 이어지지 않는다
    uniqueIndex('session_refresh_hash_key').on(t.refreshHash),
    index('session_prev_refresh_hash_idx').on(t.prevRefreshHash).where(sql`${t.prevRefreshHash} is not null`),
    index('session_refresh_family_idx').on(t.refreshFamily),
    check('session_login_verdict_check', sql`${t.loginVerdict} in ('ALLOW', 'CHALLENGE', 'UNKNOWN')`),
  ],
);

export const refreshTokenHash = pgTable(
  'refresh_token_hash',
  {
    // 발급한 리프레시 토큰의 SHA-256. 예전 토큰이 다시 오면 패밀리를 찾아 재사용 탐지를 한다(identity §3 '토큰 수명주기 구현')
    hash: bytea('hash').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id),
    refreshFamily: uuid('refresh_family').notNull(),
    issuedAt: at('issued_at').notNull(),
    // 그 세션의 절대 만료. 지나면 지운다
    expiresAt: at('expires_at').notNull(),
  },
  (t) => [index('refresh_token_hash_expires_idx').on(t.expiresAt), index('refresh_token_hash_session_idx').on(t.sessionId)],
);

export const sessionCreateKey = pgTable(
  'session_create_key',
  {
    key: text('key').primaryKey(),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id),
    newAccount: boolean('new_account').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('session_create_key_created_idx').on(t.createdAt)],
);
