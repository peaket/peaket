// 승인 업무 Drizzle 저장소(ops DB, BAT-615 LCH-070, ADR-0320).
// 승인 상태·계약 변경 값·투표·감사를 같은 트랜잭션에 쓴다. 버전 조건부 갱신으로 동시 승인을 한 번만 반영한다.
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import { appendAuditIn, type AuditRecord } from '../../../audit/audit.js';
import type { ApprovalVote, ContractApprovalStore, SettlementAdjustmentApprovalStore } from '../../domain/ports.js';
import type { ContractApprovalRecord, ContractApprovalStatus, ContractTermsSnapshot, GuaranteeKind, SettlementAdjustmentApprovalRecord, SettlementAdjustmentApprovalStatus } from '../../domain/approval.js';
import { approvalRequest, approvalVote, promoterContractChange } from './schema.js';

const pgCode = (e: unknown): string | undefined => {
  const any = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const c = any?.code ?? any?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  targetRef: string;
  reasonText: string;
  requestedBy: string;
  status: string;
  closeReason: string | null;
  approverId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  promoterId: string;
  currentCommissionRateBp: number;
  currentGuaranteeRateBp: number;
  currentGuaranteeKind: string;
  currentValidFrom: Date;
  requestedCommissionRateBp: number | null;
  requestedGuaranteeRateBp: number | null;
  requestedGuaranteeKind: string | null;
  requesterRole: string;
};

const record = (r: Row): ContractApprovalRecord => {
  const current: ContractTermsSnapshot = {
    commissionRateBp: r.currentCommissionRateBp,
    guaranteeRateBp: r.currentGuaranteeRateBp,
    guaranteeKind: r.currentGuaranteeKind as GuaranteeKind,
    validFrom: r.currentValidFrom.toISOString(),
  };
  return {
    approvalId: r.id,
    promoterId: r.promoterId,
    current,
    requestedCommissionRateBp: r.requestedCommissionRateBp,
    requestedGuaranteeRateBp: r.requestedGuaranteeRateBp,
    requestedGuaranteeKind: r.requestedGuaranteeKind as GuaranteeKind | null,
    requestedBy: r.requestedBy,
    requesterRole: r.requesterRole,
    reasonText: r.reasonText,
    status: r.status as ContractApprovalStatus,
    closeReason: r.closeReason,
    approverId: r.approverId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    approvedAt: r.status === 'DONE' || r.status === 'REJECTED' ? r.updatedAt : null,
    version: r.version,
  };
};

export class DrizzleContractApprovalStore implements ContractApprovalStore {
  constructor(private readonly db: Database) {}

  #select() {
    return this.db.db
      .select({
        id: approvalRequest.id,
        targetRef: approvalRequest.targetRef,
        reasonText: approvalRequest.reasonText,
        requestedBy: approvalRequest.requestedBy,
        requesterRole: approvalRequest.requesterRole,
        status: approvalRequest.status,
        closeReason: approvalRequest.closeReason,
        approverId: approvalRequest.approverId,
        createdAt: approvalRequest.createdAt,
        updatedAt: approvalRequest.updatedAt,
        version: approvalRequest.version,
        promoterId: promoterContractChange.promoterId,
        currentCommissionRateBp: promoterContractChange.currentCommissionRateBp,
        currentGuaranteeRateBp: promoterContractChange.currentGuaranteeRateBp,
        currentGuaranteeKind: promoterContractChange.currentGuaranteeKind,
        currentValidFrom: promoterContractChange.currentValidFrom,
        requestedCommissionRateBp: promoterContractChange.requestedCommissionRateBp,
        requestedGuaranteeRateBp: promoterContractChange.requestedGuaranteeRateBp,
        requestedGuaranteeKind: promoterContractChange.requestedGuaranteeKind,
      })
      .from(approvalRequest)
      .innerJoin(promoterContractChange, eq(promoterContractChange.approvalId, approvalRequest.id));
  }

  async insert(r: ContractApprovalRecord, audit?: AuditRecord): Promise<{ record: ContractApprovalRecord; created: boolean } | 'conflict'> {
    try {
      return await this.db.transaction(async (tx) => {
        const [existing] = await tx.select({ id: approvalRequest.id }).from(approvalRequest).where(eq(approvalRequest.id, r.approvalId));
        if (existing) {
          const found = await this.find(r.approvalId);
          return { record: found ?? r, created: false };
        }
        const open = await tx
          .select({ id: approvalRequest.id })
          .from(approvalRequest)
          .where(and(eq(approvalRequest.kind, 'CONTRACT_TERMS_CHANGE'), eq(approvalRequest.targetRef, r.promoterId), inArray(approvalRequest.status, ['PENDING_APPROVAL', 'EXECUTING', 'FAILED'])))
          .limit(1);
        if (open[0] && open[0].id !== r.approvalId) return 'conflict' as const;
        await tx.insert(approvalRequest).values({
          id: r.approvalId,
          kind: 'CONTRACT_TERMS_CHANGE',
          targetRef: r.promoterId,
          reasonCode: 'CONTRACT_TERMS_CHANGE',
          reasonText: r.reasonText,
          requestedBy: r.requestedBy,
          requesterRole: r.requesterRole,
          requiredApprovals: 2,
          status: r.status,
          approverId: r.approverId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          version: r.version,
        });
        await tx.insert(promoterContractChange).values({
          approvalId: r.approvalId,
          promoterId: r.promoterId,
          currentCommissionRateBp: r.current.commissionRateBp,
          currentGuaranteeRateBp: r.current.guaranteeRateBp,
          currentGuaranteeKind: r.current.guaranteeKind,
          currentValidFrom: new Date(r.current.validFrom),
          requestedCommissionRateBp: r.requestedCommissionRateBp,
          requestedGuaranteeRateBp: r.requestedGuaranteeRateBp,
          requestedGuaranteeKind: r.requestedGuaranteeKind,
          reasonText: r.reasonText,
          createdAt: r.createdAt,
        });
        if (audit) await appendAuditIn(tx, audit);
        return { record: r, created: true };
      });
    } catch (e) {
      if (pgCode(e) === '23505') {
        const found = await this.find(r.approvalId);
        if (found) return { record: found, created: false };
        return 'conflict';
      }
      throw e;
    }
  }

  async find(approvalId: string): Promise<ContractApprovalRecord | undefined> {
    if (!UUID.test(approvalId)) return undefined;
    const rows = await this.#select().where(eq(approvalRequest.id, approvalId)).limit(1);
    return rows[0] ? record(rows[0] as Row) : undefined;
  }

  async findOpenByPromoter(promoterId: string): Promise<ContractApprovalRecord | undefined> {
    if (!UUID.test(promoterId)) return undefined;
    const rows = await this.#select()
      .where(and(eq(approvalRequest.kind, 'CONTRACT_TERMS_CHANGE'), eq(approvalRequest.targetRef, promoterId), inArray(approvalRequest.status, ['PENDING_APPROVAL', 'EXECUTING', 'FAILED'])))
      .limit(1);
    return rows[0] ? record(rows[0] as Row) : undefined;
  }

  async save(r: ContractApprovalRecord, audit?: AuditRecord, vote?: ApprovalVote): Promise<boolean> {
    if (!UUID.test(r.approvalId)) return false;
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(approvalRequest)
        .set({ status: r.status, closeReason: r.closeReason, approverId: r.approverId, updatedAt: r.updatedAt, version: r.version })
        .where(and(eq(approvalRequest.id, r.approvalId), eq(approvalRequest.version, r.version - 1)))
        .returning({ id: approvalRequest.id });
      if (updated.length === 0) return false;
      if (vote) {
        await tx
          .insert(approvalVote)
          .values({ requestId: vote.approvalId, approverId: vote.approverId, requesterId: vote.requesterId, approvedAt: vote.approvedAt, reason: vote.reason })
          .onConflictDoNothing();
      }
      if (audit) await appendAuditIn(tx, audit);
      return true;
    });
  }

  async list(filter: { status?: readonly string[] | undefined; requesterId?: string | undefined; awaitingApprover?: string | undefined; limit: number }): Promise<ContractApprovalRecord[]> {
    const conditions = [];
    if (filter.status && filter.status.length > 0) conditions.push(inArray(approvalRequest.status, [...filter.status]));
    if (filter.requesterId) conditions.push(eq(approvalRequest.requestedBy, filter.requesterId));
    if (filter.awaitingApprover) {
      conditions.push(inArray(approvalRequest.status, ['PENDING_APPROVAL', 'FAILED']));
      conditions.push(ne(approvalRequest.requestedBy, filter.awaitingApprover));
    }
    const rows = await this.#select()
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(approvalRequest.createdAt))
      .limit(filter.limit);
    return (rows as Row[]).map(record);
  }
}

/**
 * 정산서 수기 조정 승인 업무(F-07-5, ADR-0368 결정 7). 공통 승인 표 approval_request(kind SETTLEMENT_ADJUSTMENT)와 approval_vote만 쓴다.
 * 상태는 버전 조건부로 바꾸고, 투표·감사를 같은 트랜잭션에 쓴다.
 */
export class DrizzleSettlementAdjustmentApprovalStore implements SettlementAdjustmentApprovalStore {
  constructor(private readonly db: Database) {}

  async insert(r: SettlementAdjustmentApprovalRecord, audit?: AuditRecord): Promise<{ record: SettlementAdjustmentApprovalRecord; created: boolean }> {
    try {
      return await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(approvalRequest)
          .values({
            id: r.approvalId,
            kind: 'SETTLEMENT_ADJUSTMENT',
            targetRef: r.statementId,
            amount: r.amount,
            reasonCode: r.reasonCode,
            reasonText: r.reasonText,
            requestedBy: r.requestedBy,
            requesterRole: r.requesterRole,
            requiredApprovals: 2,
            status: r.status,
            approverId: r.approverId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            version: r.version,
          })
          .onConflictDoNothing()
          .returning({ id: approvalRequest.id });
        if (inserted.length === 0) return { record: (await this.find(r.approvalId)) ?? r, created: false };
        if (audit) await appendAuditIn(tx, audit);
        return { record: r, created: true };
      });
    } catch (e) {
      if (pgCode(e) === '23505') {
        const found = await this.find(r.approvalId);
        if (found) return { record: found, created: false };
      }
      throw e;
    }
  }

  async #votes(ids: readonly string[]): Promise<Map<string, { approvers: string[]; first: Date | null }>> {
    const out = new Map<string, { approvers: string[]; first: Date | null }>();
    if (ids.length === 0) return out;
    const rows = await this.db.db
      .select({ requestId: approvalVote.requestId, approverId: approvalVote.approverId, approvedAt: approvalVote.approvedAt })
      .from(approvalVote)
      .where(inArray(approvalVote.requestId, [...ids]))
      .orderBy(approvalVote.approvedAt);
    for (const v of rows) {
      const cur = out.get(v.requestId) ?? { approvers: [], first: null };
      cur.approvers.push(v.approverId);
      cur.first ??= v.approvedAt;
      out.set(v.requestId, cur);
    }
    return out;
  }

  #record(row: typeof approvalRequest.$inferSelect, votes: { approvers: string[]; first: Date | null } | undefined): SettlementAdjustmentApprovalRecord {
    return {
      approvalId: row.id,
      statementId: row.targetRef,
      amount: Number(row.amount ?? 0),
      reasonCode: row.reasonCode ?? '',
      reasonText: row.reasonText,
      requestedBy: row.requestedBy,
      requesterRole: row.requesterRole,
      status: row.status as SettlementAdjustmentApprovalStatus,
      closeReason: row.closeReason,
      approverId: row.approverId,
      approvals: votes?.approvers ?? [],
      approvedAt: votes?.first ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
    };
  }

  async find(approvalId: string): Promise<SettlementAdjustmentApprovalRecord | undefined> {
    if (!UUID.test(approvalId)) return undefined;
    const rows = await this.db.db.select().from(approvalRequest).where(and(eq(approvalRequest.id, approvalId), eq(approvalRequest.kind, 'SETTLEMENT_ADJUSTMENT'))).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return this.#record(row, (await this.#votes([row.id])).get(row.id));
  }

  async save(r: SettlementAdjustmentApprovalRecord, audit?: AuditRecord, vote?: ApprovalVote): Promise<boolean> {
    if (!UUID.test(r.approvalId)) return false;
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(approvalRequest)
        .set({ status: r.status, closeReason: r.closeReason, approverId: r.approverId, updatedAt: r.updatedAt, version: r.version })
        .where(and(eq(approvalRequest.id, r.approvalId), eq(approvalRequest.kind, 'SETTLEMENT_ADJUSTMENT'), eq(approvalRequest.version, r.version - 1)))
        .returning({ id: approvalRequest.id });
      if (updated.length === 0) return false;
      if (vote) {
        await tx
          .insert(approvalVote)
          .values({ requestId: vote.approvalId, approverId: vote.approverId, requesterId: vote.requesterId, approvedAt: vote.approvedAt, reason: vote.reason })
          .onConflictDoNothing();
      }
      if (audit) await appendAuditIn(tx, audit);
      return true;
    });
  }

  async list(filter: { status?: readonly string[] | undefined; requesterId?: string | undefined; awaitingApprover?: string | undefined; limit: number }): Promise<SettlementAdjustmentApprovalRecord[]> {
    const conditions = [eq(approvalRequest.kind, 'SETTLEMENT_ADJUSTMENT')];
    if (filter.status && filter.status.length > 0) conditions.push(inArray(approvalRequest.status, [...filter.status]));
    if (filter.requesterId) conditions.push(eq(approvalRequest.requestedBy, filter.requesterId));
    if (filter.awaitingApprover) {
      conditions.push(inArray(approvalRequest.status, ['PENDING_APPROVAL', 'FAILED']));
      conditions.push(ne(approvalRequest.requestedBy, filter.awaitingApprover));
    }
    const rows = await this.db.db
      .select()
      .from(approvalRequest)
      .where(and(...conditions))
      .orderBy(desc(approvalRequest.createdAt))
      .limit(filter.limit);
    const votes = await this.#votes(rows.map((r) => r.id));
    return rows.map((r) => this.#record(r, votes.get(r.id)));
  }
}
