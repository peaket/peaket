// 시험용 우선 구매 권리 저장소. 같은 취소 표에는 한 번만 만든다.
import type { NewPriorityGrant, PriorityGrant } from '../domain/priority-grant.js';
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

  async withdraw(grantId: string, nowMs: number): Promise<PriorityGrant | undefined> {
    const g = this.grants.get(grantId);
    if (!g || g.status !== 'OFFERED') return g;
    const next: PriorityGrant = { ...g, status: 'WITHDRAWN', version: g.version + 1, updatedAtMs: nowMs };
    this.grants.set(grantId, next);
    return next;
  }
}
