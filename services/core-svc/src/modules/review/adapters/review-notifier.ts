// 신고·조치 알림 어댑터. 운영은 로그 한 줄만 남긴다(notify 모듈 연결은 뒤 단계). 시험은 MemoryReviewNotifier를 쓴다.
import type { ReportRecord, ReviewRecord } from '../domain/review.js';
import type { ReviewCaseSink, ReviewNotifier } from '../domain/ports.js';

type Log = (line: Record<string, unknown>) => void;

export class LogReviewNotifier implements ReviewNotifier {
  constructor(private readonly log: Log = (line) => console.log(JSON.stringify(line))) {}

  async reportReceived(r: ReportRecord): Promise<void> {
    this.log({ kind: 'review-report', reportId: r.reportId, targetId: r.targetId, category: r.category, rightsHolder: r.rightsHolder });
  }

  async reportResolved(r: ReportRecord, outcome: ReportRecord['outcome']): Promise<void> {
    this.log({ kind: 'review-report-resolved', reportId: r.reportId, targetId: r.targetId, outcome });
  }

  async moderationApplied(r: ReviewRecord, action: string, reason: string): Promise<void> {
    this.log({ kind: 'review-moderation', reviewId: r.reviewId, action, reasonLength: reason.length });
  }
}

export class MemoryReviewNotifier implements ReviewNotifier {
  readonly received: ReportRecord[] = [];
  readonly resolved: { reportId: string; outcome: ReportRecord['outcome'] }[] = [];
  readonly moderated: { reviewId: string; action: string; reason: string }[] = [];

  async reportReceived(r: ReportRecord): Promise<void> {
    this.received.push({ ...r });
  }

  async reportResolved(r: ReportRecord, outcome: ReportRecord['outcome']): Promise<void> {
    this.resolved.push({ reportId: r.reportId, outcome });
  }

  async moderationApplied(r: ReviewRecord, action: string, reason: string): Promise<void> {
    this.moderated.push({ reviewId: r.reviewId, action, reason });
  }
}

export class LogReviewCaseSink implements ReviewCaseSink {
  constructor(private readonly log: Log = (line) => console.log(JSON.stringify(line))) {}

  async request(input: { kind: 'CONTENT_REPORT' | 'RIGHTS_REQUEST'; targetId: string; dueAtMs: number }): Promise<void> {
    this.log({ kind: 'review-case-request', caseKind: input.kind, targetId: input.targetId, dueAt: new Date(input.dueAtMs).toISOString() });
  }
}

export class MemoryReviewCaseSink implements ReviewCaseSink {
  readonly requests: { kind: 'CONTENT_REPORT' | 'RIGHTS_REQUEST'; targetId: string; dueAtMs: number }[] = [];
  async request(input: { kind: 'CONTENT_REPORT' | 'RIGHTS_REQUEST'; targetId: string; dueAtMs: number }): Promise<void> {
    this.requests.push({ ...input });
  }
}
