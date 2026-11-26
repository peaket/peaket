// SCR-063 공연 개요·회차 허브의 화면 값(API 개요 → 문맥 머리·진행 단계·회차 표). 정본: d5 §6.3.
// 목업 LUMEN 값을 빌려 쓰지 않고, 없는 값은 null·빈 배열·'—'로 남긴다.
import type { PartnerHomeEvent, PartnerHomeSaleStatus, PartnerProductionOverview } from '@/shared/api/partner-live';
import type { Performance, Production, SaleReview, SaleStatus } from '@/entities/production';
import { kstDayText, kstStamp, kstTime } from '@/shared/lib/kst';

export type OverviewMode = 'live' | 'preview';
export type OverviewSaleStatus = 'UPCOMING' | 'ON_SALE' | 'SOLD_OUT' | 'ENDED' | 'NONE';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 소문자 UUID 공연이고 `?state=`가 없을 때만 실제 API로 간다. 목업 ID·미리보기는 preview다. */
export function overviewModeOf(id: string, sp: { state?: string } | undefined): OverviewMode {
  return UUID.test(id) && sp?.state === undefined ? 'live' : 'preview';
}

/** 승인 이력으로 재승인 대기·변경 반려를 가른다. */
export function reviewOfDetail(detail: Pick<PartnerProductionOverview, 'saleReview' | 'hasApprovalHistory'>): SaleReview {
  if (detail.saleReview === 'SUBMITTED' && detail.hasApprovalHistory) return 'RESUBMITTED';
  if (detail.saleReview === 'REJECTED' && detail.hasApprovalHistory) return 'CHANGE_REJECTED';
  return detail.saleReview;
}

/** 회차 판매 상태를 공연 하나로 합친다. ON_SALE·ALL_HELD가 있으면 판매 중, 없으면 오픈 예정, 모두 매진이면 매진, 그 밖은 종료. */
export function saleStatusOfEvents(events: readonly Pick<PartnerHomeEvent, 'saleStatus'>[]): OverviewSaleStatus {
  if (events.length === 0) return 'NONE';
  if (events.some((e) => e.saleStatus === 'ON_SALE' || e.saleStatus === 'ALL_HELD')) return 'ON_SALE';
  if (events.some((e) => e.saleStatus === 'UPCOMING')) return 'UPCOMING';
  if (events.every((e) => e.saleStatus === 'SOLD_OUT')) return 'SOLD_OUT';
  return 'ENDED';
}

const SALE_STATUS_TEXT: Record<Exclude<PartnerHomeSaleStatus, null>, string> = {
  UPCOMING: '오픈 예정',
  ON_SALE: '판매 중',
  ALL_HELD: '일시 매진',
  SOLD_OUT: '매진',
  ENDED: '판매 종료',
};

export interface EventRow {
  eventId: string;
  startsAt: string;
  doorsAt: string;
  endsAt: string;
  saleStatusText: string;
  saleRateText: string;
  saleStatus: SaleStatus | 'ALL_HELD';
  saleRate: number | null;
}

/** 회차 표·카드의 값. 판매 상태와 판매율이 없으면 '—'다. */
export function eventRowsOf(events: readonly PartnerHomeEvent[]): EventRow[] {
  return events.map((e) => ({
    eventId: e.eventId,
    startsAt: kstStamp(e.startsAt),
    doorsAt: kstTime(e.entryOpensAt),
    endsAt: kstTime(e.endsAt),
    saleStatusText: e.saleStatus === null ? '—' : SALE_STATUS_TEXT[e.saleStatus],
    saleRateText: e.soldPercent === null ? '—' : `${e.soldPercent}%`,
    saleStatus: e.saleStatus ?? 'NONE',
    saleRate: e.soldPercent,
  }));
}

export type OverviewProduction = Production & { placeName: string | null; artistNames: string[] };

const suspensionText = (code: PartnerProductionOverview['suspensionReasonCode']): string => {
  switch (code) {
    case 'SELLER_IDENTITY':
      return '판매자 신원 확인 필요';
    case 'LEGAL_REQUEST':
      return '법적 요청';
    case 'FRAUD_SUSPECTED':
      return '부정 판매 의심';
    case 'OTHER':
      return '기타';
    default:
      return '판매가 멈췄습니다';
  }
};

/** 공연 문맥 머리·회차 표가 쓰는 Production 모양. 없는 값은 목업 LUMEN이 아니라 빈 값이다. */
export function productionOfDetail(detail: PartnerProductionOverview): OverviewProduction {
  const events = detail.events;
  const first = events[0];
  const review = reviewOfDetail(detail);
  const note =
    review === 'REJECTED' || review === 'CHANGE_REJECTED'
      ? `사유: ${detail.rejectionReason ?? '확인 필요'}`
      : review === 'SUSPENDED'
        ? `사유: ${suspensionText(detail.suspensionReasonCode)}`
        : review === 'RESUBMITTED'
          ? '판매 계속 · 공개 중인 내용과 판매는 승인될 때까지 그대로입니다'
          : review === 'SUBMITTED'
            ? 'PEAKET 운영자가 확인하고 있습니다'
            : undefined;
  const rounds: Performance[] = eventRowsOf(events).map((r) => ({
    id: r.eventId,
    startsAt: r.startsAt,
    doorsAt: r.doorsAt,
    endsAt: r.endsAt,
    saleStatus: r.saleStatus === 'ALL_HELD' ? 'ON_SALE' : r.saleStatus,
    saleRate: r.saleRate,
  }));
  return {
    id: detail.productionId,
    name: detail.title,
    venueId: '',
    genre: detail.genre,
    review,
    ...(note ? { reviewNote: note } : {}),
    firstOpenAt: first ? kstStamp(first.openAt) : null,
    saleStatus: saleStatusOfEvents(events),
    saleRate: null,
    rounds,
    roundCount: events.length,
    priceTiers: [],
    queueMode: 'HYBRID',
    seatMode: first?.seatAssignment ?? 'PICK',
    perPersonLimit: first?.perPersonLimit ?? 0,
    reentry: first?.reentryAllowed ?? false,
    xl: { provider: '—', settlement: '—', staff: '—' },
    placeName: detail.place?.name ?? null,
    artistNames: detail.artists.map((a) => a.name),
  };
}

export interface ProgressStep {
  label: string;
  meta: string;
}

const PROGRESS_ORDER = ['REGISTRATION', 'SALE_REVIEW', 'OPEN', 'SALE', 'ENTRY', 'ENTRY_RECORD_CLOSED', 'SETTLEMENT'] as const;
const PROGRESS_LABEL = ['등록', '판매 승인', '오픈', '판매', '입장', '입장 기록 마감', '정산'] as const;

/** API 진행 단계를 d5 일곱 단계의 이름·지금 위치로 바꾼다. 모르는 값은 current -1이다. */
export function progressOf(detail: Pick<PartnerProductionOverview, 'progressStage' | 'events' | 'saleApprovedAt'>): { steps: ProgressStep[]; current: number } {
  const first = detail.events[0];
  const open = first ? kstStamp(first.openAt) : '—';
  const entry = first ? kstStamp(first.entryOpensAt ?? first.startsAt) : '—';
  const meta = [
    '완료',
    detail.saleApprovedAt ? `${kstDayText(detail.saleApprovedAt)} 승인` : '판매 승인',
    open,
    saleStatusOfEvents(detail.events) === 'ON_SALE' ? '판매 중' : '판매',
    entry,
    '회차마다',
    '회차 종료 다음 영업일',
  ];
  return {
    steps: PROGRESS_LABEL.map((label, i) => ({ label, meta: meta[i]! })),
    current: PROGRESS_ORDER.indexOf(detail.progressStage as (typeof PROGRESS_ORDER)[number]),
  };
}
