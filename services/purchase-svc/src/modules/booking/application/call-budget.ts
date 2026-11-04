// 요청의 남은 시간(deadline)을 호출마다 나누는 규칙(docs/api/guidelines.md §5, docs/architecture.md §5 시간 초과 표). 주문 생성과 결제 접수가 함께 쓴다.
// 좌석 Redis 호출은 상한 100ms와 남은 시간 가운데 짧은 쪽, 남은 시간이 5ms [가정] 미만이면 부르지 않고 504 deadline-exceeded(inventory hold-seats와 같은 기준, 리뷰 고침 L4).
// DB 트랜잭션은 남은 시간이 역할의 문장 상한보다 짧을 때만 그 남은 시간을 문장 시간 초과로 건다.
import type { Deadline } from '@peaket/platform';
import type { TransactionCallOptions } from '../domain/ports.js';

/** 좌석 Redis 호출 하나의 마감 상한(ms, 플랫폼 REDIS_CALL_DEADLINE_MS와 같은 값. inventory SEAT_CALL_CAP_MS와 같은 뜻) */
export const SEAT_CALL_CAP_MS = 100;
/** 좌석 Redis를 부르기 전에 남아 있어야 하는 시간(ms, inventory SEAT_CALL_MIN_REMAINING_MS와 같은 값 5 [가정]) */
export const SEAT_CALL_MIN_REMAINING_MS = 5;
/** purchase DB 역할의 문장 상한(ms, 핫패스 역할 1초 [가정], architecture §5). 남은 시간이 이보다 짧을 때만 트랜잭션에 넘긴다 */
export const DB_STATEMENT_CAP_MS = 1_000;

/** 호출 하나의 데드라인: min(상한, 요청의 남은 시간)을 내림한 정수(1 이상). 남은 시간이 없으면 상한 그대로 */
export function budgetOf(deadline: Deadline | undefined, capMs: number): number {
  return deadline ? Math.max(1, Math.floor(deadline.budgetFor(capMs))) : capMs;
}

/** 좌석 Redis 포트에 줄 마감. 요청의 남은 시간이 없으면 플랫폼 기본을 쓴다(넘기지 않는다) */
export function seatCallOf(deadline: Deadline | undefined): { deadlineMs?: number } {
  return deadline ? { deadlineMs: budgetOf(deadline, SEAT_CALL_CAP_MS) } : {};
}

/** 좌석 Redis를 부르면 안 되는가(남은 시간이 5ms [가정] 미만). 남은 시간이 없으면 거짓 */
export function seatCallTooLate(deadline: Deadline | undefined): boolean {
  return deadline !== undefined && deadline.remainingMs() < SEAT_CALL_MIN_REMAINING_MS;
}

/** 트랜잭션 선택값: 남은 시간이 DB 문장 상한보다 짧으면 그것(내림, 1 이상)을, 아니면 아무것도 넘기지 않는다(역할 기본) */
export function transactionCallOf(deadline: Deadline | undefined): TransactionCallOptions {
  if (!deadline) return {};
  const left = deadline.remainingMs();
  return left < DB_STATEMENT_CAP_MS ? { deadlineMs: Math.max(1, Math.floor(left)) } : {};
}
