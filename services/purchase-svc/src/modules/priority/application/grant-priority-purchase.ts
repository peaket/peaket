// 우선 구매 권리 발급(정본 purchase/v1/account.proto PriorityPurchaseService.GrantPriorityPurchase, docs/features/seat-hold.md §5, ADR-0171).
// 취소한 표의 좌석이 아직 비어 있으면 그 좌석을, 아니면 같은 등급의 남은 좌석 하나를 PRIORITY 홀드로 잡고 권리를 만든다.
// 판매 종료 뒤에도 잡고, 입장 시작 뒤에는 ENTRY_STARTED다. 같은 취소 표로 다시 오면 처음 권리를 돌려준다.
import { uuidv7, type Clock } from '@peaket/platform';
import type { SeatMap } from '../../inventory/index.js';
import { PRIORITY_GRANT_TTL_MS, type PriorityGrant, type PriorityGrantResult } from '../domain/priority-grant.js';
import type { CancelledTickets, PriorityGrantStore, PrioritySeatCandidates, PrioritySeatHolds } from '../domain/ports.js';

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
      seatMap: Pick<SeatMap, 'resolve'>;
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

    const sameSeat = (await this.deps.seatMap.resolve(i.eventId, [ticket.seatId]))[0];
    if (sameSeat) {
      if (await this.#tryHold(i, grantId, sameSeat, expiresAtMs)) {
        return { result: 'SAME_SEAT', grant: await this.#create(i, grantId, 'SAME_SEAT', sameSeat, ticket.price, expiresAtMs, now) };
      }
    }
    for (const seat of await this.deps.candidates.sameTier(i.eventId, ticket.tierId)) {
      if (seat.seatId === ticket.seatId) continue;
      if (await this.#tryHold(i, grantId, seat, expiresAtMs)) {
        return { result: 'SAME_TIER', grant: await this.#create(i, grantId, 'SAME_TIER', seat, ticket.price, expiresAtMs, now) };
      }
    }
    return { result: 'NO_SEAT' };
  }

  async #tryHold(i: GrantPriorityPurchaseInput, grantId: string, seat: Parameters<PrioritySeatHolds['holdPriority']>[0]['seat'], expiresAtMs: number): Promise<boolean> {
    try {
      const r = await this.deps.seats.holdPriority({ eventId: i.eventId, accountId: i.accountId, grantId, seat, expiresAtMs, keepUntilMs: expiresAtMs });
      // 좌석 저장소가 준비되지 않았으면 NO_SEAT로 숨기지 않고 503으로 드러낸다
      if (r.kind === 'NOT_READY') throw new PriorityStoreUnavailable();
      return r.kind === 'OK';
    } catch (e) {
      throw new PriorityStoreUnavailable(e);
    }
  }

  async #create(i: GrantPriorityPurchaseInput, grantId: string, kind: 'SAME_SEAT' | 'SAME_TIER', seat: { seatId: string; tierId: string }, price: number, expiresAtMs: number, nowMs: number): Promise<PriorityGrant> {
    return this.deps.grants.create({
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
    });
  }
}
