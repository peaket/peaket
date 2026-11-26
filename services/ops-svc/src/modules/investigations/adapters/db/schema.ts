// F-04-12 조사 표 Drizzle 스키마(ops DB, 마이그레이션 0035).
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: string; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v, 'hex'),
  fromDriver: (v) => Buffer.from(v as Buffer).toString('hex'),
});
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const fraudSnapshot = pgTable(
  'fraud_snapshot',
  {
    eventId: uuid('event_id').notNull(),
    version: integer('version').notNull(),
    frozenAt: at('frozen_at').notNull(),
    invHash: bytea('inv_hash').notNull(),
    tableHashes: jsonb('table_hashes').notNull().$type<Record<string, string>>(),
    prevHash: bytea('prev_hash'),
    rowCounts: jsonb('row_counts').notNull().$type<Record<string, number>>(),
    rangeFrom: at('range_from'),
    late: boolean('late').notNull(),
    verifyStatus: text('verify_status').$type<'OK' | 'MISMATCH' | null>(),
    verifiedAt: at('verified_at'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.version] }),
    check('fraud_snapshot_verify_status_check', sql`${t.verifyStatus} in ('OK', 'MISMATCH')`),
  ],
);

export const fraudClusterRun = pgTable(
  'fraud_cluster_run',
  {
    eventId: uuid('event_id').notNull(),
    generation: integer('generation').notNull(),
    attempt: integer('attempt').notNull(),
    trigger: text('trigger').notNull(),
    failureReason: text('failure_reason'),
    snapshotVersion: integer('snapshot_version').notNull(),
    ruleVersion: text('rule_version').notNull(),
    resultFingerprint: bytea('result_fingerprint'),
    clusterCount: integer('cluster_count'),
    status: text('status').notNull(),
    startedAt: at('started_at').notNull(),
    finishedAt: at('finished_at'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.generation, t.attempt] }),
    check('fraud_cluster_run_status_check', sql`${t.status} in ('RUNNING', 'DONE', 'FAILED')`),
    check('fraud_cluster_run_trigger_check', sql`${t.trigger} in ('SCHEDULED', 'SNAPSHOT', 'AUTO_RETRY', 'MANUAL')`),
    check('fraud_cluster_run_failure_reason_check', sql`${t.failureReason} in ('SOURCE_READ_FAILED', 'TIMEOUT', 'OTHER')`),
  ],
);

export const fraudCluster = pgTable(
  'fraud_cluster',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    generation: integer('generation').notNull(),
    ruleVersion: text('rule_version').notNull(),
    scoreBand: text('score_band').notNull(),
    accountCount: integer('account_count').notNull(),
    purchaseCount: integer('purchase_count').notNull(),
    limitPerPerson: integer('limit_per_person').notNull(),
    sharedAttributes: jsonb('shared_attributes').notNull().$type<string[]>(),
    signals: jsonb('signals').notNull().$type<string[]>(),
    snapshotVersion: integer('snapshot_version').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check('fraud_cluster_score_band_check', sql`${t.scoreBand} in ('HIGH', 'MEDIUM', 'LOW')`),
    index('fraud_cluster_event_generation_idx').on(t.eventId, t.generation),
  ],
);

export const fraudClusterMember = pgTable(
  'fraud_cluster_member',
  {
    clusterId: uuid('cluster_id').notNull(),
    accountId: uuid('account_id').notNull(),
    signals: jsonb('signals').notNull().$type<string[]>(),
    ticketCount: integer('ticket_count').notNull(),
    addedBy: text('added_by').notNull(),
    removedAt: at('removed_at'),
    appealReasonCategories: jsonb('appeal_reason_categories').$type<string[]>(),
    appealRequestedAt: at('appeal_requested_at'),
    appealDueAt: at('appeal_due_at'),
    lockExpiresAt: at('lock_expires_at'),
    appealResult: text('appeal_result').notNull(),
    actionNotifiedAt: at('action_notified_at'),
    objectionResult: text('objection_result').notNull().default('NONE'),
    objectionReceivedAt: at('objection_received_at'),
    objectionDecisionReason: text('objection_decision_reason'),
    objectionDecidedBy: uuid('objection_decided_by'),
    objectionDecidedAt: at('objection_decided_at'),
    objectionAppealId: uuid('objection_appeal_id'),
    appealDecisionReason: text('appeal_decision_reason'),
    appealDecidedBy: uuid('appeal_decided_by'),
    appealDecidedAt: at('appeal_decided_at'),
    appealId: uuid('appeal_id'),
  },
  (t) => [
    primaryKey({ columns: [t.clusterId, t.accountId] }),
    check('fraud_cluster_member_added_by_check', sql`${t.addedBy} in ('SYSTEM', 'INVESTIGATOR')`),
    check(
      'fraud_cluster_member_appeal_result_check',
      sql`${t.appealResult} in ('NOT_REQUESTED', 'PENDING', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'EXPIRED')`,
    ),
    check('fraud_cluster_member_objection_result_check', sql`${t.objectionResult} in ('NONE', 'SUBMITTED', 'ACCEPTED', 'REJECTED')`),
  ],
);

export const fraudCase = pgTable(
  'fraud_case',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    clusterId: uuid('cluster_id').notNull(),
    status: text('status').notNull(),
    reasonCategory: text('reason_category').notNull(),
    assigneeId: uuid('assignee_id').notNull(),
    appealDueAt: at('appeal_due_at'),
    cancelDeadlineAt: at('cancel_deadline_at').notNull(),
    approvalId: uuid('approval_id'),
    investigatorOpinion: text('investigator_opinion'),
    outcomeLabel: text('outcome_label'),
    version: bigint('version', { mode: 'number' }).notNull(),
    createdAt: at('created_at').notNull(),
    closedAt: at('closed_at'),
  },
  (t) => [
    uniqueIndex('fraud_case_cluster_uq').on(t.clusterId),
    check(
      'fraud_case_status_check',
      sql`${t.status} in ('INVESTIGATING', 'APPEAL_PENDING', 'DECISION_PENDING', 'ACTIONED', 'CLEARED', 'OBJECTED', 'REVERSED')`,
    ),
    check(
      'fraud_case_reason_category_check',
      sql`${t.reasonCategory} in ('MACRO_BOT', 'QUEUE_BYPASS', 'CAPTCHA_BYPASS', 'ACCOUNT_LENDING', 'LIMIT_EVASION')`,
    ),
    check('fraud_case_outcome_label_check', sql`${t.outcomeLabel} in ('BOT', 'HUMAN', 'NONE')`),
  ],
);

export const fraudCaseEvent = pgTable(
  'fraud_case_event',
  {
    caseId: uuid('case_id')
      .notNull()
      .references(() => fraudCase.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    actorId: uuid('actor_id'),
    note: text('note'),
    detail: jsonb('detail').$type<Record<string, unknown> | null>(),
    occurredAt: at('occurred_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.seq] }), index('fraud_case_event_case_seq_idx').on(t.caseId, t.seq)],
);

// F-04-14 증거 묶음·관리 연속성·외부 게시물·내보내기(마이그레이션 0039).
export const evidenceBundle = pgTable(
  'evidence_bundle',
  {
    id: uuid('id').primaryKey(),
    caseId: uuid('case_id').notNull(),
    eventId: uuid('event_id').notNull(),
    status: text('status').notNull(),
    snapshotHash: bytea('snapshot_hash').notNull(),
    manifestSha256: bytea('manifest_sha256'),
    queries: jsonb('queries').notNull().$type<Record<string, unknown>>(),
    s3Prefix: text('s3_prefix').notNull(),
    holdReason: text('hold_reason').notNull(),
    holdEndRequestedBy: uuid('hold_end_requested_by'),
    holdEndRequestedAt: at('hold_end_requested_at'),
    holdEndBasis: text('hold_end_basis'),
    holdEndConfirmedBy: uuid('hold_end_confirmed_by'),
    holdEndedAt: at('hold_ended_at'),
    createdBy: uuid('created_by'),
    createdAt: at('created_at').notNull(),
    files: jsonb('files').notNull().$type<{ name: string; sha256: string; sizeBytes: number }[]>(),
  },
  (t) => [index('evidence_bundle_event_created_idx').on(t.eventId, t.createdAt), index('evidence_bundle_case_idx').on(t.caseId)],
);

export const evidenceCustodyLog = pgTable(
  'evidence_custody_log',
  {
    bundleId: uuid('bundle_id').notNull(),
    seq: integer('seq').notNull(),
    action: text('action').notNull(),
    actorId: uuid('actor_id'),
    reason: text('reason'),
    exportKind: text('export_kind'),
    dataRequestId: uuid('data_request_id'),
    prevHash: bytea('prev_hash'),
    rowHash: bytea('row_hash').notNull(),
    occurredAt: at('occurred_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.bundleId, t.seq] })],
);

export const externalPost = pgTable(
  'external_post',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    url: text('url').notNull(),
    site: text('site').notNull(),
    capturedAt: at('captured_at').notNull(),
    source: text('source').notNull(),
    reportCaseId: uuid('report_case_id'),
    claimedSeats: text('claimed_seats'),
    postedAt: at('posted_at'),
    maskRegions: jsonb('mask_regions').notNull().$type<{ x: number; y: number; w: number; h: number }[]>(),
    captureKey: text('capture_key').notNull(),
    captureSha256: bytea('capture_sha256').notNull(),
    scanStatus: text('scan_status').notNull(),
    matchedTicketIds: jsonb('matched_ticket_ids').notNull().$type<string[]>(),
    registeredBy: uuid('registered_by').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('external_post_event_created_idx').on(t.eventId, t.createdAt)],
);

export const evidenceExport = pgTable(
  'evidence_export',
  {
    id: uuid('id').primaryKey(),
    bundleId: uuid('bundle_id').notNull(),
    kind: text('kind').notNull(),
    dataRequestId: uuid('data_request_id'),
    documentId: uuid('document_id'),
    sha256: bytea('sha256').notNull(),
    rows: integer('rows').notNull(),
    reason: text('reason').notNull(),
    actorId: uuid('actor_id').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('evidence_export_actor_created_idx').on(t.actorId, t.createdAt)],
);
