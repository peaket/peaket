// 불변식 목록(docs/verification.md §2.5 '판정'). 하나 = sql/의 파일 하나이고, 파일은 위반 행만 subject·detail로 돌려준다.
// requires의 표가 원본에 없거나 records가 필요한데 시험 기록이 없으면 SKIPPED다.
import type { TableName } from './tables.js';

export interface InvariantDef {
  id: string;
  name: string;
  file: string;
  requires: readonly TableName[];
  /** 시험 기록이 있어야 센다 */
  records?: boolean;
  /** 결과를 모르는 요청 수를 세는 SQL(대기열 기록) */
  unknownSql?: string;
}

export const INVARIANTS: readonly InvariantDef[] = [
  {
    id: 'Q1',
    name: '차례 전 입장',
    file: 'q1_admit_before_turn.sql',
    requires: [],
    records: true,
    unknownSql: "SELECT count(*)::int AS n FROM pg_temp.rec_queue_admit WHERE result = 'unknown'",
  },
  {
    id: 'Q2',
    name: '같은 세대 순번 중복',
    file: 'q2_seq_duplicate.sql',
    requires: [],
    records: true,
    unknownSql: "SELECT count(*)::int AS n FROM pg_temp.rec_queue_entry WHERE result = 'unknown'",
  },
  { id: 'S1', name: '오버셀(좌석당 활성 판매 둘 이상)', file: 's1_seat_oversell.sql', requires: ['seat_sale'] },
  { id: 'S2', name: '오버셀(판매 대상 좌석 수 초과)', file: 's2_sold_over_capacity.sql', requires: ['seat_sale', 'event_sale'] },
  { id: 'S3', name: '오버셀(좌석당 유효 티켓 둘 이상)', file: 's3_ticket_double_seat.sql', requires: ['ticket'] },
  { id: 'S4', name: '1인 한도 초과', file: 's4_quota_exceeded.sql', requires: ['seat_sale', 'purchase_order', 'purchase_quota'] },
  { id: 'P1', name: '이중 결제(결제 원장)', file: 'p1_double_payment_ledger.sql', requires: ['payment'] },
  { id: 'P2', name: '이중 결제(결제사 원장)', file: 'p2_double_payment_pg.sql', requires: [], records: true },
  { id: 'P3', name: '결제-발권 불일치(승인 뒤 큐 등록 시한 초과)', file: 'p3_approved_not_enqueued.sql', requires: ['payment', 'payment_cancel', 'order_event'] },
  { id: 'P4', name: '결제-발권 불일치(발권 기한 초과)', file: 'p4_issue_deadline_exceeded.sql', requires: ['payment', 'order_event', 'ticket_issue_job'] },
  { id: 'P5', name: '결제-발권 불일치(승인 없는 발권)', file: 'p5_ticket_without_approval.sql', requires: ['ticket', 'order_item', 'order_cancellation', 'payment'] },
  { id: 'P6', name: '결제-발권 불일치(원장이 모르는 결제사 승인)', file: 'p6_pg_charge_unknown_to_ledger.sql', requires: ['payment'], records: true },
  { id: 'M1', name: '정산: 완료 지급 합 = 지급액(PAID)', file: 'm1_paid_payout_sum.sql', requires: ['settlement_statement', 'payout'] },
  { id: 'M2', name: '정산: 한 정산서의 지급 건 합 ≤ 지급액', file: 'm2_payout_over_statement.sql', requires: ['settlement_statement', 'payout'] },
  { id: 'M3', name: '정산: 미수금 남은 금액 = 금액 − 이동 기록 합 ≥ 0', file: 'm3_receivable_remaining.sql', requires: ['partner_receivable', 'receivable_movement'] },
  { id: 'M4', name: '정산: 한 환급이 두 정산서에 없음', file: 'm4_refund_in_two_statements.sql', requires: ['settlement_statement', 'statement_source'] },
  {
    id: 'M5',
    name: '정산: 판매 대금 = 그 판이 쓴 대사 완료 승인 합',
    file: 'm5_statement_gross_reconciled.sql',
    requires: ['settlement_statement', 'statement_source', 'payment', 'reconciliation_run'],
  },
];
