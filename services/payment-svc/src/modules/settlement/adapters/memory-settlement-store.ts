// 정산 메모리 저장소(단위 시험·개발). Drizzle과 같은 포트·같은 의미(조건부 전이, 한 번에 쓰거나 하나도 쓰지 않음)를 쓴다.
// trade.settlements Outbox 대신 outbox 배열에 사건 값을 남긴다(Drizzle은 같은 트랜잭션의 Outbox 표).
import type { AdjustmentInsertResult, GuaranteeCollectionAtomicInput, PayoutBatchAtomicInput, StatementFilter, StatementNotification, StatementPage, SettlementStore, StatementTransition } from '../domain/ports.js';
import type { AdjustmentRecord } from '../domain/adjustment.js';
import {
  SettlementProblem,
  TRADE_SETTLEMENTS_TOPIC,
  type DisputeRecord,
  type GuaranteeCollectionRecord,
  type KycRecord,
  type PayoutAccountRecord,
  type PayoutBatchAuditRecord,
  type PayoutBatchRecord,
  type PayoutRecord,
  type Pg,
  type PgStore,
  type ReceivableMoveRecord,
  type ReceivableRecord,
  type SettlementEventValue,
  type StatementAuditRecord,
  type StatementRecord,
  type StatementSource,
} from '../domain/settlement.js';

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
  readonly webhookReceipts = new Set<string>();
  readonly adjustments = new Map<string, AdjustmentRecord>();
  /** trade.settlements에 쓴 사건(Outbox 대역). topic·key·value */
  readonly outbox: { topic: string; key: string; value: SettlementEventValue }[] = [];

  #emit(events: readonly SettlementEventValue[]): void {
    for (const e of events) this.outbox.push({ topic: TRADE_SETTLEMENTS_TOPIC, key: e.promoterId, value: e });
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
    const statements = new Map<string, StatementRecord>();
    const disputes = new Map<string, DisputeRecord>();
    const adjustments = new Map<string, AdjustmentRecord>();
    const receivables: ReceivableRecord[] = [];
    const audits: StatementAuditRecord[] = [];
    const events: SettlementEventValue[] = [];
    for (const t of ts) {
      const s = statements.get(t.statementId) ?? this.statements.get(t.statementId);
      if (!s || !t.from.includes(s.status)) return false;
      const e = t.expect;
      if (e?.disputeDueAfter && !(s.disputeDueAt !== null && s.disputeDueAt.getTime() > e.disputeDueAfter.getTime())) return false;
      if (e?.disputeDueAtOrBefore && !(s.disputeDueAt !== null && s.disputeDueAt.getTime() <= e.disputeDueAtOrBefore.getTime())) return false;
      if (e?.adjustmentAmount !== undefined && (s.adjustmentAmount ?? 0) !== e.adjustmentAmount) return false;
      if (e?.offsetAmount !== undefined && s.offsetAmount !== e.offsetAmount) return false;
      if (e?.unbatched && s.payoutBatchId !== null) return false;
      const next: StatementRecord = { ...s, status: t.to, updatedAt: t.updatedAt };
      if (t.set?.holdReason !== undefined) next.holdReason = t.set.holdReason;
      if (t.set?.disputeDueAt !== undefined) next.disputeDueAt = t.set.disputeDueAt;
      if (t.set?.adjustmentAmount !== undefined) next.adjustmentAmount = t.set.adjustmentAmount;
      if (t.set?.payoutAmount !== undefined) next.payoutAmount = t.set.payoutAmount;
      if (t.set?.offsetAmount !== undefined) next.offsetAmount = t.set.offsetAmount;
      statements.set(t.statementId, next);
      if (t.insertDispute) disputes.set(t.insertDispute.disputeId, { ...t.insertDispute, result: null, resolvedAt: null });
      if (t.resolveDispute) {
        const r = t.resolveDispute;
        const d = disputes.get(r.disputeId) ?? this.disputes.get(r.disputeId);
        if (!d || d.statementId !== t.statementId || d.result !== null) return false;
        disputes.set(r.disputeId, { ...d, result: r.result, resolvedAt: r.resolvedAt, resolvedBy: r.resolvedBy, resolutionNote: r.resolutionNote });
      }
      if (t.applyAdjustment) {
        const a = adjustments.get(t.applyAdjustment.approvalId) ?? this.adjustments.get(t.applyAdjustment.approvalId);
        if (!a || a.statementId !== t.statementId || a.status !== 'PENDING') return false;
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
    for (const [id, s] of statements) this.statements.set(id, s);
    for (const [id, d] of disputes) this.disputes.set(id, d);
    for (const [id, a] of adjustments) this.adjustments.set(id, a);
    for (const r of receivables) this.receivables.set(r.receivableId, r);
    this.statementAudits.push(...audits);
    this.#emit(events);
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
      .filter((d) => d.result === null && (d.caseRequestedAt ?? null) === null)
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
    const duplicate = [...this.batches.values()].some((b) => b.pg === record.pg && b.pgStore === record.pgStore && b.payoutDate === record.payoutDate && b.status !== 'COMPLETED' && b.status !== 'PARTIAL_FAILED');
    if (duplicate) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
    const bound: StatementRecord[] = [];
    for (const id of statementIds) {
      const s = this.statements.get(id);
      if (!s || s.status !== 'CONFIRMED' || s.payoutBatchId !== null) throw new SettlementProblem('payout-batch-statement-conflict', 409, '확정 정산서가 아닌 건이 지급 묶음에 섞였습니다');
      bound.push(s);
    }
    this.batches.set(record.batchId, record);
    for (const s of bound) this.statements.set(s.statementId, { ...s, status: 'SCHEDULED', payoutBatchId: record.batchId, updatedAt: record.updatedAt });
  }
  async createPayoutBatchAtomically(input: PayoutBatchAtomicInput) {
    const { batch: record } = input;
    const duplicate = [...this.batches.values()].some((b) => b.pg === record.pg && b.pgStore === record.pgStore && b.payoutDate === record.payoutDate && b.status !== 'COMPLETED' && b.status !== 'PARTIAL_FAILED');
    if (duplicate) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
    for (const u of input.statementUpdates) {
      const s = this.statements.get(u.statementId);
      // 보류·상계는 출발 상태(기본 CONFIRMED)이고 묶음에 붙지 않은 정산서만 바꾼다(Drizzle 조건부 갱신과 같다)
      if (!s || !(u.from ?? ['CONFIRMED']).includes(s.status) || s.payoutBatchId !== null) throw new SettlementProblem('payout-batch-statement-conflict', 409, '정산서 상태가 다른 처리와 겹쳤습니다');
    }
    for (const u of input.receivableUpdates) if (!this.receivables.has(u.receivableId)) throw new SettlementProblem('payout-batch-statement-conflict', 409, '미수금을 찾지 못했습니다');
    const bound: StatementRecord[] = [];
    for (const id of input.statementIds) {
      const s = this.statements.get(id);
      if (!s || s.status !== 'CONFIRMED' || s.payoutBatchId !== null) throw new SettlementProblem('payout-batch-statement-conflict', 409, '확정 정산서가 아닌 건이 지급 묶음에 섞였습니다');
      bound.push(s);
    }
    for (const u of input.statementUpdates) {
      const s = this.statements.get(u.statementId)!;
      this.statements.set(u.statementId, { ...s, status: u.status, holdReason: u.holdReason, offsetAmount: u.offsetAmount, payoutAmount: u.payoutAmount, updatedAt: u.updatedAt });
      if (u.audits) this.statementAudits.push(...u.audits);
      if (u.events) this.#emit(u.events);
    }
    for (const u of input.receivableUpdates) {
      const r = this.receivables.get(u.receivableId)!;
      const moved = input.receivableMoves.filter((m) => m.receivableId === u.receivableId).reduce((sum, m) => sum + m.amount, 0);
      if (r.remaining !== u.remaining + moved) throw new SettlementProblem('payout-batch-statement-conflict', 409, '미수금 잔액이 다른 지급 묶음과 겹쳤습니다');
      this.receivables.set(u.receivableId, { ...r, remaining: u.remaining, status: u.status, updatedAt: u.updatedAt });
    }
    this.receivableMoves.push(...input.receivableMoves);
    this.batches.set(record.batchId, record);
    for (const s of bound) this.statements.set(s.statementId, { ...this.statements.get(s.statementId)!, status: 'SCHEDULED', payoutBatchId: record.batchId, updatedAt: record.updatedAt });
  }
  async releasePayoutBatch(batchId: string): Promise<boolean> {
    const batch = this.batches.get(batchId);
    if (!batch || (batch.status !== 'PENDING_APPROVAL' && batch.status !== 'APPROVED')) return false;
    if ([...this.payouts.values()].some((p) => p.batchId === batchId)) return false;
    for (const s of this.statements.values()) if (s.payoutBatchId === batchId) this.statements.set(s.statementId, { ...s, payoutBatchId: null, status: 'CONFIRMED' });
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
  async findKycByTossSellerId(tossSellerId: string) {
    return [...this.kycs.values()].find((k) => k.tossSellerId === tossSellerId);
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
  async hasSettlementWebhookReceipt(transmissionId: string) {
    return this.webhookReceipts.has(transmissionId);
  }
  async recordSettlementWebhookReceipt(transmissionId: string) {
    this.webhookReceipts.add(transmissionId);
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
}
