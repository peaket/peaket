// SCR-048 판매 승인 화면의 응답→화면 값·승인 본문·오류 문구(BAT-617, LCH-080, d5 §7.9, ADR-0327).
// 승인 본문은 회차별 scales와 (있으면) placeId만 낸다. artistIds·aliases는 계약에 없다(RV-05).
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';

/** 화면이 읽는 문제 응답 모양(application/problem+json). 전체 형은 api-client가 안다 */
interface ProblemLike {
  status?: number;
  type?: string;
  title?: string;
  detail?: string;
}

export type SaleReviewStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type ShowScale = 'LARGE' | 'MEDIUM' | 'SMALL';

export interface SaleReviewListItem {
  productionId: string;
  title: string;
  promoterName: string;
  status: SaleReviewStatus;
  reapproval: boolean;
  submittedAt: string | null;
  firstOpenAt: string | null;
  eventCount: number;
  suspensionApprovalPending: boolean;
}
export interface SaleReviewPage {
  items: SaleReviewListItem[];
  nextCursor: string | null;
}
export interface SaleReviewEvent {
  eventId: string;
  openAt: string;
  startsAt: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'POSTPONED';
  scale: ShowScale | null;
  demandForecastPath: string;
}
export interface SellerInfo {
  legalName: string;
  representative: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  businessRegNo: string | null;
  mailOrderReportNo: string | null;
  exemptionBasis: string | null;
}
export interface SaleReviewDetail {
  productionId: string;
  title: string;
  promoterId: string;
  promoterName: string;
  status: SaleReviewStatus;
  reapproval: boolean;
  submittedAt: string | null;
  rejectionReason: string | null;
  seller: SellerInfo | null;
  verifiedAt: string | null;
  placeId: string | null;
  placeName: string | null;
  requestedPlace: boolean;
  accessibleSeatingCheck: boolean | null;
  salePolicy: unknown[];
  events: SaleReviewEvent[];
  suspensionApprovalPending: boolean;
}

const S = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const N = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function mapSaleReviewList(page: { items?: unknown[]; nextCursor?: string | null }): SaleReviewPage {
  const items = (page.items ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      productionId: S(r.productionId),
      title: S(r.title),
      promoterName: S(r.promoterName),
      status: S(r.status, 'SUBMITTED') as SaleReviewStatus,
      reapproval: r.reapproval === true,
      submittedAt: typeof r.submittedAt === 'string' ? r.submittedAt : null,
      firstOpenAt: typeof r.firstOpenAt === 'string' ? r.firstOpenAt : null,
      eventCount: N(r.eventCount),
      suspensionApprovalPending: r.suspensionApprovalPending === true,
    };
  });
  return { items, nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null };
}

export function mapSaleReviewDetail(raw: Record<string, unknown>): SaleReviewDetail {
  const seller = raw.seller as Record<string, unknown> | null | undefined;
  return {
    productionId: S(raw.productionId),
    title: S(raw.title),
    promoterId: S(raw.promoterId),
    promoterName: S(raw.promoterName),
    status: S(raw.status, 'SUBMITTED') as SaleReviewStatus,
    reapproval: raw.reapproval === true,
    submittedAt: typeof raw.submittedAt === 'string' ? raw.submittedAt : null,
    rejectionReason: typeof raw.rejectionReason === 'string' ? raw.rejectionReason : null,
    seller: seller
      ? {
          legalName: S(seller.legalName),
          representative: typeof seller.representative === 'string' ? seller.representative : null,
          address: typeof seller.address === 'string' ? seller.address : null,
          phone: typeof seller.phone === 'string' ? seller.phone : null,
          email: typeof seller.email === 'string' ? seller.email : null,
          businessRegNo: typeof seller.businessRegNo === 'string' ? seller.businessRegNo : null,
          mailOrderReportNo: typeof seller.mailOrderReportNo === 'string' ? seller.mailOrderReportNo : null,
          exemptionBasis: typeof seller.exemptionBasis === 'string' ? seller.exemptionBasis : null,
        }
      : null,
    verifiedAt: typeof raw.verifiedAt === 'string' ? raw.verifiedAt : null,
    placeId: typeof raw.placeId === 'string' ? raw.placeId : null,
    placeName: typeof raw.placeName === 'string' ? raw.placeName : null,
    requestedPlace: raw.requestedPlace === true,
    accessibleSeatingCheck: typeof raw.accessibleSeatingCheck === 'boolean' ? raw.accessibleSeatingCheck : null,
    salePolicy: Array.isArray(raw.salePolicy) ? raw.salePolicy : [],
    events: (Array.isArray(raw.events) ? raw.events : []).map((e) => {
      const x = e as Record<string, unknown>;
      const scale = x.scale === 'LARGE' || x.scale === 'MEDIUM' || x.scale === 'SMALL' ? x.scale : null;
      return {
        eventId: S(x.eventId),
        openAt: S(x.openAt),
        startsAt: S(x.startsAt),
        status: (S(x.status, 'SCHEDULED') as SaleReviewEvent['status']),
        scale,
        demandForecastPath: S(x.demandForecastPath, `/v1/ops/events/${S(x.eventId)}/demand-forecast`),
      };
    }),
    suspensionApprovalPending: raw.suspensionApprovalPending === true,
  };
}

export function statusLabel(status: SaleReviewStatus, reapproval: boolean): string {
  if (status === 'SUBMITTED') return reapproval ? '재승인 대기' : '승인 대기';
  if (status === 'REJECTED') return reapproval ? '변경 반려' : '반려';
  if (status === 'APPROVED') return '승인';
  if (status === 'SUSPENDED') return '판매 중지';
  return '초안';
}

export function formatKst(iso: string | null): string {
  if (iso === null) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : new Date(t + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}

export function initialScales(events: readonly SaleReviewEvent[]): Record<string, ShowScale | ''> {
  return Object.fromEntries(events.map((e) => [e.eventId, e.scale ?? '']));
}

export function validateApproval(detail: SaleReviewDetail, scales: Record<string, ShowScale | ''>): string[] {
  if (detail.events.length === 0) return ['회차가 없습니다'];
  const missing = detail.events.filter((e) => scales[e.eventId] === undefined || scales[e.eventId] === '');
  return missing.length > 0 ? ['모든 회차의 규모를 골라 주세요'] : [];
}

export function approvalBody(detail: SaleReviewDetail, scales: Record<string, ShowScale | ''>) {
  return {
    scales: detail.events.flatMap((e) => {
      const scale = scales[e.eventId];
      return scale === 'LARGE' || scale === 'MEDIUM' || scale === 'SMALL' ? [{ eventId: e.eventId, scale }] : [];
    }),
    ...(detail.placeId !== null ? { placeId: detail.placeId } : {}),
  };
}

export function validateRejection(reason: string): string | null {
  const value = reason.trim();
  if (value === '') return '반려 사유를 적어 주세요';
  if (value.length > 1000) return '반려 사유는 1,000자까지 적을 수 있습니다';
  return null;
}

export type SaleReviewProblemKind = 'conflict' | 'forbidden' | 'validation' | 'notfound' | 'server' | 'unknown';

export function saleReviewProblem(e: unknown): { kind: SaleReviewProblemKind; message: string; reload: boolean } {
  const p = (typeof e === 'object' && e !== null ? e : {}) as ProblemLike;
  if (p.status === 403) return { kind: 'forbidden', message: '이 화면을 쓸 권한이 없습니다. viewer·CS는 읽기만 할 수 있습니다.', reload: false };
  if (p.status === 404) return { kind: 'notfound', message: '공연을 찾을 수 없습니다. 목록을 새로 고칩니다.', reload: true };
  if (p.status === 409) {
    if (p.type === 'open-interval-conflict') return { kind: 'conflict', message: '다른 대형 공연과 오픈 30분 안입니다. 파트너에게 반려해 주세요.', reload: true };
    if (p.type === 'sale-review-not-submitted') return { kind: 'conflict', message: '승인 대기 중인 공연이 아닙니다. 목록을 새로 고칩니다.', reload: true };
    return { kind: 'conflict', message: '지금 상태에서는 승인하거나 반려할 수 없습니다. 목록을 새로 고칩니다.', reload: true };
  }
  if (p.status === 422) {
    if (p.type === 'sale-review-list-missing') return { kind: 'validation', message: '판매 정책이 쓰는 명단이 없습니다. 파트너에게 반려해 주세요.', reload: false };
    if (p.type === 'sale-review-scales-missing') return { kind: 'validation', message: '모든 회차의 규모를 골라 주세요.', reload: false };
    return { kind: 'validation', message: '승인 조건을 다시 확인해 주세요.', reload: false };
  }
  if (p.status === 400) return { kind: 'validation', message: '입력한 값을 다시 확인해 주세요.', reload: false };
  if (typeof p.status === 'number' && p.status >= 500) return { kind: 'server', message: '서버가 잠시 응답하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', reload: false };
  return { kind: 'unknown', message: '요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.', reload: false };
}

/** operator·commander만 승인·반려한다. 역할을 모르면(실제 세션) 서버 판정에 맡기고 true다 */
export function canAct(role: ConsoleRole | null): boolean {
  return role === null || role === 'operator' || role === 'commander';
}

/** viewer·operator·commander·cs_agent·cs_lead가 읽는다. 역할을 모르면 true다 */
export function canRead(role: ConsoleRole | null): boolean {
  return role === null || role === 'viewer' || role === 'operator' || role === 'commander' || role === 'cs_agent' || role === 'cs_lead';
}
