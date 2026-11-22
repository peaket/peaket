// 판매 중지 원본(sale_control)과 사본(s:{event:E}:ctl)의 포트(ADR-0103·0123). 도메인은 DB·Redis를 모른다.
import type { SaleControl, SaleControlSnapshot, SalePauseApplied, SalePauseWrite, SaleSuspensionApplied, SaleSuspensionWrite } from './sale-control.js';

export const SALE_CONTROL_STORE = Symbol('purchase.SaleControlStore');
export interface SaleControlStore {
  /** 회차 범위 행. 없으면 undefined */
  find(eventId: string): Promise<SaleControl | undefined>;
  /**
   * 판매 중지·재개를 조건부로 쓴다. 같은 명령이 같은 상태를 다시 쓰면 아무것도 바꾸지 않고 changed 거짓이다.
   * 그 밖에는 판 번호를 하나 올리고 changed 참이다(같은 범위에서 늘어나기만 한다).
   */
  apply(write: SaleSuspensionWrite): Promise<SaleSuspensionApplied>;
  /**
   * 명령 3(판매 일시정지)을 조건부로 쓴다(ADR-0365 결정 6). write.version이 그 범위 행의 paused_revision보다 클 때만
   * paused·paused_revision·paused_command_id·paused_changed_at을 바꾸고, 같거나 작으면 아무것도 바꾸지 않고 지금 값을 돌려준다.
   * 판매 중지 칸(suspended·revision·command_id)은 건드리지 않는다
   */
  applyPause(write: SalePauseWrite): Promise<SalePauseApplied>;
  /** 원본 전체(회차 행과 전체 행). 다시 맞춤이 2초 [가정]마다 읽는다. 읽지 못하면 던진다 */
  snapshot(): Promise<SaleControlSnapshot>;
}

/** 좌석 Redis 사본 쓰기. 실패하면 던진다(명령은 FAILED로 남고 재시도가 다시 쓴다) */
export const SALE_CONTROL_COPIES = Symbol('purchase.SaleControlCopies');
export interface SaleControlCopies {
  /**
   * s:{event:E}:ctl에 suspended('1'·'0')·suspRef·rev·cmd를 쓴다. paused·allPaused 같은 다른 칸은 건드리지 않는다.
   * 같은 값으로 여러 번 써도 같다(멱등).
   */
  write(c: Pick<SaleControl, 'eventId' | 'suspended' | 'revision' | 'commandId' | 'suspensionRef'>): Promise<void>;
  /**
   * 명령 3 회차 범위 사본: s:{event:E}:ctl의 paused('1'·'0')·pausedRev·pausedCmd를 pausedRev가 지금 칸보다 클 때만 쓴다(ADR-0365 결정 6).
   * suspended·rev·cmd·allPaused는 건드리지 않는다. 쓴 뒤의 pausedRev를 돌려준다. 판매 중지만 쓰는 사본(옛 대역)은 두 명령 3 쓰기가 없다
   */
  writePause?(c: { readonly eventId: string; readonly paused: boolean; readonly revision: number; readonly commandId?: string }): Promise<number>;
  /**
   * 명령 3 전체 범위 사본: 회차 목록 s:ctl:events의 회차마다 s:{event:E}:ctl의 allPaused·allRev·allCmd를 allRev가 지금 칸보다 클 때만 쓴다(data.md 그대로).
   * 쓴 회차 수를 돌려준다
   */
  writePlatformPause?(c: { readonly paused: boolean; readonly revision: number; readonly commandId?: string }): Promise<number>;
}

/**
 * 파드 메모리의 명령 3·판매 중지 상태(ADR-0365 결정 7·8). 받는 쪽 쓰기와 2초 다시 맞춤이 채우고, 결제 시도·결제 접수의 정지 확인과
 * 구매 세션 정리의 유휴 시계가 읽는다
 */
export interface SalePauseView {
  /** 그 회차가 판매 일시정지(회차·전체)나 판매 중지인가 */
  stopped(eventId: string): boolean;
  /**
   * 유휴 시계 규칙(ADR-0365 결정 8): 그 회차가 일시정지(회차·전체)이면 paused 참. 아니면 마지막으로 풀린 시각(회차·전체 가운데 늦은 것)이 있으면 releasedAtMs.
   * 판매 중지(suspended)는 상태 기계 T11의 예외가 아니라 보지 않는다
   */
  idleRule(eventId: string): { readonly paused: true } | { readonly paused: false; readonly releasedAtMs?: number };
}
