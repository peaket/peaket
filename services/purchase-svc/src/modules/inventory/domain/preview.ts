// 사전 모의(F-02-5)의 포트·상수·응답 꼴. 어댑터가 응용 층을 가져오지 않게 도메인에 둔다(architecture §3.1).
export interface PreviewCount {
  readonly key: string;
  readonly value: number;
  readonly source: string;
  readonly measuredAtMs: number;
}

export interface PreviewUnavailable {
  readonly key: string;
  readonly reason: string;
}

export const PURCHASE_PREVIEW_KEYS = ['purchaseSessions', 'paymentSessions', 'holdsPerSecond5m', 'paymentAcceptsPerSecond5m'] as const;
export const PREVIEW_WINDOW_MS = 5 * 60_000;
/** Paying 수를 세는 색인 멤버 상한 [가정](계획 14절 1) */
export const PAYING_COUNT_MAX = 10_000;
/** 초당으로 바꾸는 나눗수(5분 = 300초) */
export const PREVIEW_DIVISOR = 300;

export interface PurchaseSessionCounter {
  count(eventId: string): Promise<{ sessions: number; paying: number } | 'too-many'>;
}

export interface SaleRecordCounter {
  count(eventId: string, sinceMs: number): Promise<{ holds?: number; accepts?: number }>;
}
