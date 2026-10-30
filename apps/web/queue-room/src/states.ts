// 퍼블리싱 상태 고르기(add-screen-publishing design.md 결정 7). 상태 이름은 캔버스 보드 `state` 열거값(한국어) 그대로다.
// 같은 주소(/queue/[eventId])가 로비·대기열·매진을 모두 그리므로(§3.4) 상태 이름 하나가 화면과 상태 기계 자리를 함께 정한다.
// 데이터 연결 단계에서 걷어 낸다(ADR-0170).
import type { MachineState, Screen } from './machine';

export interface BoardState {
  name: string;
  screen: Screen | 'goods';
  machine: MachineState;
  /** 화면 목록에서 이 상태를 열 목업 ID(보드가 다른 공연으로 그린 상태) */
  eventId?: string;
  /** 보드에 없고 d5 상태 표·§3.4에만 있어 더한 상태 */
  added?: boolean;
}

const s = (name: string, screen: BoardState['screen'], machine: MachineState, extra: Partial<BoardState> = {}): BoardState =>
  ({ name, screen, machine, ...extra });

/** SCR-007 로비(보드 SCR-007-m 순서). '저전력'은 d5 §5.7 상태 표에서 더했다 */
export const LOBBY_STATES: readonly BoardState[] = [
  s('오픈 전 대기', '007', 'lobby'),
  s('순번 공개 대기', '007', 'shuffle-fetch'),
  s('발표 지연', '007', 'shuffle-delayed'),
  s('다른 기기 참가 409', '007', 'other-device'),
  s('자동 배정 공연', '007', 'lobby', { eventId: 'evt-winter-fanmeet' }),
  s('사람 확인 중', '007', 'lobby-join'),
  s('사람 확인 실패', '007', 'lobby-join'),
  s('순서 계산 중', '007', 'shuffle-fetch'),
  s('비상 처리 공지', '007', 'shuffle-fetch'),
  s('다른 기기에서 취소됨', '007', 'cancelled-elsewhere'),
  s('오프라인', '007', 'lobby'),
  s('참가 전, 이 기기의 버튼은 아직', '007', 'lobby-join'),
  s('저전력', '007', 'lobby', { added: true }),
];

const FIFO = 'evt-autumn-fest';

/** SCR-008 대기열(보드 SCR-008-m 순서). '연결 끊김'은 §3.4 offline(008)과 d5 §5.8 시연 목록에서 더했다 */
export const QUEUE_STATES: readonly BoardState[] = [
  s('대기 중', '008', 'waiting'),
  s('순서를 정하는 중', '008', 'batching', { eventId: FIFO }),
  s('곧 입장', '008', 'soon'),
  s('연결 확인 중', '008', 'stale'),
  s('일시정지', '008', 'paused'),
  s('일시 매진', '008', 'all-held'),
  s('대기표 만료', '008', 'expired'),
  s('대기 취소 확인', '008', 'waiting'),
  s('값이 바뀌는 순간', '008', 'waiting'),
  s('순번 안내 시트', '008', 'waiting'),
  s('자동 배정 희망 조건', '008', 'waiting', { eventId: FIFO }),
  s('희망 조건 바꾸기 시트', '008', 'waiting', { eventId: FIFO }),
  s('운영 공지', '008', 'waiting'),
  s('구매가 어려울 수 있음', '008', 'waiting'),
  s('다른 기기에서 취소', '008', 'cancelled-elsewhere'),
  s('추가 검증', '008', 'verify-redirect'),
  s('이미 입장', '008', 'already-admitted'),
  s('로그인 만료', '008', 'login-expired'),
  s('판매 종료', '008', 'ended'),
  s('순번 확인 중', '008', 'enter'),
  s('차례 도래 유예', '008', 'grace'),
  s('1순위 등급 매진', '008', 'waiting', { eventId: FIFO }),
  s('다른 곳에서 이미 입장', '008', 'duplicate'),
  s('순번 안내 시트 — 선착순', '008', 'waiting', { eventId: FIFO }),
  s('예매 제한(입장 확정 403)', '008', 'restricted'),
  s('연결 끊김', '008', 'offline', { added: true }),
];

/** SCR-018 매진(보드 SCR-018-m) */
export const SOLDOUT_STATES: readonly BoardState[] = [
  s('매진', '018', 'sold-out'),
  s('판매 종료 뒤 매진', '018', 'sold-out'),
  s('알림 신청됨', '018', 'sold-out'),
  s('알림 신청 실패', '018', 'sold-out'),
];

/** SCR-015 굿즈 대기(보드 SCR-015-m의 '인기 MD 대기열') */
export const GOODS_STATES: readonly BoardState[] = [s('인기 MD 대기열', 'goods', 'waiting')];

/** 보드 상태 이름 → 상태(이름은 화면 넷에서 겹치지 않는다) */
export function findState(name: string | null, screen?: BoardState['screen']): BoardState | undefined {
  if (!name) return undefined;
  const all = [...LOBBY_STATES, ...QUEUE_STATES, ...SOLDOUT_STATES, ...GOODS_STATES];
  return all.find((x) => x.name === name && (!screen || x.screen === screen));
}

/** 상태 기계 자리 → 그 화면의 기본 보드 상태(주소에 ?state=가 없을 때) */
export function defaultStateFor(machine: MachineState): BoardState {
  if (machine === 'sold-out') return SOLDOUT_STATES[0]!;
  if (machine === 'lobby' || machine === 'lobby-join' || machine === 'shuffle-fetch') return LOBBY_STATES[0]!;
  return QUEUE_STATES[0]!;
}

/** `?theme=` 같은 다른 값을 남기며 같은 화면의 다른 상태로 가는 주소 */
export function stateHref(path: string, st: BoardState | string | undefined, keep: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(keep)) if (v !== undefined && k !== 'state') p.set(k, v);
  if (st !== undefined) p.set('state', typeof st === 'string' ? st : st.name);
  const q = p.toString();
  return q ? `${path}?${q}` : path;
}
