// 탈퇴 참여자의 미사용 티켓 읽기(WithdrawalTicketStore, docs/features/payment.md §4.1 '미사용 티켓 견적' '답',
// docs/data.md §5.1 '탈퇴 참여자의 계정 주문 찾기', docs/api/proto/peaket/purchase/v1/account.proto QuoteAccountWithdrawal, I-T26, BAT-013).
// 호출마다 한 문장이고 인덱스 purchase_order_account_idx (account_id, id)를 탄다. 그 계정 ID의 주문만 읽는다.
// 미사용 티켓: purchase_order가 CONFIRMED·PARTIALLY_REFUNDED이고 order_item.ticket_id가 있으며 그 표에 order_cancellation 행이 없다.
// 문장 시간 한도는 부르는 쪽이 준다. 연결 실패·문장 시간 초과 같은 일시 오류는 WithdrawalOrdersUnavailable(gRPC UNAVAILABLE)이고,
// 그 밖의 SQL 오류는 그대로 던진다(INTERNAL). 주문·표·취소 행을 바꾸는 SQL은 쓰지 않는다.
import { type Database, isTransientError } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { WithdrawalOrdersUnavailable } from '../../../booking/index.js';
import type { WithdrawalTicket, WithdrawalTicketStore } from '../../domain/account-withdrawal-tickets.js';

/** 읽는 주문 상태: 결제가 끝나 표를 가진 주문(취소가 일부 끝난 주문 포함) */
const UNUSED_ORDER_STATUSES = sql.raw(`o.status in ('CONFIRMED', 'PARTIALLY_REFUNDED')`);

// drizzle-orm/node-postgres의 tx.execute는 TIMESTAMPTZ를 Date가 아니라 글이나 Date로 돌려준다(같은 저장소의 drizzle-event-refund-targets.ts와 같은 꼴로 읽는다)
type Row = { ticket_id: string; order_id: string; event_id: string; unit_price: number | string; created_at: Date | string };

export class DrizzleWithdrawalTickets implements WithdrawalTicketStore {
  constructor(private readonly database: Database) {}

  async unusedTicketsOf(accountId: string, o: { statementTimeoutMs: number }): Promise<WithdrawalTicket[]> {
    let rows: Row[];
    try {
      rows = await this.database.transaction(
        async (tx) => {
          const r = await tx.execute(sql`
            select i.ticket_id, i.order_id, o.event_id, i.unit_price, o.created_at
              from order_item i
              join purchase_order o on o.id = i.order_id
             where o.account_id = ${accountId}::uuid
               and ${UNUSED_ORDER_STATUSES}
               and i.ticket_id is not null
               and not exists (select 1 from order_cancellation c where c.order_id = i.order_id and c.ticket_id = i.ticket_id)
             order by i.ticket_id`);
          return r.rows as unknown as Row[];
        },
        { isolationLevel: 'read committed', accessMode: 'read only', statementTimeoutMs: o.statementTimeoutMs },
      );
    } catch (e) {
      if (isTransientError(e)) throw new WithdrawalOrdersUnavailable(e);
      throw e;
    }
    return rows.map((row) => ({ ticketId: row.ticket_id, orderId: row.order_id, eventId: row.event_id, ticketPrice: Number(row.unit_price), bookedAtMs: new Date(row.created_at).getTime() }));
  }

  /** 그 계정 주문의 order_cancellation 가운데 사유 ACCOUNT_WITHDRAWAL이고 상태가 REQUESTED·REFUND_PENDING인 표 수 */
  async pendingRefunds(accountId: string, o: { statementTimeoutMs: number }): Promise<number> {
    try {
      const r = await this.database.transaction(
        async (tx) => {
          const q = await tx.execute(sql`
            select count(*)::int as pending
              from order_cancellation c
              join purchase_order o on o.id = c.order_id
             where o.account_id = ${accountId}::uuid
               and c.reason = 'ACCOUNT_WITHDRAWAL'
               and c.status in ('REQUESTED', 'REFUND_PENDING')`);
          return q.rows as unknown as Array<{ pending: number | string }>;
        },
        { isolationLevel: 'read committed', accessMode: 'read only', statementTimeoutMs: o.statementTimeoutMs },
      );
      return Number(r[0]?.pending ?? 0);
    } catch (e) {
      if (isTransientError(e)) throw new WithdrawalOrdersUnavailable(e);
      throw e;
    }
  }

  /** 취소 ID로 취소 행의 상태(행을 쓴 뒤 실패한 표를 두 번 세지 않게). 없으면 undefined */
  async cancellationStatus(cancellationId: string): Promise<string | undefined> {
    try {
      const [row] = await this.database.db.execute(sql`select status from order_cancellation where id = ${cancellationId}::uuid`).then((r) => r.rows as unknown as Array<{ status: string }>);
      return row?.status;
    } catch (e) {
      if (isTransientError(e)) throw new WithdrawalOrdersUnavailable(e);
      throw e;
    }
  }
}
