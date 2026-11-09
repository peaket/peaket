// 좌석 연결 화면 상태 기계(docs/frontend.md §3.5, CMP-021, ADR-0240, FE-T11, BUILD_ORDER HOT-100). 연결은 Worker가 맡고(@peaket/seatmap connection), 이 기계는 그 알림을 받아 화면 상태를 정한다.
// 화면에 잇는 일은 realtime-gw가 생긴 뒤의 HOT-357이다.
import { assign, setup } from 'xstate';

export type ConnectionEndReason = 'token-invalid' | 'token-expired' | 'forbidden';

export type ConnectionEvent =
  | { type: 'OPENED' }
  | { type: 'LOST' }
  | { type: 'BATCH'; degraded: boolean }
  | { type: 'ENDED'; reason: ConnectionEndReason };

export interface ConnectionContext {
  degraded: boolean;
  endReason: ConnectionEndReason | null;
}

/** Worker가 알린 상태 → 기계 이벤트. 'connecting'은 시작 상태라 이벤트가 없다 */
export function connectionEvent(state: string, detail?: { reason?: ConnectionEndReason; degraded?: boolean }): ConnectionEvent | null {
  if (state === 'live') return detail?.degraded === undefined ? { type: 'OPENED' } : { type: 'BATCH', degraded: detail.degraded };
  if (state === 'reconnecting') return { type: 'LOST' };
  if (state === 'ended') return { type: 'ENDED', reason: detail?.reason ?? 'token-invalid' };
  return null;
}

export const connectionMachine = setup({
  types: {
    context: {} as ConnectionContext,
    events: {} as ConnectionEvent,
  },
}).createMachine({
  id: 'seat-connection',
  initial: 'connecting',
  context: { degraded: false, endReason: null },
  on: { ENDED: { target: '.ended', actions: assign({ endReason: ({ event }) => event.reason }) } },
  states: {
    connecting: { on: { OPENED: 'live', LOST: 'reconnecting' } },
    live: {
      on: {
        LOST: 'reconnecting',
        BATCH: { actions: assign({ degraded: ({ event }) => event.degraded }) },
      },
    },
    // 다시 붙으면 Degraded 여부는 서버가 다시 알린다(BatchInterval은 바뀔 때만 온다)
    reconnecting: { on: { OPENED: { target: 'live', actions: assign({ degraded: false }) } } },
    ended: { type: 'final' },
  },
});
