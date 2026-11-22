// @peaket/widget-purchase: 관제 원격 위젯(구매 팀 주인, docs/frontend.md §4.5).
// 퍼블리싱 화면(?state=)은 이 묶음을 workspace:로 그린다. 실제 값의 원격 노출은 ./remote(Module Federation ./widgets, ADR-0360)이다.
export { type WidgetBaseProps } from './common';
export { SeatHoldWidget, type SeatHoldWidgetProps, type SeatHoldData } from './SeatHoldWidget';
export { PaymentBudgetWidget, type PaymentBudgetWidgetProps, type PaymentBudgetData, type JourneyBudget } from './PaymentBudgetWidget';
export { PgStatusWidget, type PgStatusWidgetProps, type PgStatusData } from './PgStatusWidget';
export { FunnelWidget, type FunnelWidgetProps, type FunnelData, type FunnelStep } from './FunnelWidget';

/** 위젯 정보(WidgetManifest의 퍼블리싱 판). 권한 이름은 frontend §4.5 예시 */
export const PURCHASE_WIDGETS = [
  { name: 'purchase-seat-hold', title: '좌석 홀드 p99', permissions: ['ops:read'] },
  { name: 'purchase-payment-budget', title: '결제 확정·남은 허용 실패', permissions: ['ops:read'] },
  { name: 'purchase-pg-status', title: '결제사', permissions: ['ops:read'] },
  { name: 'purchase-funnel', title: '퍼널(F3)', permissions: ['ops:read'] },
] as const;
