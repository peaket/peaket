// ticket DB의 스캐너 기기 원장 스키마(BUILD_ORDER GAT-170, docs/data.md scanner_device).
// 마이그레이션은 migrations/0001_scanner_device.sql이다. 등록 코드는 Redis에만 둔다.
import { sql } from 'drizzle-orm';
import { check, customType, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** 스캐너 기기 한 행. 기기 키 지문(jkt)은 ACTIVE 기기에만 묶인다. */
export const scannerDevice = pgTable(
  'scanner_device',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    credentialType: text('credential_type').notNull(),
    /** 기기 키 JWK SHA-256 지문(jkt)의 바이트. MTLS_CERT면 인증서 지문 */
    credentialThumbprint: bytea('credential_thumbprint'),
    certExpiresAt: at('cert_expires_at'),
    enrolledBy: uuid('enrolled_by').notNull(),
    enrolledAt: at('enrolled_at').notNull(),
    lastSeenAt: at('last_seen_at'),
    revokedAt: at('revoked_at'),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    uniqueIndex('scanner_device_credential_key').on(t.credentialThumbprint).where(sql`${t.credentialThumbprint} IS NOT NULL`),
    index('scanner_device_promoter_status_idx').on(t.promoterId, t.status, t.enrolledAt, t.id),
    check('scanner_device_status_check', sql`${t.status} IN ('ACTIVE', 'REVOKED', 'RETIRED')`),
    check('scanner_device_credential_type_check', sql`${t.credentialType} IN ('DEVICE_KEY', 'MTLS_CERT')`),
    check('scanner_device_name_check', sql`char_length(${t.name}) BETWEEN 1 AND 80`),
  ],
);
