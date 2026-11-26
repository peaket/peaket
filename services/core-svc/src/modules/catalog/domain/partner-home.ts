// F-07-12 파트너 홈·공연 목록 읽기 도메인(SCR-062·063, HOT-260).
// 정본: openapi `listPartnerProductions`·`getPartnerTodoSummary`·`getPartnerProduction`·`getPartnerSellerProfile`,
// docs/design/d5 §6.2·§6.3, docs/api/guidelines.md §3. 순수 함수만 둔다(프레임워크·DB를 모른다).
import type { SellerRow } from './event-detail.js';
import type { CatalogEvent, EventSaleState, Production, SaleReview, SuspensionReasonCode } from './production.js';
import type { ProductionImageRow } from './production-image.js';

/** 진행 단계(openapi PartnerProductionDetail.progressStage, d5 §6.3) */
export const PROGRESS_STAGES = ['REGISTRATION', 'SALE_REVIEW', 'OPEN', 'SALE', 'ENTRY', 'ENTRY_RECORD_CLOSED', 'SETTLEMENT'] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

/** 목록 한 줄의 저장소 값. 화면에 실을 칸으로 바꾸는 일은 유스케이스가 한다. */
export interface PartnerProductionSummaryRow {
  productionId: string;
  title: string;
  eventCount: number;
  saleReview: SaleReview;
  hasApprovalHistory: boolean;
  rejectionReason: string | null;
  suspensionReasonCode: SuspensionReasonCode | null;
  /** 취소 회차를 뺀, 변경분 회차를 포함한 가장 이른 오픈. 없으면 null(응답에서는 칸을 뺀다) */
  firstOpenAt: Date | null;
  /** 필터는 이 회차 원값으로 거른다. 응답 요약은 summarySaleStatus가 합성한다(TR-06) */
  saleStates: EventSaleState[];
}

/** 할 일 카드의 저장소 값. 네 칸 가운데 core가 답할 수 없는 셋은 null이다. */
export interface PartnerTodoRow {
  rejectedSaleReviewCount: number | null;
  settlementDisputeDueCount: number | null;
  settlementDisputeEarliestDueAt: Date | null;
  openGateFlagCount: number | null;
  pendingStaffInvitationCount: number | null;
}

/** 공연 개요의 회차 한 줄. pending은 승인 뒤 변경분에만 있는 회차다. */
export interface PartnerEventSource {
  eventId: string;
  version: number;
  pending: boolean;
  openAt: Date;
  lobbyMinutes: number;
  entryOpensAt: Date | null;
  startsAt: Date;
  endsAt: Date;
  reentryAllowed: boolean;
  lobbyShuffle: boolean;
  openBatch: boolean;
  seatAssignment: 'PICK' | 'AUTO';
  perPersonLimit: number;
  status: CatalogEvent['status'];
  saleStatus: EventSaleState | null;
  soldPercent: number | null;
  entryClosedAt: Date | null;
}

/** 공연 개요의 저장소 값. 이미지·판매자 원문은 유스케이스가 계약 칸으로 줄인다. */
export interface PartnerProductionSource {
  production: Production & { ageRating?: string | null; runningMinutes?: number | null };
  events: PartnerEventSource[];
  images: ProductionImageRow[];
  place: { id: string; name: string } | null;
  artists: { artistId: string; name: string }[];
  aliases: string[];
  hasPendingRevision: boolean;
  pendingRevisionFields: string[];
}

/** 판매자 정보 읽기(SCR-063 고지 미리보기). 변경 요청 표가 없어 pendingChange는 null이다. */
export interface PartnerSellerSource {
  seller: SellerRow;
  verifiedAt: Date | null;
}

/** 목록 쿼리(계약 파라미터). platform이 쉼표 여러 값을 배열로 바꾸고 반복 파라미터는 400으로 막는다. */
export interface PartnerProductionQuery {
  saleReview?: SaleReview[];
  hasApprovalHistory?: boolean;
  saleStatus?: EventSaleState[];
  from?: string;
  to?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

/** 목록 한 페이지(응답). firstOpenAt은 없으면 칸을 뺀다(계약 optional string, TR-02). */
export interface PartnerProductionSummary {
  productionId: string;
  title: string;
  eventCount: number;
  saleReview: SaleReview;
  hasApprovalHistory: boolean;
  rejectionReason: string | null;
  suspensionReasonCode: SuspensionReasonCode | null;
  firstOpenAt?: string;
  saleStatus: EventSaleState | null;
  pgPrimary: 'TOSS' | 'PORTONE' | null;
  payoutHoldReason: 'KYC' | 'ACCOUNT_CHANGE' | 'BALANCE' | 'ACCOUNT_MISMATCH' | 'SALE_SUSPENDED' | null;
}

/**
 * 목록·개요의 판매 상태 요약(계약 `saleStatus`). 판매 승인 전·판매 중지 중·회차 없음은 null이고,
 * ON_SALE·ALL_HELD가 하나라도 있으면 ON_SALE, 없고 UPCOMING이 있으면 UPCOMING, 모두 SOLD_OUT이면 SOLD_OUT, 그 밖은 ENDED다.
 */
export function summarySaleStatus(production: Pick<Production, 'saleReview' | 'saleApprovedAt'>, states: readonly EventSaleState[]): EventSaleState | null {
  if (production.saleApprovedAt === null || production.saleReview === 'SUSPENDED' || production.saleReview === 'DRAFT') return null;
  if (states.length === 0) return null;
  if (states.some((s) => s === 'ON_SALE' || s === 'ALL_HELD')) return 'ON_SALE';
  if (states.some((s) => s === 'UPCOMING')) return 'UPCOMING';
  if (states.every((s) => s === 'SOLD_OUT')) return 'SOLD_OUT';
  return 'ENDED';
}

/**
 * 진행 단계(openapi progressStage, 계획 I-01). DRAFT는 등록, 승인 전 SUBMITTED·REJECTED는 판매 승인,
 * 승인 이력이 있으면 가장 이른 회차(취소 제외)의 오픈·시작·종료·입장 기록 마감과 지금을 견준다.
 * `entryClosedAt`이 있으면 종료보다 먼저 본다. 회차가 없으면 판매 승인 단계다(추천 적용, 2026-11-26).
 */
export function progressStageOf(
  row: {
    saleReview: SaleReview;
    saleApprovedAt: Date | null;
    events: readonly { openAt: Date; startsAt: Date; endsAt: Date; entryClosedAt: Date | null; status: CatalogEvent['status'] }[];
  },
  now: Date,
): ProgressStage {
  if (row.saleReview === 'DRAFT') return 'REGISTRATION';
  if (row.saleApprovedAt === null) return 'SALE_REVIEW';
  const first = [...row.events].filter((e) => e.status !== 'CANCELLED').sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.openAt.getTime() - b.openAt.getTime()))[0];
  if (!first) return 'SALE_REVIEW';
  if (first.entryClosedAt !== null) return 'ENTRY_RECORD_CLOSED';
  if (now.getTime() >= first.endsAt.getTime()) return 'SETTLEMENT';
  if (now.getTime() >= first.startsAt.getTime()) return 'ENTRY';
  if (now.getTime() >= first.openAt.getTime()) return 'SALE';
  return 'OPEN';
}

/** KST 날짜(from·to, to 그날 포함)를 UTC 경계로 바꾼다. `to`는 다음 날 00:00 KST의 전까지다. */
export function kstDateRange(from: string | undefined, to: string | undefined): { fromMs?: number; toMs?: number } {
  const day = 86_400_000;
  const at = (d: string) => Date.parse(`${d}T00:00:00+09:00`);
  return {
    ...(from !== undefined ? { fromMs: at(from) } : {}),
    ...(to !== undefined ? { toMs: at(to) + day } : {}),
  };
}

export interface PartnerCursor {
  /** firstOpenAt의 밀리초. 없는 행은 null이고 정렬에서 맨 뒤다. */
  at: number | null;
  id: string;
}

export function encodePartnerCursor(row: Pick<PartnerProductionSummaryRow, 'productionId' | 'firstOpenAt'>): string {
  return Buffer.from(JSON.stringify({ at: row.firstOpenAt?.getTime() ?? null, id: row.productionId }), 'utf8').toString('base64url');
}

/** 모양이 틀린 커서는 undefined(호출부가 400으로 닫는다). */
export function decodePartnerCursor(s: string): PartnerCursor | undefined {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (typeof v !== 'object' || v === null) return undefined;
    const o = v as { at?: unknown; id?: unknown };
    if (!(o.at === null || (typeof o.at === 'number' && Number.isSafeInteger(o.at)))) return undefined;
    if (typeof o.id !== 'string' || o.id.length === 0) return undefined;
    return { at: o.at, id: o.id };
  } catch {
    return undefined;
  }
}

/** 목록 정렬: 첫 오픈 내림차순, 없는 행은 뒤, 같으면 공연 ID 오름차순. */
export function comparePartnerRows(a: PartnerProductionSummaryRow, b: PartnerProductionSummaryRow): number {
  if (a.firstOpenAt !== null && b.firstOpenAt === null) return -1;
  if (a.firstOpenAt === null && b.firstOpenAt !== null) return 1;
  if (a.firstOpenAt !== null && b.firstOpenAt !== null) {
    const d = b.firstOpenAt.getTime() - a.firstOpenAt.getTime();
    if (d !== 0) return d;
  }
  return a.productionId < b.productionId ? -1 : a.productionId > b.productionId ? 1 : 0;
}

/** 커서 뒤의 행인가(같은 첫 오픈이면 공연 ID 오름차순을 잇는다). */
export function afterPartnerCursor(row: PartnerProductionSummaryRow, cursor: PartnerCursor): boolean {
  if (cursor.at === null) return row.firstOpenAt === null && row.productionId > cursor.id;
  if (row.firstOpenAt === null) return true;
  const at = row.firstOpenAt.getTime();
  return at < cursor.at || (at === cursor.at && row.productionId > cursor.id);
}

/** 목록 쿼리 술어. `saleStatus`는 회차 원값으로 거르고(ALL_HELD 포함), 응답 요약과 다르다. */
export function matchesPartnerQuery(row: PartnerProductionSummaryRow, q: PartnerProductionQuery): boolean {
  if (q.saleReview && !q.saleReview.includes(row.saleReview)) return false;
  if (q.hasApprovalHistory !== undefined && q.hasApprovalHistory !== row.hasApprovalHistory) return false;
  if (q.saleStatus && !q.saleStatus.some((s) => row.saleStates.includes(s))) return false;
  if (q.q !== undefined && !row.title.toLowerCase().includes(q.q.toLowerCase())) return false;
  const range = kstDateRange(q.from, q.to);
  if (range.fromMs !== undefined) {
    if (row.firstOpenAt === null || row.firstOpenAt.getTime() < range.fromMs) return false;
  }
  if (range.toMs !== undefined) {
    if (row.firstOpenAt === null || row.firstOpenAt.getTime() >= range.toMs) return false;
  }
  return true;
}
