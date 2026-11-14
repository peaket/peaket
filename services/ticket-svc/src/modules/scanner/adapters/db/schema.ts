// ticket DB의 스캐너 기기 원장 스키마(BUILD_ORDER GAT-170, docs/data.md scanner_device).
// 마이그레이션은 migrations/0001_scanner_device.sql이다. 등록 코드는 Redis에만 둔다.
import { sql } from 'drizzle-orm';
import { bigint, check, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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

/** 회차 하나에서 기기 하나의 게이트 구역·모드(docs/data.md scanner_placement, offline-gate §6.2). */
export const scannerPlacement = pgTable(
  'scanner_placement',
  {
    eventId: uuid('event_id').notNull(),
    scannerDeviceId: uuid('scanner_device_id').notNull(),
    gateZone: text('gate_zone').notNull(),
    mode: text('mode').notNull(),
    setBy: uuid('set_by').notNull(),
    setAt: at('set_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.scannerDeviceId] }),
    index('scanner_placement_device_idx').on(t.scannerDeviceId, t.eventId),
    check('scanner_placement_mode_check', sql`${t.mode} IN ('IN', 'OUT')`),
    check('scanner_placement_gate_zone_check', sql`char_length(${t.gateZone}) BETWEEN 1 AND 80`),
    check('scanner_placement_version_check', sql`${t.version} >= 1`),
  ],
);

/** 근무 준비 보고(SCR-033·SCR-037). 기기·회차마다 마지막 보고 하나를 덮어쓴다. */
export const scannerReadiness = pgTable(
  'scanner_readiness',
  {
    eventId: uuid('event_id').notNull(),
    scannerDeviceId: uuid('scanner_device_id').notNull(),
    packageSeq: bigint('package_seq', { mode: 'number' }).notNull(),
    clockOffsetMs: integer('clock_offset_ms').notNull(),
    pendingUploads: integer('pending_uploads').notNull(),
    reportedBy: uuid('reported_by').notNull(),
    reportedAt: at('reported_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.scannerDeviceId] }),
    check('scanner_readiness_package_seq_check', sql`${t.packageSeq} >= 0`),
    check('scanner_readiness_pending_uploads_check', sql`${t.pendingUploads} >= 0`),
  ],
);

/** 회차별 변경 일련번호 카운터(offline-gate §6.3, ADR-0086). 변경 트랜잭션 안에서 UPDATE … RETURNING으로 올린다. */
export const scannerSeq = pgTable('scanner_seq', {
  eventId: uuid('event_id').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
});

/** 회차별 변경 기록. (event_id, seq)가 기본 키이고 seq는 커밋 순서와 같다. */
export const scannerChange = pgTable(
  'scanner_change',
  {
    eventId: uuid('event_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.seq] }),
    index('scanner_change_event_kind_seq_idx').on(t.eventId, t.kind, sql`${t.seq} DESC`),
    check(
      'scanner_change_kind_check',
      sql`${t.kind} IN ('KEY_REGISTERED', 'KEY_REVOKED', 'TICKET_STATUS', 'SCAN_STATE', 'POLICY', 'PLACEMENT', 'FLAG', 'SESSION_TERMINATED')`,
    ),
  ],
);

/** 스캔 기록(offline-gate §6.5). 클라이언트 ID로 멱등하고, 서버가 다시 판정한 결과를 남긴다. */
export const scanEvent = pgTable(
  'scan_event',
  {
    id: uuid('id').notNull(),
    eventId: uuid('event_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    scannerDeviceId: uuid('scanner_device_id').notNull(),
    scannerSessionId: uuid('scanner_session_id'),
    staffAccountId: uuid('staff_account_id'),
    direction: text('direction').notNull(),
    method: text('method').notNull(),
    result: text('result').notNull(),
    reason: text('reason'),
    gateZone: text('gate_zone').notNull().default(''),
    keyId: bytea('key_id'),
    qrTs: at('qr_ts'),
    scannedAtDevice: at('scanned_at_device').notNull(),
    clockOffsetMs: integer('clock_offset_ms'),
    knownSeq: bigint('known_seq', { mode: 'number' }).notNull(),
    deviceSeq: bigint('device_seq', { mode: 'number' }).notNull(),
    receivedAt: at('received_at').notNull(),
    flag: text('flag').notNull().default('NONE'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.id] }),
    uniqueIndex('scan_event_id_key').on(t.id),
    index('scan_event_ticket_time_idx').on(t.eventId, t.ticketId, t.scannedAtDevice, t.deviceSeq),
    check('scan_event_direction_check', sql`${t.direction} IN ('IN', 'OUT')`),
    check('scan_event_method_check', sql`${t.method} IN ('QR', 'OVERRIDE', 'VERIFY')`),
    check('scan_event_result_check', sql`${t.result} IN ('PASS', 'REJECT', 'CHECK')`),
    check('scan_event_flag_check', sql`${t.flag} IN ('NONE', 'DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'TIME_UNCERTAIN', 'STALE_VERSION')`),
  ],
);

/** 이상 표시(offline-gate §7.2). */
export const gateFlag = pgTable(
  'gate_flag',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    kind: text('kind').notNull(),
    awareness: text('awareness').notNull().default('CONCURRENT'),
    status: text('status').notNull().default('OPEN'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: at('resolved_at'),
    note: text('note'),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    index('gate_flag_event_created_idx').on(t.eventId, t.createdAt, t.id),
    check('gate_flag_kind_check', sql`${t.kind} IN ('DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'OVERRIDE_REVIEW', 'STALE_VERSION')`),
    check('gate_flag_awareness_check', sql`${t.awareness} IN ('CONCURRENT', 'KNOWN')`),
    check('gate_flag_status_check', sql`${t.status} IN ('OPEN', 'OK', 'SUSPECT', 'UNDETERMINED')`),
  ],
);

/** 이상 표시를 만든 스캔 연결(ADR-0086). */
export const gateFlagScan = pgTable(
  'gate_flag_scan',
  {
    flagId: uuid('flag_id').notNull(),
    scanEventId: uuid('scan_event_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.flagId, t.scanEventId] })],
);
