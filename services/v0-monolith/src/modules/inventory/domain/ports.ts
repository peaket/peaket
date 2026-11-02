// 좌석 v0 포트: 저장소(PostgreSQL 행 잠금), 입장 확인(queue 모듈), 변경분 받기(LISTEN).
import type { ExtendResult, HoldResult, ReleaseResult, SeatDefinition, SeatDelta, SeatEventConfig, SeatView } from './inventory.js';

export const SEAT_STORE = Symbol.for('peaket.v0.inventory.store');
export const ADMISSION_CHECK = Symbol.for('peaket.v0.inventory.admission');
export const DELTA_FEED = Symbol.for('peaket.v0.inventory.deltaFeed');

export interface SeatStore {
  /** 좌석을 연다(다시 부르면 설정만 바꾸고, 이미 있는 좌석의 상태는 그대로 둔다) */
  open(eventId: string, config: Required<SeatEventConfig>, seats: SeatDefinition[]): Promise<void>;
  /** 좌석을 연 회차가 아니면 null */
  seats(eventId: string): Promise<SeatView[] | null>;
  hold(eventId: string, accountId: string, seatIds: string[], nowMs: number): Promise<HoldResult>;
  release(holdId: string, accountId: string, nowMs: number): Promise<ReleaseResult>;
  extend(holdId: string, accountId: string, nowMs: number): Promise<ExtendResult>;
  /** 만료 시각이 지난 HELD 홀드를 풀고 푼 홀드 수를 돌려준다 */
  expireDue(nowMs: number, limit: number): Promise<number>;
}

/** 그 회차 대기열에 입장했는지(queue 모듈 공개 함수, queue-admission §13 동작 5) */
export interface AdmissionCheck {
  isAdmitted(eventId: string, pid: string): Promise<boolean>;
}

/** 커밋된 변경분을 받는다(복제본마다). 받은 원문 JSON과 회차 ID를 넘긴다 */
export interface DeltaFeed {
  subscribe(listener: (delta: SeatDelta, raw: string) => void): () => void;
  /** 받기 연결이 끊겨 그동안의 변경분을 잃었을 수 있을 때 부른다(닫을 때는 부르지 않는다) */
  onGap(listener: () => void): () => void;
  /** 지금 변경분을 받고 있는지. 아니면 새 변경분 연결을 받지 않는다(받으면 그동안의 변경분을 잃은 채 낡은 화면이 남는다) */
  isListening(): boolean;
}
