// BAT-037 쓰기 경로 HTTP 백프레셔(칸막이). 주문 생성·결제 시도 시작·결제 접수의 동시 처리 수를 묶어,
// 핫패스 DB 풀(16)이 250ms 안에 못 받는 폭주를 입구에서 429 server-busy + Retry-After로 빨리 돌려보낸다.
// BAT-038: 결제 접수는 공식 K7 점검 경로라 주문·결제 시작과 다른 이름(purchase-accept)의 칸막이를 따로 쓴다.
// 주문 폭주가 접수 몫을 먹지 않게 하고, 접수 자신의 폭주만 따로 막는다.
import type { RouteBulkhead } from '@peaket/platform';

export const WRITE_BULKHEAD_NAME = 'purchase-write';
export const WRITE_BULKHEAD_DEFAULT_LIMIT = 64;
export const WRITE_BULKHEAD_MIN_LIMIT = 1;
export const WRITE_BULKHEAD_MAX_LIMIT = 1_024;
export const WRITE_BULKHEAD_RETRY_AFTER_SECONDS = 1;
export const WRITE_BULKHEAD_LIMIT_ENV = 'PEAKET_PURCHASE_WRITE_BULKHEAD_LIMIT';

/** 주문 생성·결제 시도 시작이 함께 쓰는 칸막이. start()가 환경 값으로 limit을 바꾼다(같은 객체를 장식자가 참조한다) */
export const WRITE_BULKHEAD: RouteBulkhead = {
  name: WRITE_BULKHEAD_NAME,
  limit: WRITE_BULKHEAD_DEFAULT_LIMIT,
  retryAfterSeconds: WRITE_BULKHEAD_RETRY_AFTER_SECONDS,
};

export const ACCEPT_BULKHEAD_NAME = 'purchase-accept';
export const ACCEPT_BULKHEAD_DEFAULT_LIMIT = 64;
export const ACCEPT_BULKHEAD_LIMIT_ENV = 'PEAKET_PURCHASE_ACCEPT_BULKHEAD_LIMIT';

/** 결제 접수 전용 칸막이. 주문·결제 시작과 이름이 달라 그쪽 폭주가 접수 몫을 먹지 않는다 */
export const ACCEPT_BULKHEAD: RouteBulkhead = {
  name: ACCEPT_BULKHEAD_NAME,
  limit: ACCEPT_BULKHEAD_DEFAULT_LIMIT,
  retryAfterSeconds: WRITE_BULKHEAD_RETRY_AFTER_SECONDS,
};

/** 환경 값에서 1~1,024의 10진 정수를 읽는다. 없거나 비면 기본값 */
function limitFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name}는 ${WRITE_BULKHEAD_MIN_LIMIT}~${WRITE_BULKHEAD_MAX_LIMIT}의 10진 정수다: ${raw}`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < WRITE_BULKHEAD_MIN_LIMIT || n > WRITE_BULKHEAD_MAX_LIMIT) {
    throw new Error(`${name}는 ${WRITE_BULKHEAD_MIN_LIMIT}~${WRITE_BULKHEAD_MAX_LIMIT}의 10진 정수다: ${raw}`);
  }
  return n;
}

function setLimit(bulkhead: RouteBulkhead, limit: number, what: string): void {
  if (!Number.isInteger(limit) || limit < WRITE_BULKHEAD_MIN_LIMIT || limit > WRITE_BULKHEAD_MAX_LIMIT) {
    throw new Error(`${what} 칸막이 한도는 ${WRITE_BULKHEAD_MIN_LIMIT}~${WRITE_BULKHEAD_MAX_LIMIT}의 정수다: ${limit}`);
  }
  bulkhead.limit = limit;
}

/**
 * 환경 값에서 쓰기(주문·결제 시작) 칸막이 한도를 읽는다. 없거나 비면 기본 64, 있으면 1~1,024의 10진 정수만 받는다.
 * @throws Error 10진 정수가 아니거나 범위 밖
 */
export function writeBulkheadLimitFromEnv(env: Record<string, string | undefined>): number {
  return limitFromEnv(env, WRITE_BULKHEAD_LIMIT_ENV, WRITE_BULKHEAD_DEFAULT_LIMIT);
}

/** 환경 값에서 결제 접수 전용 칸막이 한도를 읽는다. 없거나 비면 기본 64 */
export function acceptBulkheadLimitFromEnv(env: Record<string, string | undefined>): number {
  return limitFromEnv(env, ACCEPT_BULKHEAD_LIMIT_ENV, ACCEPT_BULKHEAD_DEFAULT_LIMIT);
}

/** 시작 파일이 읽은 값으로 주문·결제 시작 칸막이 한도를 바꾼다. 장식자가 같은 객체를 참조하므로 이후 요청부터 적용된다 */
export function setWriteBulkheadLimit(limit: number): void {
  setLimit(WRITE_BULKHEAD, limit, '쓰기');
}

/** 시작 파일이 읽은 값으로 결제 접수 칸막이 한도를 바꾼다 */
export function setAcceptBulkheadLimit(limit: number): void {
  setLimit(ACCEPT_BULKHEAD, limit, '결제 접수');
}
