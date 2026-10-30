// 대기실 상태 기계(docs/frontend.md §3.4). 손으로 쓴 상태표 하나가 화면(SCR)을 정한다.
// 지금은 퍼블리싱 단계라 폴러·진입 API를 붙이지 않고, 목업 토큰으로 boot만 흉내 낸다. 화면은 `?state=`(보드 상태 이름)로 고른다.
import type { EventFixture } from './fixtures';

export type Screen = '007' | '008' | '018';

export type MachineState =
  | 'boot' | 'lobby-join' | 'lobby' | 'shuffle-fetch' | 'shuffle-delayed' | 'enter' | 'batching' | 'waiting' | 'stale'
  | 'paused' | 'all-held' | 'turn' | 'soon' | 'grace' | 'admitted' | 'verify-redirect' | 'other-device'
  | 'cancelled-elsewhere' | 'already-admitted' | 'duplicate' | 'expired' | 'restricted' | 'sold-out' | 'ended'
  | 'login-expired' | 'offline';

export type MachineEvent =
  | 'JOIN_OPEN' | 'JOINED' | 'CONFLICT' | 'OPEN_REACHED' | 'SHUFFLE_READY' | 'SHUFFLE_SLOW' | 'ENTERED' | 'BATCHED'
  | 'TURN' | 'SOON' | 'ADMITTED' | 'VERIFY' | 'PAUSED' | 'ALL_HELD' | 'ON_SALE' | 'SOLD_OUT' | 'ENDED' | 'FAILURES'
  | 'RECOVERED' | 'EXPIRED' | 'REJOIN' | 'DUPLICATE' | 'RESTRICTED' | 'UNAUTHORIZED' | 'CANCELLED_ELSEWHERE' | 'OFFLINE';

interface Row {
  /** 그리는 화면. null이면 다른 화면으로 이동만 한다 */
  screen: Screen | null;
  on?: Partial<Record<MachineEvent, MachineState>>;
}

/** §3.4 상태표. 나가는 조건 → 다음 상태 */
export const TABLE: Record<MachineState, Row> = {
  boot: { screen: null },
  'lobby-join': { screen: '007', on: { JOINED: 'lobby', VERIFY: 'verify-redirect', CONFLICT: 'other-device' } },
  lobby: { screen: '007', on: { OPEN_REACHED: 'shuffle-fetch', CANCELLED_ELSEWHERE: 'cancelled-elsewhere', OFFLINE: 'offline' } },
  'shuffle-fetch': { screen: '007', on: { SHUFFLE_READY: 'waiting', SHUFFLE_SLOW: 'shuffle-delayed' } },
  'shuffle-delayed': { screen: '007', on: { SHUFFLE_READY: 'waiting' } },
  enter: { screen: '008', on: { ENTERED: 'waiting', BATCHED: 'batching', CONFLICT: 'other-device', SOLD_OUT: 'sold-out', ENDED: 'ended' } },
  batching: { screen: '008', on: { ENTERED: 'waiting' } },
  waiting: {
    screen: '008',
    on: { TURN: 'turn', PAUSED: 'paused', ALL_HELD: 'all-held', SOLD_OUT: 'sold-out', ENDED: 'ended', FAILURES: 'stale', OFFLINE: 'offline' },
  },
  stale: { screen: '008', on: { RECOVERED: 'waiting' } },
  paused: { screen: '008', on: { ON_SALE: 'waiting' } },
  'all-held': { screen: '008', on: { ON_SALE: 'waiting', SOLD_OUT: 'sold-out', ENDED: 'ended' } },
  turn: {
    screen: '008',
    on: { ADMITTED: 'admitted', SOON: 'soon', VERIFY: 'verify-redirect', DUPLICATE: 'duplicate', EXPIRED: 'expired', ENDED: 'ended', RESTRICTED: 'restricted', UNAUTHORIZED: 'login-expired' },
  },
  soon: { screen: '008', on: { TURN: 'turn' } },
  // d5 §5.8 '차례 도래 유예'(탭이 백그라운드였던 사이 차례가 지남, 15분 유예). §3.4 표에는 없어 turn 앞의 화면 상태로 둔다
  grace: { screen: '008', on: { TURN: 'turn' } },
  admitted: { screen: null },
  'verify-redirect': { screen: null },
  'other-device': { screen: '007', on: { REJOIN: 'lobby-join' } },
  'cancelled-elsewhere': { screen: '007' },
  'already-admitted': { screen: '008' },
  duplicate: { screen: '008' },
  expired: { screen: '008', on: { REJOIN: 'enter' } },
  // d5 §5.8 '예매 제한'(입장 확정 403 booking-restricted). §3.4 표에는 없다
  restricted: { screen: '008' },
  'sold-out': { screen: '018' },
  ended: { screen: '008' },
  'login-expired': { screen: '008' },
  offline: { screen: '008', on: { RECOVERED: 'waiting' } },
};

export function next(state: MachineState, ev: MachineEvent): MachineState {
  return TABLE[state].on?.[ev] ?? state;
}

/** §3.4 boot: 저장소의 토큰(목업)으로 첫 상태를 고른다 */
export function boot(ev: EventFixture): MachineState {
  if (ev.status.saleStatus === 'SOLD_OUT') return 'sold-out';
  if (ev.session.queueTicket) return 'waiting';
  if (ev.session.joinToken) return 'lobby';
  if (ev.session.beforeOpen) return 'lobby-join';
  return 'enter';
}
