// 화면 함수들이 받는 문맥. 화면은 이 문맥으로만 상태를 바꾸고 시트·대화상자를 연다.
import type { EventFixture, ProductFixture } from './fixtures';
import type { QueueView } from './live/controller.ts';
import type { EventMeta } from './live/meta.ts';
import type { BoardState } from './states';

export type ModalKey = 'logout' | 'notify' | 'cancel' | 'info' | 'pref' | 'rejoin' | 'menu';

/** 모든 화면이 쓰는 것 */
export interface BaseCtx {
  /** 지금 주소의 경로(로그인 뒤 돌아올 곳) */
  path: string;
  /** 시트·대화상자 열기. opener는 닫은 뒤 초점이 돌아갈 버튼 */
  open(key: ModalKey, opener: HTMLElement | null): void;
  /** 다시 그릴 때 정리할 타이머 */
  onCleanup(fn: () => void): void;
}

/** 퍼블리싱 화면(로비·굿즈 대기, 데이터 연결 전): `?state=`로 고른다 */
export interface Ctx extends BaseCtx {
  state: BoardState;
  /** 시연용 상태 바꾸기(같은 주소의 ?state=를 바꾸고 다시 그린다. 초점은 새 화면의 h1로) */
  go(stateName: string): void;
}

export interface EventCtx extends Ctx {
  ev: EventFixture;
}

export interface GoodsCtx extends Ctx {
  product: ProductFixture;
}

/** 머리가 쓰는 공연 값(목업과 실제 공개 요약 모두) */
export interface HeaderEvent {
  id: string;
  title: string;
  when: string;
}

/** 대기열·매진 화면(데이터 연결, ADR-0207): 상태 기계가 낸 화면 값과 동작 */
export interface LiveCtx extends BaseCtx {
  ev: EventMeta;
  view: QueueView;
  actions: {
    /** 대기 취소(확인 대화상자 뒤). 실패하면 false */
    cancel(): Promise<boolean>;
    /** 다시 줄 서기·이 기기에서 다시 참가 */
    rejoin(): void;
  };
}
