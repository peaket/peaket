// 표본 검토 보안 로그 줄(docs/observability.md §7, ASVS 16.3.3·16.3.4).
// - ops_bot_review_judgement: 표본 ID·판정·묶음·라벨 결과·처리자의 로그 가명·시각. pid·기기 가명·세션 가명 원문은 싣지 않는다.
// - ops_bot_review_label_failure: 표본 ID·사유·시각.
import type { PlatformLogger } from '@peaket/platform';
import type { BotReviewLog } from '../domain/ports.js';

export class SecurityBotReviewLog implements BotReviewLog {
  constructor(private readonly logger: PlatformLogger) {}

  judgement(e: {
    readonly sampleId: string;
    readonly verdict: 'HUMAN' | 'BOT' | 'UNDECIDED';
    readonly reviewBatch: 'PASSED' | 'SHADOW_CHALLENGED';
    readonly label: 'APPLIED' | 'UNCHANGED' | 'DEVICE_NOT_FOUND' | 'SKIPPED';
    readonly atMs: number;
    readonly accountRef?: string;
  }): void {
    this.logger.info(
      {
        kind: 'security',
        event: 'ops_bot_review_judgement',
        sampleId: e.sampleId,
        verdict: e.verdict,
        reviewBatch: e.reviewBatch,
        label: e.label,
        ...(e.accountRef ? { accountRef: e.accountRef } : {}),
        at: new Date(e.atMs).toISOString(),
      },
      'ops_bot_review_judgement',
    );
  }

  labelFailure(e: { readonly sampleId: string; readonly reason: string; readonly atMs: number }): void {
    this.logger.warn(
      { kind: 'security', event: 'ops_bot_review_label_failure', sampleId: e.sampleId, reason: e.reason, at: new Date(e.atMs).toISOString() },
      'ops_bot_review_label_failure',
    );
  }
}
