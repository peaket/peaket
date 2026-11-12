// BAT-037 쓰기 경로 HTTP 백프레셔(칸막이). 주문 생성·결제 시도 시작·결제 접수의 동시 처리 수를 묶어,
// 핫패스 DB 풀(16)이 250ms 안에 못 받는 폭주를 입구에서 429 server-busy + Retry-After로 빨리 돌려보낸다.
// 기본 64는 핫패스 풀의 4배다(연결 하나에 네 요청까지 줄 세우는 셈). K7 진단에서 429 <1%·confirm p99 <3초를 보고 조정한다.
import type { RouteBulkhead } from '@peaket/platform';

export const WRITE_BULKHEAD_NAME = 'purchase-write';
export const WRITE_BULKHEAD_DEFAULT_LIMIT = 64;
export const WRITE_BULKHEAD_MIN_LIMIT = 1;
export const WRITE_BULKHEAD_MAX_LIMIT = 1_024;
export const WRITE_BULKHEAD_RETRY_AFTER_SECONDS = 1;
export const WRITE_BULKHEAD_LIMIT_ENV = 'PEAKET_PURCHASE_WRITE_BULKHEAD_LIMIT';

/** 세 쓰기 경로가 함께 쓰는 칸막이. start()가 환경 값으로 limit을 바꾼다(같은 객체를 장식자가 참조한다) */
export const WRITE_BULKHEAD: RouteBulkhead = {
  name: WRITE_BULKHEAD_NAME,
  limit: WRITE_BULKHEAD_DEFAULT_LIMIT,
  retryAfterSeconds: WRITE_BULKHEAD_RETRY_AFTER_SECONDS,
};

/**
 * 환경 값에서 쓰기 칸막이 한도를 읽는다. 없거나 비면 기본 64, 있으면 1~1,024의 10진 정수만 받는다.
 * @throws Error 10진 정수가 아니거나 범위 밖
 */
export function writeBulkheadLimitFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[WRITE_BULKHEAD_LIMIT_ENV];
  if (raw === undefined || raw === '') return WRITE_BULKHEAD_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw new Error(`${WRITE_BULKHEAD_LIMIT_ENV}는 1~${WRITE_BULKHEAD_MAX_LIMIT}의 10진 정수다: ${raw}`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < WRITE_BULKHEAD_MIN_LIMIT || n > WRITE_BULKHEAD_MAX_LIMIT) {
    throw new Error(`${WRITE_BULKHEAD_LIMIT_ENV}는 1~${WRITE_BULKHEAD_MAX_LIMIT}의 10진 정수다: ${raw}`);
  }
  return n;
}

/** 시작 파일이 읽은 값으로 칸막이 한도를 바꾼다. 장식자가 같은 객체를 참조하므로 이후 요청부터 적용된다 */
export function setWriteBulkheadLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < WRITE_BULKHEAD_MIN_LIMIT || limit > WRITE_BULKHEAD_MAX_LIMIT) {
    throw new Error(`쓰기 칸막이 한도는 ${WRITE_BULKHEAD_MIN_LIMIT}~${WRITE_BULKHEAD_MAX_LIMIT}의 정수다: ${limit}`);
  }
  WRITE_BULKHEAD.limit = limit;
}
