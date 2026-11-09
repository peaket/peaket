// RB-35 저장소 포트(ADR-0239 결정 8). 값은 q:{event:E}:shuffle의 칸이다(docs/data.md §3).
import type { BatchSchedule, ShuffleGroup } from '../../batch/index.js';

export interface Rb35State {
  stop: string | null;
  commit: string | null;
  round: number | null;
  published: boolean;
}

export type Rb35Kind = 'wait' | 'emergency' | 'recommit';

export interface Rb35Apply {
  eventId: string;
  group: ShuffleGroup;
  commandId: string;
  kind: Rb35Kind;
  /** 넣은 묶음(지울 때 값이 같은지 본다) */
  raw: string;
  expect: { stop: string | null; commit: string; round: number };
  /** 회차 키 수명(판매 종료 + 1일) */
  expireAtMs: number;
  /** 공개 사유 */
  reason: string;
  /** 적용한 서명 묶음(표시 칸에 함께 저장한다, ADR-0239 결정 15) */
  signedJson: string;
  /** 더 기다리기의 길이 */
  extendMs?: number;
  /** 비상 셔플의 멈췄던 이유 */
  stopReason?: string;
  /** 다시 공시 */
  newRound?: number;
  newRoundTimeMs?: number;
  minLeadMs?: number;
  /** 커밋 뒤 이만큼 지난 라운드여야 한다 */
  minDelayMs?: number;
  /** 지금 라운드의 예정 시각과 '이미 공개됨' 여유(멈추기 전 다시 공시에서만 본다) */
  currentRoundTimeMs?: number;
  publicMarginMs?: number;
  /** 지금 일정의 라운드. 있으면 이미 다시 공시한 구간은 지금 라운드가 이보다 앞설 때만 받는다 */
  scheduledRound?: number;
}

export type Rb35ApplyResult = 'applied' | 'replay' | 'published' | 'beacon_recorded' | 'stale_state' | 'too_late' | 'round_public' | 'already_recommitted' | 'already_emergency';

export interface Rb35Store {
  scheduleOf(eventId: string): Promise<BatchSchedule | null>;
  state(eventId: string, group: ShuffleGroup): Promise<Rb35State>;
  /** 받는 쪽이 볼 묶음. 같은 구간에 다른 명령이 처리 중이면 false */
  deposit(eventId: string, group: ShuffleGroup, commandId: string, raw: string): Promise<boolean>;
  pending(eventId: string): Promise<{ group: ShuffleGroup; raw: string }[]>;
  /** Lua 한 번에 지금 상태를 보고 적용한다 */
  apply(a: Rb35Apply): Promise<Rb35ApplyResult>;
  /** 거절: 전달 칸을 비우고(같은 값일 때만) 결과를 남긴다 */
  reject(eventId: string, group: ShuffleGroup, commandId: string | null, raw: string, reason: string): Promise<void>;
  result(eventId: string, commandId: string): Promise<string | null>;
}
