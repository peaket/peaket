// R3 정산 대조(docs/features/analytics.md §7 '정확성(돈)', A-T9, F-04-6).
// 회차·결제사별 티켓 판매 대금(F15 판매 금액 − 되돌림 금액 합)과 환급(F8 환불 금액 합)이 회차 정산서(STATEMENT_NOTIFIED, 판본이 가장 큰 것)와 원 단위로 같은지 본다.
// 상품 정산서(kind PRODUCT)는 대조 대상이 아니다. F8에는 결제사 칸이 없어(§5.2 그레인) 환급은 회차 합으로 견준다.
import type { ClickHouse } from './clickhouse.js';

export interface StatementTotals {
  pg: string;
  sales: number;
  refund: number;
}

export interface Reconciliation {
  /** 판정을 보류할 지표 코드(metric_value의 지표 이름) */
  failed: string[];
  /** 로그·품질 표에 남길 요약(금액만, 개인정보 없음) */
  detail: string;
}

/** 순수 계산: 결제사별 골드 판매 대금과 회차 환급 합을 정산서와 견준다 */
export function reconcile(goldSalesByPg: ReadonlyMap<string, number>, goldRefund: number, statements: readonly StatementTotals[]): Reconciliation {
  if (statements.length === 0) return { failed: ['sales_amount', 'refunds'], detail: '정산서 없음' };
  const failed = new Set<string>();
  const parts: string[] = [];
  const stmt = new Map(statements.map((s) => [s.pg, s]));
  const pgs = new Set([...stmt.keys(), ...[...goldSalesByPg].filter(([, v]) => v !== 0).map(([k]) => k)]);
  for (const pg of [...pgs].sort()) {
    const g = goldSalesByPg.get(pg) ?? 0;
    const s = stmt.get(pg)?.sales ?? 0;
    if (g !== s) {
      failed.add('sales_amount');
      parts.push(`${pg || '결제사 없음'} 판매 대금 골드 ${g} ≠ 정산서 ${s}`);
    }
  }
  const refundStmt = statements.reduce((a, s) => a + s.refund, 0);
  if (goldRefund !== refundStmt) {
    failed.add('refunds');
    parts.push(`환급 골드 ${goldRefund} ≠ 정산서 ${refundStmt}`);
  }
  return { failed: [...failed], detail: parts.length ? parts.join('; ') : '정산서와 0원 차이' };
}

/** 이번 판의 골드와 정산서를 읽어 견준다 */
export async function reconcileRun(ch: ClickHouse, eventId: string, runId: string): Promise<Reconciliation> {
  const gold = await ch.query<{ pg: string; amount: string }>(
    'SELECT pg, toString(sum(sales_amount) - sum(reversed_amount)) AS amount FROM gold.fct_sales_daily WHERE event_id = {e:String} AND run_id = {r:String} GROUP BY pg',
    { e: eventId, r: runId },
  );
  const refund = await ch.query<{ amount: string }>('SELECT toString(sum(refund_amount)) AS amount FROM gold.fct_refund_daily WHERE event_id = {e:String} AND run_id = {r:String}', { e: eventId, r: runId });
  const statements = await ch.query<{ pg: string; sales: string; refund: string }>(
    "SELECT pg, toString(argMax(sales_amount, revision)) AS sales, toString(argMax(refund_amount, revision)) AS refund FROM staging.stg_settlement_event WHERE event_id = {e:String} AND type = 'STATEMENT_NOTIFIED' AND kind = 'EVENT' GROUP BY pg",
    { e: eventId },
  );
  return reconcile(
    new Map(gold.map((r) => [r.pg, Number(r.amount)])),
    Number(refund[0]?.amount ?? 0),
    statements.map((s) => ({ pg: s.pg, sales: Number(s.sales), refund: Number(s.refund) })),
  );
}
