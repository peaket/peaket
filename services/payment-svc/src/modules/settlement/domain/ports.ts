// 정산·지급·KYC 저장 포트. 메모리(단위 시험)와 Drizzle(운영)이 같은 모양을 쓴다.
import type { AdjustmentRecord } from './adjustment.js';
import type {
  DisputeRecord,
  GuaranteeCollectionRecord,
  GuaranteeKind,
  KycRecord,
  PaymentFact,
  PayoutAccountRecord,
  PayoutAccountChangeRecord,
  PortoneLedgerSyncName,
  PortoneLedgerSyncRecord,
  PortonePartnerRecord,
  PortoneTransferRecord,
  RefundFact,
  RefundScanRecord,
  SettlementRecalculationRecord,
  SettlementAlertRequestRecord,
  OpsRefusal,
  PayoutRetryAuditRecord,
  PayoutStatus,
  PgBalanceReconciliationRecord,
  SettlementCaseRequestRecord,
  TossSellerRecord,
  TossSellerStatus,
  PayoutBatchAuditRecord,
  PayoutBatchRecord,
  PayoutRecord,
  Pg,
  PgStore,
  ProductSettlementItem,
  ReceivableMoveRecord,
  ReceivableRecord,
  ReceivableStatus,
  SettlementEventValue,
  StatementAuditRecord,
  StatementKind,
  StatementRecord,
  StatementSource,
  StatementStatus,
} from './settlement.js';

export interface StatementFilter {
  from?: string | undefined;
  to?: string | undefined;
  pgStore?: PgStore | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface StatementPage {
  items: StatementRecord[];
  nextCursor: string | null;
}

export interface StatementUpdate {
  statementId: string;
  status: StatementRecord['status'];
  holdReason: StatementRecord['holdReason'];
  offsetAmount: number;
  payoutAmount: number;
  updatedAt: Date;
  /** 출발 상태(기본 CONFIRMED). 묶음에 붙지 않은 정산서만 바꾼다. 지금 상태가 다르면 묶음 전체를 롤백하고 409다(ADR-0368 결정 2) */
  from?: readonly StatementStatus[];
  /** 같은 트랜잭션에 쓸 전이 감사·사건(상태가 바뀔 때) */
  audits?: readonly StatementAuditRecord[];
  events?: readonly SettlementEventValue[];
}

/**
 * 정산서 상태 전이 한 건(ADR-0368 결정 2·3). 지금 상태가 from 안이고 expect가 맞을 때만 상태·바꿀 칸·감사·딸린 행·Outbox 사건을
 * 한 트랜잭션에 쓴다. 맞지 않으면 아무것도 쓰지 않는다(저장소는 false를 돌려준다). 사건은 트랜잭션의 마지막 문장으로 Outbox에 쓴다.
 */
export interface StatementTransition {
  statementId: string;
  from: readonly StatementStatus[];
  to: StatementStatus;
  set?: {
    holdReason?: StatementRecord['holdReason'];
    disputeDueAt?: Date | null;
    adjustmentAmount?: number;
    payoutAmount?: number;
    offsetAmount?: number;
    /** 마감 넘김의 지급일 미룸(같은 상태 전이, ADR-0369 결정 14 ①) */
    payoutDate?: string;
  };
  /** 함께 걸 조건(낙관적 대조): 이의 기한 전·후, 조정 합계·상계가 읽은 값 그대로, 묶음에 붙지 않음, 그 묶음에 붙어 있음 */
  expect?: {
    disputeDueAfter?: Date;
    disputeDueAtOrBefore?: Date;
    adjustmentAmount?: number;
    offsetAmount?: number;
    unbatched?: boolean;
    payoutBatchId?: string;
  };
  /**
   * 조건이 맞지 않아도 함께 쓰는 다른 행을 되돌리지 않고 이 전이만 건너뛴다(감사·사건도 쓰지 않는다). 결제사가 이미 접수한 지급 ID처럼
   * 정산서 상태와 무관하게 남겨야 하는 쓰기와 한 트랜잭션에 둘 때만 쓴다(PayoutWrite)
   */
  optional?: boolean;
  updatedAt: Date;
  audits: readonly StatementAuditRecord[];
  events: readonly SettlementEventValue[];
  /** 같은 트랜잭션에 넣을 이의 행(이의 받기) */
  insertDispute?: DisputeRecord;
  /** 열린 이의(result 없음) 하나를 닫는다. 이미 닫혔으면 전이 전체가 실패한다 */
  resolveDispute?: { disputeId: string; result: 'ADJUSTED' | 'DISMISSED'; resolvedBy: string | null; resolutionNote: string | null; resolvedAt: Date };
  /** PENDING 조정 행 하나를 APPLIED로 바꾼다. PENDING이 아니면 전이 전체가 실패한다 */
  applyAdjustment?: { approvalId: string; appliedAt: Date };
  /** 같은 트랜잭션에 넣을 미수금(근거 부분 유일에 걸리면 넣지 않고 그 미수금 사건도 쓰지 않는다) */
  insertReceivable?: ReceivableRecord;
  // ---- F-07-8(ADR-0380 결정 4·8): 다시 계산 보류의 같은 트랜잭션 행 ----
  /** 정산서를 그 묶음에서 뺀다(payout_batch_id 비움, 묶음 합계에서 amount를 빼고 건수 −1). expect.payoutBatchId와 함께 쓴다 */
  unbatch?: { batchId: string; amount: number };
  /** 이 정산서의 상계(OFFSET)마다 되돌림(REVERSAL) 한 줄·미수금 남은 금액 되살림·OPEN. 이미 되돌린 이동이면 전이 전체가 실패한다 */
  reverseOffsets?: readonly ReverseOffset[];
}

/** 상계 되돌림 한 줄(receivable_movement REVERSAL, reverses_id = 되돌린 OFFSET) */
export interface ReverseOffset {
  reversalId: string;
  /** 되돌린 OFFSET 이동 ID */
  moveId: string;
  receivableId: string;
  amount: number;
  at: Date;
}

/**
 * 다시 계산 한 건(ADR-0380 결정 6·8)을 한 트랜잭션에: 옛 판 조건부 전이(SUPERSEDED, 상계 되돌림 포함) → 옛 판 NEGATIVE_STATEMENT 미수금 행 잠금 →
 * decide가 잠근 값으로 정한 새 판(원본 목록·통지·감사·사건)과 음수 미수금 닫기 → 옛 판의 열린 이의 SUPERSEDED·적용 전 조정 VOID.
 * 옛 판 전이가 맞지 않으면(다른 완료가 먼저 썼다) 아무것도 쓰지 않고 false다. 하나라도 실패하면 모두 없다
 */
export interface StatementSupersede {
  old: StatementTransition;
  /** 옛 판의 음수 미수금 근거(negative-statement:{옛 판 ID}). 있으면 행 잠금으로 읽는다 */
  negativeSourceRef?: string;
  /** 열린 이의를 닫고 적용 전 조정을 무효로 하는 시각 */
  closedAt: Date;
  decide(snap: { negative?: { receivableId: string; amount: number; remaining: number } }): SupersedePlan;
}

export interface SupersedePlan {
  /** CALCULATED로 넣을 새 판 */
  record: StatementRecord;
  sources: readonly StatementSource[];
  notify: StatementNotification;
  /** 새 판에 더 남길 감사(negative-recovered 근거) */
  audits: readonly StatementAuditRecord[];
  /** 옛 판 음수 미수금을 남은 금액만큼 닫는다(이동 SUPERSEDED 한 줄·남은 0·CLOSED). amount 0이면 이동 없이 그대로 */
  closeNegative?: { receivableId: string; amount: number; moveId: string; at: Date };
}

/** 계산 = 통지(ADR-0368 결정 1): CALCULATED로 넣은 행을 같은 트랜잭션에서 NOTIFIED로 바꾸고 감사·사건을 쓴다 */
export interface StatementNotification {
  disputeDueAt: Date;
  audit: StatementAuditRecord;
  event: SettlementEventValue;
}

/** 조정 행 저장 결과. 같은 승인 ID는 처음 행, 그 정산서에 적용 전 조정이 이미 있으면 'pending' */
export type AdjustmentInsertResult = { record: AdjustmentRecord; created: boolean } | 'pending';

export interface ReceivableUpdate {
  receivableId: string;
  remaining: number;
  status: ReceivableRecord['status'];
  updatedAt: Date;
}

/** 보증 충당의 원자적 저장(0026). collection·movement·receivable 갱신을 한 트랜잭션에 쓴다. */
export interface GuaranteeCollectionAtomicInput {
  collection: GuaranteeCollectionRecord;
  move: ReceivableMoveRecord;
  receivable: Pick<ReceivableRecord, 'receivableId' | 'remaining' | 'status' | 'updatedAt'>;
}

/** core-svc 지금 계약 조건(보증 비율·종류). 없으면 undefined. payment-svc는 계약 없이 보증을 만들지 않는다. */
export interface PromoterContractSource {
  current(promoterId: string): Promise<{ commissionRateBp: number; guaranteeRateBp: number; guaranteeKind: GuaranteeKind } | undefined>;
}

/** 지급 건 재요청 한 건(새 순번은 저장소가 정산서 행을 잠근 채 그 정산서의 가장 큰 순번 + 1로 정한다, ADR-0369 결정 8) */
export interface PayoutRetrySpec {
  /** 실패한 옛 지급 건. FAILED가 아니거나 이미 다른 지급 건이 대신했으면 쓰기 전체가 실패한다 */
  oldPayoutId: string;
  newPayoutId: string;
  auditId: string;
  payoutDate: string;
  autoRetryCount: number;
  actor: string;
  reason: PayoutRetryAuditRecord['reason'];
  at: Date;
}

/** 지급 건·정산서·묶음·CS 건 요청을 한 트랜잭션에 쓰는 묶음(ADR-0369 결정 6·7·8·10). 하나라도 조건이 맞지 않으면 아무것도 쓰지 않는다 */
export interface PayoutWrite {
  /** 지급 건 조건부 갱신. from이 있으면 지금 상태가 그 안일 때만이고 0행이면 쓰기 전체가 실패한다 */
  payoutUpdates?: readonly {
    payoutId: string;
    from?: readonly PayoutStatus[];
    set: {
      pgPayoutId?: string | null;
      status?: PayoutStatus;
      errorCode?: string | null;
      failureClass?: PayoutRecord['failureClass'];
      payoutDate?: string;
      /** 포트원 출금 대사 결과(F-07-7 I-13) */
      pgTransferId?: string | null;
      transferCheck?: PayoutRecord['transferCheck'];
      transferCheckedAt?: Date | null;
      updatedAt: Date;
    };
  }[];
  /** 새 지급 건(포트원 수기 정산건 실행, F-07-7 I-07). 같은 정산서·순번이 있으면 쓰기 전체가 실패한다 */
  insertPayouts?: readonly PayoutRecord[];
  retries?: readonly PayoutRetrySpec[];
  transitions?: readonly StatementTransition[];
  /** 묶음 갱신. expectStatus가 있으면 지금 상태가 그 안일 때만이고 0행이면 쓰기 전체가 실패한다 */
  batch?: {
    batchId: string;
    expectStatus?: readonly PayoutBatchRecord['status'][];
    set: Partial<Pick<PayoutBatchRecord, 'status' | 'payoutDate' | 'submitAttempts' | 'nextSubmitAt' | 'submitDeadlineAt' | 'lastSubmitError' | 'dateRetryUsed'>> & { updatedAt: Date };
  };
  /** 같은 사건 키가 이미 있으면 넣지 않는다 */
  caseRequests?: readonly SettlementCaseRequestRecord[];
  // ---- F-07-7(ADR-0370 결정 5·7·8): 같은 트랜잭션에 넣을 행 ----
  /** 운영 경보 요청. 같은 사건 키가 이미 있으면 넣지 않는다 */
  alertRequests?: readonly SettlementAlertRequestRecord[];
  /** 포트원 이체 한 줄. 이미 있으면(겹친 대사) 아무것도 쓰지 않고 ok=false */
  portoneTransfer?: PortoneTransferRecord;
  /** 포트원 대사 진행 행(넣거나 바꿈) */
  ledgerSync?: PortoneLedgerSyncRecord;
  /** 포트원 파트너 행(넣거나 바꿈) */
  portonePartner?: PortonePartnerRecord;
  /** 정산 계좌 판 조건부 갱신(expectedVersion 0은 행이 없을 때만 넣음). 판이 다르면 쓰기 전체가 실패한다 */
  payoutAccount?: { record: PayoutAccountRecord; expectedVersion: number };
  /** 정산 계좌 변경 시도 행(덧붙이기). 같은 재인증 jti가 있으면 쓰기 전체가 실패한다 */
  payoutAccountChange?: PayoutAccountChangeRecord;
}

/** ops 받기 거절을 세는 대상(행 종류) */
export type OpsIntakeRow = 'case-request' | 'alert-request' | 'payout-account-change' | 'dispute';

/** 쓰기 결과. ok=false면 아무것도 쓰지 않았다. retried는 만든 새 순번 지급 건 */
export interface PayoutWriteResult {
  ok: boolean;
  retried: readonly PayoutRecord[];
}

/** 지급 결과 반영의 트랜잭션 안 읽기(지급 건을 조건부로 바꾼 뒤, 정산서·묶음 행을 잠근 채 읽은 값) */
export interface PayoutFactSnapshot {
  payout: PayoutRecord;
  statement: StatementRecord;
  statementPayouts: readonly PayoutRecord[];
  batch: PayoutBatchRecord;
  batchPayouts: readonly PayoutRecord[];
}

/** 결제사 지급 가능 잔액. 토스만 API가 있고, 없으면 undefined(확인 생략)다. 포트원은 운영자 입력값을 쓴다. */
export interface PgBalanceSource {
  available(input: { pg: Pg; pgStore: PgStore }): Promise<{ availableAmount: number; pendingAmount: number } | undefined>;
}

export interface PayoutBatchAtomicInput {
  batch: PayoutBatchRecord;
  statementIds: readonly string[];
  statementUpdates: readonly StatementUpdate[];
  receivableUpdates: readonly ReceivableUpdate[];
  receivableMoves: readonly ReceivableMoveRecord[];
  /**
   * 09시에 미리 만든 PREPARED 묶음을 이 요청이 묶는다(ADR-0369 결정 13). 있으면 새 행을 넣지 않고 그 행을 batch 값으로 바꾸며,
   * 트랜잭션의 첫 문장으로 그 행이 아직 PREPARED일 때만 바꾼다(아니면 payout-batch-exists로 전체 롤백)
   */
  promotePrepared?: boolean;
  /** 정산서 갱신 밖에서 같은 트랜잭션에 쓸 사건(상계로 닫힌 미수금의 RECEIVABLE_CLOSED) */
  events?: readonly SettlementEventValue[];
}

/** ops-svc payout_approval 한 건을 결제사가 대조할 값만 옮긴 모양. 계좌·사유 글은 싣지 않는다. */
export interface VerifiedPayoutApproval {
  approvalId: string;
  kind: 'PAYOUT_BATCH';
  targetRef: string;
  batchId: string;
  pg: Pg;
  pgStore: PgStore;
  payoutDate: string;
  currency: 'KRW';
  amount: number;
  statementCount: number;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'DONE' | 'FAILED';
  requiredApprovals: number;
  requestedBy: string;
  approvals: readonly string[];
  approvedAt: string | null;
}

/** ops-svc 지급 승인 기록 확인. 없으면 undefined, ops가 5xx·시간 초과·모양 위반이면 503 SettlementProblem. */
export interface PayoutApprovalVerifier {
  verify(approvalId: string): Promise<VerifiedPayoutApproval | undefined>;
}

/** core-svc 판매 승인 상태 읽기. core가 5xx·시간 초과면 503 SettlementProblem. */
export interface SaleSuspensionSource {
  listSuspended(eventIds: readonly string[]): Promise<ReadonlySet<string>>;
}

/** 지급 승인 성공·거절의 구조화 로그. 계좌번호·내부 토큰·승인 사유 원문은 싣지 않는다. */
export interface SettlementApprovalLog {
  approved(o: { batchId: string; approvalId: string; requesterId: string; approverId: string; amount: number; pg: Pg; pgStore: PgStore; payoutDate: string; at: Date }): void;
  rejected(o: { batchId: string; approvalId: string; reason: string; at: Date }): void;
  /** 파트너가 남의 정산서를 보거나 이의하려 했다(settlement_authz_denied, J-T10). 금액·계좌는 싣지 않는다 */
  authzDenied?(o: { partnerId: string; accountId: string; statementId: string | null; eventId?: string; action: 'list-event' | 'dispute'; at: Date }): void;
  /** CS 처리함 건을 열지 못했다(다음 점검이 다시 보낸다) */
  caseNoticeFailed?(o: { disputeId: string; statementId: string; at: Date; reason?: 'mark-failed' }): void;
  /** 지급 쪽 CS 건 요청을 보내지 못했다(다음 30분 점검이 다시 보낸다) */
  payoutCaseNoticeFailed?(o: { eventKey: string; kind: string; at: Date }): void;
  /** 정산 웹훅 서명 불일치(보안 이벤트, ASVS 16.3.3). 전송 ID·시각만 싣고 키·본문은 싣지 않는다 */
  webhookSignatureInvalid?(o: { transmissionId: string; at: Date }): void;
  /** 서명은 맞지만 전송 시각이 5분 넘게 다른 늦은 웹훅(본문을 쓰지 않고 단건 조회로만 확정한다) */
  webhookLate?(o: { transmissionId: string; sentAt: string; at: Date }): void;
  /** 토스 지급대행 설정이 없어 정산 사건을 받지 않았다 */
  webhookUnconfigured?(o: { at: Date }): void;
  /** 결제사 응답 JWE를 쓰지 않았다(다른 alg·enc, 복호 실패, ASVS 16.3.4). 키·JWE 원문은 싣지 않는다 */
  tossJweInvalid?(o: { pgStore: PgStore; at: Date }): void;
  /** 토스 지급의 자동 일(전송·09시 묶음·미완료 점검·잔액 대사·셀러 조회)을 하지 못했다 */
  payoutJobFailed?(o: { job: string; batchId?: string; pgStore?: PgStore; reason: string; at: Date }): void;
  /** 정산 계좌 변경의 재인증 거부(사건 payout_account_reauth_rejected, 파트너·사유 종류만, F-07-7 ASVS 16.3.3) */
  payoutAccountReauthRejected?(o: { promoterId: string; reason: string; at: Date }): void;
  /** 포트원 사후 대사 tick 실패(사건 portone_reconciliation_failed, 이름·까닭 종류만) */
  portoneReconciliationFailed?(o: { name: string; kind: string; at: Date }): void;
  /** ops 받기 거절 3번째의 영구 실패(사건 ops_intake_refused, 개인정보 없음) */
  opsIntakeRefused?(o: { target: string; eventKey: string; kind: string; refusal: string; count: number; at: Date }): void;
}

/** 정산 지급 지표(ADR-0369 결정 12, settlement §11) */
export interface SettlementSignals {
  payoutFailed(pg: Pg, reason: string): void;
  webhookSignatureInvalid(): void;
  sellerKycRequired(pg: Pg, count: number): void;
  pgBalanceDiff(pg: Pg, pgStore: PgStore, diff: number): void;
  payoutOverdue(pg: Pg): void;
  // ---- F-07-7(포트원 지급대행·계좌 변경·사후 대사·ops 받기 거절). 고정된 F-07-6 가짜를 깨지 않게 선택 메서드다 ----
  payoutAccountChange?(result: 'ACCEPTED' | 'HOLDER_MISMATCH' | 'AGENCY_FAILED'): void;
  agencySyncPending?(count: number): void;
  portoneWithdrawalUnmatched?(): void;
  portonePartnerAccountMismatch?(count: number): void;
  portoneBalanceDiff?(diff: number): void;
  portoneLedgerSyncAge?(sync: 'WITHDRAWAL' | 'PARTNER_ACCOUNT', seconds: number): void;
  portoneExecutionPending?(count: number): void;
  opsIntakeRefused?(target: OpsIntakeTarget): void;
  opsIntakeFailed?(target: OpsIntakeTarget, count: number): void;
  // ---- F-07-8(계산 뒤 환급 미수금·다시 계산 대기). 선택 메서드다 ----
  /** settlement_refund_receivable_total(카운터): 새로 만든 계산 뒤 환급 미수금 수 */
  refundReceivableCreated?(count: number): void;
  /** settlement_recalculation_pending(게이지): PENDING 다시 계산 요청 수 */
  recalculationPending?(count: number): void;
}

/** ops 받기 대상 셋(지표 이름표 target) */
export type OpsIntakeTarget = 'cs-case' | 'ops-alert' | 'audit-record';

/** ops-svc 승인 업무 SETTLEMENT_ADJUSTMENT 한 건에서 payment가 대조할 사실(ADR-0368 결정 8). 근거 메모·계좌는 싣지 않는다 */
export interface VerifiedAdjustmentApproval {
  approvalId: string;
  kind: 'SETTLEMENT_ADJUSTMENT';
  targetRef: string;
  amount: number;
  reasonCode: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'DONE' | 'FAILED' | 'WITHDRAWN' | 'EXPIRED';
  requiredApprovals: number;
  requestedBy: string;
  approvals: readonly string[];
  approvedAt: string | null;
}

/** ops-svc 조정 승인 기록 확인. 없으면 undefined, ops가 5xx·시간 초과·모양 위반이면 503 SettlementProblem */
export interface AdjustmentApprovalVerifier {
  verify(approvalId: string): Promise<VerifiedAdjustmentApproval | undefined>;
}

/** ops-svc CS 처리함 '정산 이의' 건 열기(ADR-0368 결정 5). 열지 못하면 던진다(이의는 그대로 남고 정산 일꾼이 다시 보낸다) */
export interface SettlementCaseNotice {
  openDispute(o: { disputeId: string; statementId: string; createdAt: Date }): Promise<void>;
  /**
   * 지급 쪽 종류(SELLER_KYC_REQUIRED·PAYOUT_ERROR·PAYOUT_FAILED·PAYOUT_DELAYED·PG_BALANCE_MISMATCH, ADR-0369 결정 10, F-07-7의 PORTONE_PAYOUT_EXECUTION·PORTONE_LEDGER_MISMATCH).
   * 받지 않으면 던진다. detail은 선택 칸(1~2,000자, F-07-7 계획 §5.1 (타) 결정 2)이고 있을 때만 ops 본문에 싣는다.
   * ops가 거절하면(202 accepted:false·400·422) OpsIntakeRefused, 일시 실패면 SettlementProblem 503을 던진다
   */
  openCase(o: { eventKey: string; kind: string; sourceId: string; createdAt: Date; detail?: string }): Promise<void>;
}

/** 포트원 플랫폼 파트너의 사업자 정보(F-07-6 registerTossSellers의 company와 같은 칸) */
export interface PayoutCompany {
  name: string;
  representativeName: string;
  businessRegistrationNumber: string;
  email: string;
  phone: string;
}

/** 지급 계좌(결제사 요청에만 넘긴다. 저장·로그·오류 메시지에 넣지 않는다). bankCode는 PEAKET 두 자리 은행 코드 */
export interface PayoutAccountInput {
  bankCode: string;
  accountNumber: string;
  holderName: string;
}

/**
 * 포트원 플랫폼 API 전송(F-07-7 계획 §5.1 (나), ADR-0370 결정 1·7·8).
 * 응답 없음·5xx·모양 틀림은 PortoneTransportError(kind NO_RESPONSE·REJECTED·SHAPE)를 던진다. 오류 메시지·스팬에 계좌번호가 없다
 */
export interface PortonePlatformTransport {
  /** 없는 계좌는 null */
  lookupHolder(input: { bankCode: string; accountNumber: string }): Promise<{ holderName: string } | null>;
  registerPartner(input: { partnerId: string; contractId: string; company: PayoutCompany; account: PayoutAccountInput }): Promise<{ partnerId: string }>;
  updatePartnerAccount(partnerId: string, account: PayoutAccountInput): Promise<void>;
  getPartner(partnerId: string): Promise<{ partnerId: string; bankCode: string; accountLast4: string; holderName: string; scheduled: { bankCode: string; accountLast4: string; holderName: string } | null }>;
  /** transferId = 정산서 ID. 같은 아이디가 있으면 조회해 금액·정산일이 같을 때 created:false, 다르면 PortoneTransportError(REJECTED) */
  createManualTransfer(input: { transferId: string; partnerId: string; amount: number; settlementDate: string }): Promise<{ transferId: string; created: boolean }>;
  getManualTransfer(transferId: string): Promise<{ transferId: string; amount: number; settlementDate: string; status: string } | null>;
  cancelManualTransfer(transferId: string): Promise<void>;
  listPayouts(input: { bulkPayoutId: string }): Promise<readonly PortonePayoutItem[]>;
  listAccountTransfers(input: { from: Date; to: Date }): Promise<readonly PortoneAccountTransfer[]>;
  listPartnerSettlements(settlementDate: string): Promise<readonly { partnerId: string; transferId: string; amount: number }[]>;
}

export interface PortonePayoutItem {
  payoutId: string;
  transferId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED' | 'CANCELLED';
  completedAt: Date | null;
  failureCode: string | null;
}

/** 이체 원장 한 줄. bankCode는 PEAKET 두 자리 은행 코드(어댑터가 바꿈), 받는 계좌는 끝 4자리만 */
export interface PortoneAccountTransfer {
  transferId: string;
  type: 'WITHDRAWAL' | 'DEPOSIT';
  withdrawalType: string | null;
  payoutId: string | null;
  amount: number;
  bankCode: string | null;
  accountLast4: string | null;
  holderName: string | null;
  balance: number | null;
  transferredAt: Date;
}

/** ops 감사 받기(POST /internal/v1/ops/audit-records, recordType PAYOUT_ACCOUNT_CHANGED). 거절은 OpsIntakeRefused, 일시 실패는 SettlementProblem 503 */
export interface PayoutAccountAuditSink {
  send(o: { eventKey: string; recordId: string; payload: Record<string, unknown>; occurredAt: Date }): Promise<void>;
}

/** ops 운영 경보 받기(POST /internal/v1/ops-alerts). 거절은 OpsIntakeRefused, 일시 실패는 SettlementProblem 503 */
export interface SettlementAlertSink {
  send(o: { eventKey: string; kind: string; severity: 'SEV2' | 'SEV3'; sourceId: string; reason: string; createdAt: Date }): Promise<void>;
}

export interface SettlementStore {
  /**
   * 부분 유일 인덱스에 걸려 넣지 못하면 false(원본 목록·감사·사건도 쓰지 않는다).
   * notify가 있으면 CALCULATED로 넣은 행을 같은 트랜잭션에서 NOTIFIED(이의 기한)로 바꾸고 감사·STATEMENT_NOTIFIED를 쓴다(계산 = 통지).
   * notify 없이 부르는 것은 시험 자료 넣기뿐이다.
   */
  insertStatement(record: StatementRecord, sources: readonly StatementSource[], notify?: StatementNotification): Promise<boolean>;
  /** 조건부 전이 한 건. 조건이 맞지 않으면 아무것도 쓰지 않고 false */
  transitionStatement(t: StatementTransition): Promise<boolean>;
  /** 여러 정산서의 조건부 전이를 한 트랜잭션에. 하나라도 맞지 않으면 모두 롤백하고 false */
  transitionStatements(ts: readonly StatementTransition[]): Promise<boolean>;
  findStatement(promoterId: string, statementId: string): Promise<StatementRecord | undefined>;
  findStatementById(statementId: string): Promise<StatementRecord | undefined>;
  findEventStatement(promoterId: string, eventId: string, pg: Pg, pgStore: PgStore): Promise<StatementRecord | undefined>;
  listEvent(promoterId: string, eventId: string): Promise<StatementRecord[]>;
  listProduct(promoterId: string, filter: StatementFilter): Promise<StatementPage>;
  /**
   * 조건 없는 덮어쓰기. 응용 층은 정산서 상태를 이것으로 바꾸지 않는다(상태 전이는 transitionStatement, ADR-0368 결정 2).
   * 시험 자료를 맞출 때만 쓴다.
   */
  saveStatement(record: StatementRecord): Promise<void>;
  /** 그 회차에 다른 파트너의 정산서가 있는가(테넌트 격리 로그, J-T10) */
  hasEventStatementOfOther(promoterId: string, eventId: string): Promise<boolean>;
  listDisputes(statementId: string): Promise<DisputeRecord[]>;
  /** CS 처리함 건을 아직 열지 못한 열린 이의(오래된 차례) */
  listDisputesAwaitingCase(limit: number): Promise<DisputeRecord[]>;
  markDisputeCaseRequested(disputeId: string, at: Date): Promise<void>;
  // ---- 수기 조정(payment 0027, settlement §4.3) ----
  /** 같은 승인 ID면 처음 행(created=false), 그 정산서에 적용 전 조정이 있으면 'pending' */
  insertAdjustment(record: AdjustmentRecord): Promise<AdjustmentInsertResult>;
  findAdjustmentByApproval(approvalId: string): Promise<AdjustmentRecord | undefined>;
  /** PENDING만 VOID로 닫는다. 닫았으면 true */
  voidAdjustment(approvalId: string, at: Date): Promise<boolean>;
  /** requestedAt이 before보다 이른 PENDING 행을 VOID로 닫고 닫은 수를 돌려준다 */
  voidStalePendingAdjustments(before: Date, limit: number): Promise<number>;
  insertPayoutBatch(record: PayoutBatchRecord): Promise<void>;
  /** 배치와 정산서 결속을 한 트랜잭션으로 쓴다. 결속할 수 없는 정산서가 섞이면 롤백하고 409다. */
  createPayoutBatchWithStatements(record: PayoutBatchRecord, statementIds: readonly string[]): Promise<void>;
  /** 상계·보류·배치·정산서 결속을 한 트랜잭션으로 쓴다(M1-F1). 하나라도 실패하면 전부 롤백한다. */
  createPayoutBatchAtomically(input: PayoutBatchAtomicInput): Promise<void>;
  /** 반려·취소한 배치를 풀어 정산서를 CONFIRMED로 되돌리고 같은 지급일의 새 배치를 가능하게 한다(CONS-V02). */
  releasePayoutBatch(batchId: string): Promise<boolean>;
  /** 승인 상태 저장과 감사 행을 한 트랜잭션에 쓴다. 다른 요청이 먼저 승인했으면 false(버전 조건부). */
  approvePayoutBatchAtomically(batch: PayoutBatchRecord, audit: PayoutBatchAuditRecord): Promise<boolean>;
  /** 거절 감사. 배치 상태는 바꾸지 않는다. */
  insertPayoutBatchAudit(audit: PayoutBatchAuditRecord): Promise<void>;
  findPayoutBatch(batchId: string): Promise<PayoutBatchRecord | undefined>;
  listPayoutBatches(filter: { pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; status?: readonly string[] | undefined; limit: number }): Promise<PayoutBatchRecord[]>;
  savePayoutBatch(record: PayoutBatchRecord): Promise<void>;
  /** 아직 어느 지급 묶음에도 붙지 않은 확정 정산서만. */
  listConfirmed(pg: Pg, pgStore: PgStore, payoutDate: string): Promise<StatementRecord[]>;
  listStatementsByBatch(batchId: string): Promise<StatementRecord[]>;
  /** 이의 기간이 끝난 NOTIFIED 정산서(자동 확정 대상, M1-F3). */
  listDueConfirmation(now: Date, limit: number): Promise<StatementRecord[]>;
  insertPayouts(records: readonly PayoutRecord[]): Promise<void>;
  listPayouts(batchId: string): Promise<PayoutRecord[]>;
  findPayout(payoutId: string): Promise<PayoutRecord | undefined>;
  savePayout(record: PayoutRecord): Promise<void>;
  findKyc(promoterId: string): Promise<KycRecord | undefined>;
  saveKyc(record: KycRecord): Promise<void>;
  findPayoutAccount(promoterId: string): Promise<PayoutAccountRecord | undefined>;
  savePayoutAccount(record: PayoutAccountRecord): Promise<void>;
  /** 관제 목록(테넌트를 가리지 않는다) */
  listStatements(filter: { kind?: StatementKind | undefined; status?: string | undefined; pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; limit: number }): Promise<StatementRecord[]>;
  findProductStatement(promoterId: string, pg: Pg, pgStore: PgStore, periodStart: string, periodEnd: string): Promise<StatementRecord | undefined>;
  // ---- 미수금 상계(settlement §7) ----
  insertReceivable(record: ReceivableRecord): Promise<void>;
  /** source_ref 부분 유일(0024)에 걸리면 새로 쓰지 않고 false. 배상 미수금의 겹친 두 요청은 한 행만 남긴다 */
  insertReceivableIfAbsent(record: ReceivableRecord): Promise<boolean>;
  /** source_ref로 한 행(배상 미수금 멱등). 없으면 undefined */
  findReceivableBySourceRef(sourceRef: string): Promise<ReceivableRecord | undefined>;
  saveReceivable(record: ReceivableRecord): Promise<void>;
  listReceivables(filter: { promoterId?: string | undefined; pg?: Pg | undefined; status?: readonly ReceivableStatus[] | undefined; limit: number }): Promise<ReceivableRecord[]>;
  listOpenReceivables(promoterId: string, pg: Pg): Promise<ReceivableRecord[]>;
  insertReceivableMove(record: ReceivableMoveRecord): Promise<void>;
  listReceivableMoves(statementId: string): Promise<ReceivableMoveRecord[]>;
  findReceivable(receivableId: string): Promise<ReceivableRecord | undefined>;
  /** 미수금 하나의 이동 기록(보증 한도 계산). */
  listReceivableMovesForReceivable(receivableId: string): Promise<ReceivableMoveRecord[]>;
  /** 멱등 키로 보증 충당 한 건. 없으면 undefined */
  findGuaranteeCollection(idempotencyKey: string): Promise<GuaranteeCollectionRecord | undefined>;
  /** 보증 이동·남은 금액·상태를 한 트랜잭션에 쓴다. 같은 미수금의 동시 충당은 행 잠금으로 직렬화한다. */
  collectGuaranteeAtomically(input: GuaranteeCollectionAtomicInput): Promise<void>;
  /** 그 파트너의 토스 지급 예정 정산서 합계(지급일 [from, to]). KYC 예고가 쓴다. */
  sumScheduledTossPayouts(promoterId: string, from: string, to: string): Promise<number>;
  /** 같은 지급일·결제사·상점의 HELD 정산서(SCR-049 제외 목록). */
  listHeldStatements(pg: Pg, pgStore: PgStore, payoutDate: string): Promise<StatementRecord[]>;
  /** 토스 pgPayoutId로 지급 건 찾기(웹훅 단건 조회 반영). */
  findPayoutByPgPayoutId(pgPayoutId: string): Promise<PayoutRecord | undefined>;
  /** 정산 웹훅 중복 확인은 본문 eventId로 한다(payment 0029, ADR-0369 결정 14) */
  hasWebhookEvent(eventId: string): Promise<boolean>;
  /** 받음 기록. 전송 ID가 겹쳐도(같은 전송 ID·새 eventId) 실패하지 않는다 */
  recordWebhookEvent(o: { eventId: string; transmissionId: string; receivedAt: Date }): Promise<void>;
  // ---- 토스 지급대행(payment 0029, F-07-6 ADR-0369) ----
  findTossSeller(promoterId: string, pgStore: PgStore): Promise<TossSellerRecord | undefined>;
  findTossSellerById(tossSellerId: string): Promise<TossSellerRecord | undefined>;
  /** 파트너·상점 키로 넣거나 바꾼다 */
  saveTossSeller(record: TossSellerRecord): Promise<void>;
  /** 그 상태인 토스 셀러 수(settlement_seller_kyc_required 지표) */
  countTossSellers(status: TossSellerStatus): Promise<number>;
  /** 그 파트너·결제사·상점의 HELD 정산서(보류 사유 무관) */
  listHeldStatementsOf(promoterId: string, pg: Pg, pgStore: PgStore): Promise<StatementRecord[]>;
  /** 그 파트너·상점 토스 정산서의 실패 지급 건 가운데 그 갈래이고 아직 다른 지급 건이 대신하지 않은 것 */
  listUnretriedFailedPayouts(o: { promoterId: string; pgStore: PgStore; failureClass: NonNullable<PayoutRecord['failureClass']> }): Promise<PayoutRecord[]>;
  /** 지급 건·정산서·묶음·CS 건 요청을 한 트랜잭션에 쓴다 */
  writePayoutChanges(w: PayoutWrite): Promise<PayoutWriteResult>;
  /**
   * 지급 결과 반영(ADR-0369 결정 6): 지급 건을 조건부로 바꾸고(0행이면 아무것도 하지 않고 undefined), 정산서·묶음 행을 잠근 채 읽은 값으로
   * decide가 정한 쓰기를 같은 트랜잭션에 쓴다
   */
  applyPayoutFact(o: {
    payoutId: string;
    from: readonly PayoutStatus[];
    set: { status: PayoutStatus; errorCode: string | null; failureClass: PayoutRecord['failureClass']; updatedAt: Date };
    decide: (s: PayoutFactSnapshot) => PayoutWrite;
  }): Promise<PayoutWriteResult | undefined>;
  /** CS 건 요청을 넣는다(같은 사건 키는 넣지 않는다). 새로 넣은 수 */
  insertCaseRequests(records: readonly SettlementCaseRequestRecord[]): Promise<number>;
  /** 보내지 않은 CS 건 요청(오래된 차례) */
  listUnsentCaseRequests(limit: number): Promise<SettlementCaseRequestRecord[]>;
  markCaseRequestSent(eventKey: string, at: Date): Promise<void>;
  /** 대사 행과(있으면) CS 건 요청을 한 트랜잭션에 쓴다. 같은 달·같은 묶음 유일에 걸리면 아무것도 쓰지 않고 false */
  insertPgBalanceReconciliation(record: PgBalanceReconciliationRecord, caseRequest?: SettlementCaseRequestRecord): Promise<boolean>;
  lastPgBalanceReconciliation(pg: Pg, pgStore: PgStore): Promise<PgBalanceReconciliationRecord | undefined>;
  /** 대사 행이 없는, 그 시각 뒤 만든 토스 묶음 */
  listBatchesAwaitingReconciliation(since: Date, limit: number): Promise<PayoutBatchRecord[]>;
  /** 그 상점의 끝나지 않은(REQUESTED·IN_PROGRESS) 토스 예약지급 합. excludeBatchId 묶음은 뺀다 */
  sumUnfinishedTossPayouts(pgStore: PgStore, excludeBatchId?: string): Promise<number>;
  /** 묶음 전송 잡기: next_submit_at이 읽은 값 그대로일 때만 next로 바꾼다. 이겼으면 true */
  claimBatchSubmit(batchId: string, expectedNextSubmitAt: Date | null, next: Date | null): Promise<boolean>;
  // ---- F-07-7 포트원 지급대행·계좌 변경·사후 대사(payment 0030·0032, ADR-0370) ----
  findPortonePartner(promoterId: string): Promise<PortonePartnerRecord | undefined>;
  savePortonePartner(record: PortonePartnerRecord): Promise<void>;
  listPortonePartners(limit: number): Promise<PortonePartnerRecord[]>;
  /** 정산 계좌 변경 시도 행 하나(예금주 불일치처럼 다른 쓰기가 없을 때). 같은 jti면 false */
  insertPayoutAccountChange(record: PayoutAccountChangeRecord): Promise<boolean>;
  /** ops 감사로 보내지 않았고 영구 실패도 아닌 변경 행(오래된 차례) */
  listUnsentPayoutAccountChanges(limit: number): Promise<PayoutAccountChangeRecord[]>;
  markPayoutAccountChangeSent(id: string, at: Date): Promise<void>;
  /** 수정 대기(agency_sync_pending)인 정산 계좌 수(지표) */
  countAgencySyncPending(): Promise<number>;
  findLedgerSync(name: PortoneLedgerSyncName): Promise<PortoneLedgerSyncRecord | undefined>;
  saveLedgerSync(record: PortoneLedgerSyncRecord): Promise<void>;
  /** 같은 사건 키는 넣지 않는다. 새로 넣은 수 */
  insertAlertRequests(records: readonly SettlementAlertRequestRecord[]): Promise<number>;
  /** 보내지 않았고 영구 실패도 아닌 경보 요청(오래된 차례) */
  listUnsentAlertRequests(limit: number): Promise<SettlementAlertRequestRecord[]>;
  markAlertRequestSent(eventKey: string, at: Date): Promise<void>;
  findAlertRequest(eventKey: string): Promise<SettlementAlertRequestRecord | undefined>;
  findCaseRequest(eventKey: string): Promise<SettlementCaseRequestRecord | undefined>;
  /**
   * ops 받기 거절 한 번을 센다(F-07-7 계획 §5.1 (파) (마)). 영구 실패가 아닌 행만, 읽은 거절 수 그대로일 때만 올려 겹친 두 tick이 두 번 세지 않는다.
   * 거절 수가 limit에 닿으면 failed_at·last_refusal을 채운다. 행이 없거나 이미 영구 실패면 undefined
   */
  markRefused(row: OpsIntakeRow, key: string, refusal: OpsRefusal, at: Date, limit: number): Promise<{ refusedCount: number; failed: boolean } | undefined>;
  /** 영구 실패로 남은 행 수(지표 settlement_ops_intake_failed) */
  countIntakeFailed(row: OpsIntakeRow): Promise<number>;
  /** 출금 대사 대상: 포트원 묶음의 지급 건 가운데 COMPLETED·IN_PROGRESS이고 transfer_check가 빈 것 */
  listPortonePayoutsForTransferCheck(limit: number): Promise<PayoutRecord[]>;
  /** 그 파트너·결제사의 정산서 가운데 그 상태인 것 */
  listStatementsOfPromoter(promoterId: string, pg: Pg, statuses: readonly StatementStatus[]): Promise<StatementRecord[]>;
  /** next_submit_at이 지난 토스 묶음(APPROVED·SUBMITTED·PARTIAL_FAILED) */
  listDueSubmitBatches(now: Date, limit: number): Promise<PayoutBatchRecord[]>;
  // ---- F-07-8 회차 취소 다시 계산·계산 뒤 환급·대사 미완 결제 풀림(payment 0033, ADR-0380) ----
  /** 같은 요청 ID가 있으면 넣지 않고 그 행(created=false) */
  insertRecalculation(record: SettlementRecalculationRecord): Promise<{ created: boolean; record: SettlementRecalculationRecord }>;
  findRecalculation(requestId: string): Promise<SettlementRecalculationRecord | undefined>;
  /** 그 회차의 PENDING 다시 계산(가장 먼저 연 것) */
  findPendingRecalculation(eventId: string): Promise<SettlementRecalculationRecord | undefined>;
  listPendingRecalculations(limit: number): Promise<SettlementRecalculationRecord[]>;
  /** 지금 행이 PENDING일 때만 바꾼다(DONE은 덮지 않는다). 바꿨으면 true */
  saveRecalculation(record: SettlementRecalculationRecord): Promise<boolean>;
  /** 그 회차의 SUPERSEDED가 아닌 회차 정산서(모든 결제사·상점·파트너) */
  listLiveEventStatements(eventId: string): Promise<StatementRecord[]>;
  /** 그 정산서의 상계(OFFSET) 이동 가운데 아직 되돌리지 않은 것 */
  listOffsetMovements(statementId: string): Promise<ReceivableMoveRecord[]>;
  /** 그 판의 계산 원본 목록 */
  listStatementSources(statementId: string): Promise<StatementSource[]>;
  /** 다시 계산 한 건(StatementSupersede). 옛 판 전이가 맞지 않으면 false */
  supersedeStatement(s: StatementSupersede): Promise<boolean>;
  findRefundScan(name: RefundScanRecord['name']): Promise<RefundScanRecord | undefined>;
  saveRefundScan(record: RefundScanRecord): Promise<void>;
  /** 그 정산서·결제로 이미 만든 계산 뒤 환급 미수금의 환급액 합 */
  sumRefundReceivables(statementId: string, paymentId: string): Promise<number>;
  /** 대사 불일치로 뺀 결제가 아직 풀림 처리되지 않은 살아 있는 회차 정산서 */
  listStatementsWithOpenExclusions(limit: number): Promise<StatementRecord[]>;
  /** 뺀 결제 항목에 풀림 표시를 더하고(지금 그 항목이 있을 때만) 조정 제안 CS 건 요청을 한 트랜잭션에 쓴다. 표시를 바꿨으면 true */
  resolveExcludedPayment(o: { statementId: string; entry: string; resolvedEntry: string; caseRequest: SettlementCaseRequestRecord; at: Date }): Promise<boolean>;
  /** 지급일 다음 은행 영업일 12:00 KST가 지난 끝나지 않은 토스 지급 건(결제사 지급 ID가 있는 것) */
  listOverduePayouts(now: Date, limit: number): Promise<PayoutRecord[]>;
}

/** 결제사 잔액 대사의 장부 원천(대사 끝난 승인·취소 합, 완료 지급 합·달별 건 수, ADR-0369 결정 11) */
export interface PgLedgerSource {
  ledger(input: { pg: Pg; pgStore: PgStore; cutoffAt: Date }): Promise<{ approvedAmount: number; refundedAmount: number; paidOutAmount: number; payoutCountByMonth: Record<string, number>; firstPaymentAt: Date | null }>;
}

export interface ProductSettlementSource {
  /** core-svc shop의 상품 정산 원천(정산 기준일이 [from, to]에 든 항목). */
  listProductItems(from: string, to: string): Promise<ProductSettlementItem[]>;
}

export interface DueEvent {
  promoterId: string;
  eventId: string;
  endsAt: string;
}

/** 회차 종료 뒤 정산할 회차 목록(core-svc event_sale_config). 스케줄러가 하루 한 번 읽는다. */
export interface DueEventSettlementSource {
  listDue(through: string, limit: number): Promise<DueEvent[]>;
}

/** 회차 수수료율(core-svc 공연 설정·계약). 없으면 정산을 만들지 않는다(A1-H10). */
export interface EventCommissionRateSource {
  rateBp(eventId: string): Promise<number | undefined>;
}

export interface SettlementPaymentSource {
  /** 회차·결제사·결제 상점 결제 원장. 입금 오류 되돌림(FAILED·DEPOSIT_CANCELED)은 뺀다. */
  listEventPayments(eventId: string, pg: Pg, pgStore: PgStore): Promise<PaymentFact[]>;
  /**
   * 끝난 결제 취소가 있는 결제를 (마지막 취소 끝난 시각, 결제 ID) 차례로 그 열쇠 뒤부터(F-07-8 I-02 계산 뒤 환급 훑기).
   * 선택 메서드: 없으면 계산 뒤 환급 미수금을 만들지 않는다
   */
  listRefundsAfter?(after: { at: Date; paymentId: string }, limit: number): Promise<RefundFact[]>;
}

export interface PayoutSubmitInput {
  batch: PayoutBatchRecord;
  payouts: readonly PayoutRecord[];
  /** 지급 건 ID → 받을 토스 셀러 ID(요청 칸 destination). 토스만 쓴다 */
  tossSellerIds?: Readonly<Record<string, string>>;
}

/** 토스 지급 요청 한 번의 결과 넷(ADR-0369 결정 7). 전송 어댑터는 던지지 않고 이것을 돌려준다 */
export type TossSendResult =
  | { kind: 'ACCEPTED'; payouts: readonly { refPayoutId: string; pgPayoutId: string; status: PayoutStatus }[] }
  | { kind: 'REJECTED'; code: string; refPayoutId?: string }
  | { kind: 'NO_RESPONSE' }
  | { kind: 'PROCESSING' };

/** 실행 결과. PENDING은 접수되지 않은 요청 묶음이 남았다는 뜻이다. groups는 토스 요청 묶음별 결과다(없으면 묶음 전체의 결과만 아는 실행 기록 어댑터) */
export interface PayoutSubmitResult {
  status: 'SUBMITTED' | 'COMPLETED' | 'PENDING';
  groups?: readonly { idempotencyKey: string; refPayoutIds: readonly string[]; result: TossSendResult }[];
}

/** 셀러 등록 본문(결제사로 보내는 평문). 계좌번호는 이 값으로만 넘기고 저장하지 않는다 */
export interface TossSellerRegistration {
  refSellerId: string;
  businessType: 'INDIVIDUAL_BUSINESS' | 'CORPORATE';
  company: { name: string; representativeName: string; businessRegistrationNumber: string; email: string; phone: string };
  account: { bankCode: string; accountNumber: string; holderName: string };
}

/**
 * 토스페이먼츠 지급대행 전송(F-07-6 ADR-0369 결정 1·7). 모든 메서드의 첫 인자는 결제 상점이다.
 * requestPayouts는 던지지 않고 결과 넷을 돌려주고, 나머지는 응답을 받지 못하거나 복호가 실패하면 던진다.
 */
export interface TossPayoutTransport {
  requestPayouts(pgStore: PgStore, input: { payoutDate: string; idempotencyKey: string; items: readonly { refPayoutId: string; amount: number; tossSellerId: string }[] }): Promise<TossSendResult>;
  getPayout(pgStore: PgStore, pgPayoutId: string): Promise<{ pgPayoutId: string; status: PayoutStatus; errorCode?: string }>;
  /** 예약지급 취소. 결과 본문은 쓰지 않는다(던지지 않으면 취소됨, F-07-7 I-06) */
  cancelPayout(pgStore: PgStore, pgPayoutId: string): Promise<{ pgPayoutId: string; status: PayoutStatus } | void>;
  registerSeller(pgStore: PgStore, body: TossSellerRegistration): Promise<{ tossSellerId: string; status: TossSellerStatus }>;
  /** 셀러 수정(POST /v2/sellers/{id}, JWE, F-07-7 계획 §5.1 (타) 결정 1). 선택 메서드: 없으면 계좌 변경은 503 payout-gateway-unavailable */
  updateSeller?(pgStore: PgStore, tossSellerId: string, body: TossSellerRegistration): Promise<{ tossSellerId: string; status: TossSellerStatus }>;
  getSeller(pgStore: PgStore, tossSellerId: string): Promise<{ tossSellerId: string; status: TossSellerStatus }>;
  balance(pgStore: PgStore): Promise<{ availableAmount: number; pendingAmount: number }>;
  /** 그 기간(KST 날짜, 양끝 포함)의 정산 조회 수수료 합 */
  listSettlementFees(pgStore: PgStore, from: Date, to: Date): Promise<number>;
}

/** 지급 실행 어댑터. 토스 지급대행 JWE·포트원 콘솔 실행은 이 경계 뒤에 둔다. */
export interface PayoutGateway {
  readonly pg: Pg;
  submit(input: PayoutSubmitInput): Promise<PayoutSubmitResult>;
}

export interface VerifiedReauth {
  jti: string;
  accountId: string;
  sessionId: string;
  act: string;
  factors: string[];
}

export interface ReauthVerifier {
  /** 없거나 틀리면 SettlementProblem('reauth-required', 403) */
  verify(token: string | undefined, o: { sessionId: string; act: string }): Promise<VerifiedReauth>;
}

export const SETTLEMENT_STORE = Symbol.for('peaket.settlement.store');
export const ADJUSTMENT_APPROVAL_VERIFIER = Symbol.for('peaket.settlement.adjustment-approval-verifier');
export const SETTLEMENT_CASE_NOTICE = Symbol.for('peaket.settlement.case-notice');
export const SETTLEMENT_HOLIDAYS = Symbol.for('peaket.settlement.holidays');
export const SETTLEMENT_PAYMENT_SOURCE = Symbol.for('peaket.settlement.payment-source');
export const SETTLEMENT_PRODUCT_SOURCE = Symbol.for('peaket.settlement.product-source');
export const SETTLEMENT_EVENT_SOURCE = Symbol.for('peaket.settlement.event-source');
export const SETTLEMENT_COMMISSION_SOURCE = Symbol.for('peaket.settlement.commission-source');
export const PAYOUT_APPROVAL_VERIFIER = Symbol.for('peaket.settlement.payout-approval-verifier');
export const PROMOTER_CONTRACT_SOURCE = Symbol.for('peaket.settlement.promoter-contract-source');
export const PG_BALANCE_SOURCE = Symbol.for('peaket.settlement.pg-balance-source');
export const SALE_SUSPENSION_SOURCE = Symbol.for('peaket.settlement.sale-suspension-source');
export const SETTLEMENT_APPROVAL_LOG = Symbol.for('peaket.settlement.approval-log');
export const PAYOUT_GATEWAY = Symbol.for('peaket.settlement.payout-gateway');
export const REAUTH_VERIFIER = Symbol.for('peaket.settlement.reauth-verifier');
