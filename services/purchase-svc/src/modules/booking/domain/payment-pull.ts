// 결제 결과 당기기의 값과 규칙(ADR-0140 결정 1~4, docs/features/payment.md §2 '결제 결과 반영', docs/data.md order_saga_job·§5.1,
// docs/api/proto/peaket/payment/v1/payment.proto BatchGetPayments·OrderPaymentState·PaymentStatus, BUILD_ORDER PRF-171).
// 결과 사건(trade.payments)이 늦을 때 purchase가 payment-svc에 직접 묻는 보조 길이다(밀기와 당기기). 사건 길을 대신하지 않는다(ADR-0140 결정 4).
// 실행기(application/payment-result-pull.ts)가 1초 [가정]마다, 승인 명령을 보낸 지 5초 [가정]가 지나도 결과를 반영하지 못한 주문(order_saga_job의 CONFIRM·AWAIT 행)을
// 100건 [가정]씩 BatchGetPayments로 묻고(파드마다 동시 4개 [가정], 데드라인 500ms [가정]), 답(OrderPaymentState)을 결제 사건(PaymentResultEvent)으로 바꿔
// 사건 길과 같은 ApplyPaymentResult.execute로 반영한다. 이미 반영한 순번 이하는 건너뛰므로 사건이 뒤늦게 와도 두 번 반영되지 않는다(ADR-0140 결정 2).
// 프레임워크·저장소·계약 패키지를 모른다(순수 값과 함수). 답의 모양(proto 칸 이름·enum 앞머리)은 어댑터(adapters/grpc-payment-results.ts)가 바꿔 넘긴다.
// 정본에 없어 정한 것은 BUILD_ORDER PRF-171 설계 1~9(추천 적용 2026-11-06)다. 이 파일에서 더 정한 것:
// - APPROVED인데 approved_at이 없으면 occurredAt을 당긴 시각으로 둔다(발권 기한이 실제 승인보다 몇 초 늦게 잡힐 뿐이다. 버리면 사건 길이 멈춘 동안 승인이 확정되지 않는다).
// - APPROVED의 approved_at이 그 주문의 승인 명령을 보낸 시각(confirm_sent_at)보다 1분 [정함]을 넘게 이르면 있을 수 없는 값으로 보고 occurredAt을 당긴 시각으로 둔다
//   (발권 기한(승인 + 30분)을 이미 지난 것으로 잡지 않게. 1분은 파드 사이 시계 어긋남의 여유다. 경고 줄은 남기지 않는다, 2026-11-06 코드 리뷰 L2).
// - 반영할 수 없는 모양의 답(상태 UNSPECIFIED·결제사 없음·순번이나 금액이 틀림·eventKey 빈 글)은 IGNORE MALFORMED다(실행기가 경고 한 줄 뒤 60초 [가정] 미룬다).
// - 사건의 attemptNo(그 주문 ACCEPTED 결제 시도의 순번)는 값만 채우고 반영에는 쓰지 않는다(결정 함수·쓰기가 보지 않는다. 사건 길의 값과 같다는 보장이 없다,
//   docs/features/payment.md §2 '기록 없음이 길어질 때', 2026-11-06 코드 리뷰).
// 다음 점검 간격(실행기가 정한다, docs/features/payment.md §2 '기록 없음이 길어질 때', 2026-11-06 코드 리뷰 H1·M2·M3): 잡을 때 5초, 답이 UNKNOWN이면 30초·입금 대기면 60초
// (반영 결과와 상관없이), 취소 상태·모양 틀림 60초, 보류(HOLD)·기록 없음 10분, payment-svc가 답하지 못한 묶음(차단기 열림·UNAVAILABLE·시간 초과) 30초.
import { type AppliedPaymentEventType, PAYMENT_FAILURE_CATEGORIES, type PaymentFailureCategory, type PaymentResultEvent } from './payment-result.js';
import type { PaymentPg } from './ports.js';
import type { GrpcStatusName } from './ticket-issue.js';

/** 반복 간격 1초 [가정](ADR-0140 결정 1. 모든 API 파드가 돈다) */
export const PAYMENT_PULL_INTERVAL_MS = 1000;
/** 승인 명령을 보낸 뒤(confirm_sent_at) 당기기 대상이 되기까지 5초 [가정](ADR-0140 결정 1: 평소에는 사건이 1초 안에 와서 당기기가 거의 돌지 않는다) */
export const PAYMENT_PULL_AFTER_SENT_MS = 5000;
/** 같은 주문을 다시 묻는 간격 5초 [가정](잡기가 pull_next_at = 지금 + 이 값을 쓴다. 파드 여럿이어도 같은 주문은 5초에 한 번, ADR-0140 결정 1) */
export const PAYMENT_PULL_REPEAT_MS = 5000;
/**
 * BatchGetPayments 한 번에 묻는 주문 수 상한 100건 [가정](ADR-0140 결정 1, payment.proto BatchGetPaymentsRequest: 넘으면 INVALID_ARGUMENT).
 * 잡기 한 번(PaymentPullTargets.claimDue)의 상한과 같다(설계 3)
 */
export const PAYMENT_PULL_BATCH = 100;
/** 파드마다 동시에 보내는 BatchGetPayments 요청 수 4개 [가정](ADR-0140 결정 3) */
export const PAYMENT_PULL_CONCURRENCY = 4;
/** BatchGetPayments 데드라인 500ms [가정](ADR-0140 결정 3) */
export const PAYMENT_PULL_DEADLINE_MS = 500;
/**
 * 반영하지 않는 답(IGNORE: PARTIAL_CANCELED·CANCELED(취소 흐름 PRF-173 몫)·모양 틀림)의 다음 점검 60초 [가정](설계 5): pull_next_at = 지금 + 이 값
 */
export const PAYMENT_PULL_SLOW_REPEAT_MS = 60_000;
/**
 * 보류(HOLD)·기록 없음 10분의 다음 점검 10분 [가정](docs/features/payment.md §2 '기록 없음이 길어질 때', 2026-11-06 코드 리뷰 M3).
 * 반영이 보류로 끝났거나 승인 명령을 보낸 지 PAYMENT_PULL_MISSING_AFTER_MS가 지나도 답에 없을 때 pull_next_at = 지금 + 이 값.
 * 그래서 파드가 많아도 기록 없음 SEV2 줄과 보류 로그가 주문마다 10분에 한 줄이다(파드 메모리 창만으로는 다른 파드의 줄을 막지 못한다)
 */
export const PAYMENT_PULL_LONG_REPEAT_MS = 10 * 60_000;
/**
 * payment-svc가 답하지 못한 묶음의 다음 점검 30초 [가정](같은 절, 2026-11-06 코드 리뷰 M2): BatchGetPayments가 PAYMENT_PULL_OUTAGE_CODES로 실패하면
 * 실행기가 그 틱의 남은 잡기를 멈추고 그 묶음을 pull_next_at = 지금 + 이 값으로 미룬다(장애 동안 purchase DB를 5초마다 두드리지 않게)
 */
export const PAYMENT_PULL_OUTAGE_REPEAT_MS = 30_000;
/** payment-svc가 답하지 못한 실패(차단기 열림·UNAVAILABLE·시간 초과, 같은 절). 그 밖의 실패 코드는 다음 점검(5초 [가정])에 다시 묻는다 */
export const PAYMENT_PULL_OUTAGE_CODES: ReadonlySet<PaymentPullFailureCode> = new Set<PaymentPullFailureCode>(['CIRCUIT_OPEN', 'UNAVAILABLE', 'DEADLINE_EXCEEDED']);
/**
 * 답이 UNKNOWN일 때의 다음 점검 30초 [가정](docs/features/payment.md §2 '중간 결과 뒤에도 당긴다'·'기록 없음이 길어질 때'). 결과 반영의 상태만 쓰기(mark, T12)가
 * 작업 행을 AWAIT로 남기며 pull_next_at = 지금 + 이 값을 쓰고, 실행기도 답이 UNKNOWN이면 반영 결과(건너뜀 포함)와 상관없이 같은 값으로 미룬다(리뷰 고침 H1)
 */
export const PAYMENT_PULL_AFTER_UNKNOWN_MS = 30_000;
/** 답이 입금 대기(T10·T14)일 때의 다음 점검 60초 [가정](같은 절. 입금 기한은 며칠일 수 있어 촘촘히 묻지 않는다. mark와 실행기가 같은 값을 쓴다) */
export const PAYMENT_PULL_AFTER_DEPOSIT_MS = 60_000;
/**
 * 당기기가 빼는 보류 사건의 토픽(결제 결과 소비자의 trade.payments, inbound TRADE_PAYMENTS_TOPIC과 같은 값. 어댑터가 받는 층을 가져오지 않아 여기 둔다).
 * 그 주문의 보류 사건(held_event, 다시 처리 전)이 있으면 잡기가 고르지 않는다(키 단위 소비자가 그 주문의 뒤 사건도 함께 보류하므로 당기기가 앞지르면
 * 보류 사건이 다시 처리될 때 버려진다, docs/features/payment.md §2 'Saga 실행기와 갈림', 2026-11-06 코드 리뷰 M4)
 */
export const PAYMENT_PULL_HELD_TOPIC = 'trade.payments';
/** approved_at이 승인 명령을 보낸 시각보다 이만큼 넘게 이르면 있을 수 없는 값으로 본다 1분 [정함](파드 사이 시계 어긋남의 여유, 리뷰 고침 L2) */
export const PAYMENT_PULL_APPROVED_SKEW_MS = 60_000;
/** 승인 명령을 보낸 뒤 이만큼 지나도 답에 없으면(기록 없음) SEV2 한 줄 10분 [가정](인증 + 10분 승인 기한과 같은 길이, 설계 7). 주문을 실패로 단정하지 않는다(PRF-180) */
export const PAYMENT_PULL_MISSING_AFTER_MS = 10 * 60_000;
/**
 * 기록 없음 로그(kind payment-result-missing)를 같은 주문에 다시 남기지 않는 파드 메모리 창 10분 [가정](docs/features/payment.md §2 '기록 없음이 길어질 때').
 * 파드 사이의 줄은 다음 점검 10분(PAYMENT_PULL_LONG_REPEAT_MS)이 막고, 이 창은 같은 파드가 그 사이에 다시 잡은 경우(미루기 실패 등)를 막는다
 */
export const PAYMENT_PULL_MISSING_LOG_WINDOW_MS = 10 * 60_000;
/** 당기기 전용 purchase DB 풀의 연결 수 2개 [가정](설계 4. 잡기·미루기만 쓴다. 발권 실행기 풀과 같은 꼴, 이름 purchase-svc-payment-pull) */
export const PAYMENT_PULL_DB_MAX = 2;

/** 당기기가 반영하는 사건 종류(지표 payment_result_pulled_total{type}의 값, 차례는 설계 5) */
export const PAYMENT_PULL_TYPES: readonly Exclude<AppliedPaymentEventType, 'DEPOSIT_REVERSED'>[] = ['APPROVED', 'FAILED', 'AWAITING_DEPOSIT', 'UNKNOWN'];

/**
 * 결제 원장 상태(payment.proto PaymentStatus에서 앞머리 PAYMENT_STATUS_를 뗀 이름, docs/data.md payment.status).
 * UNSPECIFIED는 칸이 없거나(proto 기본값) 모르는 값이다
 */
export const PAYMENT_LEDGER_STATUSES = ['UNSPECIFIED', 'ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED'] as const;
export type PaymentLedgerStatus = (typeof PAYMENT_LEDGER_STATUSES)[number];

/**
 * BatchGetPayments 답의 주문 하나(payment.proto OrderPaymentState를 도메인 모양으로 옮긴 것, ADR-0140 결정 2).
 * 어댑터가 칸 이름을 바꾸고 enum 앞머리를 떼서 싣는다. 값을 검사하지 않고 옮긴다(반영할 수 있는 모양인지는 paymentStateToResultEvent가 본다)
 */
export interface OrderPaymentState {
  readonly orderId: string;
  /** 결제 원장 ID(payment_id). 반영에는 쓰지 않는다 */
  readonly paymentId: string;
  /** 결제사(PgProvider에서 PG_PROVIDER_를 뗀 이름). 칸이 없거나 모르는 값이면 undefined */
  readonly pg?: PaymentPg;
  readonly status: PaymentLedgerStatus;
  /** 결제 금액(원, Money.krw). 칸이 없으면 NaN(어댑터) */
  readonly amount: number;
  /** 승인 시각(epoch ms, approved_at). 칸이 없으면 undefined */
  readonly approvedAtMs?: number;
  /** 실패 범주(FailureCategory에서 FAILURE_CATEGORY_를 뗀 이름). FAILED일 때만 있고, UNSPECIFIED·모르는 값이면 undefined */
  readonly failureCategory?: PaymentFailureCategory;
  /** 마지막 결제 사건(payment_event 행)의 eventKey. 같은 사건이 trade.payments로 늦게 와도 반영의 순번 조건이 거른다 */
  readonly eventKey: string;
  /** 마지막 결제 사건의 순번(int64, 주문마다 늘어나기만 한다). 주문 payment_event_seq와 견준다 */
  readonly eventSeq: number;
  /** 입금 기한(epoch ms, deposit_due_at, 입금 대기일 때만, BUILD_ORDER HOT-151). 칸이 없으면 undefined */
  readonly depositDueAtMs?: number;
}

/** 답을 사건으로 바꿀 때 답 밖에서 채우는 값 */
export interface PaymentPullContext {
  /** 작업 행의 회차(order_saga_job.event_id). 사건의 eventId(사건 길에서는 Kafka 키로 쓰는 회차) */
  readonly eventId: string;
  /** 그 주문 ACCEPTED 결제 시도의 순번(저장소가 읽는다, PaymentPullTarget.attemptNo). 사건 칸을 채울 뿐 반영에는 쓰지 않는다(머리 주석) */
  readonly attemptNo: number;
  /** 그 주문의 승인 명령을 처음 보내기 바로 전에 적은 시각(epoch ms, PaymentPullTarget.confirmSentAtMs). approved_at이 있을 수 있는 값인지 본다(리뷰 고침 L2) */
  readonly confirmSentAtMs: number;
  /** 당긴 시각(epoch ms, 앱 시계). APPROVED가 아닌 사건(과 approved_at이 없거나 있을 수 없는 APPROVED)의 occurredAt */
  readonly pulledAtMs: number;
}

/** 반영하지 않는 까닭. CANCELED: PARTIAL_CANCELED·CANCELED(취소 흐름은 PRF-173·환불 단계), MALFORMED: 반영할 수 없는 모양의 답 [정함] */
export type PaymentPullIgnoreReason = 'CANCELED' | 'MALFORMED';

/**
 * 답 하나를 어떻게 할지(설계 5).
 * - APPLY: 이 사건을 ApplyPaymentResult.execute로 반영한다
 * - WAIT: 승인 중(ACCEPTED)이다. 아무것도 하지 않고 다음 점검(잡기가 쓴 5초 [가정] 뒤)에 다시 묻는다
 * - IGNORE: 반영하지 않는다. 실행기가 경고 한 줄 뒤 다음 점검을 PAYMENT_PULL_SLOW_REPEAT_MS(60초 [가정]) 미룬다
 */
export type PaymentPullDecision =
  | { readonly kind: 'APPLY'; readonly event: PaymentResultEvent }
  | { readonly kind: 'WAIT' }
  | { readonly kind: 'IGNORE'; readonly reason: PaymentPullIgnoreReason };

/**
 * BatchGetPayments 실패의 코드. gRPC 상태 이름(OK 빼고, 모르는 번호는 UNKNOWN), CIRCUIT_OPEN(차단기 payment-svc-batch가 열려 부르지 않았다),
 * BAD_ANSWER(답은 받았지만 payments 모양이 틀렸다) [정함: 정본에 없다. 발권 호출 TicketIssueFailureCode와 같은 묶음].
 * PAYMENT_PULL_OUTAGE_CODES(payment-svc가 답하지 못함)면 실행기가 그 틱의 잡기를 멈추고 그 묶음을 30초 [가정] 미루며, 그 밖의 코드는 다음 점검(잡기가 쓴
 * 5초 [가정] 뒤)에 다시 묻는다
 */
export type PaymentPullFailureCode = Exclude<GrpcStatusName, 'OK'> | 'CIRCUIT_OPEN' | 'BAD_ANSWER';

/** 실행기 오류 로그의 단계 이름(PaymentPullLog.runError what) */
export type PaymentPullRunStage = 'claim' | 'batch_get' | 'apply' | 'defer';

/**
 * 답 하나 → 반영할 결제 사건(설계 5). 순수 함수다(던지지 않는다).
 * - ACCEPTED(승인 중) → WAIT
 * - APPROVED → APPLY type APPROVED, occurredAt = approvedAtMs(없거나 ctx.confirmSentAtMs − PAYMENT_PULL_APPROVED_SKEW_MS(1분)보다 이르면 ctx.pulledAtMs [정함])
 * - FAILED → APPLY type FAILED, failureCategory는 있으면 그대로(없으면 칸 없음: 반영이 PAYMENT_FAILURE_FALLBACK을 적는다)
 * - AWAITING_DEPOSIT → APPLY type AWAITING_DEPOSIT · UNKNOWN → APPLY type UNKNOWN(결제사 단독 조회 규칙은 payment-svc 몫, 주문은 T12 등 지금 전이 함수대로).
 *   occurredAt = ctx.pulledAtMs
 * - PARTIAL_CANCELED·CANCELED → IGNORE CANCELED
 * - UNSPECIFIED, 결제사 없음, amount가 0 이상의 안전한 정수가 아님, eventSeq가 1 이상의 안전한 정수가 아님, eventKey가 빈 글,
 *   ctx.attemptNo가 0 이상의 안전한 정수가 아님, 시각이 날짜 범위 밖 → IGNORE MALFORMED [정함]
 * 사건 칸: eventId = ctx.eventId, orderId·pg·amount·eventKey·eventSeq = 답의 값, attemptNo = ctx.attemptNo(반영에는 쓰지 않는다), refMissing false,
 * occurredAt은 ISO 8601(toISOString). payMethodCategory·result·latencyMs는 싣지 않는다
 */
export function paymentStateToResultEvent(state: OrderPaymentState, ctx: PaymentPullContext): PaymentPullDecision {
  // 상태부터 가른다: 승인 중·취소 상태는 다른 칸을 보지 않는다(반영하지 않으므로)
  const status: unknown = state.status;
  if (status === 'ACCEPTED') return WAIT;
  if (status === 'PARTIAL_CANCELED' || status === 'CANCELED') return IGNORE_CANCELED;
  if (typeof status !== 'string' || !APPLIED_STATUSES.has(status)) return IGNORE_MALFORMED;
  const type = status as AppliedPaymentEventType;
  // 반영할 수 있는 모양인지(결정 함수·쓰기 어댑터가 받는 범위와 같다)
  const pg: unknown = state.pg;
  if (typeof pg !== 'string' || !PGS.has(pg)) return IGNORE_MALFORMED;
  if (!isSafeIntAtLeast(state.amount, 0) || !isSafeIntAtLeast(state.eventSeq, 1) || !isSafeIntAtLeast(ctx.attemptNo, 0)) return IGNORE_MALFORMED;
  if (typeof state.eventKey !== 'string' || state.eventKey === '') return IGNORE_MALFORMED;
  // 발생 시각: 승인은 approved_at(없거나 승인 명령을 보낸 시각보다 1분 넘게 이르면 당긴 시각 [정함], 리뷰 고침 L2), 그 밖은 당긴 시각. 날짜 범위 밖이면 모양 틀림
  const occurredAt = type === 'APPROVED' && approvedAtUsable(state.approvedAtMs, ctx.confirmSentAtMs) ? isoOf(state.approvedAtMs) : isoOf(ctx.pulledAtMs);
  if (occurredAt === undefined) return IGNORE_MALFORMED;
  const failureCategory = type === 'FAILED' && typeof state.failureCategory === 'string' && FAILURE_CATEGORIES.has(state.failureCategory) ? state.failureCategory : undefined;
  // 입금 기한은 입금 대기 답에 있을 때만 싣는다(판매 행 기한을 쓴다, BUILD_ORDER HOT-151)
  const depositDueAt = type === 'AWAITING_DEPOSIT' ? isoOf(state.depositDueAtMs) : undefined;
  // 사건 길에만 있는 칸(payMethodCategory·result·latencyMs)은 싣지 않는다. 실패 범주는 FAILED이고 값이 있을 때만
  const event: PaymentResultEvent = {
    eventId: ctx.eventId,
    orderId: state.orderId,
    pg: pg as PaymentPg,
    type,
    amount: state.amount,
    refMissing: false,
    attemptNo: ctx.attemptNo,
    occurredAt,
    eventSeq: state.eventSeq,
    eventKey: state.eventKey,
    ...(failureCategory !== undefined ? { failureCategory } : {}),
    ...(depositDueAt !== undefined ? { depositDueAt } : {}),
  };
  return { kind: 'APPLY', event };
}

/**
 * 기록 없음이 길어졌나(설계 7): nowMs − confirmSentAtMs ≥ PAYMENT_PULL_MISSING_AFTER_MS(10분 [가정])면 참(경계 시각은 넘긴 것으로 본다).
 * 순수 함수다(던지지 않는다. 수가 아닌 값이면 거짓)
 */
export function isPaymentResultMissingLong(confirmSentAtMs: number, nowMs: number): boolean {
  if (typeof confirmSentAtMs !== 'number' || typeof nowMs !== 'number' || !Number.isFinite(confirmSentAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - confirmSentAtMs >= PAYMENT_PULL_MISSING_AFTER_MS;
}

const WAIT: PaymentPullDecision = Object.freeze({ kind: 'WAIT' });
const IGNORE_CANCELED: PaymentPullDecision = Object.freeze({ kind: 'IGNORE', reason: 'CANCELED' });
const IGNORE_MALFORMED: PaymentPullDecision = Object.freeze({ kind: 'IGNORE', reason: 'MALFORMED' });

/** 결과로 반영하는 원장 상태(같은 이름의 사건 종류가 된다) */
const APPLIED_STATUSES: ReadonlySet<string> = new Set<string>(PAYMENT_PULL_TYPES);
/** 결제사(ports.ts PaymentPg와 같은 값) */
const PGS: ReadonlySet<string> = new Set<PaymentPg>(['TOSS', 'PORTONE', 'SIMULATOR']);
const FAILURE_CATEGORIES: ReadonlySet<string> = new Set<string>(PAYMENT_FAILURE_CATEGORIES);

/** min 이상의 안전한 정수 */
const isSafeIntAtLeast = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

/**
 * approved_at을 발생 시각으로 쓸 수 있나(리뷰 고침 L2): 있고, 승인 명령을 보낸 시각이 수이면 그보다 PAYMENT_PULL_APPROVED_SKEW_MS를 넘게 이르지 않다.
 * 보낸 시각이 수가 아니면(코드 오류) approved_at을 그대로 쓴다(날짜 범위 밖은 isoOf가 모양 틀림으로 거른다)
 */
function approvedAtUsable(approvedAtMs: number | undefined, confirmSentAtMs: number): boolean {
  if (approvedAtMs === undefined) return false;
  if (typeof approvedAtMs !== 'number' || typeof confirmSentAtMs !== 'number' || !Number.isFinite(confirmSentAtMs)) return true;
  return approvedAtMs >= confirmSentAtMs - PAYMENT_PULL_APPROVED_SKEW_MS;
}

/** epoch ms → ISO 8601. 수가 아니거나 날짜 범위(±8.64e15) 밖이면 undefined(던지지 않는다) */
function isoOf(ms: unknown): string | undefined {
  if (typeof ms !== 'number') return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
