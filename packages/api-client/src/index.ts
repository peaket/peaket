// @peaket/api-client 공개 함수(docs/frontend.md §2.2·§4.1). 실행 정책과 계약에서 만든 작업 서술 표·오류 목록. orval 호출 함수·훅은
// '@peaket/api-client/endpoints/<태그>'에서, MSW 처리기는 '@peaket/api-client/mocks'에서 가져온다(BUILD_ORDER BAS-041).
export { anySignal } from './signal';
export { parseRetryAfter, fullJitterMs, retryDelayMs, RetryBudget, type Random, type RetryHint } from './retry';
export { ApiError, isPreconditionFailed, purchaseUnauthorizedAction } from './error';
export {
  createApiClient,
  type ApiClient,
  type ApiResponse,
  credentialsFor,
  T0_TEXT_PLAIN_OPERATIONS,
  TIMEOUT_MS,
  type ClientOptions,
  type Host,
  type Operation,
  type OperationKind,
  type RequestOptions,
} from './client';
export { matchOperation, orvalFetch, setOrvalClient } from './orval-fetch';
export { pickRequestFields } from './pick';
export { OPERATIONS, type OperationId } from './gen/operations';
export { PROBLEM_TYPE_BASE, PROBLEM_TYPES, type ProblemType } from './gen/problem-types';
export { copyKeyOf, PROBLEM_COPY_KEYS } from './problem-copy';
