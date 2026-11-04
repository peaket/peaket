// 오류 type → 화면 문구 키(docs/frontend.md §5.12 '오류 type → 문구 키', BUILD_ORDER BAS-041).
// 이름 붙은 오류의 목록은 계약(src/gen/problem-types.ts)이고, 키는 problem.<이름>이 기본이다. §5.12 표가 정한 키만 여기서 덮는다.
// 화면은 서버의 title·detail 원문을 보이지 않고 이 키로 문구를 고른다(5xx는 문의용 traceId만).
import type { ApiError } from './error';
import type { OperationId } from './gen/operations';
import { PROBLEM_TYPES, type ProblemType } from './gen/problem-types';

/** docs/frontend.md §5.12 표의 키(화면 문구 번호는 docs/design/d5 §9.2) */
const FROM_TABLE: Partial<Record<ProblemType, string>> = {
  'seat-already-held': 'seat.hold.conflict',
  'seat-recently-released': 'seat.hold.recentlyReleased',
  'manual-selection-required': 'seat.auto.noMatch',
  'sale-ended': 'sale.ended',
  'reauth-required': 'auth.reauth.expired',
  'not-payer': 'ticket.cancel.notPayer',
  'duplicate-admission': 'queue.admission.duplicate',
  'already-admitted': 'queue.entry.alreadyAdmitted',
  'entry-started': 'transfer.entryStarted',
  'payment-attempts-exceeded': 'payment.attemptsExceeded',
  'trigger-deferred': 'ops.decision.deferred',
  'no-placement': 'scanner.shift.noPlacement',
  'open-interval-conflict': 'ops.saleReview.openIntervalConflict',
  'scale-change-closed': 'ops.saleReview.scaleChangeClosed',
  'sale-paused': 'sale.paused',
  'sold-out': 'queue.soldOut',
};

/** 같은 이름인데 작업마다 문구가 다른 것(§5.12 표의 booking-restricted 행) */
const BY_OPERATION: Partial<Record<ProblemType, Partial<Record<OperationId, string>>>> = {
  'booking-restricted': { createQueueAdmission: 'queue.admission.restricted', createOrder: 'order.create.restricted' },
};

export const PROBLEM_COPY_KEYS = Object.fromEntries(
  (Object.keys(PROBLEM_TYPES) as ProblemType[]).map((t) => [t, FROM_TABLE[t] ?? `problem.${t}`]),
) as Record<ProblemType, string>;

const isKnown = (t: string): t is ProblemType => Object.hasOwn(PROBLEM_TYPES, t);

/**
 * 오류의 문구 키. 이름 붙은 오류는 표의 키, 이름이 없거나(about:blank) 목록에 없는 이름(다른 판의 서버)은
 * 429·503 + Retry-After면 common.retryAfter, 그 밖은 common.http.<상태 코드>다
 */
export function copyKeyOf(e: ApiError, operationId?: OperationId): string {
  if (isKnown(e.type)) return (operationId && BY_OPERATION[e.type]?.[operationId]) || PROBLEM_COPY_KEYS[e.type];
  if ((e.status === 429 || e.status === 503) && e.retryAfter !== null) return 'common.retryAfter';
  return `common.http.${e.status}`;
}
