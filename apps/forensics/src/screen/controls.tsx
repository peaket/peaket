// 재생·정지·속도·시나리오 고르기의 작은 클라이언트 동작(design.md 결정 8: 실제 재생 Worker는 붙이지 않는다).
// 재생·정지와 시나리오 목록은 보드 상태(?state=)를 바꾸고, 배속은 눌림 표시만 바꾼다.
import { createContext, useContext } from 'react';

export type Speed = '×1' | '×10' | '×60';

export interface ReplayControls {
  play(): void;
  pause(): void;
  speed: Speed;
  setSpeed(s: Speed): void;
  /** 시나리오 목록 열기·닫기 */
  togglePick(): void;
  /** 다시 만들기 → '만드는 중' */
  regenerate(): void;
}

const noop = () => {};
const Ctx = createContext<ReplayControls>({ play: noop, pause: noop, speed: '×1', setSpeed: noop, togglePick: noop, regenerate: noop });

export const ReplayProvider = Ctx.Provider;

export function useReplay(): ReplayControls {
  return useContext(Ctx);
}
