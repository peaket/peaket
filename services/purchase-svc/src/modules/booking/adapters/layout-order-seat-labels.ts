// 주문 상세의 좌석 이름·등급 이름을 좌석맵 판에서 읽는 어댑터(F-07-2 OrderSeatLabels).
// inventory의 LayoutSeatMap.resolve·config만 받는다(공개 면을 가져오지 않는다, inventory-bridges와 같은 방식).
// 판이 없거나 읽지 못하면 이름 없이 돌려주고, 상세는 저장 값(좌석 ID·등급 ID)으로 떨어진다.
import type { OrderSeatLabels } from '../domain/ports.js';

export interface OrderSeatMapSource {
  resolve(eventId: string, seatIds: readonly string[]): Promise<readonly ({ label?: string; tierId: string } | undefined)[]>;
  config(eventId: string): Promise<{ readonly tierNames?: Readonly<Record<string, string>> } | undefined>;
}

export class LayoutOrderSeatLabels implements OrderSeatLabels {
  constructor(private readonly source: OrderSeatMapSource) {}

  async resolve(eventId: string, seatIds: readonly string[]): Promise<readonly ({ label?: string; tierName?: string } | undefined)[]> {
    const refs = await this.source.resolve(eventId, seatIds);
    const config = await this.source.config(eventId).catch(() => undefined);
    return refs.map((ref) => {
      if (!ref) return undefined;
      const tierName = config?.tierNames?.[ref.tierId];
      return {
        ...(ref.label !== undefined ? { label: ref.label } : {}),
        ...(tierName !== undefined ? { tierName } : {}),
      };
    });
  }
}
