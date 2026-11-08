// 도메인 층: 공연 상세 응답의 값 판정(openapi EventPublicSummary, ADR-0118, ADR-0200 결정 4·5, BUILD_ORDER HOT-306). 순수 함수만 둔다.
import { type EventStatus, saleEndsAt } from './production.js';

/** 공개 회차 목록의 상한 [가정](openapi rounds maxItems) */
export const MAX_PUBLIC_ROUNDS = 60;
/** 아티스트 칸의 상한(openapi artists maxItems) */
export const MAX_ARTISTS = 20;
/** 설명 글의 상한 [가정](openapi descriptionText maxLength). 입력 검사는 HOT-180이 하고, 읽을 때도 계약을 넘지 않게 자른다 */
export const MAX_DESCRIPTION_TEXT = 20_000;

export type QueueOrder = 'HYBRID' | 'PREQUEUE_SHUFFLE' | 'FIFO';

/** 정렬 방식 이름: 회차의 두 설정에서 계산한다(ADR-0118). 둘 다 끈 값은 DB 제약이 막는다 */
export function queueOrder(lobbyShuffle: boolean, openBatch: boolean): QueueOrder {
  if (!lobbyShuffle) return 'FIFO';
  return openBatch ? 'HYBRID' : 'PREQUEUE_SHUFFLE';
}

/** 로비 개방 시각. 로비 셔플을 끈 회차(FIFO)는 null */
export function lobbyOpensAt(openAt: Date, lobbyMinutes: number, lobbyShuffle: boolean): Date | null {
  return lobbyShuffle ? new Date(openAt.getTime() - lobbyMinutes * 60_000) : null;
}

export interface SellerRow {
  legalName: string;
  representative: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  businessRegNo: string | null;
  mailOrderReportNo: string | null;
  exemptionBasis: string | null;
}

export interface SellerInfo {
  legalName: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessRegNo: string;
  mailOrderReportNo?: string;
  exemptionBasis?: string;
}

const filled = (v: string | null): v is string => v !== null && v.trim() !== '';

/** 판매자 신원정보 일곱 항목이 다 있을 때만 준다(판매 승인이 다 확인하지 않은 공연은 상호만 보인다, ADR-0200 결정 4) */
export function sellerInfo(s: SellerRow): SellerInfo | undefined {
  if (!filled(s.representative) || !filled(s.address) || !filled(s.phone) || !filled(s.email) || !filled(s.businessRegNo)) return undefined;
  const base = { legalName: s.legalName, representative: s.representative, address: s.address, phone: s.phone, email: s.email, businessRegNo: s.businessRegNo };
  if (filled(s.mailOrderReportNo)) return { ...base, mailOrderReportNo: s.mailOrderReportNo };
  return filled(s.exemptionBasis) ? { ...base, exemptionBasis: s.exemptionBasis } : undefined;
}

export interface RoundRow {
  id: string;
  startsAt: Date;
  openAt: Date;
  status: EventStatus;
}

export interface PublicRound {
  eventId: string;
  startsAt: string;
  openAt: string;
  saleEndsAt: string;
  status: EventStatus;
}

/**
 * 같은 공연의 공개 회차(시작 순). 취소된 회차와 판매 종료가 지난 회차는 빼되 이 회차는 늘 넣고, 60개까지다.
 * 승인 뒤 더한 회차(변경분)는 표에 없어 들지 않는다(ADR-0198 결정 3)
 */
export function publicRounds(rows: readonly RoundRow[], eventId: string, now: Date): PublicRound[] {
  const open = rows.filter((r) => r.id === eventId || (r.status !== 'CANCELLED' && saleEndsAt(r).getTime() > now.getTime())).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  let picked = open.slice(0, MAX_PUBLIC_ROUNDS);
  // 상한에 잘렸어도 이 회차는 넣는다(시작 순을 지킨다)
  if (!picked.some((r) => r.id === eventId)) {
    const self = open.find((r) => r.id === eventId);
    if (self) picked = [...picked.slice(0, MAX_PUBLIC_ROUNDS - 1), self].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }
  return picked.map((r) => ({ eventId: r.id, startsAt: r.startsAt.toISOString(), openAt: r.openAt.toISOString(), saleEndsAt: saleEndsAt(r).toISOString(), status: r.status }));
}
