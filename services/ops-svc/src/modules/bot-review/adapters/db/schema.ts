// 표본 검토 Drizzle 스키마(ops DB bot_review_batch·bot_review_sample·bot_review_judgement, 마이그레이션 0020).
// 카드 표에는 pid·IP·기기 가명·계정 ID·점수 원값·가중치를 두지 않는다(POL-006).
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AppliedVerdict, ReviewBatch, ReviewKind, SampleStatus, SampleTimelineStep } from '../../domain/bot-review.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const botReviewBatch = pgTable(
  'bot_review_batch',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    reviewKind: text('review_kind').notNull().$type<ReviewKind>(),
    seed: text('seed').notNull(),
    targetCount: integer('target_count').notNull(),
    populationCount: integer('population_count').notNull(),
    retentionUntil: at('retention_until').notNull(),
    r2DueAt: at('r2_due_at').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('bot_review_batch_event_kind_uq').on(t.eventId, t.reviewKind),
    check('bot_review_batch_review_kind_check', sql`${t.reviewKind} in ('PASSED_SAMPLE', 'HUMAN_BASELINE')`),
    check('bot_review_batch_target_check', sql`${t.targetCount} >= 0 and ${t.populationCount} >= 0`),
  ],
);

export const botReviewSample = pgTable(
  'bot_review_sample',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => botReviewBatch.id, { onDelete: 'cascade' }),
    sampleRef: text('sample_ref').notNull(),
    verdictEventKey: uuid('verdict_event_key').notNull(),
    status: text('status').notNull().$type<SampleStatus>(),
    riskBand: text('risk_band'),
    behaviorSummaryBand: text('behavior_summary_band'),
    timeline: jsonb('timeline').notNull().$type<readonly SampleTimelineStep[]>(),
    evidenceAvailable: text('evidence_available').array().notNull(),
    ordinal: integer('ordinal').notNull(),
    reviewBatch: text('review_batch').notNull().$type<ReviewBatch>(),
    appliedVerdict: text('applied_verdict').notNull().$type<AppliedVerdict>(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('bot_review_sample_batch_ref_uq').on(t.batchId, t.sampleRef),
    uniqueIndex('bot_review_sample_batch_event_key_uq').on(t.batchId, t.verdictEventKey),
    uniqueIndex('bot_review_sample_batch_ordinal_uq').on(t.batchId, t.ordinal),
    index('bot_review_sample_batch_status_ordinal_idx').on(t.batchId, t.status, t.ordinal),
    check('bot_review_sample_status_check', sql`${t.status} in ('PENDING', 'RECORDED')`),
    check('bot_review_sample_review_batch_check', sql`${t.reviewBatch} in ('PASSED', 'SHADOW_CHALLENGED')`),
    check('bot_review_sample_applied_verdict_check', sql`${t.appliedVerdict} in ('ALLOW', 'CHALLENGE')`),
    check('bot_review_sample_ordinal_check', sql`${t.ordinal} >= 0`),
  ],
);

export const botReviewJudgement = pgTable(
  'bot_review_judgement',
  {
    sampleId: uuid('sample_id')
      .primaryKey()
      .references(() => botReviewSample.id, { onDelete: 'cascade' }),
    verdict: text('verdict').notNull(),
    evidenceKinds: text('evidence_kinds').array().notNull(),
    labelResult: text('label_result').notNull(),
    recordedAt: at('recorded_at').notNull(),
  },
  (t) => [
    check('bot_review_judgement_verdict_check', sql`${t.verdict} in ('HUMAN', 'BOT', 'UNDECIDED')`),
    check('bot_review_judgement_label_result_check', sql`${t.labelResult} in ('APPLIED', 'UNCHANGED', 'DEVICE_NOT_FOUND', 'SKIPPED')`),
  ],
);
