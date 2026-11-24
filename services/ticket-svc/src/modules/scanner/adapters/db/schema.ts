// ticket DB의 스캐너 기기 원장 스키마(BUILD_ORDER GAT-170, docs/data.md scanner_device).
// 마이그레이션은 migrations/0001_scanner_device.sql이다. 등록 코드는 Redis에만 둔다.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    /** 스캐너가 마지막으로 변경분을 받은 시각(O-T20 신선도 경보). null이면 아직 받은 적이 없다 */
    lastChangesAt: at('last_changes_at'),
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

/** ops-svc 기기 명령 한 번(request_id 멱등, ADR-0148, BAT-450). 같은 요청이 다시 와도 기기를 또 만들지 않는다 */
export const scannerDeviceCommand = pgTable(
  'scanner_device_command',
  {
    requestId: uuid('request_id').primaryKey(),
    action: text('action').notNull(),
    deviceId: uuid('device_id').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    index('scanner_device_command_device_idx').on(t.deviceId, t.createdAt),
    check('scanner_device_command_action_check', sql`${t.action} IN ('REGISTER', 'REVOKE', 'REISSUE')`),
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

/** 회차 입장 정책 사본(offline-gate §6.3, docs/data.md scanner_event_policy, 마이그레이션 0013). */
export const scannerEventPolicy = pgTable(
  'scanner_event_policy',
  {
    eventId: uuid('event_id').primaryKey(),
    reentryAllowed: boolean('reentry_allowed').notNull(),
    /** 마지막으로 적은 POLICY 변경 번호. 처음 만들 때 0 */
    policySeq: bigint('policy_seq', { mode: 'number' }).notNull().default(0),
    observedAt: at('observed_at').notNull(),
  },
  (t) => [check('scanner_event_policy_policy_seq_check', sql`${t.policySeq} >= 0`)],
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
    /** 예외 통과 메모(100자 이하). OVERRIDE_REVIEW 표시와 함께 남긴다(C1-01) */
    overrideNote: text('override_note'),
    gateZone: text('gate_zone').notNull().default(''),
    keyId: bytea('key_id'),
    qrTs: at('qr_ts'),
    scannedAtDevice: at('scanned_at_device').notNull(),
    clockOffsetMs: integer('clock_offset_ms'),
    knownSeq: bigint('known_seq', { mode: 'number' }).notNull(),
    deviceSeq: bigint('device_seq', { mode: 'number' }).notNull(),
    /** 그 기록으로 적은 SCAN_STATE 변경의 일련번호(중복 입장의 몰랐음/알고도 통과를 가른다, offline-gate §7.1). 옛 행은 NULL */
    stateSeq: bigint('state_seq', { mode: 'number' }),
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
    check('scan_event_flag_check', sql`${t.flag} IN ('NONE', 'DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'TIME_UNCERTAIN', 'OVERRIDE_REVIEW', 'STALE_VERSION')`),
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
    check('gate_flag_kind_check', sql`${t.kind} IN ('DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'TIME_UNCERTAIN', 'OVERRIDE_REVIEW', 'STALE_VERSION')`),
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

/** 기기·회차마다 마지막 큐 비움 보고 하나(offline-gate §7.3, 마이그레이션 0019). */
export const scannerQueueReport = pgTable(
  'scanner_queue_report',
  {
    eventId: uuid('event_id').notNull(),
    scannerDeviceId: uuid('scanner_device_id').notNull(),
    pendingUploads: integer('pending_uploads').notNull(),
    reportedAt: at('reported_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.scannerDeviceId] }),
    check('scanner_queue_report_pending_uploads_check', sql`${t.pendingUploads} >= 0`),
  ],
);

/** 회차마다 마감 행 하나(offline-gate §7.3 '한 번만'). core_synced_at이 비면 다음 판단마다 다시 알린다. */
export const entryClose = pgTable(
  'entry_close',
  {
    eventId: uuid('event_id').primaryKey(),
    closedAt: at('closed_at').notNull(),
    reason: text('reason').notNull(),
    roleEndsAt: at('role_ends_at').notNull(),
    coreSyncedAt: at('core_synced_at'),
  },
  (t) => [check('entry_close_reason_check', sql`${t.reason} IN ('ALL_REPORTED', 'TIMEOUT')`)],
);

/**
 * 회차마다 가장 이른 ticket.event_starts_at 하나(마이그레이션 0020, F-05-6 IR-03).
 * ticket INSERT·event_starts_at 고침 트리거가 유지하고, 입장 기록 마감 후보 고르기가 (starts_at, event_id) 차례로 읽는다.
 */
export const ticketEventStart = pgTable(
  'ticket_event_start',
  {
    eventId: uuid('event_id').primaryKey(),
    startsAt: at('starts_at').notNull(),
  },
  (t) => [index('ticket_event_start_order_idx').on(t.startsAt, t.eventId)],
);

/** TIMEOUT 마감 때 보고가 없는 기기마다 한 행(offline-gate §7.3 '미보고 스캐너 건'). */
export const scannerUnreportedCase = pgTable(
  'scanner_unreported_case',
  {
    eventId: uuid('event_id').notNull(),
    scannerDeviceId: uuid('scanner_device_id').notNull(),
    eventKey: uuid('event_key').notNull(),
    createdAt: at('created_at').notNull(),
    openedAt: at('opened_at'),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.scannerDeviceId] })],
);
