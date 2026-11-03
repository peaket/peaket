// 원본 DB에서 옮길 표와 칸의 고정 목록(docs/data.md의 정본 칸). 불변식에 필요한 칸만 읽는다(ASVS v5.0.0-14.2.6).
// 예매자 성명·휴대폰(purchase_order.buyer_name·buyer_phone), 가상계좌 번호 같은 개인정보 칸은 넣지 않는다(14.1.1).
// 표·칸 이름은 이 목록에서만 SQL에 들어간다(사용자 입력으로 SQL을 만들지 않는다, 1.2.4).
export const SOURCES = ['purchase', 'payment', 'ticket'] as const;
export type SourceName = (typeof SOURCES)[number];

export interface SourceTable {
  name: string;
  source: SourceName;
  columns: readonly string[];
}

export const SOURCE_TABLES: readonly SourceTable[] = [
  { name: 'purchase_order', source: 'purchase', columns: ['id', 'account_id', 'event_id', 'status', 'amount', 'created_at'] },
  { name: 'order_event', source: 'purchase', columns: ['order_id', 'seq', 'to_status', 'occurred_at'] },
  { name: 'order_item', source: 'purchase', columns: ['order_id', 'line_no', 'seat_id', 'ticket_id'] },
  { name: 'order_cancellation', source: 'purchase', columns: ['id', 'order_id', 'ticket_id', 'status'] },
  { name: 'seat_sale', source: 'purchase', columns: ['event_id', 'seat_id', 'order_id', 'status'] },
  { name: 'purchase_quota', source: 'purchase', columns: ['account_id', 'event_id', 'used', 'limit_count'] },
  { name: 'event_sale', source: 'purchase', columns: ['event_id', 'sellable_seats'] },
  { name: 'ticket_issue_job', source: 'purchase', columns: ['order_id', 'event_id', 'issue_due_at', 'created_at'] },
  { name: 'payment', source: 'payment', columns: ['id', 'order_id', 'event_id', 'pg', 'amount', 'status', 'approved_at'] },
  { name: 'payment_cancel', source: 'payment', columns: ['id', 'payment_id', 'amount', 'status', 'canceled_at'] },
  {
    name: 'settlement_statement',
    source: 'payment',
    columns: ['id', 'kind', 'event_id', 'pg', 'gross_amount', 'refund_amount', 'payout_amount', 'revision', 'excluded_payments', 'status'],
  },
  { name: 'statement_source', source: 'payment', columns: ['statement_id', 'source_id', 'kind', 'payment_id', 'amount'] },
  { name: 'payout', source: 'payment', columns: ['id', 'statement_id', 'amount', 'status'] },
  { name: 'partner_receivable', source: 'payment', columns: ['id', 'amount', 'remaining'] },
  { name: 'receivable_movement', source: 'payment', columns: ['id', 'receivable_id', 'kind', 'amount'] },
  { name: 'reconciliation_run', source: 'payment', columns: ['id', 'pg', 'recon_date', 'status'] },
  { name: 'ticket', source: 'ticket', columns: ['id', 'event_id', 'seat_id', 'status'] },
];

export type TableName = (typeof SOURCE_TABLES)[number]['name'];

export const tableByName = (name: string): SourceTable => {
  const t = SOURCE_TABLES.find((x) => x.name === name);
  if (!t) throw new Error(`모르는 원본 표: ${name}`);
  return t;
};
