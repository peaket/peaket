// 환급 잇기(offline-gate §7.3 '환급 잇기', BUILD_ORDER GAT-180)의 포트. 어댑터가 구현하고 유스케이스가 쓴다.
/** core-svc 판매 설정의 마감 시각. null은 아직, undefined는 모름 */
export interface EntryCloseTimes {
  closedAtMs(eventId: string): Promise<number | null | undefined>;
}

export interface EntryCloseDueStore {
  /** 기다리는 행(refund_due_at > nowMs)이 있는 회차를 (가장 이른 refund_due_at, 회차 ID) 차례로 limit개까지 */
  waitingEvents(nowMs: number, limit: number, after?: { dueAtMs: number; eventId: string }): Promise<{ eventId: string; dueAtMs: number }[]>;
  /** 그 회차의 조건에 맞는 행만 마감 시각으로 당기고 바꾼 행 수를 준다 */
  pullDue(eventId: string, closedAtMs: number): Promise<number>;
}

export type EntryCloseDueResult = 'moved' | 'not_closed' | 'unavailable';

export interface EntryCloseDueMetrics {
  inc(labels: { result: EntryCloseDueResult }): void;
}
