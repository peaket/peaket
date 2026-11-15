// SCR-002 공연 상세의 등급별 실시간 판매 상태: 대기 상태 파일 구간 0의 saleStatus·soldOutTiers(ADR-0272 결정 1, BUILD_ORDER HOT-346).
// 순수 함수만 둔다(node --test가 바로 불러 본다). 시험 담당이 만든 빈 뼈대이고, 동작은 구현 담당이 채운다(ADR-0270 결정 1).

export type LiveSaleStatus = 'ON_SALE' | 'PAUSED' | 'ALL_HELD' | 'TIER_SOLD_OUT' | 'SOLD_OUT' | 'ENDED';

export type LiveSale = { status: 'loading' } | { status: 'unknown' } | { status: 'known'; saleStatus: LiveSaleStatus; soldOutTiers: string[] };

/** 상태 파일 요청 설정(쿠키 없이 브라우저 HTTP 캐시만 건너뛴다, docs/frontend.md §5.9) */
export const LIVE_SALE_FETCH_INIT: RequestInit = { credentials: 'omit', cache: 'no-store' };

const notYet = (): never => {
  throw new Error('아직 없음');
};

/** 응답 → 화면 값. 200이고 모양이 맞을 때만 known */
export function toLiveSale(httpStatus: number, body: unknown): LiveSale {
  void httpStatus;
  void body;
  return notYet();
}

/** 상태 파일 구간 0의 주소 */
export function liveSaleUrl(filesOrigin: string, eventId: string): string {
  void filesOrigin;
  void eventId;
  return notYet();
}
