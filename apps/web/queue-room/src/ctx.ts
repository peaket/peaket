// 화면 함수들이 받는 문맥. 화면은 이 문맥으로만 상태를 바꾸고 시트·대화상자를 연다.
import type { EventFixture, ProductFixture } from './fixtures';
import type { BoardState } from './states';

export type ModalKey = 'logout' | 'notify' | 'cancel' | 'info' | 'pref' | 'rejoin' | 'menu';

export interface Ctx {
  state: BoardState;
  /** 지금 주소의 경로(로그인 뒤 돌아올 곳) */
  path: string;
  /** 시연용 상태 바꾸기(같은 주소의 ?state=를 바꾸고 다시 그린다. 초점은 새 화면의 h1로) */
  go(stateName: string): void;
  /** 시트·대화상자 열기. opener는 닫은 뒤 초점이 돌아갈 버튼 */
  open(key: ModalKey, opener: HTMLElement | null): void;
  /** 다시 그릴 때 정리할 타이머 */
  onCleanup(fn: () => void): void;
}

export interface EventCtx extends Ctx {
  ev: EventFixture;
}

export interface GoodsCtx extends Ctx {
  product: ProductFixture;
}
