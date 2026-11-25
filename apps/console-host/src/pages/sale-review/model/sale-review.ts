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
  /** 등록 아티스트와 파트너가 요청한 새 이름(artistId null)을 보이는 순서대로 합친 목록 */
  artists: SaleReviewArtist[];
  accessibleSeatingCheck: boolean | null;
  salePolicy: unknown[];
  events: SaleReviewEvent[];
  suspensionApprovalPending: boolean;
  /** F-07-7이 주는 지급대행 등록 읽기. CS 두 역할이면 서버가 계좌를 null로 준다 */
  payoutAccount: PayoutAccountSummary | null;
  pgRegistration: PgRegistration | null;
}

export interface SaleReviewArtist {
  artistId: string | null;
  name: string;
}

export interface PayoutAccountSummary {
  bankCode: string;
  last4: string;
  holderVerified: boolean;
  holdUntil: string | null;
}

export interface PgRegistration {
  tossEnabled: boolean;
  portoneEnabled: boolean;
  tossSellers: { pgStore: 'STANDARD' | 'ESCROW'; status: string }[];
  portonePartnerRegistered: boolean;
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

/** 응답의 아티스트 목록을 화면 값으로. 새 이름 요청은 artistId null이다 */
export function mapArtists(raw: unknown): SaleReviewArtist[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const r = x as Record<string, unknown>;
    if (typeof r.name !== 'string') return [];
    return [{ artistId: typeof r.artistId === 'string' ? r.artistId : null, name: r.name }];
  });
}

/** 상세의 지급대행 등록 읽기(F-07-7). 없거나 모양이 다르면 null로 두고 화면이 '읽지 못함'을 적는다 */
export function mapPayout(raw: Record<string, unknown>): Pick<SaleReviewDetail, 'payoutAccount' | 'pgRegistration'> {
  const a = raw.payoutAccount as Record<string, unknown> | null | undefined;
  const g = raw.pgRegistration as Record<string, unknown> | null | undefined;
  const payoutAccount =
    a && typeof a.bankCode === 'string' && typeof a.last4 === 'string'
      ? { bankCode: a.bankCode, last4: a.last4, holderVerified: a.holderVerified === true, holdUntil: typeof a.holdUntil === 'string' ? a.holdUntil : null }
      : null;
  const sellers: PgRegistration['tossSellers'] = [];
  if (Array.isArray(g?.tossSellers)) {
    for (const x of g.tossSellers as unknown[]) {
      const s = x as Record<string, unknown>;
      if ((s.pgStore !== 'STANDARD' && s.pgStore !== 'ESCROW') || typeof s.status !== 'string') continue;
      sellers.push({ pgStore: s.pgStore, status: s.status });
    }
  }
  const pgRegistration =
    g === null || g === undefined
      ? null
      : { tossEnabled: g.tossEnabled === true, portoneEnabled: g.portoneEnabled === true, tossSellers: sellers, portonePartnerRegistered: g.portonePartnerRegistered === true };
  return { payoutAccount, pgRegistration };
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
    artists: mapArtists(raw.artists),
    accessibleSeatingCheck: typeof raw.accessibleSeatingCheck === 'boolean' ? raw.accessibleSeatingCheck : null,
    ...mapPayout(raw),
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

/** 운영자가 고른 연결 값(요청 이름 → 아티스트 ID, 공연장 ID) */
export interface ResolvedLinkage {
  artists: Record<string, string>;
  placeId: string | null;
}

/** 새 이름 요청과 새 공연장 요청이 모두 연결됐는지. 비어 있으면 승인할 수 있다 */
export function validateLinkage(detail: SaleReviewDetail, resolved: ResolvedLinkage): string[] {
  const issues: string[] = [];
  const unresolved = detail.artists.filter((a) => a.artistId === null && (resolved.artists[a.name] === undefined || resolved.artists[a.name] === ''));
  if (unresolved.length > 0) issues.push(`새 이름 아티스트마다 연결할 아티스트를 골라 주세요: ${unresolved.map((a) => a.name).join(', ')}`);
  if (detail.requestedPlace && detail.placeId === null && (resolved.placeId === null || resolved.placeId === '')) {
    issues.push('새 공연장 요청은 연결할 공연장을 골라 주세요');
  }
  return issues;
}

/** 승인 본문: 회차 규모·고른 공연장·요청 이름별 아티스트만 낸다(artistIds·aliases 없음) */
export function linkageBody(detail: SaleReviewDetail, resolved: ResolvedLinkage, scales: Record<string, ShowScale | ''>) {
  const artists = detail.artists
    .filter((a) => a.artistId === null)
    .flatMap((a) => {
      const artistId = resolved.artists[a.name];
      return artistId === undefined || artistId === '' ? [] : [{ name: a.name, artistId }];
    });
  const placeId = resolved.placeId ?? detail.placeId;
  return {
    scales: detail.events.flatMap((e) => {
      const scale = scales[e.eventId];
      return scale === 'LARGE' || scale === 'MEDIUM' || scale === 'SMALL' ? [{ eventId: e.eventId, scale }] : [];
    }),
    ...(placeId !== null && placeId !== '' ? { placeId } : {}),
    ...(artists.length > 0 ? { artists } : {}),
  };
}

/** 찾기 목록을 고르기 항목으로. 화면이 같은 모양을 쓴다 */
export function artistOptions(items: readonly { artistId: string; name: string }[]): { value: string; label: string }[] {
  return items.map((a) => ({ value: a.artistId, label: a.name }));
}

export function placeOptions(items: readonly { placeId: string; name: string; address: string }[]): { value: string; label: string }[] {
  return items.map((p) => ({ value: p.placeId, label: `${p.name} · ${p.address}` }));
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
    if (p.type === 'sale-review-payout-registration-incomplete') return { kind: 'conflict', message: '지급대행 등록이 끝나지 않아 승인할 수 없습니다. 결제사 설정을 확인해 주세요.', reload: true };
    if (p.type === 'artist-exists' || p.type === 'place-exists') return { kind: 'conflict', message: '같은 이름이 이미 있습니다. 기존 항목을 골라 주세요.', reload: false };
    return { kind: 'conflict', message: '지금 상태에서는 승인하거나 반려할 수 없습니다. 목록을 새로 고칩니다.', reload: true };
  }
  if (p.status === 422) {
    if (p.type === 'sale-review-artists-missing') return { kind: 'validation', message: '새 이름 아티스트마다 연결할 아티스트를 골라 주세요.', reload: false };
    if (p.type === 'sale-review-place-missing') return { kind: 'validation', message: '새 공연장 요청은 연결할 공연장을 골라 주세요.', reload: false };
    if (p.type === 'sale-review-list-missing') return { kind: 'validation', message: '판매 정책이 쓰는 명단이 없습니다. 파트너에게 반려해 주세요.', reload: false };
    if (p.type === 'sale-review-scales-missing') return { kind: 'validation', message: '모든 회차의 규모를 골라 주세요.', reload: false };
    return { kind: 'validation', message: '승인 조건을 다시 확인해 주세요.', reload: false };
  }
  if (p.status === 400) return { kind: 'validation', message: '입력한 값을 다시 확인해 주세요.', reload: false };
  if (p.status === 503) return { kind: 'server', message: '지급 서비스에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', reload: false };
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
