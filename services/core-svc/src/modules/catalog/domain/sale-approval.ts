// 판매 승인 실행의 순수 부분(판매 승인 LCH-080, ADR-0093·0198·0261).
// 승인 트랜잭션이 pending_revision의 규칙·회차 고침·더한 회차를 공개본으로 옮기고, 회차의 규모·결제사 칸을 정한다.
// 저장소는 이 결과를 DB에 쓰고, 대기열·core DB 판매 설정 사본은 PublishSaleConfigs가 이 결과로 만든다.
import type { SaleEventRow, SaleState } from './sale-ports.js';

export type ShowScale = 'LARGE' | 'MEDIUM' | 'SMALL';
export type PgName = 'TOSS' | 'PORTONE';

/** 승인 때 회차에 고정할 플랫폼 기본 결제사(payment §2.2, ADR-0062 결정 33). 운영 main.ts가 환경 값으로 넘긴다 */
export interface PgDefaults {
  primary: PgName;
  fallback?: PgName;
}

/** 플랫폼 기본 결제사 주입 토큰. 없으면(메모리 시험 조립) 결제사 칸을 쓰지 않고 채널 확인도 하지 않는다 */
export const PG_DEFAULTS = Symbol('PG_DEFAULTS');

export interface SaleApprovalInput {
  now: Date;
  /** 그 공연의 모든 회차(변경분의 더한 회차 포함)마다 규모 */
  scales: { eventId: string; scale: ShowScale }[];
  /** 운영자가 확인한 공연장. 새 공연장 요청이면 승인 전에 반드시 있어야 한다 */
  placeId?: string;
  /** 파트너가 새 이름으로 요청한 아티스트를 잇는 값(요청 이름 → 아티스트 ID). 없으면 연결 없음 */
  artists?: { name: string; artistId: string }[];
  /** 유스케이스가 연결 검사로 정한 저장 값(요청 순서). 저장소만 읽는다 */
  artistLinks?: { artistId: string; sortOrder: number }[];
  /** 휠체어석 확인(LCH-090). 지금은 승인 본문이 true만 받는다 */
  accessibleSeatingCheck?: boolean;
  /** 승인 트랜잭션 안에서 읽은 그 파트너의 지금 계약 수수료율(만분율). 계약이 없으면 없다 */
  commissionRateBp?: number;
  /** 지정이 빈 회차에 채울 플랫폼 기본 결제사(그 시점 값). 없으면 결제사 칸을 쓰지 않는다 */
  pgDefaults?: PgDefaults;
}

/**
 * 승인 결과의 공개본. 이 값을 저장소가 쓰고 설정 사본이 읽는다.
 * 수수료율은 첫 승인이면 그 공연의 모든 회차에, 재승인이면 새로 더한 회차에만 쓴다(ADR-0060·0320).
 * 이미 승인된 회차의 값은 계약이 바뀌어도 그대로 둔다.
 */
export function applyApproval(st: SaleState, input: SaleApprovalInput): SaleState {
  const rules = st.production.pendingRules ?? st.production.rules;
  const scaleOf = new Map(input.scales.map((s) => [s.eventId, s.scale]));
  const firstApproval = st.production.saleApprovedAt === null;
  const rate = input.commissionRateBp;
  const withRate = (e: SaleEventRow): Partial<SaleEventRow> => (rate === undefined ? {} : e.commissionRateBp === undefined && firstApproval ? { commissionRateBp: rate } : {});
  // 결제사 지정은 회차 칸이고 판매 승인 뒤에는 비지 않는다(payment §2.2, ADR-0062 결정 33).
  // 이미 지정된 회차는 그대로 두고, 비어 있는 회차(첫 승인·새로 더한 회차)에만 그 시점 기본값을 쓴다
  const pg = input.pgDefaults;
  const withPg = (e: Pick<SaleEventRow, 'pgPrimary' | 'pgFallback'>): Partial<SaleEventRow> => {
    if (pg === undefined || e.pgPrimary !== undefined) return {};
    return { pgPrimary: pg.primary, ...(pg.fallback !== undefined && pg.fallback !== pg.primary ? { pgFallback: pg.fallback } : {}) };
  };
  const events = st.events
    .map((e) => {
      const change = st.eventChanges[e.eventId] ?? {};
      const scale = scaleOf.get(e.eventId);
      return {
        ...e,
        ...change,
        version: e.version + 1,
        ...(scale !== undefined ? { scale } : {}),
        ...withRate(e),
        ...withPg(e),
      } as SaleEventRow;
    })
    .concat(
      st.addedEvents.map((e) => ({
        eventId: e.eventId,
        status: 'SCHEDULED' as const,
        version: 1,
        venueId: e.venueId ?? null,
        openAt: e.openAt,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        entryOpensAt: e.entryOpensAt ?? null,
        lobbyMinutes: e.lobbyMinutes,
        lobbyShuffle: e.lobbyShuffle,
        openBatch: e.openBatch,
        seatAssignment: e.seatAssignment,
        perPersonLimit: e.perPersonLimit,
        ...(scaleOf.get(e.eventId) !== undefined ? { scale: scaleOf.get(e.eventId) } : {}),
        ...(rate !== undefined ? { commissionRateBp: rate } : {}),
        ...withPg({}),
      })),
    )
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.eventId < b.eventId ? -1 : 1));
  return {
    ...st,
    production: {
      ...st.production,
      saleReview: 'APPROVED',
      saleApprovedAt: input.now,
      rules,
      pendingRules: undefined,
    },
    events,
    eventChanges: {},
    addedEvents: [],
  };
}
