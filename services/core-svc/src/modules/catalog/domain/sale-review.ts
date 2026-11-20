// 판매 승인 요청·관제 목록·상세의 값·검사(BAT-616 LCH-080, ADR-0327, settlement §3·§9·§10, docs/planning/03 §2.14).
// 요청 본문은 닫힌 객체이고(모르는 칸 400), 여기서는 여러 칸이 함께 맞아야 하는 규칙(통신판매업 신고번호 또는 면제 근거, 휠체어석 확인)만 본다.
// 정산 계좌는 모양만 보고 저장하지 않는다(지급대행 연동 전, LCH-110). 계좌번호 원문은 응답·로그·감사에 싣지 않는다.
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import type { EventStatus, SaleReview } from './production.js';
import type { ShowScale } from './demand-forecast.js';
import type { SellerInfo } from './promoter-contract.js';

/** 파트너가 보내는 판매자 신원정보(openapi SellerInfoInput). 6칸은 필수이고 신고번호·면제 근거 가운데 하나가 필요하다 */
export interface SellerInfoInput {
  legalName: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessRegNo: string;
  mailOrderReportNo?: string;
  exemptionBasis?: string;
}

/** 정산 계좌 모양(openapi PayoutAccountChange). 저장하지 않고 모양만 본다 */
export interface PayoutAccountInput {
  bankCode: string;
  accountNumber: string;
  holderName: string;
}

/** 휠체어석 확인(openapi CreatePartnerProductionSaleReviewBody.accessibleSeating) */
export interface AccessibleSeatingInput {
  confirmed: true;
  shortfallReason?: 'RELAXED_STANDARD' | 'RECOMMENDED_FACILITY' | 'NOT_USED_THIS_SHOW' | 'OTHER';
  note?: string;
}

/** 판매 승인 요청 본문(닫힌 객체) */
export interface SaleReviewRequestBody {
  seller: SellerInfoInput;
  payoutAccount: PayoutAccountInput;
  accessibleSeating: AccessibleSeatingInput;
}

/** 유스케이스 층의 이름 붙은 오류(openapi problem type과 같은 status·title) */
export class SaleReviewProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'SaleReviewProblem';
  }
}

const invalid = (title: string, type = 'sale-review-request-invalid') => new SaleReviewProblem(type, 422, title);

/**
 * 요청 본문의 칸 사이 규칙(400이 아닌 422). 신고번호와 면제 근거는 꼭 하나이고, 휠체어석 확인은 참이어야 한다.
 * 필수 칸·모양·정의 밖 칸은 받는 층의 닫힌 스키마가 400으로 막는다.
 */
export function validateSaleReviewRequest(body: SaleReviewRequestBody): void {
  const hasReport = body.seller.mailOrderReportNo !== undefined && body.seller.mailOrderReportNo.trim() !== '';
  const hasExemption = body.seller.exemptionBasis !== undefined && body.seller.exemptionBasis.trim() !== '';
  if (hasReport === hasExemption) throw invalid('통신판매업 신고번호와 면제 근거 가운데 꼭 하나를 보내 주세요');
  if (body.accessibleSeating.confirmed !== true) throw invalid('휠체어석 수와 위치를 확인해 주세요');
  if (body.accessibleSeating.shortfallReason === 'OTHER' && !body.accessibleSeating.note?.trim()) throw invalid('휠체어석 부족 이유가 OTHER이면 설명이 필요합니다');
}

/** 관제 목록이 받는 상태(DRAFT는 받지 않는다) */
export const SALE_REVIEW_FILTER_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const;
export type SaleReviewFilterStatus = (typeof SALE_REVIEW_FILTER_STATUSES)[number];

export function isSaleReviewFilterStatus(value: string): value is SaleReviewFilterStatus {
  return (SALE_REVIEW_FILTER_STATUSES as readonly string[]).includes(value);
}

export interface OpsSaleReviewQuery {
  /** 비어 있으면 SUBMITTED만 본다 */
  statuses: SaleReviewFilterStatus[];
  cursor?: string | undefined;
  limit: number;
}

/** 관제 판매 승인 목록의 한 줄(openapi OpsSaleReviewItem) */
export interface OpsSaleReviewItem {
  productionId: string;
  title: string;
  promoterId: string;
  promoterName: string;
  status: Exclude<SaleReview, 'DRAFT'>;
  reapproval: boolean;
  submittedAt: Date | null;
  firstOpenAt: Date | null;
  eventCount: number;
  /** LCH-090 전에는 늘 false다 */
  suspensionApprovalPending: boolean;
}

export interface OpsSaleReviewPage {
  items: OpsSaleReviewItem[];
  nextCursor: string | null;
}

/** 관제 확인 패널의 회차 한 줄. 수요 예측은 링크로 가리킨다(SCR-048, BAT-617) */
export interface OpsSaleReviewEvent {
  eventId: string;
  openAt: Date;
  startsAt: Date;
  status: EventStatus;
  scale?: ShowScale;
  demandForecastPath: string;
}

/** 관제 판매 승인 상세(openapi OpsSaleReviewDetail) */
export interface OpsSaleReviewDetail {
  productionId: string;
  title: string;
  promoterId: string;
  promoterName: string;
  status: Exclude<SaleReview, 'DRAFT'>;
  reapproval: boolean;
  submittedAt: Date | null;
  rejectionReason: string | null;
  seller: SellerInfo | null;
  verifiedAt: Date | null;
  /** 확인 패널의 판매 정책(재승인 대기 변경분이 있으면 그 규칙). 읽기 전용이다 */
  salePolicy: SalePolicyRule[];
  events: OpsSaleReviewEvent[];
  suspensionApprovalPending: boolean;
}

/** 파트너 판매 승인 현황의 회차 한 줄(SCR-021 5단계) */
export interface PartnerSaleReviewEvent {
  eventId: string;
  openAt: Date;
  startsAt: Date;
  scale?: ShowScale;
}

/** 파트너가 읽는 판매 승인 현황(얇은 읽기 경로) */
export interface PartnerSaleReviewView {
  saleReview: SaleReview;
  rejectionReason: string | null;
  hasApprovalHistory: boolean;
  submittedAt: Date | null;
  seller: OpsSaleReviewDetail['seller'];
  events: PartnerSaleReviewEvent[];}

const encodeCursor = (at: Date, productionId: string): string => Buffer.from(JSON.stringify([at.toISOString(), productionId])).toString('base64url');

/** 목록 커서는 정렬 키(제출·승인·등록 시각)와 공연 ID다. 같은 시각이 겹쳐도 한 줄씩 넘어간다 */
export function encodeSaleReviewCursor(at: Date, productionId: string): string {
  return encodeCursor(at, productionId);
}

export function decodeSaleReviewCursor(cursor: string): { at: Date; productionId: string } | undefined {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string') return undefined;
    const at = new Date(v[0]);
    return Number.isNaN(at.getTime()) ? undefined : { at, productionId: v[1] };
  } catch {
    return undefined;
  }
}

/** 목록 정렬 키: 제출 시각 → (없으면) 승인 시각 → (없으면) 등록 시각. 저장소마다 같은 값을 쓴다 */
export function saleReviewSortKey(p: { saleSubmittedAt: Date | null; saleApprovedAt: Date | null; saleCreatedAt: Date }): Date {
  return p.saleSubmittedAt ?? p.saleApprovedAt ?? p.saleCreatedAt;
}
