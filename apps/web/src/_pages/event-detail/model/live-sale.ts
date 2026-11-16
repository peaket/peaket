// SCR-002 공연 상세의 등급별 실시간 판매 상태: 대기 상태 파일 구간 0의 saleStatus·soldOutTiers(ADR-0272 결정 1, BUILD_ORDER HOT-346).
// 순수 함수만 둔다(node --test가 바로 불러 본다). 새 경로·새 파일은 만들지 않고, queue-svc가 내는 구간 0 파일(openapi QueueState)을 쓴다.
// 실패(404·5xx·연결 실패·시간 한도·모양 틀림·모르는 saleStatus)는 unknown이고 화면은 고정 글 '판매 중'(d5 '잔여석 조회 실패', POL-029)이다.

export type LiveSaleStatus = 'ON_SALE' | 'PAUSED' | 'ALL_HELD' | 'TIER_SOLD_OUT' | 'SOLD_OUT' | 'ENDED';

export type LiveSale = { status: 'loading' } | { status: 'unknown' } | { status: 'known'; saleStatus: LiveSaleStatus; soldOutTiers: string[] };

/** 상태 파일 요청 설정(쿠키 없이 브라우저 HTTP 캐시만 건너뛴다, docs/frontend.md §5.9) */
export const LIVE_SALE_FETCH_INIT: RequestInit = { credentials: 'omit', cache: 'no-store' };

const STATUSES: readonly LiveSaleStatus[] = ['ON_SALE', 'PAUSED', 'ALL_HELD', 'TIER_SOLD_OUT', 'SOLD_OUT', 'ENDED'];

/** 응답 → 화면 값. 200이고 모양이 맞을 때만 known */
export function toLiveSale(httpStatus: number, body: unknown): LiveSale {
  const unknown = { status: 'unknown' } as const;
  if (httpStatus !== 200 || typeof body !== 'object' || body === null) return unknown;
  const b = body as { saleStatus?: unknown; soldOutTiers?: unknown };
  if (!STATUSES.includes(b.saleStatus as LiveSaleStatus) || !Array.isArray(b.soldOutTiers)) return unknown;
  return { status: 'known', saleStatus: b.saleStatus as LiveSaleStatus, soldOutTiers: (b.soldOutTiers as unknown[]).filter((t): t is string => typeof t === 'string') };
}

/** 상태 파일 구간 0의 주소(회차 ID는 인코딩, 쿼리·캐시 버스터 없음) */
export function liveSaleUrl(filesOrigin: string, eventId: string): string {
  return `${filesOrigin.replace(/\/+$/, '')}/v1/queues/${encodeURIComponent(eventId)}/segment-states/0.json`;
}
