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

// SCR-007 로비·SCR-008 대기열·SCR-018 매진은 데이터에 이었다(ADR-0207·0208). 상태는 상태 기계와 응답이 정한다(로컬에서는 가짜 API 상태 바꾸기, apps/README.md)

/** SCR-015 굿즈 대기(보드 SCR-015-m의 '인기 MD 대기열') */
export const GOODS_STATES: readonly BoardState[] = [s('인기 MD 대기열', 'goods', 'waiting')];

/** 보드 상태 이름 → 상태(이름은 화면 넷에서 겹치지 않는다) */
export function findState(name: string | null, screen?: BoardState['screen']): BoardState | undefined {
  if (!name) return undefined;
  const all = [...GOODS_STATES];
  return all.find((x) => x.name === name && (!screen || x.screen === screen));
}


/** `?theme=` 같은 다른 값을 남기며 같은 화면의 다른 상태로 가는 주소 */
export function stateHref(path: string, st: BoardState | string | undefined, keep: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(keep)) if (v !== undefined && k !== 'state') p.set(k, v);
  if (st !== undefined) p.set('state', typeof st === 'string' ? st : st.name);
  const q = p.toString();
  return q ? `${path}?${q}` : path;
}
