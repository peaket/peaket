// 메모리 파트너사·계약 저장소(단위 시험·로컬). Drizzle 저장소와 같은 포트를 쓴다.
// 파트너사 행과 계약 기간을 메모리 카탈로그 저장소에 두어 판매 승인·상품 게시가 같은 값을 읽는다.
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { idempotencyKeyReused, type IdempotencyRequest } from '@peaket/platform';
import { currentPeriod, isSameApproval, sellerInfoOf, type ContractTerms, type PromoterContractPage, type PromoterDetail, type PromoterPage, type PromoterSummary } from '../domain/promoter-contract.js';
import type { OpsPromoterActor, PromoterCreateInput, PromoterStore, PromoterTermsQuery, ReservedContractChange } from '../domain/promoter-ports.js';
import type { MemoryCatalogRepository, MemoryPromoter, MemoryPromoterContract } from './memory-catalog-repository.js';

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

/** 계약 기간의 커서는 시작 시각이다(최신순) */
const encodeTermCursor = (p: { validFrom: Date }): string => Buffer.from(p.validFrom.toISOString()).toString('base64url');
const decodeTermCursor = (cursor: string): Date | undefined => {
  const d = new Date(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export class MemoryPromoterStore implements PromoterStore {
  readonly #idempotency = new Map<string, { hash: Buffer; resultRef: string }>();

  constructor(private readonly repo: MemoryCatalogRepository) {}

  #summary(p: MemoryPromoter): PromoterSummary {
    const current = currentPeriod(this.repo.promoterContracts.get(p.promoterId) ?? []);
    return {
      promoterId: p.promoterId,
      legalName: p.legalName,
      commissionRateBp: current?.commissionRateBp ?? p.commissionRateBp,
      guaranteeRateBp: current?.guaranteeRateBp ?? 0,
      contractChangePending: p.pendingContractApprovalId !== null,
    };
  }

  async list(q: { q?: string | undefined; cursor?: string | undefined; limit: number }): Promise<PromoterPage> {
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const needle = q.q?.trim().toLowerCase();
    const rows = [...this.repo.promoters.values()]
      .filter((p) => !needle || p.legalName.toLowerCase().includes(needle))
      .map((p) => this.#summary(p))
      .sort((a, b) => a.legalName.localeCompare(b.legalName, 'ko') || a.promoterId.localeCompare(b.promoterId));
    const start = after ? rows.findIndex((p) => p.legalName > after.legalName || (p.legalName === after.legalName && p.promoterId > after.id)) : 0;
    const rest = start < 0 ? [] : rows.slice(start);
    const items = rest.slice(0, q.limit);
    return { items, nextCursor: rest.length > q.limit && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null };
  }

  async detail(promoterId: string): Promise<PromoterDetail | undefined> {
    const p = this.repo.promoters.get(promoterId);
    if (!p) return undefined;
    const periods = this.repo.promoterContracts.get(promoterId) ?? [];
    const current = currentPeriod(periods);
    if (!current) return undefined;
    return {
      promoterId,
      legalName: p.legalName,
      contract: { ...current },
      pendingContractApprovalId: p.pendingContractApprovalId,
      seller: sellerInfoOf(p),
      verifiedAt: p.verifiedAt,
      payoutAccount: null,
      pgRegistration: { tossSellers: [], portonePartnerRegistered: false },
    };
  }

  async terms(promoterId: string, q: PromoterTermsQuery): Promise<PromoterContractPage | undefined> {
    if (!this.repo.promoters.has(promoterId)) return undefined;
    const after = q.cursor ? decodeTermCursor(q.cursor) : undefined;
    const rows = [...(this.repo.promoterContracts.get(promoterId) ?? [])].sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
    const rest = after ? rows.filter((p) => p.validFrom.getTime() < after.getTime()) : rows;
    const items = rest.slice(0, q.limit).map((p) => ({ commissionRateBp: p.commissionRateBp, guaranteeRateBp: p.guaranteeRateBp, guaranteeKind: p.guaranteeKind, validFrom: p.validFrom, validUntil: p.validUntil, approvalId: p.approvalId }));
    return { items, nextCursor: rest.length > q.limit && items.length > 0 ? encodeTermCursor(items[items.length - 1]!) : null };
  }

  #idemKey(once: IdempotencyRequest): string {
    return `${once.accountRef}|${once.operation}|${once.key}`;
  }

  #replay(once: IdempotencyRequest): string | undefined {
    const seen = this.#idempotency.get(this.#idemKey(once));
    if (!seen) return undefined;
    const hash = Buffer.from(once.requestHash);
    if (seen.hash.length !== hash.length || !timingSafeEqual(seen.hash, hash)) throw idempotencyKeyReused();
    return seen.resultRef;
  }

  async create(input: PromoterCreateInput, actor: OpsPromoterActor, now: Date, once?: IdempotencyRequest | undefined): Promise<PromoterDetail> {
    const replayed = once ? this.#replay(once) : undefined;
    if (replayed) {
      const found = await this.detail(replayed);
      if (found) return found;
    }
    const promoterId = randomUUID();
    const record: MemoryPromoter = {
      promoterId,
      legalName: input.legalName,
      representative: null,
      address: null,
      phone: null,
      email: null,
      businessRegNo: null,
      mailOrderReportNo: null,
      exemptionBasis: null,
      verifiedAt: null,
      commissionRateBp: input.commissionRateBp,
      pendingContractApprovalId: null,
    };
    this.repo.promoters.set(promoterId, record);
    this.repo.sellerNames.set(promoterId, input.legalName);
    this.repo.promoterContracts.set(promoterId, [{ id: randomUUID(), ...input, validFrom: now, validUntil: null, approvalId: null, createdBy: actor.accountId }]);
    if (once) this.#idempotency.set(this.#idemKey(once), { hash: Buffer.from(once.requestHash), resultRef: promoterId });
    const detail = await this.detail(promoterId);
    if (!detail) throw new Error('방금 만든 파트너사가 없다');
    return detail;
  }

  async reserveChange(promoterId: string, approvalId: string, requested: ContractTerms, _now: Date): Promise<ReservedContractChange | 'not-found' | 'pending' | 'no-contract'> {
    const p = this.repo.promoters.get(promoterId);
    if (!p) return 'not-found';
    if (p.pendingContractApprovalId !== null) return 'pending';
    const current = currentPeriod(this.repo.promoterContracts.get(promoterId) ?? []);
    if (!current) return 'no-contract';
    this.repo.promoters.set(promoterId, { ...p, pendingContractApprovalId: approvalId });
    return { current: { ...current }, requested };
  }

  async clearPending(promoterId: string, approvalId: string): Promise<void> {
    const p = this.repo.promoters.get(promoterId);
    if (p?.pendingContractApprovalId === approvalId) this.repo.promoters.set(promoterId, { ...p, pendingContractApprovalId: null });
  }

  async applyChange(promoterId: string, approvalId: string, requested: Partial<ContractTerms>, approvedAt: Date, _approverId: string): Promise<{ kind: 'applied' | 'already'; validFrom: Date } | 'not-found' | 'conflict'> {
    const p = this.repo.promoters.get(promoterId);
    if (!p) return 'not-found';
    const periods = this.repo.promoterContracts.get(promoterId) ?? [];
    const same = periods.find((x) => isSameApproval(x, approvalId));
    if (same) return { kind: 'already', validFrom: same.validFrom };
    if (p.pendingContractApprovalId !== approvalId) return 'conflict';
    const current = currentPeriod(periods);
    if (!current) return 'conflict';
    const next = {
      commissionRateBp: requested.commissionRateBp ?? current.commissionRateBp,
      guaranteeRateBp: requested.guaranteeRateBp ?? current.guaranteeRateBp,
      guaranteeKind: requested.guaranteeKind ?? current.guaranteeKind,
    };
    // 옛 기간의 끝과 새 기간의 시작을 같은 시각으로 맞춘다(겹치지 않는다)
    const closed: MemoryPromoterContract = { ...(current as MemoryPromoterContract), validUntil: approvedAt };
    const nextPeriod: MemoryPromoterContract = { id: randomUUID(), ...next, validFrom: approvedAt, validUntil: null, approvalId, createdBy: p.promoterId };
    this.repo.promoterContracts.set(promoterId, periods.map((x) => (x.id === closed.id ? closed : x)).concat(nextPeriod).sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime()));
    this.repo.promoters.set(promoterId, { ...p, commissionRateBp: next.commissionRateBp, pendingContractApprovalId: null });
    return { kind: 'applied', validFrom: approvedAt };
  }

  async summary(promoterId: string): Promise<PromoterSummary | undefined> {
    const p = this.repo.promoters.get(promoterId);
    return p ? this.#summary(p) : undefined;
  }

  async currentCommissionRateBp(promoterId: string): Promise<number | undefined> {
    const current = currentPeriod(this.repo.promoterContracts.get(promoterId) ?? []);
    return current?.commissionRateBp ?? this.repo.promoters.get(promoterId)?.commissionRateBp;
  }
}
