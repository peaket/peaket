// 좌석맵 판에서 같은 등급의 남은 좌석 후보를 찾는 어댑터(GAT-135). 운영은 LayoutSeatMap을 넘긴다.
import type { SeatMapIndex, SeatMapTiers, SeatRef } from '../../inventory/index.js';
import type { PrioritySeatCandidates } from '../domain/ports.js';

export class SeatMapPriorityCandidates implements PrioritySeatCandidates {
  constructor(private readonly map: SeatMapTiers & SeatMapIndex) {}

  async sameTier(eventId: string, tierId: string): Promise<readonly SeatRef[]> {
    const layout = await this.map.saleLayout(eventId);
    const indexes = layout?.tiers.find((t) => t.tierId === tierId)?.indexes ?? [];
    const seats = await this.map.byIndex(eventId, indexes);
    return seats.filter((s): s is SeatRef => s !== undefined && s.tierId === tierId);
  }
}
