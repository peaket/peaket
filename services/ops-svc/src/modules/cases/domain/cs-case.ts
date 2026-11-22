// CS 처리함 건 계약(asyncapi support.cases-requested, openapi CsCase, docs/data.md cs_case·cs_case_request, docs/features/transfer-refund.md §7.1).
// F-06-2 GAT-280(ADR-0364): 받는 종류 아홉(결정 4), 종류별 두 기한(결정 2), 배정·판·해결 메모(결정 5), 기한 경보 표시(결정 3).
import type { AuditRecord } from '../../audit/index.js';

export const CS_CASE_KINDS = [
  'UNKNOWN_PAYMENT',
  'REFUND_FAILED',
  'FLAGGED',
  'REFUND_ACCOUNT_PENDING',
  'COMPENSATION_PENDING',
  'ABUSE_FLAG',
  'DISPUTE',
  'JUDGEMENT_PENDING',
  'STATEMENT_DISPUTE',
  'SELLER_KYC_REQUIRED',
  'PAYOUT_ERROR',
  'PAYOUT_FAILED',
  'PAYOUT_DELAYED',
  'PORTONE_PAYOUT_EXECUTION',
  'SCANNER_UNREPORTED',
  'KOPIS_REPORT_FAILED',
  'VERIFICATION_APPEAL',
  'APPROVAL_EXECUTION_FAILED',
  'RETURN_DELAYED',
  'MINOR_CONTRACT_CANCEL',
  'INQUIRY',
  'CONTENT_REPORT',
  'RIGHTS_REQUEST',
  'PORTONE_LEDGER_MISMATCH',
  'TICKET_NOT_ISSUED',
  'PG_BALANCE_MISMATCH',
  'APPEAL',
  'FRAUD_OBJECTION_COMPENSATION',
] as const;
export type CsCaseKind = (typeof CS_CASE_KINDS)[number];

/**
 * ops-svc가 받는 종류(ADR-0364 결정 4의 아홉과 F-07-5의 정산 이의). 나머지는 그 건의 상세를 읽을 기능이 더한다
 * (문의 F-06-5, 소명 F-06-3·F-06-4, 게시물 신고 LCH-150, 결제 뒤 미발권 BAT-012 등).
 */
export const ACCEPTED_KINDS: ReadonlySet<CsCaseKind> = new Set<CsCaseKind>([
  'REFUND_FAILED',
  'FLAGGED',
  'JUDGEMENT_PENDING',
  'REFUND_ACCOUNT_PENDING',
  'COMPENSATION_PENDING',
  'VERIFICATION_APPEAL',
  'DISPUTE',
  'SCANNER_UNREPORTED',
  'APPROVAL_EXECUTION_FAILED',
  // payment-svc가 이의를 받은 뒤 여는 정산 이의(F-07-5 ADR-0368 결정 5, settlement §4.2)
  'STATEMENT_DISPUTE',
]);

/**
 * 지급·대사·KYC 건(open-items 72번, openapi listOpsCases 설명). CS 담당자(cs_agent·cs_lead)의 목록·상세에 없고(404),
 * operator·commander만 보고 갱신한다(ADR-0364 결정 5)
 */
export const SETTLEMENT_OPS_KINDS: ReadonlySet<CsCaseKind> = new Set<CsCaseKind>([
  'SELLER_KYC_REQUIRED',
  'PAYOUT_ERROR',
  'PAYOUT_FAILED',
  'PAYOUT_DELAYED',
  'PORTONE_PAYOUT_EXECUTION',
  'PORTONE_LEDGER_MISMATCH',
  'PG_BALANCE_MISMATCH',
]);

export const CS_CASE_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;
export type CsCaseStatus = (typeof CS_CASE_STATUSES)[number];

/** 해결 메모 글자 수 상한(코드 포인트, data.md cs_case.result_note) */
export const RESULT_NOTE_MAX = 2_000;
/** 건 요청 eventKey 글자 수 상한(cs_case_request.event_key CHECK) */
export const EVENT_KEY_MAX = 200;

/** asyncapi support.cases-requested의 본문(개인정보·본문 없이 ID와 종류만) */
export interface CaseRequested {
  readonly eventKey: string;
  readonly kind: CsCaseKind;
  readonly sourceId: string;
  readonly category: string;
  readonly followUp?: boolean | undefined;
  readonly hold?: boolean | undefined;
  readonly createdAt: string;
  /** 기한을 세는 시작 시각(없으면 createdAt, ADR-0364 결정 2) */
  readonly dueBaseAt?: string | undefined;
}

export interface CsCase {
  readonly caseId: string;
  readonly kind: CsCaseKind;
  readonly targetRef: string;
  readonly status: CsCaseStatus;
  readonly createdAtMs: number;
  /** 건 요청의 category. 없으면 빈 글 */
  readonly category: string;
  readonly progressDueAtMs: number | null;
  readonly resultDueAtMs: number | null;
  /** 담당 관리 계정 ID */
  readonly assignee: string | null;
  /** 판 번호(상태·결과·배정이 바뀔 때마다 1 오른다). 새 건은 1 */
  readonly version: number;
  readonly resultNote: string | null;
  readonly resolvedAtMs: number | null;
  readonly updatedAtMs: number;
  /** 기한 1영업일 전 경보를 연 마지막 기한 값(data.md due_soon_alerted_for) */
  readonly dueSoonAlertedForMs: number | null;
  /** 기한 넘김 경보를 연 마지막 기한 값(data.md overdue_alerted_for) */
  readonly overdueAlertedForMs: number | null;
}

/** 이른 기한(data.md next_due_at). 기한이 없으면 null('infinity') */
export function nextDueOf(c: Pick<CsCase, 'progressDueAtMs' | 'resultDueAtMs'>): number | null {
  const ds = [c.progressDueAtMs, c.resultDueAtMs].filter((d): d is number => d !== null);
  return ds.length === 0 ? null : Math.min(...ds);
}

/** 새 건을 여는 값 */
export interface CsCaseOpenInput {
  readonly caseId: string;
  readonly kind: CsCaseKind;
  readonly targetRef: string;
  readonly nowMs: number;
  readonly category?: string;
  readonly progressDueAtMs?: number | null;
  readonly resultDueAtMs?: number | null;
}

/** 새 건 값(메모리·DB 저장소가 같은 기본값을 쓴다) */
export function newCsCase(i: CsCaseOpenInput): CsCase {
  return {
    caseId: i.caseId,
    kind: i.kind,
    targetRef: i.targetRef,
    status: 'OPEN',
    createdAtMs: i.nowMs,
    category: i.category ?? '',
    progressDueAtMs: i.progressDueAtMs ?? null,
    resultDueAtMs: i.resultDueAtMs ?? null,
    assignee: null,
    version: 1,
    resultNote: null,
    resolvedAtMs: null,
    updatedAtMs: i.nowMs,
    dueSoonAlertedForMs: null,
    overdueAlertedForMs: null,
  };
}

/** 건 요청 하나의 결과. opened 새 건, existing 같은 (종류, 대상)의 열린 건, duplicate 이미 받은 eventKey */
export type CsCaseReceiveResult = 'opened' | 'existing' | 'duplicate';

/** 목록 조건(정렬은 next_due_at·caseId 차례, 기한 없는 건은 끝) */
export interface CsCaseListQuery {
  readonly statuses: readonly CsCaseStatus[];
  /** 이 종류만(없으면 전부) */
  readonly kinds?: readonly CsCaseKind[];
  /** 이 종류는 뺀다(CS 담당자의 지급·대사·KYC 건) */
  readonly excludeKinds?: readonly CsCaseKind[];
  /** 이른 기한이 이 시각 이하인 건만(기한 없는 건은 빠진다) */
  readonly dueAtOrBeforeMs?: number;
  /** 이 (이른 기한, ID) 다음부터. nextDueMs null은 기한 없음('infinity') */
  readonly after?: { readonly nextDueMs: number | null; readonly caseId: string };
  readonly limit: number;
}

/** 목록 정렬 비교(next_due_at·id, 기한 없음은 끝). 메모리 저장소와 커서가 쓴다 */
export function compareByDue(a: { nextDueMs: number | null; caseId: string }, b: { nextDueMs: number | null; caseId: string }): number {
  const da = a.nextDueMs ?? Number.POSITIVE_INFINITY;
  const db = b.nextDueMs ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  return a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0;
}

export interface CsCaseStore {
  /** 같은 kind·targetRef의 열린 건이 있으면 그것을 돌려준다(멱등). eventKey 기록 없이 연다 */
  open(input: CsCaseOpenInput): Promise<CsCase>;
  /**
   * 건 요청을 받는다(한 트랜잭션): eventKey를 이미 받았으면 그 건(duplicate, 해결된 건이어도 새 건을 열지 않는다),
   * 아니면 같은 (종류, 대상)의 열린 건(existing)이나 새 건(opened)을 돌려주고 eventKey를 cs_case_request에 한 번 적는다
   */
  receive(input: CsCaseOpenInput & { readonly eventKey: string }): Promise<{ result: CsCaseReceiveResult; case: CsCase }>;
  find(caseId: string): Promise<CsCase | undefined>;
  /** 같은 (종류, 대상)의 열린 건 */
  findOpen(kind: CsCaseKind, targetRef: string): Promise<CsCase | undefined>;
  list(q: CsCaseListQuery): Promise<CsCase[]>;
  /** 판 조건부 갱신(next.version = expectedVersion + 1). 감사 기록은 같은 트랜잭션에 쓴다. 판이 다르면 false */
  update(next: CsCase, expectedVersion: number, audit?: AuditRecord): Promise<boolean>;
  /** 경보를 연 기한 값을 적는다(판은 바꾸지 않는다) */
  markAlerted(caseId: string, marks: { readonly dueSoonForMs?: number; readonly overdueForMs?: number }): Promise<void>;
  /** 해결됐는데 경보 표시가 남은 건(경보를 풀 대상) */
  resolvedWithAlerts(limit: number): Promise<CsCase[]>;
  /** 경보 표시를 지운다(경보를 푼 뒤) */
  clearAlerted(caseId: string): Promise<void>;
}

/**
 * 실패한 승인 업무의 건(ADR-0364 결정 6). 세 승인 모듈(계약 조건 변경·관리 역할 변경·지급 묶음)이 FAILED·DONE 자리에서 부른다.
 * kind는 승인 종류(건의 category), dueAtMs는 원래 승인 업무의 기한(없으면 null). 실패해도 승인 흐름을 막지 않게 부르는 쪽이 잡는다
 */
export interface ApprovalFailureCases {
  failed(a: { approvalId: string; kind: string; dueAtMs: number | null }, nowMs: number): Promise<void>;
  succeeded(approvalId: string, nowMs: number): Promise<void>;
}

/** 건 지표(transfer-refund §13 'CS 처리함 건' 행). 없으면 세지 않는다 */
export interface CsCaseSignals {
  /** ops_cs_case_requests_total{kind,result} */
  request(kind: string, result: 'opened' | 'existing' | 'duplicate' | 'ignored'): void;
  /** ops_cs_case_open{kind,due_state}: 한 바퀴에서 센 열린 건 수(전체를 다시 쓴다) */
  openCounts(counts: ReadonlyMap<string, number>): void;
  /** ops_cs_case_due_tick_seconds: 알림 작업 한 바퀴가 끝난 시각(초) */
  tickFinished(nowMs: number): void;
}

export interface CsActor {
  readonly accountId: string;
  readonly role: string;
}

/** 배정 대상이 활성 CS 담당자(cs_agent·cs_lead)인지. 확인하지 못하면 던진다(503) */
export interface CsAssigneeDirectory {
  isActiveCsAgent(adminAccountId: string): Promise<boolean>;
}

/**
 * 종류별 상세 칸(F-06-7 추가 검증 이의 등이 더한다, 계획 §12). 건 하나에 상세 객체를 붙인다.
 * 돌려준 칸은 응답에 그대로 더하므로 팬 이름·연락처·계좌를 싣지 않는다
 */
export interface CsCaseDetailReader {
  read(c: CsCase, actor: CsActor): Promise<Record<string, unknown>>;
}

/** 해결한 건의 기한 경보를 푼다(cs-case-deadline-tick.ts). 실패해도 갱신은 그대로이고 배경 작업이 다시 푼다 */
export interface CsCaseAlertRelease {
  release(c: CsCase, nowMs: number): Promise<void>;
}
