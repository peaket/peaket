// 공연(production)·회차(performance)·판매 승인 상태 목업. 이름·숫자는 캔버스 보드 SCR-062·063의 예시 그대로다.
// 판매 승인 상태는 data.md event.sale_review(DRAFT·SUBMITTED·APPROVED·REJECTED)에 승인 이력 유무와 판매 중지를 더해 화면 이름으로 나눈다
// (docs/planning/03 §2.14, ADR-0123).
import { notFound } from 'next/navigation';

export type SaleReview =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'RESUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CHANGE_REJECTED'
  | 'SUSPENDED';

export const SALE_REVIEW_LABEL: Record<SaleReview, string> = {
  DRAFT: '초안',
  SUBMITTED: '승인 대기',
  RESUBMITTED: '재승인 대기',
  APPROVED: '승인',
  REJECTED: '반려',
  CHANGE_REJECTED: '변경 반려',
  SUSPENDED: '판매 중지',
};

/** 키트 배지 클래스 */
export const SALE_REVIEW_BADGE: Record<SaleReview, string> = {
  DRAFT: 'badge',
  SUBMITTED: 'badge',
  RESUBMITTED: 'badge badge-warning',
  APPROVED: 'badge badge-success',
  REJECTED: 'badge badge-danger',
  CHANGE_REJECTED: 'badge badge-danger',
  SUSPENDED: 'badge badge-danger',
};

export type SaleStatus = 'PRIVATE' | 'UPCOMING' | 'ON_SALE' | 'SOLD_OUT' | 'ENDED' | 'OPEN_PAUSED' | 'NONE';

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = {
  PRIVATE: '비공개',
  UPCOMING: '오픈 예정',
  ON_SALE: '판매 중',
  SOLD_OUT: '매진',
  ENDED: '판매 종료',
  OPEN_PAUSED: '오픈 예약 멈춤',
  NONE: '—',
};

export const SALE_STATUS_BADGE: Record<SaleStatus, string> = {
  PRIVATE: 'badge badge-outline',
  UPCOMING: 'badge badge-primary',
  ON_SALE: 'badge badge-success',
  SOLD_OUT: 'badge badge-danger',
  ENDED: 'badge',
  OPEN_PAUSED: 'badge badge-warning',
  NONE: '',
};

export type QueueMode = 'HYBRID' | 'PREQUEUE_SHUFFLE' | 'FIFO';
export const QUEUE_MODE_LABEL: Record<QueueMode, string> = {
  HYBRID: '하이브리드',
  PREQUEUE_SHUFFLE: '사전 셔플',
  FIFO: '선착순',
};

export interface Performance {
  id: string;
  /** '10/25(일) 18:00 KST' */
  startsAt: string;
  /** 입장 시작 '16:30 KST' */
  doorsAt: string;
  /** 공연 종료 예정 '20:00 KST' */
  endsAt: string;
  saleStatus: SaleStatus;
  /** 잠정 판매율(%). 오픈 전이면 0, 정보 없음은 null */
  saleRate: number | null;
}

export interface PriceTier {
  grade: string;
  price: number;
}

export interface Production {
  id: string;
  name: string;
  venueId: string;
  artistId?: string;
  genre: string;
  review: SaleReview;
  /** 반려·판매 중지 사유 요약 */
  reviewNote?: string;
  /** 판매 승인일 '10/8(목)' */
  approvedAt?: string;
  /** 첫 오픈 '10/14(수) 20:00 KST'. 정하지 않았으면 null, 보드의 자리 표시는 '[오픈 일시]' */
  firstOpenAt: string | null;
  saleStatus: SaleStatus;
  saleRate: number | null;
  rounds: readonly Performance[];
  /** 회차 수(목록 칸). rounds를 다 그리지 않은 목업은 이 값이 더 크다 */
  roundCount: number;
  priceTiers: readonly PriceTier[];
  queueMode: QueueMode;
  seatMode: 'PICK' | 'AUTO';
  perPersonLimit: number;
  reentry: boolean;
  /** 판매 승인 때 운영자가 정하는 규모 */
  scale?: '대형' | '중형' | '소형';
  /** xl 1440 표에 더하는 결제사·정산·현장 스태프 칸(보드 SCR-062-xl) */
  xl: { provider: string; settlement: string; settlementNote?: string; staff: string };
}

const LUMEN_TIERS: readonly PriceTier[] = [
  { grade: 'R', price: 154000 },
  { grade: 'S', price: 132000 },
  { grade: 'A', price: 110000 },
];

/** 공연 관리 목록 순서(첫 오픈 늦은 순, 보드 SCR-062) */
export const productions: readonly Production[] = [
  {
    id: 'evt-fanmeet-2026',
    name: '팬미팅',
    venueId: 'venue-blue-hall',
    genre: '팬미팅',
    review: 'SUBMITTED',
    firstOpenAt: '10/28(수) 20:00 KST',
    saleStatus: 'PRIVATE',
    saleRate: null,
    rounds: [{ id: 'perf-fm-1', startsAt: '11/7(토) 18:00 KST', doorsAt: '17:00 KST', endsAt: '20:00 KST', saleStatus: 'PRIVATE', saleRate: null }],
    roundCount: 1,
    priceTiers: [{ grade: '전석', price: 99000 }],
    queueMode: 'HYBRID',
    seatMode: 'PICK',
    perPersonLimit: 2,
    reentry: false,
    xl: { provider: '승인 때 지정', settlement: '—', staff: '—' },
  },
  {
    id: 'evt-lumen-2026',
    name: 'LUMEN 콘서트 2026 서울',
    venueId: 'venue-peaket-arena',
    artistId: 'art-lumen',
    genre: '콘서트',
    review: 'APPROVED',
    approvedAt: '10/8(목)',
    firstOpenAt: '10/14(수) 20:00 KST',
    saleStatus: 'UPCOMING',
    saleRate: 0,
    rounds: [
      { id: 'perf-lumen-1025', startsAt: '10/25(일) 18:00 KST', doorsAt: '16:30 KST', endsAt: '20:00 KST', saleStatus: 'UPCOMING', saleRate: 0 },
      { id: 'perf-lumen-1026', startsAt: '10/26(월) 17:00 KST', doorsAt: '15:30 KST', endsAt: '19:00 KST', saleStatus: 'UPCOMING', saleRate: 0 },
    ],
    roundCount: 2,
    priceTiers: LUMEN_TIERS,
    queueMode: 'HYBRID',
    seatMode: 'PICK',
    perPersonLimit: 4,
    reentry: false,
    scale: '대형',
    xl: { provider: '토스페이먼츠', settlement: '정산 전', settlementNote: '첫 정산서 10/26(월)', staff: '수락 2 · 대기 5' },
  },
  {
    id: 'evt-small-musical',
    name: '소극장 뮤지컬',
    venueId: 'venue-small-stage',
    genre: '뮤지컬',
    review: 'APPROVED',
    approvedAt: '9/20(일)',
    firstOpenAt: null,
    saleStatus: 'SOLD_OUT',
    saleRate: 100,
    rounds: [],
    roundCount: 3,
    priceTiers: [{ grade: '전석', price: 66000 }],
    queueMode: 'FIFO',
    seatMode: 'PICK',
    perPersonLimit: 2,
    reentry: false,
    xl: { provider: '토스페이먼츠', settlement: '정산 전', staff: '—' },
  },
  {
    id: 'evt-autumn-fest',
    name: '가을 야외 페스티벌',
    venueId: 'venue-peaket-arena',
    genre: '페스티벌',
    review: 'APPROVED',
    approvedAt: '9/28(월)',
    firstOpenAt: null,
    saleStatus: 'ON_SALE',
    saleRate: 62,
    rounds: [{ id: 'perf-fest-1', startsAt: '11/14(토) 13:00 KST', doorsAt: '11:30 KST', endsAt: '21:00 KST', saleStatus: 'ON_SALE', saleRate: 62 }],
    roundCount: 1,
    priceTiers: [
      { grade: '1일권', price: 129000 },
      { grade: '얼리버드', price: 99000 },
    ],
    queueMode: 'HYBRID',
    seatMode: 'AUTO',
    perPersonLimit: 4,
    reentry: true,
    xl: { provider: '포트원', settlement: '정산 전', settlementNote: '첫 정산서 11/9(월)', staff: '—' },
  },
  {
    id: 'evt-winter-fanmeet',
    name: '겨울 팬미팅',
    venueId: 'venue-blue-hall',
    genre: '팬미팅',
    review: 'SUSPENDED',
    reviewNote: '판매자 신원 확인 필요',
    approvedAt: '10/20(화)',
    firstOpenAt: '11/2(월) 20:00 KST',
    saleStatus: 'NONE',
    saleRate: null,
    rounds: [{ id: 'perf-wf-1', startsAt: '12/19(토) 17:00 KST', doorsAt: '16:00 KST', endsAt: '19:00 KST', saleStatus: 'NONE', saleRate: null }],
    roundCount: 1,
    priceTiers: [{ grade: '전석', price: 88000 }],
    queueMode: 'HYBRID',
    seatMode: 'PICK',
    perPersonLimit: 2,
    reentry: false,
    xl: { provider: '토스페이먼츠', settlement: '지급 보류', settlementNote: '판매 중지', staff: '—' },
  },
  {
    id: 'evt-autumn-musical',
    name: '가을 뮤지컬',
    venueId: 'venue-river-theater',
    genre: '뮤지컬',
    review: 'REJECTED',
    reviewNote: '통신판매업 신고번호 누락',
    firstOpenAt: null,
    saleStatus: 'NONE',
    saleRate: null,
    rounds: [],
    roundCount: 12,
    priceTiers: [
      { grade: 'VIP', price: 150000 },
      { grade: 'R', price: 130000 },
      { grade: 'S', price: 100000 },
    ],
    queueMode: 'PREQUEUE_SHUFFLE',
    seatMode: 'PICK',
    perPersonLimit: 4,
    reentry: false,
    xl: { provider: '—', settlement: '—', staff: '—' },
  },
];

/** 공연 개요·좌석맵 등 공연 문맥 화면의 기본 목업 공연 */
export const PRIMARY_PRODUCTION_ID = 'evt-lumen-2026';

export function getProduction(id: string): Production | undefined {
  return productions.find((p) => p.id === id);
}

/** 원 단위 정수를 '₩154,000'으로 */
export function formatWon(won: number): string {
  return `₩${won.toLocaleString('ko-KR')}`;
}

/** 공연 문맥 화면에서: 없는 공연이나 다른 테넌트 공연은 404(d5 §6 머리글). 레이아웃과 페이지가 함께 그려지므로 페이지도 부른다 */
export function requireProduction(id: string): Production {
  const p = getProduction(id);
  if (!p) notFound();
  return p;
}
