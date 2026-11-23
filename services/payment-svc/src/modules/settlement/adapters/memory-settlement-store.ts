// 정산 메모리 저장소(단위 시험·개발). Drizzle과 같은 포트·같은 의미(조건부 전이, 한 번에 쓰거나 하나도 쓰지 않음)를 쓴다.
// trade.settlements Outbox 대신 outbox 배열에 사건 값을 남긴다(Drizzle은 같은 트랜잭션의 Outbox 표).
import type {
  AdjustmentInsertResult,
  OpsIntakeRow,
  GuaranteeCollectionAtomicInput,
  PayoutBatchAtomicInput,
  PayoutFactSnapshot,
  PayoutWrite,
  PayoutWriteResult,
  StatementFilter,
  StatementNotification,
  StatementPage,
  SettlementStore,
  StatementTransition,
} from '../domain/ports.js';
import type { AdjustmentRecord } from '../domain/adjustment.js';
import { nextBankBusinessDay } from '../domain/payout-failure.js';
import {
  SettlementProblem,
  TRADE_SETTLEMENTS_TOPIC,
  type DisputeRecord,
  type GuaranteeCollectionRecord,
  type KycRecord,
  type OpsRefusal,
  type PayoutAccountChangeRecord,
  type PayoutAccountRecord,
  type PortoneLedgerSyncName,
  type PortoneLedgerSyncRecord,
  type PortonePartnerRecord,
  type PortoneTransferRecord,
  type SettlementAlertRequestRecord,
  type StatementStatus,
  type PayoutBatchAuditRecord,
  type PayoutBatchRecord,
  type PayoutRecord,
  type PayoutRetryAuditRecord,
  type PayoutStatus,
  type Pg,
  type PgBalanceReconciliationRecord,
  type PgStore,
  type ReceivableMoveRecord,
  type ReceivableRecord,
  type SettlementCaseRequestRecord,
  type SettlementEventValue,
  type StatementAuditRecord,
  type StatementRecord,
  type StatementSource,
  type TossSellerRecord,
  type TossSellerStatus,
} from '../domain/settlement.js';

/** 쓰기 묶음의 조건이 맞지 않았다(아무것도 쓰지 않는다) */
class WriteRejected extends Error {}
const LIVE_SUBMIT_STATUSES: readonly PayoutBatchRecord['status'][] = ['APPROVED', 'SUBMITTED', 'PARTIAL_FAILED'];
const UNFINISHED: readonly PayoutStatus[] = ['REQUESTED', 'IN_PROGRESS'];
interface TransitionPlan {
  statements: Map<string, StatementRecord>;
  disputes: Map<string, DisputeRecord>;
  adjustments: Map<string, AdjustmentRecord>;
  receivables: ReceivableRecord[];
  audits: StatementAuditRecord[];
  events: SettlementEventValue[];
}

const cursorOf = (s: StatementRecord): string => Buffer.from(`${s.createdAt.getTime()}:${s.statementId}`).toString('base64url');
const decodeCursor = (cursor: string): { at: number; id: string } | undefined => {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const n = Number(at);
    return Number.isSafeInteger(n) && id ? { at: n, id } : undefined;
  } catch {
    return undefined;
  }
};

/** 메모리 CS 건 요청 행(시험 단언용 타입은 거절 칸을 채운 모양, 값은 넣은 그대로) */
type StoredCaseRequest = SettlementCaseRequestRecord & { refusedCount: number; failedAt: Date | null; lastRefusal: OpsRefusal | null };

export class MemorySettlementStore implements SettlementStore {
  readonly statements = new Map<string, StatementRecord>();
  readonly sources = new Map<string, StatementSource[]>();
  readonly disputes = new Map<string, DisputeRecord>();
  readonly statementAudits: StatementAuditRecord[] = [];
  readonly batches = new Map<string, PayoutBatchRecord>();
  readonly payoutBatchAudits: PayoutBatchAuditRecord[] = [];
  readonly payouts = new Map<string, PayoutRecord>();
  readonly kycs = new Map<string, KycRecord>();
  readonly accounts = new Map<string, PayoutAccountRecord>();
  readonly receivables = new Map<string, ReceivableRecord>();
  readonly receivableMoves: ReceivableMoveRecord[] = [];
  readonly guaranteeCollections = new Map<string, GuaranteeCollectionRecord>();
  /** 정산 웹훅 받음 기록(본문 eventId, payment 0029 settlement_webhook_receipt.event_id) */
  readonly webhookEvents = new Set<string>();
  readonly adjustments = new Map<string, AdjustmentRecord>();
  /** 파트너·상점별 토스 셀러(키 `${promoterId}:${pgStore}`, payment 0029 toss_seller) */
  readonly tossSellers = new Map<string, TossSellerRecord>();
  /** 지급 쪽 CS 건 요청(키 사건 키, payment 0029 settlement_case_request) */
  /**
   * CS 건 요청. 행은 넣은 모양 그대로 두고(고정된 F-07-6 시험의 toEqual), 읽을 때 없는 거절 칸은 0·null로 본다.
   * 시험이 거절 칸을 바로 단언할 수 있게 값의 타입은 칸을 채운 모양으로 연다(F-07-7)
   */
  readonly caseRequests = new Map<string, StoredCaseRequest>();
  /** 지급 건 재요청 기록(payment 0029 payout_retry_audit) */
  readonly retryAudits: PayoutRetryAuditRecord[] = [];
  /** 결제사 잔액 대사(payment 0029 pg_balance_reconciliation) */
  readonly pgBalanceReconciliations: PgBalanceReconciliationRecord[] = [];
  /** trade.settlements에 쓴 사건(Outbox 대역). topic·key·value */
  readonly outbox: { topic: string; key: string; value: SettlementEventValue }[] = [];
  // ---- F-07-7(payment 0030·0032, ADR-0370) ----
  /** portone_partner(키 promoterId) */
  readonly portonePartners = new Map<string, PortonePartnerRecord>();
  /** payout_account_change(덧붙이기만) */
  readonly payoutAccountChanges: PayoutAccountChangeRecord[] = [];
  /** portone_transfer(키 이체 ID) */
  readonly portoneTransfers = new Map<string, PortoneTransferRecord>();
  /** portone_ledger_sync(키 WITHDRAWAL·PARTNER_ACCOUNT) */
  readonly ledgerSyncs = new Map<string, PortoneLedgerSyncRecord>();
  /** settlement_alert_request(키 사건 키) */
  readonly alertRequests = new Map<string, SettlementAlertRequestRecord>();

  #emit(events: readonly SettlementEventValue[]): void {
    for (const e of events) this.outbox.push({ topic: TRADE_SETTLEMENTS_TOPIC, key: e.promoterId, value: e });
  }

  /** 전이 묶음을 검사하고 쓸 값을 만든다(쓰지는 않는다). 필수 전이가 맞지 않으면 undefined */
  #planTransitions(ts: readonly StatementTransition[]): TransitionPlan | undefined {
    const statements = new Map<string, StatementRecord>();
    const disputes = new Map<string, DisputeRecord>();
    const adjustments = new Map<string, AdjustmentRecord>();
    const receivables: ReceivableRecord[] = [];
    const audits: StatementAuditRecord[] = [];
    const events: SettlementEventValue[] = [];
    for (const t of ts) {
      const s = statements.get(t.statementId) ?? this.statements.get(t.statementId);
      const e = t.expect;
      const matches =
        s !== undefined &&
        t.from.includes(s.status) &&
        !(e?.disputeDueAfter && !(s.disputeDueAt !== null && s.disputeDueAt.getTime() > e.disputeDueAfter.getTime())) &&
        !(e?.disputeDueAtOrBefore && !(s.disputeDueAt !== null && s.disputeDueAt.getTime() <= e.disputeDueAtOrBefore.getTime())) &&
        !(e?.adjustmentAmount !== undefined && (s.adjustmentAmount ?? 0) !== e.adjustmentAmount) &&
        !(e?.offsetAmount !== undefined && s.offsetAmount !== e.offsetAmount) &&
        !(e?.unbatched && s.payoutBatchId !== null) &&
        !(e?.payoutBatchId !== undefined && s.payoutBatchId !== e.payoutBatchId);
      if (!matches || s === undefined) {
        if (t.optional) continue;
        return undefined;
      }
      const next: StatementRecord = { ...s, status: t.to, updatedAt: t.updatedAt };
      if (t.set?.holdReason !== undefined) next.holdReason = t.set.holdReason;
      if (t.set?.disputeDueAt !== undefined) next.disputeDueAt = t.set.disputeDueAt;
      if (t.set?.adjustmentAmount !== undefined) next.adjustmentAmount = t.set.adjustmentAmount;
      if (t.set?.payoutAmount !== undefined) next.payoutAmount = t.set.payoutAmount;
      if (t.set?.offsetAmount !== undefined) next.offsetAmount = t.set.offsetAmount;
      if (t.set?.payoutDate !== undefined) next.payoutDate = t.set.payoutDate;
      statements.set(t.statementId, next);
      if (t.insertDispute) disputes.set(t.insertDispute.disputeId, { ...t.insertDispute, result: null, resolvedAt: null });
      if (t.resolveDispute) {
        const r = t.resolveDispute;
        const d = disputes.get(r.disputeId) ?? this.disputes.get(r.disputeId);
        if (!d || d.statementId !== t.statementId || d.result !== null) return undefined;
        disputes.set(r.disputeId, { ...d, result: r.result, resolvedAt: r.resolvedAt, resolvedBy: r.resolvedBy, resolutionNote: r.resolutionNote });
      }
      if (t.applyAdjustment) {
        const a = adjustments.get(t.applyAdjustment.approvalId) ?? this.adjustments.get(t.applyAdjustment.approvalId);
        if (!a || a.statementId !== t.statementId || a.status !== 'PENDING') return undefined;
        adjustments.set(a.approvalId, { ...a, status: 'APPLIED', appliedAt: t.applyAdjustment.appliedAt });
      }
      let receivableOpened = true;
      if (t.insertReceivable) {
        const ref = t.insertReceivable.sourceRef;
        receivableOpened = !(ref && ([...this.receivables.values()].some((r) => r.sourceRef === ref) || receivables.some((r) => r.sourceRef === ref)));
        if (receivableOpened) receivables.push({ ...t.insertReceivable });
      }
      audits.push(...t.audits);
      events.push(...t.events.filter((ev) => receivableOpened || ev.type !== 'RECEIVABLE_OPENED'));
    }
    return { statements, disputes, adjustments, receivables, audits, events };
  }

  #commitTransitions(plan: TransitionPlan): void {
    for (const [id, s] of plan.statements) this.statements.set(id, s);
    for (const [id, d] of plan.disputes) this.disputes.set(id, d);
    for (const [id, a] of plan.adjustments) this.adjustments.set(id, a);
    for (const r of plan.receivables) this.receivables.set(r.receivableId, r);
    this.statementAudits.push(...plan.audits);
    this.#emit(plan.events);
  }

  /**
   * 지급 쓰기 묶음(PayoutWrite). 모든 조건을 먼저 본 뒤 한꺼번에 쓴다(Drizzle 트랜잭션과 같은 답). 중간에 await가 없어 겹친 호출이 끼어들지 않는다.
   * base는 같은 묶음 앞에서 바꾼 지급 건(결과 반영의 조건부 갱신)이다
   */
  #applyWrite(w: PayoutWrite, base: Map<string, PayoutRecord> = new Map()): PayoutWriteResult {
    try {
      const working = new Map<string, PayoutRecord>(base);
      const get = (id: string) => working.get(id) ?? this.payouts.get(id);
      for (const u of w.payoutUpdates ?? []) {
        const p = get(u.payoutId);
        if (!p || (u.from && !u.from.includes(p.status))) throw new WriteRejected();
        const next: PayoutRecord = { ...p, updatedAt: u.set.updatedAt };
        if (u.set.pgPayoutId !== undefined) next.pgPayoutId = u.set.pgPayoutId;
        if (u.set.status !== undefined) next.status = u.set.status;
        if (u.set.errorCode !== undefined) next.errorCode = u.set.errorCode;
        if (u.set.failureClass !== undefined) next.failureClass = u.set.failureClass;
        if (u.set.payoutDate !== undefined) next.payoutDate = u.set.payoutDate;
        if (u.set.pgTransferId !== undefined) next.pgTransferId = u.set.pgTransferId;
        if (u.set.transferCheck !== undefined) next.transferCheck = u.set.transferCheck;
        if (u.set.transferCheckedAt !== undefined) next.transferCheckedAt = u.set.transferCheckedAt;
        working.set(next.payoutId, next);
      }
      for (const n of w.insertPayouts ?? []) {
        const all = [...new Map([...this.payouts, ...working]).values()];
        // 기본 키·payout_ref_key·(batch, statement, seq) 유일과 같은 답
        if (all.some((p) => p.payoutId === n.payoutId || p.refPayoutId === n.refPayoutId || (p.batchId === n.batchId && p.statementId === n.statementId && p.seq === n.seq))) throw new WriteRejected();
        working.set(n.payoutId, { ...n });
      }
      if (w.portoneTransfer && this.portoneTransfers.has(w.portoneTransfer.transferId)) throw new WriteRejected();
      if (w.payoutAccount) {
        const current = this.accounts.get(w.payoutAccount.record.promoterId);
        const ok = w.payoutAccount.expectedVersion === 0 ? current === undefined : current?.version === w.payoutAccount.expectedVersion;
        if (!ok) throw new WriteRejected();
      }
      const change = w.payoutAccountChange;
      if (change && this.payoutAccountChanges.some((c) => c.reauthJti === change.reauthJti)) throw new WriteRejected();
      const retried: PayoutRecord[] = [];
      const audits: PayoutRetryAuditRecord[] = [];
      for (const r of w.retries ?? []) {
        const old = get(r.oldPayoutId);
        const all = () => [...new Map([...this.payouts, ...working]).values()];
        if (!old || old.status !== 'FAILED' || all().some((p) => p.retryOfPayoutId === old.payoutId)) throw new WriteRejected();
        const seq = Math.max(0, ...all().filter((p) => p.statementId === old.statementId).map((p) => p.seq)) + 1;
        const next: PayoutRecord = {
          ...old,
          payoutId: r.newPayoutId,
          seq,
          refPayoutId: `${old.statementId}-${seq}`,
          pgPayoutId: null,
          status: 'REQUESTED',
          errorCode: null,
          pgTransferId: null,
          transferCheck: null,
          transferCheckedAt: null,
          payoutDate: r.payoutDate,
          failureClass: null,
          retryOfPayoutId: old.payoutId,
          autoRetryCount: r.autoRetryCount,
          createdAt: r.at,
          updatedAt: r.at,
        };
        working.set(next.payoutId, next);
        retried.push(next);
        audits.push({ auditId: r.auditId, payoutId: old.payoutId, newPayoutId: next.payoutId, oldSeq: old.seq, newSeq: seq, actor: r.actor, reason: r.reason, createdAt: r.at });
      }
      const plan = this.#planTransitions(w.transitions ?? []);
      if (!plan) throw new WriteRejected();
      let batch: PayoutBatchRecord | undefined;
      if (w.batch) {
        const b = this.batches.get(w.batch.batchId);
        if (!b || (w.batch.expectStatus && !w.batch.expectStatus.includes(b.status))) throw new WriteRejected();
        batch = { ...b, ...w.batch.set };
      }
      for (const [id, p] of working) this.payouts.set(id, p);
      this.retryAudits.push(...audits);
      if (batch) this.batches.set(batch.batchId, batch);
      for (const c of w.caseRequests ?? []) if (!this.caseRequests.has(c.eventKey)) this.caseRequests.set(c.eventKey, { ...c } as StoredCaseRequest);
      for (const a of w.alertRequests ?? []) if (!this.alertRequests.has(a.eventKey)) this.alertRequests.set(a.eventKey, { ...a });
      if (w.portoneTransfer) this.portoneTransfers.set(w.portoneTransfer.transferId, { ...w.portoneTransfer });
      if (w.ledgerSync) this.ledgerSyncs.set(w.ledgerSync.name, { ...w.ledgerSync });
      if (w.portonePartner) this.portonePartners.set(w.portonePartner.promoterId, { ...w.portonePartner });
      if (w.payoutAccount) this.accounts.set(w.payoutAccount.record.promoterId, { ...w.payoutAccount.record });
      if (change) this.payoutAccountChanges.push({ ...change });
      this.#commitTransitions(plan);
      return { ok: true, retried };
    } catch (e) {
      if (e instanceof WriteRejected) return { ok: false, retried: [] };
      throw e;
    }
  }

  async writePayoutChanges(w: PayoutWrite): Promise<PayoutWriteResult> {
    return this.#applyWrite(w);
  }

  async applyPayoutFact(o: Parameters<SettlementStore['applyPayoutFact']>[0]): Promise<PayoutWriteResult | undefined> {
    const p = this.payouts.get(o.payoutId);
    if (!p || !o.from.includes(p.status)) return undefined;
    const updated: PayoutRecord = { ...p, status: o.set.status, errorCode: o.set.errorCode, failureClass: o.set.failureClass, updatedAt: o.set.updatedAt };
    const statement = this.statements.get(p.statementId);
    const batch = this.batches.get(p.batchId);
    if (!statement || !batch) return undefined;
    const withUpdated = (rows: PayoutRecord[]) => rows.map((r) => (r.payoutId === updated.payoutId ? updated : r)).sort((a, b) => a.seq - b.seq);
    const snapshot: PayoutFactSnapshot = {
      payout: updated,
      statement,
      statementPayouts: withUpdated([...this.payouts.values()].filter((r) => r.statementId === p.statementId)),
      batch,
      batchPayouts: withUpdated([...this.payouts.values()].filter((r) => r.batchId === p.batchId)),
    };
    const write = o.decide(snapshot);
    const result = this.#applyWrite(write, new Map([[updated.payoutId, updated]]));
    return result.ok ? result : undefined;
  }

  async insertStatement(record: StatementRecord, sources: readonly StatementSource[], notify?: StatementNotification): Promise<boolean> {
    const conflicts = [...this.statements.values()].some((s) => {
      if (s.statementId === record.statementId) return true;
      if (s.status === 'SUPERSEDED' || record.status === 'SUPERSEDED') return false;
      if (s.kind !== record.kind || s.promoterId !== record.promoterId || s.pg !== record.pg || s.pgStore !== record.pgStore) return false;
      if (record.kind === 'EVENT') return s.eventId === record.eventId;
      return s.periodStart === record.periodStart && s.periodEnd === record.periodEnd;
    });
    if (conflicts) return false;
    if (notify && record.status !== 'CALCULATED') throw new Error('계산한 정산서를 통지 상태로 바꾸지 못했다');
    const stored: StatementRecord = notify
      ? { ...record, status: 'NOTIFIED', disputeDueAt: notify.disputeDueAt, updatedAt: notify.audit.createdAt, adjustmentAmount: record.adjustmentAmount ?? 0, excludedPayments: [...record.excludedPayments] }
      : { ...record, adjustmentAmount: record.adjustmentAmount ?? 0, excludedPayments: [...record.excludedPayments] };
    this.statements.set(record.statementId, stored);
    this.sources.set(record.statementId, sources.map((s) => ({ ...s })));
    if (notify) {
      this.statementAudits.push(notify.audit);
      this.#emit([notify.event]);
    }
    return true;
  }

  async transitionStatement(t: StatementTransition): Promise<boolean> {
    return this.transitionStatements([t]);
  }

  async transitionStatements(ts: readonly StatementTransition[]): Promise<boolean> {
    // 모두 맞는지 먼저 본 뒤 한꺼번에 쓴다(Drizzle 트랜잭션의 롤백과 같은 답). 같은 정산서가 두 번 오면 앞 전이 뒤의 상태로 본다
    const plan = this.#planTransitions(ts);
    if (!plan) return false;
    this.#commitTransitions(plan);
    return true;
  }
  async findStatement(promoterId: string, statementId: string) {
    const s = this.statements.get(statementId);
    return s?.promoterId === promoterId ? s : undefined;
  }
  async findStatementById(statementId: string) {
    return this.statements.get(statementId);
  }
  async findEventStatement(promoterId: string, eventId: string, pg: Pg, pgStore: PgStore) {
    return [...this.statements.values()].find((s) => s.promoterId === promoterId && s.kind === 'EVENT' && s.eventId === eventId && s.pg === pg && s.pgStore === pgStore && s.status !== 'SUPERSEDED');
  }
  async listEvent(promoterId: string, eventId: string) {
    return [...this.statements.values()].filter((s) => s.promoterId === promoterId && s.eventId === eventId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async listProduct(promoterId: string, filter: StatementFilter): Promise<StatementPage> {
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    let rows = [...this.statements.values()]
      .filter((s) => s.promoterId === promoterId && s.kind === 'PRODUCT')
      .filter((s) => !filter.from || (s.periodStart !== null && s.periodStart >= filter.from))
      .filter((s) => !filter.to || (s.periodEnd !== null && s.periodEnd <= filter.to))
      .filter((s) => !filter.pgStore || s.pgStore === filter.pgStore)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.statementId.localeCompare(a.statementId));
    if (cursor) rows = rows.filter((s) => s.createdAt.getTime() < cursor.at || (s.createdAt.getTime() === cursor.at && s.statementId < cursor.id));
    const page = rows.slice(0, filter.limit + 1);
    const items = page.slice(0, filter.limit);
    return { items, nextCursor: page.length > filter.limit ? cursorOf(items[items.length - 1]!) : null };
  }
  async saveStatement(record: StatementRecord) {
    this.statements.set(record.statementId, { ...record, excludedPayments: [...record.excludedPayments] });
  }
  async hasEventStatementOfOther(promoterId: string, eventId: string) {
    return [...this.statements.values()].some((s) => s.kind === 'EVENT' && s.eventId === eventId && s.promoterId !== promoterId);
  }
  async listDisputes(statementId: string) {
    return [...this.disputes.values()].filter((d) => d.statementId === statementId).sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
  }
  async listDisputesAwaitingCase(limit: number) {
    return [...this.disputes.values()]
      .filter((d) => d.result === null && (d.caseRequestedAt ?? null) === null && (d.caseFailedAt ?? null) === null)
      .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime() || a.disputeId.localeCompare(b.disputeId))
      .slice(0, limit);
  }
  async markDisputeCaseRequested(disputeId: string, at: Date) {
    const d = this.disputes.get(disputeId);
    if (d && (d.caseRequestedAt ?? null) === null) this.disputes.set(disputeId, { ...d, caseRequestedAt: at });
  }
  async insertAdjustment(record: AdjustmentRecord): Promise<AdjustmentInsertResult> {
    const existing = this.adjustments.get(record.approvalId);
    if (existing) return { record: existing, created: false };
    if ([...this.adjustments.values()].some((a) => a.statementId === record.statementId && a.status === 'PENDING')) return 'pending';
    this.adjustments.set(record.approvalId, { ...record });
    return { record, created: true };
  }
  async findAdjustmentByApproval(approvalId: string) {
    return this.adjustments.get(approvalId);
  }
  async voidAdjustment(approvalId: string) {
    const a = this.adjustments.get(approvalId);
    if (!a || a.status !== 'PENDING') return false;
    this.adjustments.set(approvalId, { ...a, status: 'VOID' });
    return true;
  }
  async voidStalePendingAdjustments(before: Date, limit: number) {
    const stale = [...this.adjustments.values()]
      .filter((a) => a.status === 'PENDING' && a.requestedAt.getTime() < before.getTime())
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
      .slice(0, limit);
    for (const a of stale) this.adjustments.set(a.approvalId, { ...a, status: 'VOID' });
    return stale.length;
  }
  async insertPayoutBatch(record: PayoutBatchRecord) {
    this.batches.set(record.batchId, record);
  }
  async createPayoutBatchWithStatements(record: PayoutBatchRecord, statementIds: readonly string[]) {
    await this.createPayoutBatchAtomically({ batch: record, statementIds, statementUpdates: [], receivableUpdates: [], receivableMoves: [] });
  }
  async createPayoutBatchAtomically(input: PayoutBatchAtomicInput) {
    const { batch: record } = input;
    // 09시 PREPARED 묶음을 바꾸는 요청은 그 행이 아직 PREPARED일 때만(첫 조건, Drizzle은 트랜잭션 첫 문장, ADR-0369 결정 13)
    if (input.promotePrepared) {
      const current = this.batches.get(record.batchId);
      if (!current || current.status !== 'PREPARED') throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
    } else {
      const duplicate = [...this.batches.values()].some((b) => b.pg === record.pg && b.pgStore === record.pgStore && b.payoutDate === record.payoutDate && b.status !== 'COMPLETED' && b.status !== 'PARTIAL_FAILED');
      if (duplicate) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
    }
    for (const u of input.statementUpdates) {
      const s = this.statements.get(u.statementId);
      // 보류·상계는 출발 상태(기본 CONFIRMED)이고 묶음에 붙지 않은 정산서만 바꾼다(Drizzle 조건부 갱신과 같다)
      if (!s || !(u.from ?? ['CONFIRMED']).includes(s.status) || s.payoutBatchId !== null) throw new SettlementProblem('payout-batch-statement-conflict', 409, '정산서 상태가 다른 처리와 겹쳤습니다');
    }
    for (const u of input.receivableUpdates) {
      const r = this.receivables.get(u.receivableId);
      const moved = input.receivableMoves.filter((m) => m.receivableId === u.receivableId).reduce((sum, m) => sum + m.amount, 0);
      if (!r) throw new SettlementProblem('payout-batch-statement-conflict', 409, '미수금을 찾지 못했습니다');
      if (r.remaining !== u.remaining + moved) throw new SettlementProblem('payout-batch-statement-conflict', 409, '미수금 잔액이 다른 지급 묶음과 겹쳤습니다');
    }
    const updated = new Map(input.statementUpdates.map((u) => [u.statementId, u]));
    for (const id of input.statementIds) {
      const s = this.statements.get(id);
      const after = updated.get(id)?.status ?? s?.status;
      if (!s || after !== 'CONFIRMED' || s.payoutBatchId !== null) throw new SettlementProblem('payout-batch-statement-conflict', 409, '확정 정산서가 아닌 건이 지급 묶음에 섞였습니다');
    }
    for (const u of input.statementUpdates) {
      const s = this.statements.get(u.statementId)!;
      this.statements.set(u.statementId, { ...s, status: u.status, holdReason: u.holdReason, offsetAmount: u.offsetAmount, payoutAmount: u.payoutAmount, updatedAt: u.updatedAt });
      if (u.audits) this.statementAudits.push(...u.audits);
      if (u.events) this.#emit(u.events);
    }
    for (const u of input.receivableUpdates) {
      const r = this.receivables.get(u.receivableId)!;
      this.receivables.set(u.receivableId, { ...r, remaining: u.remaining, status: u.status, updatedAt: u.updatedAt });
    }
    this.receivableMoves.push(...input.receivableMoves);
    this.batches.set(record.batchId, record);
    // 묶을 때는 payout_batch_id만 채우고 상태는 CONFIRMED 그대로다(접수 때 T9로 SCHEDULED, ADR-0369 결정 14 ①)
    for (const id of input.statementIds) this.statements.set(id, { ...this.statements.get(id)!, payoutBatchId: record.batchId, updatedAt: record.updatedAt });
    this.#emit(input.events ?? []);
  }
  async releasePayoutBatch(batchId: string): Promise<boolean> {
    const batch = this.batches.get(batchId);
    if (!batch || (batch.status !== 'PENDING_APPROVAL' && batch.status !== 'APPROVED')) return false;
    if ([...this.payouts.values()].some((p) => p.batchId === batchId)) return false;
    // 묶음만 푼다. 정산서 상태는 그대로(CONFIRMED)다(ADR-0369 결정 14 ①)
    for (const s of this.statements.values()) if (s.payoutBatchId === batchId) this.statements.set(s.statementId, { ...s, payoutBatchId: null });
    this.batches.delete(batchId);
    return true;
  }
  async approvePayoutBatchAtomically(batch: PayoutBatchRecord, audit: PayoutBatchAuditRecord): Promise<boolean> {
    const current = this.batches.get(batch.batchId);
    if (!current || current.status !== 'PENDING_APPROVAL' || current.approvalId !== null) return false;
    if ([...this.batches.values()].some((b) => b.batchId !== batch.batchId && b.approvalId === batch.approvalId)) {
      throw new SettlementProblem('payout-approval-reused', 409, '다른 지급 묶음이 이미 쓴 승인 업무입니다');
    }
    this.batches.set(batch.batchId, batch);
    this.payoutBatchAudits.push(audit);
    return true;
  }
  async insertPayoutBatchAudit(audit: PayoutBatchAuditRecord) {
    this.payoutBatchAudits.push(audit);
  }
  async findPayoutBatch(batchId: string) {
    return this.batches.get(batchId);
  }
  async listPayoutBatches(filter: { pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; status?: readonly string[] | undefined; limit: number }) {
    return [...this.batches.values()]
      .filter((b) => !filter.pg || b.pg === filter.pg)
      .filter((b) => !filter.pgStore || b.pgStore === filter.pgStore)
      .filter((b) => !filter.payoutDate || b.payoutDate === filter.payoutDate)
      .filter((b) => !filter.status || filter.status.length === 0 || filter.status.includes(b.status))
      .sort((a, b) => b.payoutDate.localeCompare(a.payoutDate) || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit);
  }
  async savePayoutBatch(record: PayoutBatchRecord) {
    this.batches.set(record.batchId, record);
  }
  async listConfirmed(pg: Pg, pgStore: PgStore, payoutDate: string) {
    return [...this.statements.values()].filter((s) => s.status === 'CONFIRMED' && s.payoutBatchId === null && s.payoutAmount > 0 && s.pg === pg && s.pgStore === pgStore && s.payoutDate === payoutDate);
  }
  async listStatementsByBatch(batchId: string) {
    return [...this.statements.values()].filter((s) => s.payoutBatchId === batchId).sort((a, b) => a.promoterId.localeCompare(b.promoterId) || a.statementId.localeCompare(b.statementId));
  }
  async listDueConfirmation(now: Date, limit: number) {
    return [...this.statements.values()]
      .filter((s) => s.status === 'NOTIFIED' && s.disputeDueAt !== null && s.disputeDueAt.getTime() <= now.getTime())
      .sort((a, b) => a.disputeDueAt!.getTime() - b.disputeDueAt!.getTime() || a.statementId.localeCompare(b.statementId))
      .slice(0, limit);
  }
  async insertPayouts(records: readonly PayoutRecord[]) {
    for (const r of records) this.payouts.set(r.payoutId, r);
  }
  async listPayouts(batchId: string) {
    return [...this.payouts.values()].filter((p) => p.batchId === batchId).sort((a, b) => a.seq - b.seq);
  }
  async findPayout(payoutId: string) {
    return this.payouts.get(payoutId);
  }
  async savePayout(record: PayoutRecord) {
    this.payouts.set(record.payoutId, record);
  }
  async findPayoutByPgPayoutId(pgPayoutId: string) {
    return [...this.payouts.values()].find((p) => p.pgPayoutId === pgPayoutId);
  }
  async findKyc(promoterId: string) {
    return this.kycs.get(promoterId);
  }
  async saveKyc(record: KycRecord) {
    this.kycs.set(record.promoterId, record);
  }
  async findPayoutAccount(promoterId: string) {
    return this.accounts.get(promoterId);
  }
  async savePayoutAccount(record: PayoutAccountRecord) {
    this.accounts.set(record.promoterId, record);
  }
  async listStatements(filter: { kind?: 'EVENT' | 'PRODUCT' | undefined; status?: string | undefined; pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; limit: number }) {
    return [...this.statements.values()]
      .filter((s) => !filter.kind || s.kind === filter.kind)
      .filter((s) => !filter.status || s.status === filter.status)
      .filter((s) => !filter.pg || s.pg === filter.pg)
      .filter((s) => !filter.pgStore || s.pgStore === filter.pgStore)
      .filter((s) => !filter.payoutDate || s.payoutDate === filter.payoutDate)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.statementId.localeCompare(a.statementId))
      .slice(0, filter.limit);
  }
  async listHeldStatements(pg: Pg, pgStore: PgStore, payoutDate: string) {
    return [...this.statements.values()]
      .filter((s) => s.status === 'HELD' && s.pg === pg && s.pgStore === pgStore && s.payoutDate === payoutDate)
      .sort((a, b) => a.promoterId.localeCompare(b.promoterId) || a.statementId.localeCompare(b.statementId));
  }
  async sumScheduledTossPayouts(promoterId: string, from: string, to: string) {
    return [...this.statements.values()]
      .filter((s) => s.promoterId === promoterId && s.pg === 'TOSS' && s.payoutDate !== null && s.payoutDate >= from && s.payoutDate <= to)
      .filter((s) => s.status === 'NOTIFIED' || s.status === 'CONFIRMED' || s.status === 'SCHEDULED' || s.status === 'HELD')
      .reduce((sum, s) => sum + s.payoutAmount, 0);
  }
  async findProductStatement(promoterId: string, pg: Pg, pgStore: PgStore, periodStart: string, periodEnd: string) {
    return [...this.statements.values()].find((s) => s.promoterId === promoterId && s.kind === 'PRODUCT' && s.pg === pg && s.pgStore === pgStore && s.periodStart === periodStart && s.periodEnd === periodEnd && s.status !== 'SUPERSEDED');
  }
  async insertReceivable(record: ReceivableRecord) {
    this.receivables.set(record.receivableId, record);
  }
  async insertReceivableIfAbsent(record: ReceivableRecord) {
    if (record.sourceRef && [...this.receivables.values()].some((r) => r.sourceRef === record.sourceRef)) return false;
    this.receivables.set(record.receivableId, record);
    return true;
  }
  async findReceivableBySourceRef(sourceRef: string) {
    return [...this.receivables.values()].find((r) => r.sourceRef === sourceRef);
  }
  async saveReceivable(record: ReceivableRecord) {
    this.receivables.set(record.receivableId, record);
  }
  async listReceivables(filter: { promoterId?: string | undefined; pg?: Pg | undefined; status?: readonly ReceivableRecord['status'][] | undefined; limit: number }) {
    return [...this.receivables.values()]
      .filter((r) => !filter.promoterId || r.promoterId === filter.promoterId)
      .filter((r) => !filter.pg || r.pg === filter.pg)
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, filter.limit);
  }
  async listOpenReceivables(promoterId: string, pg: Pg) {
    return [...this.receivables.values()]
      .filter((r) => r.promoterId === promoterId && (r.pg === pg || r.cause === 'COMPENSATION_ADVANCE') && r.status === 'OPEN' && r.remaining > 0)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async insertReceivableMove(record: ReceivableMoveRecord) {
    this.receivableMoves.push(record);
  }
  async listReceivableMoves(statementId: string) {
    return this.receivableMoves.filter((m) => m.statementId === statementId);
  }
  async findReceivable(receivableId: string) {
    return this.receivables.get(receivableId);
  }
  async listReceivableMovesForReceivable(receivableId: string) {
    return this.receivableMoves.filter((m) => m.receivableId === receivableId);
  }
  async findGuaranteeCollection(idempotencyKey: string) {
    return this.guaranteeCollections.get(idempotencyKey);
  }
  async hasWebhookEvent(eventId: string) {
    return this.webhookEvents.has(eventId);
  }
  async recordWebhookEvent(o: { eventId: string; transmissionId: string; receivedAt: Date }) {
    this.webhookEvents.add(o.eventId);
  }
  // ---- 토스 지급대행(payment 0029) ----
  async findTossSeller(promoterId: string, pgStore: PgStore) {
    return this.tossSellers.get(`${promoterId}:${pgStore}`);
  }
  async findTossSellerById(tossSellerId: string) {
    return [...this.tossSellers.values()].find((s) => s.tossSellerId === tossSellerId);
  }
  async saveTossSeller(record: TossSellerRecord) {
    const clash = [...this.tossSellers.values()].find((s) => (s.tossSellerId === record.tossSellerId || s.refSellerId === record.refSellerId) && !(s.promoterId === record.promoterId && s.pgStore === record.pgStore));
    if (clash) throw new Error('toss_seller 유일 칸(셀러 ID·참조 ID)이 다른 행과 겹친다');
    this.tossSellers.set(`${record.promoterId}:${record.pgStore}`, { ...record });
  }
  async countTossSellers(status: TossSellerStatus) {
    return [...this.tossSellers.values()].filter((s) => s.status === status).length;
  }
  async listHeldStatementsOf(promoterId: string, pg: Pg, pgStore: PgStore) {
    return [...this.statements.values()]
      .filter((s) => s.status === 'HELD' && s.promoterId === promoterId && s.pg === pg && s.pgStore === pgStore)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.statementId.localeCompare(b.statementId));
  }
  async listUnretriedFailedPayouts(o: { promoterId: string; pgStore: PgStore; failureClass: NonNullable<PayoutRecord['failureClass']> }) {
    const all = [...this.payouts.values()];
    return all
      .filter((p) => p.status === 'FAILED' && p.failureClass === o.failureClass && !all.some((q) => q.retryOfPayoutId === p.payoutId))
      .filter((p) => {
        const s = this.statements.get(p.statementId);
        return s?.promoterId === o.promoterId && s.pg === 'TOSS' && s.pgStore === o.pgStore;
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq);
  }
  async insertCaseRequests(records: readonly SettlementCaseRequestRecord[]) {
    let inserted = 0;
    for (const c of records) {
      if (this.caseRequests.has(c.eventKey)) continue;
      this.caseRequests.set(c.eventKey, { ...c } as StoredCaseRequest);
      inserted += 1;
    }
    return inserted;
  }
  async listUnsentCaseRequests(limit: number) {
    return [...this.caseRequests.values()]
      .filter((c) => c.requestedAt === null && (c.failedAt ?? null) === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.eventKey.localeCompare(b.eventKey))
      .slice(0, limit);
  }
  async markCaseRequestSent(eventKey: string, at: Date) {
    const c = this.caseRequests.get(eventKey);
    if (c && c.requestedAt === null) this.caseRequests.set(eventKey, { ...c, requestedAt: at });
  }
  async insertPgBalanceReconciliation(record: PgBalanceReconciliationRecord, caseRequest?: SettlementCaseRequestRecord) {
    const clash = this.pgBalanceReconciliations.some((r) =>
      record.kind === 'MONTHLY' ? r.kind === 'MONTHLY' && r.pg === record.pg && r.pgStore === record.pgStore && r.periodMonth === record.periodMonth : r.kind === 'BATCH' && r.batchId === record.batchId,
    );
    if (clash) return false;
    this.pgBalanceReconciliations.push({ ...record });
    if (caseRequest && !this.caseRequests.has(caseRequest.eventKey)) this.caseRequests.set(caseRequest.eventKey, { ...caseRequest } as StoredCaseRequest);
    return true;
  }
  async lastPgBalanceReconciliation(pg: Pg, pgStore: PgStore) {
    return this.pgBalanceReconciliations
      .filter((r) => r.pg === pg && r.pgStore === pgStore)
      .sort((a, b) => b.cutoffAt.getTime() - a.cutoffAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime())[0];
  }
  async listBatchesAwaitingReconciliation(since: Date, limit: number) {
    return [...this.batches.values()]
      .filter((b) => b.pg === 'TOSS' && b.createdAt.getTime() >= since.getTime() && !this.pgBalanceReconciliations.some((r) => r.kind === 'BATCH' && r.batchId === b.batchId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }
  async sumUnfinishedTossPayouts(pgStore: PgStore, excludeBatchId?: string) {
    return [...this.payouts.values()]
      .filter((p) => UNFINISHED.includes(p.status) && p.batchId !== excludeBatchId)
      .filter((p) => {
        const b = this.batches.get(p.batchId);
        return b?.pg === 'TOSS' && b.pgStore === pgStore;
      })
      .reduce((sum, p) => sum + p.amount, 0);
  }
  async claimBatchSubmit(batchId: string, expectedNextSubmitAt: Date | null, next: Date | null) {
    const b = this.batches.get(batchId);
    if (!b || (b.nextSubmitAt?.getTime() ?? null) !== (expectedNextSubmitAt?.getTime() ?? null)) return false;
    this.batches.set(batchId, { ...b, nextSubmitAt: next });
    return true;
  }
  async listDueSubmitBatches(now: Date, limit: number) {
    return [...this.batches.values()]
      .filter((b) => b.pg === 'TOSS' && LIVE_SUBMIT_STATUSES.includes(b.status) && b.nextSubmitAt !== null && b.nextSubmitAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextSubmitAt!.getTime() - b.nextSubmitAt!.getTime() || a.batchId.localeCompare(b.batchId))
      .slice(0, limit);
  }
  async listOverduePayouts(now: Date, limit: number) {
    return [...this.payouts.values()]
      .filter((p) => UNFINISHED.includes(p.status) && p.pgPayoutId !== null && this.batches.get(p.batchId)?.pg === 'TOSS')
      .filter((p) => Date.parse(`${nextBankBusinessDay(p.payoutDate)}T12:00:00+09:00`) <= now.getTime())
      .sort((a, b) => a.payoutDate.localeCompare(b.payoutDate) || a.payoutId.localeCompare(b.payoutId))
      .slice(0, limit);
  }
  async collectGuaranteeAtomically(input: GuaranteeCollectionAtomicInput) {
    if (this.guaranteeCollections.has(input.collection.idempotencyKey)) return;
    const r = this.receivables.get(input.collection.receivableId);
    if (!r) throw new SettlementProblem('guarantee-not-open', 409, '열린 미수금이 아닙니다');
    if (r.remaining !== input.receivable.remaining + input.move.amount) throw new SettlementProblem('guarantee-conflict', 409, '미수금 잔액이 다른 처리와 겹쳤습니다');
    this.guaranteeCollections.set(input.collection.idempotencyKey, input.collection);
    this.receivableMoves.push({ ...input.move, kind: 'GUARANTEE' });
    this.receivables.set(r.receivableId, { ...r, remaining: input.receivable.remaining, status: input.receivable.status, updatedAt: input.receivable.updatedAt });
  }

  // ---- F-07-7 포트원 지급대행·계좌 변경·사후 대사(payment 0030·0032) ----
  async findPortonePartner(promoterId: string) {
    return this.portonePartners.get(promoterId);
  }
  async savePortonePartner(record: PortonePartnerRecord) {
    this.portonePartners.set(record.promoterId, { ...record });
  }
  async listPortonePartners(limit: number) {
    return [...this.portonePartners.values()].sort((a, b) => a.promoterId.localeCompare(b.promoterId)).slice(0, limit);
  }
  async insertPayoutAccountChange(record: PayoutAccountChangeRecord) {
    if (this.payoutAccountChanges.some((c) => c.reauthJti === record.reauthJti)) return false;
    this.payoutAccountChanges.push({ ...record });
    return true;
  }
  async listUnsentPayoutAccountChanges(limit: number) {
    return this.payoutAccountChanges
      .filter((c) => c.auditSentAt === null && (c.auditFailedAt ?? null) === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }
  async markPayoutAccountChangeSent(id: string, at: Date) {
    const i = this.payoutAccountChanges.findIndex((c) => c.id === id);
    const c = this.payoutAccountChanges[i];
    if (c && c.auditSentAt === null) this.payoutAccountChanges[i] = { ...c, auditSentAt: at };
  }
  async countAgencySyncPending() {
    return [...this.accounts.values()].filter((a) => a.agencySyncPending === true).length;
  }
  async findLedgerSync(name: PortoneLedgerSyncName) {
    return this.ledgerSyncs.get(name);
  }
  async saveLedgerSync(record: PortoneLedgerSyncRecord) {
    this.ledgerSyncs.set(record.name, { ...record });
  }
  async insertAlertRequests(records: readonly SettlementAlertRequestRecord[]) {
    let inserted = 0;
    for (const a of records) {
      if (this.alertRequests.has(a.eventKey)) continue;
      this.alertRequests.set(a.eventKey, { ...a });
      inserted += 1;
    }
    return inserted;
  }
  async listUnsentAlertRequests(limit: number) {
    return [...this.alertRequests.values()]
      .filter((a) => a.requestedAt === null && (a.failedAt ?? null) === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.eventKey.localeCompare(b.eventKey))
      .slice(0, limit);
  }
  async markAlertRequestSent(eventKey: string, at: Date) {
    const a = this.alertRequests.get(eventKey);
    if (a && a.requestedAt === null) this.alertRequests.set(eventKey, { ...a, requestedAt: at });
  }
  async findAlertRequest(eventKey: string) {
    return this.alertRequests.get(eventKey);
  }
  async findCaseRequest(eventKey: string) {
    return this.caseRequests.get(eventKey);
  }
  /** 읽은 거절 수에서 하나 올린다(메모리는 await 없이 한 번에 바꾸므로 겹친 호출이 두 번 세지 않는다) */
  async markRefused(row: OpsIntakeRow, key: string, refusal: OpsRefusal, at: Date, limit: number) {
    const bump = (count: number | undefined) => {
      const refusedCount = (count ?? 0) + 1;
      return { refusedCount, failed: refusedCount >= limit };
    };
    if (row === 'case-request') {
      const r = this.caseRequests.get(key);
      if (!r || r.requestedAt !== null || (r.failedAt ?? null) !== null) return undefined;
      const out = bump(r.refusedCount);
      this.caseRequests.set(key, { ...r, refusedCount: out.refusedCount, lastRefusal: refusal, failedAt: out.failed ? at : null });
      return out;
    }
    if (row === 'alert-request') {
      const r = this.alertRequests.get(key);
      if (!r || r.requestedAt !== null || (r.failedAt ?? null) !== null) return undefined;
      const out = bump(r.refusedCount);
      this.alertRequests.set(key, { ...r, refusedCount: out.refusedCount, lastRefusal: refusal, failedAt: out.failed ? at : null });
      return out;
    }
    if (row === 'payout-account-change') {
      const i = this.payoutAccountChanges.findIndex((c) => c.id === key);
      const r = this.payoutAccountChanges[i];
      if (!r || r.auditSentAt !== null || (r.auditFailedAt ?? null) !== null) return undefined;
      const out = bump(r.auditRefusedCount);
      this.payoutAccountChanges[i] = { ...r, auditRefusedCount: out.refusedCount, auditFailedAt: out.failed ? at : null };
      return out;
    }
    const d = this.disputes.get(key);
    if (!d || (d.caseRequestedAt ?? null) !== null || (d.caseFailedAt ?? null) !== null) return undefined;
    const out = bump(d.caseRefusedCount);
    this.disputes.set(key, { ...d, caseRefusedCount: out.refusedCount, caseFailedAt: out.failed ? at : null });
    return out;
  }
  async countIntakeFailed(row: OpsIntakeRow) {
    if (row === 'case-request') return [...this.caseRequests.values()].filter((r) => (r.failedAt ?? null) !== null).length;
    if (row === 'alert-request') return [...this.alertRequests.values()].filter((r) => (r.failedAt ?? null) !== null).length;
    if (row === 'payout-account-change') return this.payoutAccountChanges.filter((r) => (r.auditFailedAt ?? null) !== null).length;
    return [...this.disputes.values()].filter((d) => (d.caseFailedAt ?? null) !== null).length;
  }
  async listPortonePayoutsForTransferCheck(limit: number) {
    return [...this.payouts.values()]
      .filter((p) => (p.status === 'COMPLETED' || p.status === 'IN_PROGRESS') && p.transferCheck === null && this.batches.get(p.batchId)?.pg === 'PORTONE')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.payoutId.localeCompare(b.payoutId))
      .slice(0, limit);
  }
  async listStatementsOfPromoter(promoterId: string, pg: Pg, statuses: readonly StatementStatus[]) {
    return [...this.statements.values()]
      .filter((s) => s.promoterId === promoterId && s.pg === pg && statuses.includes(s.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.statementId.localeCompare(b.statementId));
  }
}
