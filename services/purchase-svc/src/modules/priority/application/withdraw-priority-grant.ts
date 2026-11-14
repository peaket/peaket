// 우선 구매 권리 회수(GAT-135, ops-svc가 소명 인정 뒤 거둔다). OFFERED만 WITHDRAWN으로 바꾸고 판 번호를 올린다.
// 회수할 때 그 권리의 PRIORITY 보류를 함께 풀어 좌석을 바로 돌려준다(권리 만료까지 좌석이 남지 않게).
import { ProblemError } from '@peaket/platform';
import { KEEP_AFTER_SALE_END_MS, type SeatMap } from '../../inventory/index.js';
import type { PriorityGrant } from '../domain/priority-grant.js';
import type { PriorityGrantStore, PrioritySeatHolds } from '../domain/ports.js';

export class WithdrawPriorityGrant {
  constructor(
    private readonly grants: PriorityGrantStore,
    private readonly nowMs: () => number,
    /** 없으면 보류를 풀지 않는다(옛 조립·단위 시험). 운영은 늘 넘긴다 */
    private readonly holds?: { readonly seats: PrioritySeatHolds; readonly seatMap: Pick<SeatMap, 'resolve' | 'config'> },
  ) {}

  async run(grantId: string): Promise<PriorityGrant> {
    const current = await this.grants.find(grantId);
    if (!current) throw new ProblemError({ type: 'priority-grant-not-found', status: 404, title: '쓸 수 있는 우선 구매 권리가 없습니다' });
    if (current.status === 'USED') throw new ProblemError({ type: 'priority-grant-already-used', status: 409, title: '이미 사용한 우선 구매 권리입니다' });
    if (current.status !== 'OFFERED') return current;
    // 보류를 먼저 푼다. 풀지 못하면 권리를 WITHDRAWN으로 바꾸지 않는다(다시 부르면 풀린다)
    if (this.holds) await this.#release(current);
    const withdrawn = await this.grants.withdraw(grantId, this.nowMs());
    if (!withdrawn) throw new ProblemError({ type: 'priority-grant-not-found', status: 404, title: '쓸 수 있는 우선 구매 권리가 없습니다' });
    return withdrawn;
  }

  async #release(grant: PriorityGrant): Promise<void> {
    const holds = this.holds!;
    const [seat, config] = await Promise.all([holds.seatMap.resolve(grant.eventId, [grant.seatId]).then((r) => r[0]), holds.seatMap.config(grant.eventId)]);
    if (!seat) return;
    const keepUntilMs = Math.max(grant.expiresAtMs, (config?.saleEndsAtMs ?? grant.expiresAtMs) + KEEP_AFTER_SALE_END_MS);
    const r = await holds.seats.releasePriority({ eventId: grant.eventId, accountId: grant.accountId, grantId: grant.grantId, seat, keepUntilMs });
    if (r.kind === 'NOT_READY') throw new ProblemError({ type: 'seat-store-unavailable', status: 503, title: '좌석 정보를 잠시 쓸 수 없습니다', retryAfterSeconds: 2 });
  }
}
