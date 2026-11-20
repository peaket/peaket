// 파트너사·계약 Drizzle 저장소(core_ops 풀, BAT-615 LCH-070, ADR-0320 결정 8).
// 관제 경로는 모든 파트너를 다루고, 계약 기간은 promoter_contract의 tstzrange로 남긴다. 승인 적용은 파트너 행을 잠근 트랜잭션 하나에서 한다.
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { type Clock, type Database, type DbTransaction, type IdempotencyRequest, IdempotencyStore, uuidv7 } from '@peaket/platform';
import {
  currentPeriod,
  isSameApproval,
  isGuaranteeKind,
  sellerInfoOf,
  type ContractTerms,
  type GuaranteeKind,
  type PromoterContractPage,
  type PromoterContractPeriod,
  type PromoterDetail,
  type PromoterPage,
  type PromoterSummary,
} from '../../domain/promoter-contract.js';
import type { OpsPromoterActor, PromoterCreateInput, PromoterStore, PromoterTermsQuery, ReservedContractChange, ReserveChangeResult } from '../../domain/promoter-ports.js';
import { CONTRACT_CHANGE_IDEMPOTENCY_SCOPE } from '../../domain/promoter-ports.js';
import { promoter, promoterContract, promoterContractState } from './schema.js';

/** 예약이 도중에 거절됐다(멱등 트랜잭션을 되돌리고 앱에 그 뜻을 돌려준다) */
class ReservationRejected extends Error {
  constructor(readonly result: 'not-found' | 'pending' | 'no-contract') {
    super(result);
  }
}

/** PostgreSQL 범위 글자. 끝이 없으면 빈 칸이다([시작,)) */
export function rangeLiteral(from: Date, until: Date | null): string {
  return `[${from.toISOString()},${until ? until.toISOString() : ''})`;
}

const currentOf = (periods: readonly PromoterContractPeriod[]): PromoterContractPeriod | undefined => currentPeriod(periods);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (p: PromoterSummary): string => Buffer.from(JSON.stringify([p.legalName, p.promoterId])).toString('base64url');
const decodeCursor = (cursor: string): { legalName: string; id: string } | undefined => {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string') return undefined;
    return { legalName: v[0], id: v[1] };
  } catch {
    return undefined;
  }
};
const encodeTermCursor = (from: Date): string => Buffer.from(from.toISOString()).toString('base64url');
const decodeTermCursor = (cursor: string): Date | undefined => {
  const d = new Date(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

// Drizzle의 node-postgres 드라이버는 timestamptz를 날짜로 바꾸지 않고 글자 그대로 돌려준다(칸 타입이 직접 변환을 맡는다).
// 범위 함수 결과에는 그 변환이 붙지 않으므로 여기서 Date로 바꿔 응답의 toISOString()이 깨지지 않게 한다.
const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const contractFields = {
  commissionRateBp: promoterContract.commissionRateBp,
  guaranteeRateBp: promoterContract.guaranteeRateBp,
  guaranteeKind: promoterContract.guaranteeKind,
  validFrom: sql<Date | string>`lower(${promoterContract.validDuring})`,
  validUntil: sql<Date | string | null>`upper(${promoterContract.validDuring})`,
  approvalId: promoterContract.approvalId,
};

const periodOf = (row: { commissionRateBp: number; guaranteeRateBp: number; guaranteeKind: string; validFrom: Date | string; validUntil: Date | string | null; approvalId: string | null }): PromoterContractPeriod => ({
  commissionRateBp: row.commissionRateBp,
  guaranteeRateBp: row.guaranteeRateBp,
  guaranteeKind: row.guaranteeKind as GuaranteeKind,
  validFrom: toDate(row.validFrom),
  validUntil: row.validUntil === null ? null : toDate(row.validUntil),
  approvalId: row.approvalId,
});

export class DrizzlePromoterStore implements PromoterStore {
  readonly #idem: IdempotencyStore;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {
    this.#idem = new IdempotencyStore({ clock });
  }

  #currentJoin() {
    return and(eq(promoterContract.promoterId, promoter.id), sql`upper_inf(${promoterContract.validDuring})`);
  }

  async list(q: { q?: string | undefined; cursor?: string | undefined; limit: number }): Promise<PromoterPage> {
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const conditions = [];
    if (q.q?.trim()) conditions.push(sql`${promoter.legalName} ilike ${`%${q.q.trim()}%`}`);
    if (after) conditions.push(sql`(${promoter.legalName}, ${promoter.id}) > (${after.legalName}, ${after.id}::uuid)`);
    const rows = await this.db.db
      .select({
        promoterId: promoter.id,
        legalName: promoter.legalName,
        pending: promoterContractState.pendingContractApprovalId,
        commissionRateBp: sql<number>`coalesce(${promoterContract.commissionRateBp}, ${promoterContractState.commissionRateBp})`,
        guaranteeRateBp: sql<number>`coalesce(${promoterContract.guaranteeRateBp}, 0)`,
      })
      .from(promoter)
      .leftJoin(promoterContract, this.#currentJoin())
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(promoter.legalName), asc(promoter.id))
      .limit(q.limit + 1);
    const items: PromoterSummary[] = rows.slice(0, q.limit).map((r) => ({
      promoterId: r.promoterId,
      legalName: r.legalName,
      commissionRateBp: r.commissionRateBp,
      guaranteeRateBp: r.guaranteeRateBp,
      contractChangePending: r.pending !== null,
    }));
    return { items, nextCursor: rows.length > q.limit && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null };
  }

  async detail(promoterId: string): Promise<PromoterDetail | undefined> {
    if (!UUID.test(promoterId)) return undefined;
    const rows = await this.db.db
      .select({
        promoterId: promoter.id,
        legalName: promoter.legalName,
        representative: promoter.representative,
        address: promoter.address,
        phone: promoter.phone,
        email: promoter.email,
        businessRegNo: promoter.businessRegNo,
        mailOrderReportNo: promoter.mailOrderReportNo,
        exemptionBasis: promoter.exemptionBasis,
        verifiedAt: promoter.verifiedAt,
        pending: promoterContractState.pendingContractApprovalId,
        ...contractFields,
      })
      .from(promoter)
      .leftJoin(promoterContract, this.#currentJoin())
      .where(eq(promoter.id, promoterId))
      .limit(1);
    const r = rows[0];
    if (!r || r.commissionRateBp === null || r.guaranteeRateBp === null || r.guaranteeKind === null || r.validFrom === null) return undefined;
    return {
      promoterId: r.promoterId,
      legalName: r.legalName,
      contract: periodOf({ commissionRateBp: r.commissionRateBp, guaranteeRateBp: r.guaranteeRateBp, guaranteeKind: r.guaranteeKind, validFrom: r.validFrom, validUntil: r.validUntil, approvalId: r.approvalId }),
      pendingContractApprovalId: r.pending,
      seller: sellerInfoOf({ legalName: r.legalName, representative: r.representative, address: r.address, phone: r.phone, email: r.email, businessRegNo: r.businessRegNo, mailOrderReportNo: r.mailOrderReportNo, exemptionBasis: r.exemptionBasis }),
      verifiedAt: r.verifiedAt,
      payoutAccount: null,
      pgRegistration: { tossSellers: [], portonePartnerRegistered: false },
    };
  }

  async terms(promoterId: string, q: PromoterTermsQuery): Promise<PromoterContractPage | undefined> {
    if (!UUID.test(promoterId)) return undefined;
    const [p] = await this.db.db.select({ id: promoter.id }).from(promoter).where(eq(promoter.id, promoterId));
    if (!p) return undefined;
    const after = q.cursor ? decodeTermCursor(q.cursor) : undefined;
    const rows = await this.db.db
      .select(contractFields)
      .from(promoterContract)
      .where(and(eq(promoterContract.promoterId, promoterId), ...(after ? [sql`lower(${promoterContract.validDuring}) < ${after}`] : [])))
      .orderBy(desc(sql`lower(${promoterContract.validDuring})`))
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit).map(periodOf);
    return { items, nextCursor: rows.length > q.limit && items.length > 0 ? encodeTermCursor(items[items.length - 1]!.validFrom) : null };
  }

  async create(input: PromoterCreateInput, actor: OpsPromoterActor, now: Date, once?: IdempotencyRequest | undefined): Promise<PromoterDetail> {
    const promoterId = uuidv7(this.clock);
    const build = async (tx: DbTransaction): Promise<string> => {
      await tx.insert(promoter).values({ id: promoterId, legalName: input.legalName });
      await tx.update(promoterContractState).set({ commissionRateBp: input.commissionRateBp }).where(eq(promoterContractState.id, promoterId));
      await tx.insert(promoterContract).values({
        id: uuidv7(this.clock),
        promoterId,
        commissionRateBp: input.commissionRateBp,
        guaranteeRateBp: input.guaranteeRateBp,
        guaranteeKind: input.guaranteeKind,
        validDuring: rangeLiteral(now, null),
        approvalId: null,
        createdAt: now,
        createdBy: actor.accountId,
      });
      return promoterId;
    };
    const id = once
      ? await this.db.transaction((tx) =>
          this.#idem.run(tx, once, {
            execute: async () => ({ resultRef: await build(tx), value: promoterId }),
            replay: async (resultRef) => resultRef,
          }),
        )
      : await this.db.transaction(build);
    const detail = await this.detail(id);
    if (!detail) throw new Error('방금 만든 파트너사가 없다');
    return detail;
  }

  async reserveChange(
    promoterId: string,
    approvalId: string,
    requested: ContractTerms,
    _now: Date,
    once?: IdempotencyRequest | undefined,
    render?: (r: ReservedContractChange) => string,
  ): Promise<ReserveChangeResult> {
    if (!UUID.test(promoterId)) return 'not-found';
    const reserve = async (tx: DbTransaction): Promise<ReservedContractChange | 'pending' | 'no-contract'> => {
      const locked = await tx.execute(sql`select pending_contract_approval_id from promoter where id = ${promoterId}::uuid for update`);
      const row = (locked.rows as { pending_contract_approval_id: string | null }[])[0];
      if (!row) throw new ReservationRejected('not-found');
      if (row.pending_contract_approval_id !== null) return 'pending';
      const periods = await tx.select(contractFields).from(promoterContract).where(and(eq(promoterContract.promoterId, promoterId), sql`upper_inf(${promoterContract.validDuring})`));
      const current = periods[0] ? periodOf(periods[0]) : undefined;
      if (!current) return 'no-contract';
      await tx.update(promoterContractState).set({ pendingContractApprovalId: approvalId }).where(and(eq(promoterContractState.id, promoterId), sql`${promoterContractState.pendingContractApprovalId} is null`));
      return { current, requested };
    };
    if (!once) {
      try {
        return await this.db.transaction(reserve);
      } catch (e) {
        if (e instanceof ReservationRejected) return e.result;
        throw e;
      }
    }
    if (!render) throw new Error('멱등 변경 요청에는 처음 응답을 만드는 render가 필요하다');
    const scoped: IdempotencyRequest = { ...once, accountRef: CONTRACT_CHANGE_IDEMPOTENCY_SCOPE };
    try {
      // 예약과 멱등 기록을 같은 트랜잭션에 쓴다. 같은 키·같은 본문 재요청은 저장한 응답을 그대로 재생하고,
      // 같은 키·다른 본문은 플랫폼 IdempotencyStore가 422(idempotency-key-reused)로 가린다(RV-03).
      return await this.db.transaction((tx) =>
        this.#idem.run<ReserveChangeResult>(tx, scoped, {
          execute: async () => {
            const out = await reserve(tx);
            if (out === 'pending' || out === 'no-contract') throw new ReservationRejected(out);
            return { resultRef: render(out), value: out };
          },
          replay: async (resultRef) => ({ replay: resultRef }),
        }),
      );
    } catch (e) {
      if (e instanceof ReservationRejected) return e.result;
      throw e;
    }
  }

  async clearPending(promoterId: string, approvalId: string, once?: IdempotencyRequest | undefined): Promise<void> {
    if (!UUID.test(promoterId)) return;
    if (!once) {
      await this.db.db.update(promoterContractState).set({ pendingContractApprovalId: null }).where(and(eq(promoterContractState.id, promoterId), eq(promoterContractState.pendingContractApprovalId, approvalId)));
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx.update(promoterContractState).set({ pendingContractApprovalId: null }).where(and(eq(promoterContractState.id, promoterId), eq(promoterContractState.pendingContractApprovalId, approvalId)));
      // ops 호출이 실패해 예약을 풀면 멱등 기록도 지운다. 그러지 않으면 같은 키 재시도가 승인 없는 202를 재생한다
      const scoped = { ...once, accountRef: CONTRACT_CHANGE_IDEMPOTENCY_SCOPE };
      await tx.execute(sql`delete from idempotency_record where account_ref = ${scoped.accountRef} and operation = ${scoped.operation} and idempotency_key = ${scoped.key}::uuid`);
    });
  }

  async applyChange(promoterId: string, approvalId: string, requested: Partial<ContractTerms>, approvedAt: Date, approverId: string): Promise<{ kind: 'applied' | 'already'; validFrom: Date } | 'not-found' | 'conflict'> {
    if (!UUID.test(promoterId)) return 'not-found';
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select pending_contract_approval_id from promoter where id = ${promoterId}::uuid for update`);
      const row = (locked.rows as { pending_contract_approval_id: string | null }[])[0];
      if (!row) return 'not-found';
      const same = await tx.select(contractFields).from(promoterContract).where(and(eq(promoterContract.promoterId, promoterId), eq(promoterContract.approvalId, approvalId))).limit(1);
      if (same[0]) {
        const p = periodOf(same[0]);
        if (isSameApproval(p, approvalId)) return { kind: 'already', validFrom: p.validFrom };
      }
      if (row.pending_contract_approval_id !== approvalId) return 'conflict';
      const periods = await tx.select({ id: promoterContract.id, ...contractFields }).from(promoterContract).where(and(eq(promoterContract.promoterId, promoterId), sql`upper_inf(${promoterContract.validDuring})`)).limit(1);
      const current = periods[0];
      if (!current) return 'conflict';
      const next = {
        commissionRateBp: requested.commissionRateBp ?? current.commissionRateBp,
        guaranteeRateBp: requested.guaranteeRateBp ?? current.guaranteeRateBp,
        guaranteeKind: requested.guaranteeKind && isGuaranteeKind(requested.guaranteeKind) ? requested.guaranteeKind : (current.guaranteeKind as GuaranteeKind),
      };
      await tx.update(promoterContract).set({ validDuring: rangeLiteral(toDate(current.validFrom), approvedAt) }).where(eq(promoterContract.id, current.id));
      await tx.insert(promoterContract).values({
        id: uuidv7(this.clock),
        promoterId,
        commissionRateBp: next.commissionRateBp,
        guaranteeRateBp: next.guaranteeRateBp,
        guaranteeKind: next.guaranteeKind,
        validDuring: rangeLiteral(approvedAt, null),
        approvalId,
        createdAt: approvedAt,
        createdBy: approverId,
      });
      await tx.update(promoterContractState).set({ commissionRateBp: next.commissionRateBp, pendingContractApprovalId: null }).where(eq(promoterContractState.id, promoterId));
      return { kind: 'applied', validFrom: approvedAt };
    });
  }

  async summary(promoterId: string): Promise<PromoterSummary | undefined> {
    if (!UUID.test(promoterId)) return undefined;
    const rows = await this.db.db
      .select({
        promoterId: promoter.id,
        legalName: promoter.legalName,
        pending: promoterContractState.pendingContractApprovalId,
        commissionRateBp: sql<number>`coalesce(${promoterContract.commissionRateBp}, ${promoterContractState.commissionRateBp})`,
        guaranteeRateBp: sql<number>`coalesce(${promoterContract.guaranteeRateBp}, 0)`,
      })
      .from(promoter)
      .leftJoin(promoterContract, this.#currentJoin())
      .where(eq(promoter.id, promoterId))
      .limit(1);
    const r = rows[0];
    return r ? { promoterId: r.promoterId, legalName: r.legalName, commissionRateBp: r.commissionRateBp, guaranteeRateBp: r.guaranteeRateBp, contractChangePending: r.pending !== null } : undefined;
  }

  async currentCommissionRateBp(promoterId: string): Promise<number | undefined> {
    if (!UUID.test(promoterId)) return undefined;
    // 계약 기간이 없으면 undefined다. promoter.commission_rate_bp(0033의 기본 1000)로 물러나지 않는다(ADR-0320 결정 4, RV-01)
    const rows = await this.db.db
      .select({ commissionRateBp: promoterContract.commissionRateBp })
      .from(promoterContract)
      .where(and(eq(promoterContract.promoterId, promoterId), sql`upper_inf(${promoterContract.validDuring})`))
      .limit(1);
    return rows[0]?.commissionRateBp;
  }
}
