// 예매 흐름 기계(docs/frontend.md §3.6 selecting·holding·held, ADR-0225). 요청은 화면이 보내고 결과를 이벤트로 넣는다(기계는 값만 다뤄 모델 기반 시험을 돈다).
import { assign, setup } from 'xstate';

export interface SeatPick {
  seatId: string;
  label: string;
  /** 등급 ID(회차 가격표에서 가격을 찾는다) */
  tier: string | null;
}

export type BookingNotice =
  | { kind: 'lost'; suggested: string[] }
  | { kind: 'recent'; seats: string[]; availableAt?: string }
  | { kind: 'limit' }
  | { kind: 'error' }
  | { kind: 'expired' }
  /** 직접 놓았다(30초 뒤 다시 고를 수 있다) */
  | { kind: 'released' }
  /** 결제가 진행 중이라 놓거나 늘릴 수 없다 */
  | { kind: 'in-payment' }
  /** 다시 고를 수 없는 좌석을 눌렀다 */
  | { kind: 'recent-pick'; until: number };

export type BookingEvent =
  | { type: 'TOGGLE'; seat: SeatPick }
  | { type: 'HOLD' }
  /** 자동 배정 공연의 첫 홀드(고른 좌석 없이 희망 조건으로) */
  | { type: 'AUTO' }
  | { type: 'HOLD_OK'; hold: unknown }
  | { type: 'HOLD_LOST'; suggested: string[] }
  | { type: 'HOLD_RECENT'; seats: string[]; availableAt?: string }
  | { type: 'HOLD_LIMIT' }
  | { type: 'HOLD_PAUSED' }
  | { type: 'HOLD_SALE_ENDED' }
  | { type: 'HOLD_FAILED' }
  | { type: 'SESSION_ENDED' }
  /** 회차 요약이 오면 1인 매수 한도를 고친다 */
  | { type: 'SET_LIMIT'; limit: number }
  /** 홀드 시간이 끝났다 */
  | { type: 'EXPIRED' }
  /** 일시 정지 뒤 다시 홀드해 본다(재개를 알려 주는 길이 아직 없다, 서버가 다시 423이면 돌아온다) */
  | { type: 'RESUME' }
  /** 다시 읽은 홀드로 되돌린다(새로고침, 결제 화면에서 돌아옴) */
  | { type: 'RESTORE'; hold: unknown; extended: boolean }
  /** 해제가 끝났다(204) */
  | { type: 'RELEASED' }
  /** 서버에 홀드가 없다(404) */
  | { type: 'HOLD_GONE' }
  /** 연장했다 */
  | { type: 'EXTENDED' }
  | { type: 'NOTICE'; notice: BookingNotice | null };

export interface BookingContext {
  limit: number;
  picks: SeatPick[];
  notice: BookingNotice | null;
  hold: unknown;
  /** 1회 연장을 썼다 */
  extended: boolean;
}

const toggleCtx = ({ context, event }: { context: BookingContext; event: BookingEvent }): Partial<BookingContext> => {
  if (event.type !== 'TOGGLE') return {};
  const has = context.picks.some((p) => p.seatId === event.seat.seatId);
  if (has) return { picks: context.picks.filter((p) => p.seatId !== event.seat.seatId), notice: null };
  if (context.picks.length >= context.limit) return { notice: { kind: 'limit' } };
  return { picks: [...context.picks, event.seat], notice: null };
};

export const bookingMachine = setup({
  types: {
    context: {} as BookingContext,
    events: {} as BookingEvent,
    input: {} as { limit: number },
  },
  actions: {
    toggle: assign(toggleCtx),
    clearNotice: assign({ notice: null }),
  },
  guards: {
    hasPicks: ({ context }) => context.picks.length > 0,
    isPicked: ({ context, event }) => event.type === 'TOGGLE' && context.picks.some((p) => p.seatId === event.seat.seatId),
  },
}).createMachine({
  id: 'booking',
  initial: 'selecting',
  context: ({ input }) => ({ limit: input.limit, picks: [], notice: null, hold: null, extended: false }),
  on: {
    SESSION_ENDED: '.ended',
    SET_LIMIT: { actions: assign({ limit: ({ event }) => event.limit }) },
    NOTICE: { actions: assign({ notice: ({ event }) => (event.type === 'NOTICE' ? event.notice : null) }) },
  },
  states: {
    selecting: {
      on: {
        TOGGLE: { actions: 'toggle' },
        HOLD: { guard: 'hasPicks', target: 'holding', actions: 'clearNotice' },
        AUTO: { target: 'holding', actions: 'clearNotice' },
        RESTORE: { target: 'held', actions: assign({ hold: ({ event }) => (event.type === 'RESTORE' ? event.hold : null), extended: ({ event }) => event.type === 'RESTORE' && event.extended, notice: null }) },
      },
    },
    holding: {
      on: {
        HOLD_OK: { target: 'held', actions: assign({ hold: ({ event }) => event.hold, extended: false }) },
        HOLD_LOST: { target: 'selecting', actions: assign({ picks: [], notice: ({ event }) => ({ kind: 'lost', suggested: event.suggested }) }) },
        HOLD_RECENT: {
          target: 'selecting',
          actions: assign({ picks: [], notice: ({ event }) => ({ kind: 'recent', seats: event.seats, ...(event.availableAt ? { availableAt: event.availableAt } : {}) }) }),
        },
        HOLD_LIMIT: { target: 'selecting', actions: assign({ notice: { kind: 'limit' } }) },
        HOLD_FAILED: { target: 'selecting', actions: assign({ notice: { kind: 'error' } }) },
        HOLD_PAUSED: 'paused',
        HOLD_SALE_ENDED: 'saleEnded',
      },
    },
    held: {
      on: {
        EXPIRED: { target: 'selecting', actions: assign({ picks: [], hold: null, extended: false, notice: { kind: 'expired' } }) },
        HOLD_GONE: { target: 'selecting', actions: assign({ picks: [], hold: null, extended: false, notice: { kind: 'expired' } }) },
        RELEASED: { target: 'selecting', actions: assign({ picks: [], hold: null, extended: false, notice: { kind: 'released' } }) },
        EXTENDED: { actions: assign({ extended: true, notice: null }) },
      },
    },
    /** 판매 일시 정지(423): 홀드 버튼을 막는다 */
    paused: { on: { TOGGLE: { actions: 'toggle' }, RESUME: 'selecting' } },
    /** 판매 종료(410): 새로 고르지 못하고 고른 좌석을 풀 수만 있다(d5 §5.10) */
    saleEnded: { on: { TOGGLE: { guard: 'isPicked', actions: 'toggle' } } },
    ended: { type: 'final' },
  },
});

/** 홀드 요청 실패 → 기계 이벤트(docs/frontend.md §3.6 holding 행). 이름 없는 401은 refresh(토큰을 한 번 갱신하고 다시 보낸다, §4.1 '401') */
export function holdOutcome(e: { status?: number; type?: string; extensions?: Record<string, unknown> }): BookingEvent | { type: 'REFRESH' } {
  const x = e.extensions ?? {};
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  switch (e.status) {
    case 401:
      return !e.type || e.type === 'about:blank' || e.type.startsWith('http-') ? { type: 'REFRESH' } : { type: 'SESSION_ENDED' };
    case 403:
      return { type: 'SESSION_ENDED' };
    case 409:
      if (e.type === 'seat-already-held') return { type: 'HOLD_LOST', suggested: strings(x.suggestedSeats) };
      if (e.type === 'seat-recently-released') return { type: 'HOLD_RECENT', seats: strings(x.recentlyReleasedSeats), ...(typeof x.reholdAvailableAt === 'string' ? { availableAt: x.reholdAvailableAt } : {}) };
      return { type: 'HOLD_FAILED' };
    case 422:
      return e.type === 'purchase-limit-exceeded' ? { type: 'HOLD_LIMIT' } : { type: 'HOLD_FAILED' };
    case 423:
      return { type: 'HOLD_PAUSED' };
    case 410:
      return { type: 'HOLD_SALE_ENDED' };
    default:
      return { type: 'HOLD_FAILED' };
  }
}

/** 첫 직접 선택 홀드의 행동 요약. 그 요청의 멱등 키와 값이다 */
export interface FirstHoldBehavior {
  key: string;
  behavior: object | undefined;
}

/**
 * 좌석 화면 행동 요약은 구매 세션의 첫 직접 선택 홀드 본문에만 싣는다(docs/features/seat-hold.md §3 '좌석 화면 행동 요약', ADR-0171 결정 4).
 * 같은 멱등 키의 재전송은 같은 값을 다시 싣고, 좌석이 바뀌어 새 키가 되면 싣지 않는다
 */
export function behaviorForHold(first: FirstHoldBehavior | null, key: string, take: () => object | undefined): { first: FirstHoldBehavior; behavior: object | undefined } {
  const f = first ?? { key, behavior: take() };
  return { first: f, behavior: f.key === key ? f.behavior : undefined };
}

/** 멱등 키: 같은 좌석을 다시 시도하면 같은 키, 좌석이 바뀌면 새 키(docs/frontend.md §4.1 '멱등키', 서버 지문은 정렬한 seatIds) */
export function holdIdempotencyKey(prev: { key: string; seats: string } | null, seatIds: readonly string[], make: () => string): { key: string; seats: string } {
  const seats = [...seatIds].sort().join(',');
  return prev && prev.seats === seats ? prev : { key: make(), seats };
}
