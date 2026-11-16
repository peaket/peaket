// 탈퇴 후기 다시 정리 반복(소유자 결정 2026-11-16 OPEN[44], ADR-0278, docs/streaming.md §2.6 'core-svc 소비자', docs/features/identity.md §8 '다시 정리').
// 소비자를 켠 파드마다 60초 [가정]마다 때가 된 예약을 100개 [가정]씩 다시 파기한다. 이 파일은 Kafka 클라이언트(네이티브 모듈)를 싣지 않는다.
// 뼈대(W8-audit2a 시험 단계): 모양만 더했다. 구현 담당이 채운다.
import type { Registry } from '@peaket/platform';
import type { Reviews } from '../modules/review/index.js';

export interface ReviewRecheckLoopOptions {
  reviews: Pick<Reviews, 'runWithdrawalRechecks' | 'oldestOverdueRecheckMs'>;
  /** 기본 60_000 [가정] */
  everyMs?: number;
  /** 기본 100 [가정] */
  limit?: number;
  /** maintenance_retention_overdue_seconds{service:'core-svc', table:'review_withdrawal_recheck'} */
  registry?: Registry;
  logger?: { warn(o: object, msg?: string): void; info?(o: object, msg?: string): void };
  /** 시험이 바꾼다 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** 한 번 돌 때 accounts가 limit과 같으면 곧바로 다시 돈다(밀린 것을 비울 때까지). 실패는 경고 한 줄(계정 ID 없음) 뒤 다음 간격에 다시 한다 */
export function startReviewRecheckLoop(_o: ReviewRecheckLoopOptions): { stop(): Promise<void> } {
  throw new Error('아직 없음');
}
