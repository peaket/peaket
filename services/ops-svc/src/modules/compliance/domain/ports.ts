// compliance 모듈의 포트(F-07-11). 저장소·core-svc 내부 호출·감사를 바깥으로 분리한다.
import type { ComplianceAction, ComplianceActionRecord, ComplianceNoticeRecord, ComplianceStatus } from './compliance-notice.js';

export interface ComplianceNoticeListQuery {
  readonly status?: ComplianceStatus;
  readonly sort: 'DUE_ASC' | 'LATEST';
  readonly cursor?: string;
  readonly limit: number;
}

export interface ComplianceNoticeListResult {
  readonly items: readonly ComplianceNoticeRecord[];
  readonly nextCursor: string | null;
}

export interface ComplianceNoticeStore {
  insertNotice(n: ComplianceNoticeRecord): Promise<void>;
  findNotice(noticeId: string): Promise<ComplianceNoticeRecord | undefined>;
  /** 등록한 계정과 Idempotency-Key로 찾는다(계정별 멱등 범위) */
  findByIdempotency(requestedBy: string, idempotencyKey: string): Promise<ComplianceNoticeRecord | undefined>;
  listNotices(q: ComplianceNoticeListQuery): Promise<ComplianceNoticeListResult>;
  updateNotice(noticeId: string, patch: Partial<Pick<ComplianceNoticeRecord, 'status' | 'takenDownAtMs' | 'withdrawnAtMs' | 'updatedAtMs'>>): Promise<void>;
  insertAction(a: ComplianceActionRecord): Promise<void>;
  findAction(noticeId: string, action: ComplianceAction, idempotencyKey: string): Promise<ComplianceActionRecord | undefined>;
  actionsOf(noticeId: string): Promise<readonly ComplianceActionRecord[]>;
}

export interface ComplianceApplyInput {
  readonly noticeId: string;
  readonly reviewIds: readonly string[];
  readonly receivedAt: string;
  readonly deadline: 'H24' | 'H10';
  readonly reason: string;
}
export interface ComplianceApplyResult {
  readonly applied: number;
  readonly skipped: number;
  readonly deadlineAt: string;
}
export interface ComplianceWithdrawInput {
  readonly noticeId: string;
  readonly reason: string;
}
export interface ComplianceWithdrawResult {
  readonly restored: number;
  readonly sameContentRestored: number;
  readonly fingerprintsCleared: number;
}

/** core-svc 내부 통보 경로(F-07-11). 답하지 않으면 응용이 503으로 닫는다 */
export interface ComplianceCore {
  applyNotice(input: ComplianceApplyInput): Promise<ComplianceApplyResult>;
  withdrawNotice(input: ComplianceWithdrawInput): Promise<ComplianceWithdrawResult>;
}

export interface ComplianceAuditInput {
  readonly action: 'NOTICE_CREATED' | 'NOTICE_VIEWED' | 'NOTICE_TAKEN_DOWN' | 'NOTICE_WITHDRAWN';
  readonly noticeId: string;
  readonly actorId: string;
  readonly role: string;
  readonly atMs: number;
}

/** 통보 열람·등록·차단·철회를 불변 감사 기록에 남긴다(control-tower §9, ASVS 8.3.1) */
export interface ComplianceAudit {
  record(input: ComplianceAuditInput): Promise<void>;
}

export class ComplianceCoreUnavailable extends Error {
  constructor(readonly why: string) {
    super(`core-svc 통보 경로에 닿지 못했습니다: ${why}`);
    this.name = 'ComplianceCoreUnavailable';
  }
}
