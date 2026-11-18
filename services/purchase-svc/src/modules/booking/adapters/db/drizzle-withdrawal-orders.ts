// 탈퇴 참여자의 계정 주문 찾기(WithdrawalOrders, docs/features/payment.md §4.1 '탈퇴 참여자의 첫 구현' '찾기', docs/data.md §5.1 '탈퇴 참여자의 계정 주문 찾기',
// ADR-0284, BUILD_ORDER PRF-169). 호출마다 한 문장이고 인덱스 purchase_order_account_idx (account_id, id)를 탄다. 그 계정 ID의 주문만 읽는다.
// 문장 시간 한도는 부르는 쪽이 min(400ms [가정], 남은 시간)으로 준다. 연결 실패·문장 시간 초과 같은 일시 오류는 WithdrawalOrdersUnavailable(gRPC UNAVAILABLE)이고,
// 그 밖의 SQL 오류는 그대로 던진다(INTERNAL). 주문 상태를 바꾸는 SQL은 쓰지 않는다.
import { type Database, isTransientError } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { ORDER_STATUSES, type OrderStatus } from '../../domain/order.js';
import { type WithdrawalOrder, type WithdrawalOrders, WithdrawalOrdersUnavailable } from '../../domain/ports.js';

/** 읽는 상태: 결제 결과 대기 다섯과 입금 대기(payment §4.1 '찾기') */
const WITHDRAWAL_OPEN = sql.raw(`status in ('CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'UNKNOWN', 'AWAITING_DEPOSIT')`);

type Row = { id: string; status: string; amount: number | string };

export class DrizzleWithdrawalOrders implements WithdrawalOrders {
  constructor(private readonly database: Database) {}

  async openOrdersOf(accountId: string, o: { statementTimeoutMs: number }): Promise<WithdrawalOrder[]> {
    let rows: Row[];
    try {
      rows = await this.database.transaction(
        async (tx) => {
          const r = await tx.execute(sql`select id, status, amount from purchase_order where account_id = ${accountId}::uuid and ${WITHDRAWAL_OPEN} order by id`);
          return r.rows as unknown as Row[];
        },
        { isolationLevel: 'read committed', accessMode: 'read only', statementTimeoutMs: o.statementTimeoutMs },
      );
    } catch (e) {
      if (isTransientError(e)) throw new WithdrawalOrdersUnavailable(e);
      throw e;
    }
    return rows.map((row) => {
      if (!(ORDER_STATUSES as readonly string[]).includes(row.status)) throw new Error('주문 상태가 정본 목록 밖이다');
      return { orderId: row.id, status: row.status as OrderStatus, amount: Number(row.amount) };
    });
  }
}
