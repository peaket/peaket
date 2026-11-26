// SCR-062 파트너 홈·공연 목록의 화면 값(API 요약 → 화면 행). 정본: d5 §6.2, POL-030·037.
// 값 가져오기는 기존 상수를 쓰고, 없는 값은 목업이 아니라 빈 값·'—'로 그린다.
import { SALE_REVIEW_BADGE, SALE_REVIEW_LABEL, type SaleReview } from '@/shared/lib/sale-review';
import { PARTNER_SUPPORT_HREF, routes } from '@/shared/config/routes';
import { kstDate, kstDayText, kstStamp } from '@/shared/lib/kst';

export type ApiSaleReview = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type ApiSaleStatus = 'UPCOMING' | 'ON_SALE' | 'ALL_HELD' | 'SOLD_OUT' | 'ENDED' | null;
export type SuspensionCode = 'SELLER_IDENTITY' | 'LEGAL_REQUEST' | 'FRAUD_SUSPECTED' | 'OTHER' | null;

export interface PartnerSummaryLike {
  productionId: string;
  title: string;
  eventCount: number;
  saleReview: ApiSaleReview;
  hasApprovalHistory: boolean;
  rejectionReason?: string | null;
  suspensionReasonCode?: SuspensionCode;
  firstOpenAt?: string | null;
  saleStatus?: ApiSaleStatus;
  pgPrimary?: 'TOSS' | 'PORTONE' | null;
  payoutHoldReason?: string | null;
}

export interface PartnerPageLike {
  items: PartnerSummaryLike[];
  nextCursor: string | null;
}

export interface HomeRow {
  productionId: string;
  name: string;
  eventCount: number;
  reviewLabel: string;
  reviewBadge: string;
  reviewNote: string | null;
  firstOpenText: string;
  saleStatusText: string;
  saleStatusBadge: string;
  nextActions: { href: string; label: string }[];
  xl: { provider: string; settlement: string; staff: string };
}

export interface TodoCard {
  label: string;
  value: string;
  meta: string;
  href?: string;
}

export interface TodoLike {
  asOf: string;
  rejectedSaleReviewCount?: number | null;
  settlementDisputeDueCount?: number | null;
  settlementDisputeEarliestDueAt?: string | null;
  openGateFlagCount?: number | null;
  pendingStaffInvitationCount?: number | null;
}

/** `?state=`가 없으면 실제 API(live), 있으면 지금 목업 보드(preview)다. */
export function homeModeOf(sp: { state?: string } | undefined): 'live' | 'preview' {
  return sp?.state === undefined ? 'live' : 'preview';
}

export function suspensionReasonText(code: SuspensionCode): string {
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
}

/** 승인 이력으로 재승인 대기·변경 반려를 접고, 반려·판매 중지 사유를 화면 말로 만든다. */
export function reviewCellOf(item: Pick<PartnerSummaryLike, 'saleReview' | 'hasApprovalHistory' | 'rejectionReason' | 'suspensionReasonCode'>): {
  label: string;
  badge: string;
  note: string | null;
} {
  const display: SaleReview =
    item.saleReview === 'SUBMITTED' && item.hasApprovalHistory
      ? 'RESUBMITTED'
      : item.saleReview === 'REJECTED' && item.hasApprovalHistory
        ? 'CHANGE_REJECTED'
        : item.saleReview;
  const note =
    display === 'RESUBMITTED'
      ? '판매 계속 · 공개 중인 내용과 판매는 승인될 때까지 그대로입니다'
      : display === 'SUBMITTED'
        ? 'PEAKET 운영자가 확인하고 있습니다'
        : display === 'REJECTED' || display === 'CHANGE_REJECTED'
          ? `사유: ${item.rejectionReason ?? '확인 필요'}`
          : display === 'SUSPENDED'
            ? `사유: ${suspensionReasonText(item.suspensionReasonCode ?? null)}`
            : null;
  return { label: SALE_REVIEW_LABEL[display], badge: SALE_REVIEW_BADGE[display], note };
}

const SALE_STATUS_TEXT: Record<Exclude<ApiSaleStatus, null>, string> = {
  UPCOMING: '오픈 예정',
  ON_SALE: '판매 중',
  ALL_HELD: '일시 매진',
  SOLD_OUT: '매진',
  ENDED: '판매 종료',
};
const SALE_STATUS_BADGE: Record<Exclude<ApiSaleStatus, null>, string> = {
  UPCOMING: 'badge badge-primary',
  ON_SALE: 'badge badge-success',
  ALL_HELD: 'badge badge-warning',
  SOLD_OUT: 'badge badge-danger',
  ENDED: 'badge',
};

/** 다음 할 일. 반려는 고쳐서 다시 요청, 판매 중지는 지원 문의, 승인 전은 행동 없음, 승인 뒤는 판매 현황·현장. */
export function nextActionsOf(item: Pick<PartnerSummaryLike, 'productionId' | 'saleReview' | 'hasApprovalHistory' | 'saleStatus'>): { href: string; label: string }[] {
  if (item.saleReview === 'DRAFT' || item.saleReview === 'SUBMITTED') return [];
  if (item.saleReview === 'SUSPENDED') return [{ href: PARTNER_SUPPORT_HREF, label: '파트너 지원 문의' }];
  if (item.saleReview === 'REJECTED') return [{ href: routes.eventTab(item.productionId, 'edit'), label: '고쳐서 다시 요청' }];
  const links = [{ href: routes.eventTab(item.productionId, 'live'), label: '판매 현황' }];
  if (item.saleStatus !== 'SOLD_OUT') links.push({ href: routes.eventTab(item.productionId, 'staff'), label: '현장' });
  return links;
}

export interface HomeFilterInput {
  saleReview?: string;
  saleStatus?: string;
  period?: string;
  q?: string;
}

/** 화면 필터 여덟 이름을 API 쿼리로 바꾼다. '승인 대기'는 이력 조건 없이 SUBMITTED다. */
export function homeQueryOf(input: HomeFilterInput, now: Date): {
  saleReview?: string[];
  hasApprovalHistory?: boolean;
  saleStatus?: string[];
  from?: string;
  to?: string;
  q?: string;
} {
  const out: { saleReview?: string[]; hasApprovalHistory?: boolean; saleStatus?: string[]; from?: string; to?: string; q?: string } = {};
  switch (input.saleReview) {
    case '초안':
      out.saleReview = ['DRAFT'];
      break;
    case '승인 대기':
      out.saleReview = ['SUBMITTED'];
      break;
    case '재승인 대기':
      out.saleReview = ['SUBMITTED'];
      out.hasApprovalHistory = true;
      break;
    case '승인':
      out.saleReview = ['APPROVED'];
      break;
    case '반려':
      out.saleReview = ['REJECTED'];
      break;
    case '변경 반려':
      out.saleReview = ['REJECTED'];
      out.hasApprovalHistory = true;
      break;
    case '판매 중지':
      out.saleReview = ['SUSPENDED'];
      break;
    default:
      break;
  }
  switch (input.saleStatus) {
    case '오픈 예정':
      out.saleStatus = ['UPCOMING'];
      break;
    case '판매 중':
      out.saleStatus = ['ON_SALE'];
      break;
    case '매진':
      out.saleStatus = ['SOLD_OUT'];
      break;
    case '판매 종료':
      out.saleStatus = ['ENDED'];
      break;
    default:
      break;
  }
  if (input.period === '다가오는·진행 중 공연') out.from = kstDate(now);
  if (input.period === '지난 공연') out.to = kstDate(new Date(now.getTime() - 86_400_000));
  const q = input.q?.trim();
  if (q) out.q = q;
  return out;
}

const valueOf = (n: number | null | undefined) => (n === null || n === undefined ? '확인할 수 없음' : `${n}건`);

/** 할 일 카드 넷. 0은 '0건', null은 '확인할 수 없음'이다. */
export function todoCardsOf(todo: TodoLike): TodoCard[] {
  return [
    { label: '반려된 판매 승인', value: valueOf(todo.rejectedSaleReviewCount), meta: '판매 승인 반려·변경 반려' },
    {
      label: '정산 이의 기한',
      value: valueOf(todo.settlementDisputeDueCount),
      meta: todo.settlementDisputeEarliestDueAt ? `${kstDayText(todo.settlementDisputeEarliestDueAt)}까지` : '',
    },
    { label: '미처리 이상 표시', value: valueOf(todo.openGateFlagCount), meta: '현장 운영 표에서 처리합니다' },
    { label: '수락 안 한 스태프 초대', value: valueOf(todo.pendingStaffInvitationCount), meta: '현장 스태프' },
  ];
}

/** API 요약을 표·카드가 쓰는 행으로 옮긴다. 빈 목록은 빈 배열이다. */
export function homeRowsOf(page: PartnerPageLike): HomeRow[] {
  return page.items.map((item) => {
    const review = reviewCellOf(item);
    // 판매 승인 전·판매 중지 행은 계약 saleStatus가 null이어야 한다. 서버가 값을 잘못 실어도 화면은 숨긴다.
    const saleStatus = item.hasApprovalHistory && item.saleReview !== 'SUSPENDED' ? (item.saleStatus ?? null) : null;
    return {
      productionId: item.productionId,
      name: item.title,
      eventCount: item.eventCount,
      reviewLabel: review.label,
      reviewBadge: review.badge,
      reviewNote: review.note,
      firstOpenText: kstStamp(item.firstOpenAt ?? null),
      saleStatusText: saleStatus === null ? '—' : SALE_STATUS_TEXT[saleStatus],
      saleStatusBadge: saleStatus === null ? '' : SALE_STATUS_BADGE[saleStatus],
      nextActions: nextActionsOf(item),
      xl: {
        provider: item.pgPrimary === 'TOSS' ? '토스페이먼츠' : item.pgPrimary === 'PORTONE' ? '포트원' : '—',
        settlement: item.payoutHoldReason ? `지급 보류 · ${item.payoutHoldReason}` : '—',
        staff: '—',
      },
    };
  });
}
