// 회차 판매 상태 판정의 결제 중 셈(inventory SalePayingSeats 포트의 purchase DB 구현, docs/features/seat-hold.md §4 '판정의 첫 구현', docs/data.md §5.1, ADR-0122 결정 2, BUILD_ORDER PRF-144).
// inventory가 booking 표(purchase_order·order_item) SQL을 직접 쓰지 않도록 booking 모듈에 둔다. 모듈 경계를 지키려고 implements를 달지 않고 같은 모양만 낸다(main.ts가 잇는다).
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';

/** 판매 예약한 지 이만큼 안이면 결제 중으로 센다. 승인 기한 10분 [가정](ADR-0122 결정 2) */
export const SALE_APPROVAL_WINDOW_MS = 600_000;

/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DrizzleSalePayingOptions {
  database: Database;
}

/** 결제 중 셈 */
export class DrizzleSalePaying {
  constructor(private readonly o: DrizzleSalePayingOptions) {}

  /**
   * 그 회차의 결제 중 좌석을 등급별로 센다(한 문장, 인덱스 seat_sale_pending_idx (event_id, reserved_at)):
   * `select i.tier, count(*)::int n from seat_sale s join purchase_order o on o.id = s.order_id join order_item i on i.order_id = s.order_id and i.seat_id = s.seat_id
   *  where s.event_id = $1 and s.status = 'PENDING' and o.status = 'RESERVED' and s.reserved_at > $2 group by i.tier`.
   * @param eventId 회차 ID(소문자 UUID)
   * @param nowMs 지금(epoch ms, 주입 Clock). $2 = nowMs − SALE_APPROVAL_WINDOW_MS(승인 기한 10분 [가정]). pending_until은 가상계좌 기한이라 쓰지 않는다
   * @returns 등급 ID → 결제 중 좌석 수(0은 넣지 않는다)
   * @throws RangeError eventId가 소문자 UUID가 아님(쿼리를 보내지 않는다. '결제 중 0'으로 넘기면 거짓 매진 후보가 되므로 판정이 그 틱을 쉬게 한다, 리뷰 고침 L9)
   * @throws purchase DB 오류
   */
  async payingByTier(eventId: string, nowMs: number): Promise<ReadonlyMap<string, number>> {
    if (!UUID.test(eventId)) throw new RangeError('회차 ID가 소문자 UUID가 아니다');
    const r = await this.o.database.db.execute(sql`
      select i.tier, count(*)::int as n
      from seat_sale s
      join purchase_order o on o.id = s.order_id
      join order_item i on i.order_id = s.order_id and i.seat_id = s.seat_id
      where s.event_id = ${eventId}::uuid and s.status = 'PENDING' and o.status = 'RESERVED' and s.reserved_at > ${new Date(nowMs - SALE_APPROVAL_WINDOW_MS)}::timestamptz
      group by i.tier`);
    return new Map((r.rows as { tier: string; n: number }[]).map((row) => [row.tier, row.n]));
  }
}
