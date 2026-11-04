// @peaket/api-client 공개 함수(docs/frontend.md §4.1). 지금은 실행 정책만 있고, orval 생성물(타입·호출 함수·MSW 처리기)은 BAS-040에서 더한다.
export { anySignal } from './signal';
export { parseRetryAfter, fullJitterMs, retryDelayMs, RetryBudget, type Random, type RetryHint } from './retry';
export { ApiError } from './error';
export {
  createApiClient,
  credentialsFor,
  T0_TEXT_PLAIN_OPERATIONS,
  TIMEOUT_MS,
  type ClientOptions,
  type Host,
  type Operation,
  type OperationKind,
  type RequestOptions,
} from './client';
