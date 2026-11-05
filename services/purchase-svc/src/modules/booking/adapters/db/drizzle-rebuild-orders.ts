// 다시 만들기의 주문 근거(RebuildOrderReads, BUILD_ORDER PRF-167, docs/features/seat-hold.md §6 '주문 기준 되살리기' K1·K3, docs/data.md §4 0008).
// inventory가 booking 표(purchase_order·order_item)를 직접 읽지 않도록 booking이 이 읽기를 주고, 시작 파일이 SeatRebuilder의 orders(RebuildOrderSource)로 꽂는다.
// inventory를 가져오지 않는다(돌려주는 모양은 inventory RebuildSaleOrder·RebuildPinnedOrder와 같다, 조립에서 모양으로 맞춘다).
// - saleOrders: 주문 ID들 → 그 회차 주문의 hold_id·purchase_session_id(활성 판매 행의 주문 ID로 부른다, K3).
// - pinnedOrders: 그 회차의 status ACCEPTED이고 pinned_at이 있는 주문과 그 항목의 좌석 ID(줄 번호 차례, K1). 원장(seat_hold)은 읽지 않는다:
//   그 좌석에 그 주문 holdId의 HELD 행이 있는지는 inventory(SeatRebuildSource.ledgerRows → planRebuild)가 본다(리뷰 고침 M2).
//   진행 중 주문만 있는 작은 작업 표 order_saga_job에서 출발해(step RESERVE) purchase_order·order_item을 기본 키로 읽는다(리뷰 고침 H1: purchase_order에는
//   회차 색인이 없어 주문 표에서 출발하면 표 전체를 훑는다). ACCEPTED 주문에는 늘 RESERVE 작업 행이 있다: 결제 접수가 ACCEPTED와 함께 RESERVE 행을 넣고
//   (drizzle-order-accepts.ts ⑤), ACCEPTED를 벗어나는 전이 T7(판매 예약)·T8(Saga 실패 기록)이 같은 트랜잭션에서 작업 행을 CONFIRM·RELEASE로 바꾸며,
//   작업 행을 지우는 길(abandon·결제 결과 반영)은 주문이 ACCEPTED면 지우지 않거나 되돌린다.
// 트랜잭션 없이 읽기만 한다(자동 커밋 한 문장씩).
// 구현에서 정한 것(정본에 없다):
// - saleOrders의 주문 ID는 배열 글 하나(`{…}`::uuid[])로 넘기고, 1,000개씩 [가정] 나눠 묻는다(매개변수 수·한 문장 크기를 막는다). 겹친 ID는 한 번만 묻는다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { RebuildOrderHold, RebuildOrderReads, RebuildPinnedOrderView } from '../../domain/ports.js';

/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** saleOrders 한 질의의 주문 ID 수 [가정] */
const SALE_ORDER_CHUNK = 1_000;

function assertUuid(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new RangeError(`${what}가 소문자 UUID가 아니다`);
}

export class DrizzleRebuildOrders implements RebuildOrderReads {
  constructor(private readonly database: Database) {}

  /**
   * @throws RangeError 회차·주문 ID가 소문자 UUID가 아님(DB를 부르기 전) · Error purchase DB 오류
   */
  async saleOrders(eventId: string, orderIds: readonly string[]): Promise<RebuildOrderHold[]> {
    assertUuid(eventId, '회차 ID');
    for (const id of orderIds) assertUuid(id, '주문 ID');
    const ids = [...new Set(orderIds)];
    const out: RebuildOrderHold[] = [];
    for (let k = 0; k < ids.length; k += SALE_ORDER_CHUNK) {
      const chunk = ids.slice(k, k + SALE_ORDER_CHUNK);
      const r = await this.database.db.execute(sql`
        select id::text as id, hold_id::text as hold_id, purchase_session_id
          from purchase_order
         where event_id = ${eventId}::uuid and id = any(${`{${chunk.join(',')}}`}::uuid[])`);
      for (const x of r.rows) {
        const row = x as { id: string; hold_id: string; purchase_session_id: string };
        out.push({ orderId: row.id, holdId: row.hold_id, purchaseSessionId: row.purchase_session_id });
      }
    }
    return out;
  }

  /**
   * @throws RangeError 회차 ID가 소문자 UUID가 아님(DB를 부르기 전) · Error purchase DB 오류
   */
  async pinnedOrders(eventId: string): Promise<RebuildPinnedOrderView[]> {
    assertUuid(eventId, '회차 ID');
    const r = await this.database.db.execute(sql`
      select o.id::text as id, o.account_id::text as account_id, o.hold_id::text as hold_id, o.purchase_session_id, i.seat_id::text as seat_id
        from order_saga_job j
        join purchase_order o on o.id = j.order_id
        join order_item i on i.order_id = o.id
       where j.event_id = ${eventId}::uuid and j.step = 'RESERVE' and o.status = 'ACCEPTED' and o.pinned_at is not null
       order by o.id, i.line_no`);
    const byOrder = new Map<string, RebuildPinnedOrderView>();
    for (const x of r.rows) {
      const row = x as { id: string; account_id: string; hold_id: string; purchase_session_id: string; seat_id: string };
      let o = byOrder.get(row.id);
      if (o === undefined) {
        o = { orderId: row.id, accountId: row.account_id, holdId: row.hold_id, purchaseSessionId: row.purchase_session_id, seatIds: [] };
        byOrder.set(row.id, o);
      }
      o.seatIds.push(row.seat_id);
    }
    return [...byOrder.values()];
  }
}
