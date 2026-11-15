// 우선 구매 권리 발급(정본 purchase/v1/account.proto PriorityPurchaseService.GrantPriorityPurchase, docs/features/seat-hold.md §5, ADR-0171).
// 취소한 표의 좌석이 아직 비어 있으면 그 좌석을, 아니면 같은 등급의 남은 좌석 하나를 PRIORITY 홀드로 잡고 권리를 만든다.
// 판매 종료 뒤에도 잡고, 입장 시작 뒤에는 ENTRY_STARTED다. 같은 취소 표로 다시 오면 처음 권리를 돌려준다.
// 활성 판매 행(seat_sale PENDING·SOLD)이 있는 좌석은 잡지 않는다(팔린 좌석을 다시 잡지 않게).
// 같은 취소 표로 두 번이 동시에 오면 한 번만 권리를 만들고, 진 쪽이 잡은 여분 보류는 푼다.
import { uuidv7, type Clock } from '@peaket/platform';
import { KEEP_AFTER_SALE_END_MS, type SeatMap } from '../../inventory/index.js';
import { PRIORITY_GRANT_TTL_MS, PrioritySeatConflict, type PriorityGrant, type PriorityGrantResult } from '../domain/priority-grant.js';
import type { CancelledTickets, PriorityGrantLogger, PriorityGrantStore, PrioritySeatCandidates, PrioritySeatHolds, PrioritySeatSales } from '../domain/ports.js';

export class PriorityStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('우선 구매 저장소를 잠시 쓸 수 없다', cause === undefined ? undefined : { cause });
    this.name = 'PriorityStoreUnavailable';
  }
}

export class PriorityGrantNotFound extends Error {
  constructor() {
    super('취소한 표를 찾을 수 없다');
    this.name = 'PriorityGrantNotFound';
  }
}

export { PrioritySeatConflict };

export interface GrantPriorityPurchaseInput {
  readonly fraudCaseId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly cancelledTicketId: string;
  readonly actedBy: string;
}

export interface GrantPriorityPurchaseResult {
  readonly result: PriorityGrantResult;
  readonly grant?: PriorityGrant;
}

const resultOf = (g: PriorityGrant): PriorityGrantResult => (g.grantKind === 'SAME_SEAT' ? 'SAME_SEAT' : 'SAME_TIER');

export class GrantPriorityPurchase {
  constructor(
    private readonly deps: {
      grants: PriorityGrantStore;
      cancelled: CancelledTickets;
      seats: PrioritySeatHolds;
      candidates: PrioritySeatCandidates;
      seatMap: Pick<SeatMap, 'resolve' | 'config'>;
      sales?: PrioritySeatSales;
      /** DB 쓰기가 실패해 보류를 풀지 못했을 때 재시도 표시를 남긴다 */
      logger?: PriorityGrantLogger;
      clock: Clock;
    },
  ) {}

  async run(i: GrantPriorityPurchaseInput): Promise<GrantPriorityPurchaseResult> {
    const existing = await this.deps.grants.findByCancelledTicket(i.cancelledTicketId);
    if (existing) return { result: resultOf(existing), grant: existing };

    const ticket = await this.deps.cancelled.find(i.cancelledTicketId, i.fraudCaseId);
    if (!ticket || ticket.eventId !== i.eventId || ticket.accountId !== i.accountId) throw new PriorityGrantNotFound();
    const now = this.deps.clock.now();
    if (ticket.entryStartsAtMs !== undefined && now >= ticket.entryStartsAtMs) return { result: 'ENTRY_STARTED' };
    const expiresAtMs = Math.min(now + PRIORITY_GRANT_TTL_MS, ticket.entryStartsAtMs ?? Number.POSITIVE_INFINITY);
    const grantId = uuidv7(this.deps.clock);
    const keepUntilMs = await this.#keepUntil(i.eventId, expiresAtMs);

    const sameSeat = (await this.deps.seatMap.resolve(i.eventId, [ticket.seatId]))[0];
    if (sameSeat && !(await this.#sold(i.eventId, [sameSeat.seatId])).has(sameSeat.seatId)) {
      if (await this.#tryHold(i, grantId, sameSeat, expiresAtMs, keepUntilMs)) {
        const r = await this.#createOrRelease(i, grantId, 'SAME_SEAT', sameSeat, ticket.price, expiresAtMs, now, keepUntilMs);
        if (r) return r;
      }
    }
    const candidates = (await this.deps.candidates.sameTier(i.eventId, ticket.tierId)).filter((s) => s.seatId !== ticket.seatId);
    const sold = await this.#sold(i.eventId, candidates.map((s) => s.seatId));
    for (const seat of candidates) {
      if (sold.has(seat.seatId)) continue;
      if (!(await this.#tryHold(i, grantId, seat, expiresAtMs, keepUntilMs))) continue;
      const r = await this.#createOrRelease(i, grantId, 'SAME_TIER', seat, ticket.price, expiresAtMs, now, keepUntilMs);
      if (r) return r;
    }
    return { result: 'NO_SEAT' };
  }

  async #keepUntil(eventId: string, expiresAtMs: number): Promise<number> {
    const config = await this.deps.seatMap.config(eventId);
    return Math.max(expiresAtMs, (config?.saleEndsAtMs ?? expiresAtMs) + KEEP_AFTER_SALE_END_MS);
  }

  async #sold(eventId: string, seatIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (!this.deps.sales || seatIds.length === 0) return new Set();
    return this.deps.sales.active(eventId, seatIds);
  }

  async #tryHold(i: GrantPriorityPurchaseInput, grantId: string, seat: Parameters<PrioritySeatHolds['holdPriority']>[0]['seat'], expiresAtMs: number, keepUntilMs: number): Promise<boolean> {
    try {
      const r = await this.deps.seats.holdPriority({ eventId: i.eventId, accountId: i.accountId, grantId, seat, expiresAtMs, keepUntilMs });
      // 좌석 저장소가 준비되지 않았으면 NO_SEAT로 숨기지 않고 503으로 드러낸다
      if (r.kind === 'NOT_READY') throw new PriorityStoreUnavailable();
      return r.kind === 'OK';
    } catch (e) {
      throw new PriorityStoreUnavailable(e);
    }
  }

  /**
   * 권리를 만든다. 같은 취소 표로 먼저 만든 권리가 있으면 그 권리를 돌려주고 이번에 잡은 보류를 푼다.
   * 같은 좌석에 다른 권리가 있으면 보류를 풀고 undefined(다음 후보로).
   */
  async #createOrRelease(
    i: GrantPriorityPurchaseInput,
    grantId: string,
    kind: 'SAME_SEAT' | 'SAME_TIER',
    seat: Parameters<PrioritySeatHolds['holdPriority']>[0]['seat'],
    price: number,
    expiresAtMs: number,
    nowMs: number,
    keepUntilMs: number,
  ): Promise<GrantPriorityPurchaseResult | undefined> {
    try {
      const grant = await this.deps.grants.create({
        grantId,
        eventId: i.eventId,
        accountId: i.accountId,
        fraudCaseId: i.fraudCaseId,
        cancelledTicketId: i.cancelledTicketId,
        grantKind: kind,
        seatId: seat.seatId,
        tierId: seat.tierId,
        price,
        expiresAtMs,
        nowMs,
        ...(i.actedBy !== '' ? { actedBy: i.actedBy } : {}),
      });
      if (grant.grantId !== grantId) await this.#release(i, grantId, seat, keepUntilMs);
      return { result: resultOf(grant), grant };
    } catch (e) {
      if (e instanceof PrioritySeatConflict) {
        await this.#release(i, grantId, seat, keepUntilMs);
        return undefined;
      }
      // DB 쓰기가 실패하면 방금 잡은 PRIORITY 보류가 고아로 남지 않게 푼다.
      // 풀지 못하면 만료 반복이 처리할 수 있도록 재시도 표시를 남긴다.
      try {
        await this.deps.seats.releasePriority({ eventId: i.eventId, accountId: i.accountId, grantId, seat, keepUntilMs });
      } catch (releaseError) {
        this.deps.logger?.grantFailed({ eventId: i.eventId, cancelledTicketId: i.cancelledTicketId, reason: `release-failed:${releaseError instanceof Error ? releaseError.name : 'unknown'}` });
      }
      throw e;
    }
  }

  async #release(i: GrantPriorityPurchaseInput, grantId: string, seat: Parameters<PrioritySeatHolds['holdPriority']>[0]['seat'], keepUntilMs: number): Promise<void> {
    try {
      await this.deps.seats.releasePriority({ eventId: i.eventId, accountId: i.accountId, grantId, seat, keepUntilMs });
    } catch (e) {
      throw new PriorityStoreUnavailable(e);
    }
  }
}
