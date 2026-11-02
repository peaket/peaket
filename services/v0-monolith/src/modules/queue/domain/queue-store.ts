// 대기열 저장 포트(어댑터는 Redis Lua). 시각은 부르는 쪽이 주입한 시계로 넘긴다.
import type { AdmitResult, EnterResult, PersonPlace, QueueConfig, QueueSnapshot, ServingLogEntry, TickResult } from './queue.js';

export const QUEUE_STORE = Symbol.for('peaket.v0.queue.store');

export interface QueueStore {
  open(eventId: string, config: QueueConfig): Promise<void>;
  openEventIds(): Promise<string[]>;
  enter(eventId: string, pid: string, nowMs: number, graceMs: number): Promise<EnterResult>;
  /** 조회만 한다(바꾸지 않는다). 연 회차가 아니면 null */
  read(eventId: string, pid: string): Promise<{ queue: QueueSnapshot; place: PersonPlace } | null>;
  cancel(eventId: string, pid: string): Promise<void>;
  admit(eventId: string, pid: string, nowMs: number, graceMs: number): Promise<AdmitResult>;
  tick(eventId: string, nowMs: number): Promise<TickResult>;
  servingLog(eventId: string): Promise<ServingLogEntry[]>;
  /** 그 회차에 입장한 사람인지(좌석 v0가 묻는다, §13 동작 5) */
  isAdmitted(eventId: string, pid: string): Promise<boolean>;
}
