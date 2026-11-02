// 모듈 공개 함수: 회차 열기와 입장 루프 한 칸, serving 기록 읽기. HTTP로 열지 않는다(관리 API 없음, §13 동작 6).
// 시험·부하 시험 준비 스크립트(wbs 1.2.1)가 부른다.
import type { RedisCommander } from '@peaket/platform';
import { RedisQueueStore } from './adapters/redis/redis-queue-store.js';
import { advanceQueues } from './application/queue-service.js';
import type { QueueConfig, ServingLogEntry, TickResult } from './domain/queue.js';

export interface QueueAdmin {
  /** 회차를 연다(다시 부르면 설정을 바꾼다). 회차 ID 형식이나 설정 범위가 틀리면 던진다 */
  open(eventId: string, config: QueueConfig): Promise<void>;
  /** 연 회차마다 입장 루프 1초 칸을 부른다(nowMs는 유닉스 밀리초) */
  tick(nowMs: number): Promise<TickResult[]>;
  /** 그 회차의 serving 기록(오래된 것부터) */
  servingLog(eventId: string): Promise<ServingLogEntry[]>;
}

export function createQueueAdmin(redis: RedisCommander): QueueAdmin {
  const store = new RedisQueueStore(redis);
  return {
    open: (eventId, config) => store.open(eventId, config),
    tick: (nowMs) => advanceQueues(store, nowMs),
    servingLog: (eventId) => store.servingLog(eventId),
  };
}
