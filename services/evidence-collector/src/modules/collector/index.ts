// 이 모듈의 공개 파일. 조립(collector-app.ts·app.module.ts)은 층 폴더가 아니라 이 파일로만 가져온다(층 규칙).
export { CollectorModule } from './collector.module.js';
export {
  COLLECTION_RESULTS,
  CollectEvidence,
  EVIDENCE_PREFIX,
  EVIDENCE_TARGET_INTERVAL_MS,
  type CollectionResult,
  type CollectionSummary,
  type CollectorSignals,
} from './application/collect-evidence.js';
export { VerifyWebhook, WEBHOOK_REJECT_REASONS, type WebhookRejectReason } from './application/verify-webhook.js';
export { ALERT_DECISIONS, type AlertDecision } from './domain/alert.js';
export { TARGET_KINDS, type EvidenceTarget, type TargetKind } from './domain/snapshot.js';
export { PostgresSnapshotSource } from './adapters/postgres-snapshot.js';
export { RedisSnapshotSource } from './adapters/redis-snapshot.js';
