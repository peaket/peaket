// 추가 검증 이의(VERIFICATION_APPEAL) 처리 계약(F-06-7 GAT-280, ADR-0364 결정 8·9, 시험 B-T28).
// 동작의 정본은 docs/features/bot-defense.md §12 'CS 처리 첫 구현', 표는 docs/data.md verification_case·cs_case_dispatch(ops 0031)다.
// - 건이 열릴 때: 같은 트랜잭션에 verification_case(내용 없음, PENDING)와 보낼 호출 APPEAL_COPY·ACCOUNT_HOLD_OPEN(연 때의 판)
// - 결정: 인정 QUEUE_RESOLVE·TRUST_LABEL·ACCOUNT_HOLD_CLOSE, 기각 QUEUE_RESOLVE·ACCOUNT_HOLD_CLOSE(해결한 새 판)
// - 다시 보내기: n번째 실패의 다음 시각 = 실패 시각 + min(10초 × 2^(n−1), 10분), 8번째 실패에서 반영 실패(FAILED)와 SEV3 경보, 그 뒤에도 10분마다
// pid·계정 ID는 받는 쪽 호출에만 싣고 응답·운영 로그·감사 기록에는 싣지 않는다.
import type { AuditRecord } from '../../audit/index.js';
import type { CsCase } from './cs-case.js';

export type AppealOutcome = 'ACCEPTED' | 'REJECTED';
export const DISPATCH_CALLS = ['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE'] as const;
/** 한 건의 호출을 보내는 차례(bot-defense §12 '기다림과 이어 보내기') */
export type DispatchCall = (typeof DISPATCH_CALLS)[number];
export type DispatchState = 'PENDING' | 'APPLIED' | 'FAILED';
export type AppealEntryState = 'VERIFYING' | 'PASSED' | 'ENDED';
export type BlockListChange = 'NONE' | 'ADDED' | 'REMOVED' | 'DEVICE_NOT_FOUND';
export type VerificationCaseStatus = 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';

/** 이 건 종류 */
export const VERIFICATION_APPEAL_KIND = 'VERIFICATION_APPEAL' as const;

/** 다시 보내기 간격의 처음 값 10초 [가정] */
export const DISPATCH_RETRY_FIRST_MS = 10_000;
/** 다시 보내기 간격 상한 10분 [가정] */
export const DISPATCH_RETRY_CAP_MS = 600_000;
/** 이만큼 보내도 반영되지 않으면 반영 실패 8번 [가정] */
export const DISPATCH_FAIL_AFTER = 8;
/** 배경 작업 간격 10초 [가정] */
export const CS_CASE_DISPATCH_TICK_MS = 10_000;
/** 한 바퀴에 잡는 호출 수 50개 [가정] */
export const DISPATCH_BATCH = 50;
/** 잡아 두는 시간 30초 [가정](겹쳐 보내지 않게) */
export const DISPATCH_CLAIM_MS = 30_000;
/** 결정 직후와 배경 작업의 호출마다 데드라인 2초 [가정] */
export const DISPATCH_CALL_DEADLINE_MS = 2_000;
/** 상세를 열 때 읽는 호출마다 데드라인 1초 [가정] */
export const DETAIL_CALL_DEADLINE_MS = 1_000;
/** 반영 실패 경보 종류(SEV3, 건·호출마다 한 번) */
export const CS_CASE_DISPATCH_FAILED_ALERT = 'CS_CASE_DISPATCH_FAILED';
/** 내용이 없어 라벨·병합 막기를 보낼 수 없음 */
export const APPEAL_CONTENT_MISSING = 'APPEAL_CONTENT_MISSING';
/** 그 받는 쪽 주소 설정이 없음(local·ci·demo) */
export const NOT_CONFIGURED = 'NOT_CONFIGURED';

/** 다시 보내도 같은 답이라 다시 보내지 않는 gRPC 상태(bot-defense §12 '다시 보내기') */
export const NO_RETRY_CODES: ReadonlySet<string> = new Set(['INVALID_ARGUMENT', 'ALREADY_EXISTS', 'NOT_FOUND', 'FAILED_PRECONDITION', 'PERMISSION_DENIED']);

/** n번째(1부터) 실패 뒤 기다리는 시간 */
export function retryWaitMs(failures: number): number {
  return Math.min(DISPATCH_RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1), DISPATCH_RETRY_CAP_MS);
}

/** 결정이 더하는 보낼 호출 */
export function decisionCallsOf(outcome: AppealOutcome): DispatchCall[] {
  return outcome === 'ACCEPTED' ? ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE'] : ['QUEUE_RESOLVE', 'ACCOUNT_HOLD_CLOSE'];
}

/** 이의 내용을 기다리는 호출(회차·pid·계정을 쓴다). QUEUE_RESOLVE는 이의 ID만 써서 기다리지 않는다 */
export const NEEDS_CONTENT: ReadonlySet<DispatchCall> = new Set<DispatchCall>(['ACCOUNT_HOLD_OPEN', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);

/** queue-svc GetVerificationAppeal의 내용 */
export interface AppealContent {
  readonly appealId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly pid: string;
  readonly text: string;
  /** trust.proto ReasonCategory 이름에서 REASON_CATEGORY_를 뺀 값 */
  readonly reasonCategory: string;
  readonly receivedAtMs: number;
  readonly entryState: AppealEntryState | null;
}

export interface CallOptions {
  /** 이 호출의 데드라인(ms). 없으면 DISPATCH_CALL_DEADLINE_MS */
  readonly deadlineMs?: number;
}

/** queue-svc VerificationAppealService */
export interface VerificationAppeals {
  get(appealId: string, o?: CallOptions): Promise<AppealContent>;
  resolve(i: { appealId: string; caseId: string; caseVersion: number; outcome: AppealOutcome }, o?: CallOptions): Promise<'APPLIED' | 'UNCHANGED' | 'NOT_ISOLATED'>;
}

/** trust-svc TrustLabelService.ApplyLabel(LABEL_SOURCE_APPEAL_ACCEPTED, LABEL_HUMAN) */
export interface AppealLabels {
  apply(i: { caseId: string; version: number; eventId: string; pid: string; actedBy: string }, o?: CallOptions): Promise<{ changed: boolean; blockList: BlockListChange }>;
}

export type VerdictEvidenceAnswer =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly reason: string;
      readonly hardSignal: 'NONE' | 'BLOCK_LIST' | 'HONEYPOT' | null;
      readonly source: 'REALTIME' | 'REASSESS' | null;
      readonly decidedAtMs: number | null;
      readonly sent: number;
      readonly passed: number;
      readonly failed: number;
    };

/** trust-svc TrustEvidenceService.GetVerdictEvidence */
export interface VerdictEvidence {
  get(i: { eventId: string; pid: string }, o?: CallOptions): Promise<VerdictEvidenceAnswer>;
}

/** identity-svc AccountHoldService.SetAccountHold(VERIFICATION_APPEAL) */
export interface AccountHolds {
  set(i: { accountId: string; caseId: string; state: 'OPEN' | 'CLOSED'; version: number; kind?: 'VERIFICATION_APPEAL' | 'APPEAL' }, o?: CallOptions): Promise<{ changed: boolean }>;
}

/** 받는 쪽 호출의 실패. code는 gRPC 상태 이름(UNAVAILABLE 등)이고, 주소 설정이 없으면 NOT_CONFIGURED다 */
export class CsDispatchCallError extends Error {
  constructor(readonly code: string) {
    super(`받는 쪽 호출 실패: ${code}`);
    this.name = 'CsDispatchCallError';
  }
}

/** 지표 ops_cs_case_dispatch_total{call,result} */
export interface CsDispatchSignals {
  dispatch(call: DispatchCall, result: 'applied' | 'retry' | 'failed'): void;
}

/** 이의 처리 포트(시작 조립 cs-appeal-wiring.ts가 주소마다 채운다. 없는 칸은 NOT_CONFIGURED) */
export interface CsAppealPorts {
  readonly appeals?: VerificationAppeals;
  readonly labels?: AppealLabels;
  readonly evidence?: VerdictEvidence;
  readonly holds?: AccountHolds;
  readonly signals?: CsDispatchSignals;
}

/** docs/data.md verification_case */
export interface VerificationCase {
  readonly appealId: string;
  readonly caseId: string;
  readonly eventId: string | null;
  readonly accountId: string | null;
  /** 받는 쪽 호출에만 싣는다(응답·로그·감사에 없음) */
  readonly pid: string | null;
  readonly text: string | null;
  readonly reasonCategory: string | null;
  readonly receivedAtMs: number | null;
  readonly status: VerificationCaseStatus;
  readonly appealResult: AppealOutcome | null;
  readonly decidedBy: string | null;
  readonly decidedAtMs: number | null;
  readonly blockListChange: BlockListChange | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** 내용을 옮겼는가 */
export const hasContent = (a: Pick<VerificationCase, 'eventId'>): boolean => a.eventId !== null;

/** docs/data.md cs_case_dispatch */
export interface CsCaseDispatchRow {
  readonly caseId: string;
  readonly call: DispatchCall;
  readonly sourceVersion: number;
  readonly state: DispatchState;
  readonly attempts: number;
  readonly nextAttemptAtMs: number | null;
  readonly claimedUntilMs: number | null;
  readonly lastError: string | null;
  readonly result: string | null;
  readonly failedAlertedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** 새 보낼 호출 행 */
export function newDispatchRow(caseId: string, call: DispatchCall, sourceVersion: number, nowMs: number): CsCaseDispatchRow {
  return { caseId, call, sourceVersion, state: 'PENDING', attempts: 0, nextAttemptAtMs: nowMs, claimedUntilMs: null, lastError: null, result: null, failedAlertedAtMs: null, createdAtMs: nowMs, updatedAtMs: nowMs };
}

/** 새 이의 행(내용 없음) */
export function newVerificationCase(appealId: string, caseId: string, nowMs: number): VerificationCase {
  return {
    appealId,
    caseId,
    eventId: null,
    accountId: null,
    pid: null,
    text: null,
    reasonCategory: null,
    receivedAtMs: null,
    status: 'PENDING',
    appealResult: null,
    decidedBy: null,
    decidedAtMs: null,
    blockListChange: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** 이의 행의 상태(결정 전 PENDING·SKIPPED, 결정 뒤 RUNNING·PASSED·FAILED) */
export function appealStatusOf(a: Pick<VerificationCase, 'status' | 'appealResult'>, rows: readonly Pick<CsCaseDispatchRow, 'state'>[]): VerificationCaseStatus {
  if (a.appealResult === null) return a.status === 'SKIPPED' ? 'SKIPPED' : 'PENDING';
  if (rows.some((r) => r.state === 'FAILED')) return 'FAILED';
  return rows.every((r) => r.state === 'APPLIED') ? 'PASSED' : 'RUNNING';
}

/** 결정 한 트랜잭션에 쓰는 값(건 해결·이의 결과·보낼 호출·감사·멱등 기록) */
export interface AppealDecisionWrite {
  readonly next: CsCase;
  readonly expectedVersion: number;
  readonly audit: AuditRecord;
  readonly outcome: AppealOutcome;
  readonly decidedBy: string;
  readonly decidedAtMs: number;
  readonly calls: readonly DispatchCall[];
  readonly idem: { readonly accountRef: string; readonly operation: string; readonly key: string; readonly requestHash: Uint8Array };
}

export type AppealDecisionResult = { readonly kind: 'decided' } | { readonly kind: 'stale' } | { readonly kind: 'replay'; readonly caseId: string };

/** 이의 행·보낼 호출 저장소(메모리·DB가 CS 처리함 건 저장소와 같은 객체로 구현한다) */
export interface CsAppealStore {
  appealOf(caseId: string): Promise<VerificationCase | undefined>;
  dispatchRowsOf(caseId: string): Promise<CsCaseDispatchRow[]>;
  /** 내용을 옮긴다(이미 옮겼으면 그대로) */
  copyAppealContent(caseId: string, c: AppealContent, nowMs: number): Promise<void>;
  /** 이의 행 상태·차단 목록 변화를 적는다 */
  updateAppeal(caseId: string, patch: { readonly status?: VerificationCaseStatus; readonly blockListChange?: BlockListChange }, nowMs: number): Promise<void>;
  /** 결정을 다시 보낸 요청의 멱등 기록(없으면 undefined) */
  findDecisionRecord(idem: AppealDecisionWrite['idem']): Promise<{ readonly requestHash: Uint8Array; readonly caseId: string | null } | undefined>;
  decide(w: AppealDecisionWrite): Promise<AppealDecisionResult>;
  /** 보낼 때가 된 호출을 잡는다(next_attempt_at ≤ now, 잡음이 없거나 지남). next_attempt_at·case_id 차례 */
  claimDue(nowMs: number, limit: number, claimMs: number): Promise<CsCaseDispatchRow[]>;
  /** 그 건의 반영되지 않은(다시 보내지 않는 실패가 아닌) 호출을 다음 시각과 상관없이 잡는다(결정 직후 보내기) */
  claimCase(caseId: string, nowMs: number, claimMs: number): Promise<CsCaseDispatchRow[]>;
  /** 한 호출의 결과를 적고 잡음을 푼다 */
  saveDispatch(row: CsCaseDispatchRow): Promise<void>;
}
