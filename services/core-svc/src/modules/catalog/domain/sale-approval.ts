// 판매 승인 실행의 순수 부분(판매 승인 LCH-080, ADR-0093·0198·0261).
// 승인 트랜잭션이 pending_revision의 규칙·회차 고침·더한 회차를 공개본으로 옮기고, 회차의 규모·결제사 칸을 정한다.
// 저장소는 이 결과를 DB에 쓰고, 대기열·core DB 판매 설정 사본은 PublishSaleConfigs가 이 결과로 만든다.
import type { SaleEventRow, SaleState } from './sale-ports.js';

export type ShowScale = 'LARGE' | 'MEDIUM' | 'SMALL';

export interface SaleApprovalInput {
  now: Date;
  /** 그 공연의 모든 회차(변경분의 더한 회차 포함)마다 규모 */
  scales: { eventId: string; scale: ShowScale }[];
  /** 운영자가 확인한 공연장. 없으면 기존 값을 둔다 */
  placeId?: string;
  /** 휠체어석 확인(LCH-090). 지금은 승인 본문이 true만 받는다 */
  accessibleSeatingCheck?: boolean;
}

/** 승인 결과의 공개본. 이 값을 저장소가 쓰고 설정 사본이 읽는다 */
export function applyApproval(st: SaleState, input: SaleApprovalInput): SaleState {
  const rules = st.production.pendingRules ?? st.production.rules;
  const scaleOf = new Map(input.scales.map((s) => [s.eventId, s.scale]));
  const events = st.events
    .map((e) => {
      const change = st.eventChanges[e.eventId] ?? {};
      const scale = scaleOf.get(e.eventId);
      return {
        ...e,
        ...change,
        version: e.version + 1,
        ...(scale !== undefined ? { scale } : {}),
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
