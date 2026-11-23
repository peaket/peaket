// 시험용 우선 구매 권리 저장소. 같은 취소 표에는 한 번만 만든다.
import { PrioritySeatConflict, type NewPriorityGrant, type PriorityGrant } from '../domain/priority-grant.js';
import type { PriorityGrantStore } from '../domain/ports.js';

export class MemoryPriorityGrantStore implements PriorityGrantStore {
  readonly grants = new Map<string, PriorityGrant>();
  readonly #byCancelled = new Map<string, string>();

  async findByCancelledTicket(cancelledTicketId: string): Promise<PriorityGrant | undefined> {
    const id = this.#byCancelled.get(cancelledTicketId);
    return id ? this.grants.get(id) : undefined;
  }

  async find(grantId: string): Promise<PriorityGrant | undefined> {
    return this.grants.get(grantId);
  }

  async create(input: NewPriorityGrant): Promise<PriorityGrant> {
    const existing = await this.findByCancelledTicket(input.cancelledTicketId);
    if (existing) return existing;
    for (const g of this.grants.values()) {
      if (g.eventId === input.eventId && g.seatId === input.seatId && g.status === 'OFFERED') throw new PrioritySeatConflict(input.seatId);
    }
    const grant: PriorityGrant = {
      grantId: input.grantId,
      eventId: input.eventId,
      accountId: input.accountId,
      fraudCaseId: input.fraudCaseId,
      cancelledTicketId: input.cancelledTicketId,
      grantKind: input.grantKind,
      seatId: input.seatId,
      tierId: input.tierId,
      price: input.price,
      status: 'OFFERED',
      expiresAtMs: input.expiresAtMs,
      ...(input.actedBy !== undefined ? { actedBy: input.actedBy } : {}),
      version: 1,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    this.grants.set(grant.grantId, grant);
    this.#byCancelled.set(grant.cancelledTicketId, grant.grantId);
    return grant;
  }

  async beginOrder(grantId: string, orderId: string, nowMs: number): Promise<boolean> {
    const g = this.grants.get(grantId);
    if (!g || g.status !== 'OFFERED' || g.activeOrderId !== undefined) return false;
    this.grants.set(grantId, { ...g, activeOrderId: orderId, updatedAtMs: nowMs });
    return true;
  }

  async markUsed(grantId: string, orderId: string, nowMs: number): Promise<PriorityGrant | undefined> {
    const g = this.grants.get(grantId);
    if (!g) return undefined;
    const next: PriorityGrant = { ...g, status: 'USED', usedOrderId: orderId, activeOrderId: undefined, version: g.version + 1, updatedAtMs: nowMs };
    this.grants.set(grantId, next);
    return next;
  }

  async withdraw(grantId: string, actedBy: string, nowMs: number): Promise<PriorityGrant | undefined> {
    const g = this.grants.get(grantId);
    if (!g || g.status !== 'OFFERED' || g.activeOrderId !== undefined) return g;
    const next: PriorityGrant = { ...g, status: 'WITHDRAWN', withdrawnBy: actedBy, version: g.version + 1, updatedAtMs: nowMs };
    this.grants.set(grantId, next);
    return next;
  }

  async expire(grantId: string, nowMs: number): Promise<PriorityGrant | undefined> {
    const g = this.grants.get(grantId);
    // 진행 중 주문(active_order_id)이 있으면 만료하지 않는다. 결제가 끝나면 markUsed가 USED로 끝낸다
    if (!g || g.status !== 'OFFERED' || g.activeOrderId !== undefined) return g;
    const next: PriorityGrant = { ...g, status: 'EXPIRED', activeOrderId: undefined, version: g.version + 1, updatedAtMs: nowMs };
    this.grants.set(grantId, next);
    return next;
  }

  async releaseOrder(grantId: string, orderId: string, nowMs: number): Promise<boolean> {
    const g = this.grants.get(grantId);
    if (!g || g.status !== 'OFFERED' || g.activeOrderId !== orderId) return false;
    this.grants.set(grantId, { ...g, activeOrderId: undefined, updatedAtMs: nowMs });
    return true;
  }

  async expireDue(nowMs: number, limit: number): Promise<readonly PriorityGrant[]> {
    const due = [...this.grants.values()]
      .filter((g) => g.status === 'OFFERED' && g.activeOrderId === undefined && g.expiresAtMs <= nowMs)
      .sort((a, b) => a.expiresAtMs - b.expiresAtMs || a.grantId.localeCompare(b.grantId))
      .slice(0, Math.max(0, Math.trunc(limit)));
    return due.map((g) => {
      const next: PriorityGrant = { ...g, status: 'EXPIRED', activeOrderId: undefined, version: g.version + 1, updatedAtMs: nowMs };
      this.grants.set(g.grantId, next);
      return next;
    });
  }

  async listSyncable(nowMs: number, limit: number): Promise<readonly PriorityGrant[]> {
    return [...this.grants.values()]
      .filter((g) => g.expiresAtMs > nowMs && (g.status === 'OFFERED' || g.status === 'USED' || g.status === 'WITHDRAWN'))
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.grantId.localeCompare(b.grantId))
      .slice(0, Math.max(0, Math.trunc(limit)));
  }
}
