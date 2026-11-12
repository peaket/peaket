// purchase-svc 핫패스 DB 풀의 연결 대기 한도(BAT-034, HOT-468).
// 진단: K7에서 접수 429 server-busy 794·503 4, 같은 429가 주문 2,545·결제 시작 1,296에도 났다.
// 원인은 핫패스 풀(profile hot, max 16)의 100ms 연결 대기 초과다. 250ms로 늘려 짧은 포화를 흡수한다.
// max는 BAT-031이 32까지 재 봤지만 429가 줄지 않고 PostgreSQL 연결 압박만 커져 16을 유지한다.
// 값은 서비스 환경 파일에서 받는다(시작 파일은 process.env를 직접 읽지 않는다, start.ts 머리말).

/** 핫패스 연결 대기 한도 환경 값 이름 */
export const HOT_CONNECT_TIMEOUT_ENV = 'PEAKET_DB_HOT_CONNECT_TIMEOUT_MS';
/** 기본 250ms. 100ms는 200ms 남짓 점유된 연결을 429로 거절했다(BAT-034 작은 통합 시험) */
export const HOT_CONNECT_TIMEOUT_DEFAULT_MS = 250;
export const HOT_CONNECT_TIMEOUT_MIN_MS = 1;
export const HOT_CONNECT_TIMEOUT_MAX_MS = 5_000;

/**
 * 환경 값에서 핫패스 연결 대기 한도를 읽는다. 없거나 빈 값이면 250ms, 있으면 1~5,000의 정수만 받는다.
 * @throws Error 값이 정수가 아니거나 범위 밖(시작 실패)
 */
export function hotConnectTimeoutMsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[HOT_CONNECT_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return HOT_CONNECT_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < HOT_CONNECT_TIMEOUT_MIN_MS || n > HOT_CONNECT_TIMEOUT_MAX_MS) {
    throw new Error(`${HOT_CONNECT_TIMEOUT_ENV}는 ${HOT_CONNECT_TIMEOUT_MIN_MS}~${HOT_CONNECT_TIMEOUT_MAX_MS}의 정수다: ${raw}`);
  }
  return n;
}
