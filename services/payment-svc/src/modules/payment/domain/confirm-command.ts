// 승인 명령 접수의 값과 규칙(docs/features/payment.md §2 '승인 명령 접수의 첫 구현', BUILD_ORDER PRF-180, 명세 specs/payment.qnt `command`).
// 프레임워크·저장소·계약 패키지를 모른다(순수 값과 함수). 요청의 모양(proto 칸 이름·enum 앞머리)은 받는 층(inbound/payment.grpc.ts)이 바꿔 넘긴다.
import type { FailureCategory, PgName } from './payment-gateway.js';

/** BatchGetPayments 한 번에 묻는 주문 수 상한 100건 [가정](ADR-0140 결정 1, payment.proto BatchGetPaymentsRequest) */
export const BATCH_GET_MAX_ORDERS = 100;
/** 결제 참조 값의 길이 상한 200자 [가정](결제 접수와 같은 규칙, payment §2 '결제 참조 형식') */
export const PAYMENT_REF_MAX_LENGTH = 200;
/** 금액 상한: 원장 칸 amount가 int(4바이트)다 */
export const PAYMENT_AMOUNT_MAX = 2_147_483_647;
/** 인증 시각이 지금보다 뒤여도 받는 폭 5분 [가정](서버 사이 시계 차이. 넘으면 승인 기한의 기준이 될 수 없다) */
export const AUTHENTICATED_AT_MAX_FUTURE_MS = 300_000;
/** 입장 시각 상한: 9999-12-31T23:59:59.999Z. proto Timestamp가 나타낼 수 있는 끝이다(BUILD_ORDER PRF-190 코드 리뷰) */
export const ENTRY_OPENS_AT_MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
/** 호출에 남은 시간이 이보다 모자라면 시작하지 않는다 50ms [가정](docs/api/proto/README.md §2 '데드라인'. INSERT 셋과 커밋이 들어갈 만큼) */
export const MIN_CALL_REMAINING_MS = 50;

/** 결제 원장 상태(docs/data.md payment.status. 차례는 schema.ts의 CHECK 목록과 같다) */
export const PAYMENT_LEDGER_STATUSES = ['ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED'] as const;
export type PaymentLedgerStatus = (typeof PAYMENT_LEDGER_STATUSES)[number];

/** 결제창 복귀 값. `kind`는 proto oneof payment_ref의 칸 이름이다(시뮬레이터는 toss 칸을 쓴다) */
export type ConfirmPaymentRef =
  | { readonly kind: 'toss'; readonly paymentKey: string }
  | { readonly kind: 'portone'; readonly paymentId: string; readonly txId: string; readonly paymentToken: string };

/** 받는 층이 넘기는 값(검사 전). 칸이 없으면 빈 글·NaN·undefined다 */
export interface ConfirmPaymentInput {
  readonly orderId: string;
  readonly attemptId: string;
  /** 결제 시도 순번(1부터). 칸이 없으면 0 */
  readonly attemptNo: number;
  readonly eventId: string;
  /** PgProvider에서 PG_PROVIDER_를 뗀 이름. 지정이 없으면 'UNSPECIFIED' */
  readonly pg: string;
  readonly paymentRef?: ConfirmPaymentRef;
  /** 서버 금액(원, Money.krw). 칸이 없으면 NaN */
  readonly amount: number;
  /** 결제창 인증 시각(epoch ms). 칸이 없으면 undefined */
  readonly authenticatedAtMs?: number;
  /** 회차의 입장 시작 시각(epoch ms). 칸이 없으면 undefined(BUILD_ORDER PRF-190) */
  readonly entryOpensAtMs?: number;
  /** 가상계좌를 내도 되는가(POL-014, H2). 거짓인데 승인 답이 입금 대기면 입금 전 취소로 끝낸다. 없으면 지금처럼 받는다 */
  readonly virtualAccountAllowed?: boolean;
}

/** 검사를 마친 승인 명령 */
export interface ConfirmPaymentCommand {
  readonly orderId: string;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly eventId: string;
  readonly pg: PgName;
  readonly paymentRef: ConfirmPaymentRef;
  readonly amount: number;
  readonly authenticatedAtMs: number;
  /** 회차의 입장 시작 시각(epoch ms). 입금 오류 되돌림의 새 기한을 자른다(BUILD_ORDER PRF-190) */
  readonly entryOpensAtMs?: number;
  /** 가상계좌를 내도 되는가(POL-014, H2). 거짓인데 승인 답이 입금 대기면 입금 전 취소로 끝낸다. 없으면 지금처럼 받는다 */
  readonly virtualAccountAllowed?: boolean;
}

/** 저장소가 돌려주는 결제 원장 한 행(답과 대조에 쓰는 칸만) */
export interface PaymentRecord {
  readonly paymentId: string;
  readonly orderId: string;
  readonly attemptId: string;
  readonly pg: PgName;
  readonly amount: number;
  readonly status: PaymentLedgerStatus;
  /** 승인 시각(epoch ms). 비었으면 undefined */
  readonly approvedAtMs?: number;
  /** 실패 범주(payment.failure_category, 마이그레이션 0001). 실패가 아니면 undefined */
  readonly failureCategory?: FailureCategory;
}

/** ConfirmResult에서 CONFIRM_RESULT_를 뗀 이름 가운데 이 RPC가 돌려주는 값 */
export type ConfirmAnswerResult = 'APPROVED' | 'IN_PROGRESS' | 'DECLINED' | 'WAITING_FOR_DEPOSIT';

/** ConfirmPayment 답 */
export interface ConfirmAnswer {
  readonly result: ConfirmAnswerResult;
  readonly paymentId: string;
  readonly approvedAtMs?: number;
  readonly failureCategory?: FailureCategory;
}

/** BatchGetPayments 답의 주문 하나 */
export interface PaymentState {
  readonly orderId: string;
  readonly paymentId: string;
  readonly pg: PgName;
  readonly status: PaymentLedgerStatus;
  readonly amount: number;
  readonly approvedAtMs?: number;
  readonly failureCategory?: FailureCategory;
  /** 마지막 수출 사건(exported = true이고 RESOLVED가 아닌 행 가운데 순번 최대). 없으면(아직 ACCEPTED) undefined라 답의 event_key·event_seq를 비운다 */
  readonly lastEvent?: { readonly eventKey: string; readonly eventSeq: number };
  /** 입금 기한(epoch ms, 입금 대기일 때만, BUILD_ORDER HOT-151) */
  readonly depositDueAtMs?: number;
}

/** GetPayment의 찾을 값(proto oneof key) */
export type GetPaymentKey = { readonly kind: 'paymentId'; readonly paymentId: string } | { readonly kind: 'orderId'; readonly orderId: string };

/** 저장소가 돌려주는 결제 상세(가상계좌 번호는 아직 암호문이다) */
export interface PaymentDetailRow {
  readonly paymentId: string;
  readonly orderId: string;
  readonly pg: PgName;
  readonly status: PaymentLedgerStatus;
  readonly amount: number;
  readonly approvedAtMs?: number;
  /** 입금 대기일 때만 */
  readonly virtualAccountBank?: string;
  readonly virtualAccountNoSealed?: string;
  readonly depositDueAtMs?: number;
}

/** GetPayment 답 */
export interface PaymentDetail {
  readonly paymentId: string;
  readonly orderId: string;
  readonly pg: PgName;
  readonly status: PaymentLedgerStatus;
  readonly amount: number;
  /** 취소를 만드는 단계 전에는 0이다 */
  readonly cancelledAmount: number;
  readonly approvedAtMs?: number;
  /** 입금 대기일 때만. 계좌번호는 복호하지 못했거나 저장하지 않았으면 없다. 로그에 싣지 않는다 */
  readonly virtualAccount?: { readonly bank?: string; readonly accountNumber?: string; readonly dueAtMs?: number };
}

/** 원장이 없다(gRPC NOT_FOUND). 글에는 값을 싣지 않는다 */
export class PaymentNotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('결제를 찾지 못했다');
    this.name = 'PaymentNotFoundError';
  }
}

/** 입력이 틀렸다(gRPC INVALID_ARGUMENT). 글에는 칸 이름만 싣고 값을 싣지 않는다 */
export class PaymentInputError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;
  constructor(readonly field: string) {
    super(`입력이 틀렸다: ${field}`);
    this.name = 'PaymentInputError';
  }
}

/** 이미 있는 결제와 시도·결제사·금액이 다른 명령(gRPC FAILED_PRECONDITION). 글에는 주문 ID를 싣지 않는다 */
export class PaymentCommandMismatchError extends Error {
  readonly code = 'FAILED_PRECONDITION' as const;
  constructor() {
    super('이미 받은 승인 명령과 다르다');
    this.name = 'PaymentCommandMismatchError';
  }
}

/** 호출에 남은 시간 안에 시작하거나 끝낼 수 없다(gRPC DEADLINE_EXCEEDED). 글에는 내부 값을 싣지 않는다 */
export class PaymentDeadlineError extends Error {
  readonly code = 'DEADLINE_EXCEEDED' as const;
  constructor() {
    super('남은 시간이 모자란다');
    this.name = 'PaymentDeadlineError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 소문자 UUID 모양인가(판은 보지 않는다. UUIDv7 주문과 v4 값을 함께 받는다) */
export const isLowerUuid = (value: string): boolean => UUID.test(value);

/** 결제 참조 값: 보이는 ASCII(0x21~0x7E)만. 공백·제어 문자·한글은 로그 줄과 결제사 호출에 실릴 수 없다 */
const REF_VALUE = /^[!-~]+$/;
const PG_NAMES: readonly string[] = ['TOSS', 'PORTONE', 'SIMULATOR'] satisfies readonly PgName[];

const isPgName = (value: string): value is PgName => PG_NAMES.includes(value);

function uuidOf(value: string, field: string): string {
  if (!isLowerUuid(value)) throw new PaymentInputError(field);
  return value;
}

/**
 * entry_opens_at 검사(승인 명령과 결제창 준비가 함께 쓴다): 있으면 양의 정수이고 ENTRY_OPENS_AT_MAX_MS 이하다.
 * @throws PaymentInputError field = 'entry_opens_at'
 */
export function checkEntryOpensAt(entryOpensAtMs: number | undefined): void {
  if (entryOpensAtMs !== undefined && !(Number.isInteger(entryOpensAtMs) && entryOpensAtMs > 0 && entryOpensAtMs <= ENTRY_OPENS_AT_MAX_MS)) throw new PaymentInputError('entry_opens_at');
}

function checkRefValue(value: string, field: string): void {
  if (value.length > PAYMENT_REF_MAX_LENGTH || !REF_VALUE.test(value)) throw new PaymentInputError(field);
}

/** 결제 참조가 결제사와 짝이 맞고 값이 규칙에 맞는지 본다. 틀리면 칸 이름만 싣고 값은 싣지 않는다 */
function checkedRef(pg: PgName, orderId: string, ref: ConfirmPaymentRef | undefined): ConfirmPaymentRef {
  if (!ref || ref.kind !== (pg === 'PORTONE' ? 'portone' : 'toss')) throw new PaymentInputError('payment_ref');
  if (ref.kind === 'toss') {
    checkRefValue(ref.paymentKey, 'payment_key');
    return ref;
  }
  if (ref.paymentId !== `pay-${orderId}`) throw new PaymentInputError('payment_id');
  checkRefValue(ref.txId, 'tx_id');
  checkRefValue(ref.paymentToken, 'payment_token');
  return ref;
}

/**
 * 승인 명령 입력 검사(payment §2 '승인 명령 접수의 첫 구현' 입력 검사): order_id·attempt_id·event_id는 소문자 UUID, 금액은 1 이상 PAYMENT_AMOUNT_MAX 이하 정수,
 * attempt_no는 1 이상 정수, authenticated_at은 있고 양수이며 nowMs + AUTHENTICATED_AT_MAX_FUTURE_MS 이하(연도 10000 같은 값도 여기서 막힌다),
 * pg는 TOSS·PORTONE·SIMULATOR, 결제 참조는 결제사와 짝이 맞음(TOSS·SIMULATOR는 toss, PORTONE은 portone),
 * 참조 값은 1~PAYMENT_REF_MAX_LENGTH자의 보이는 ASCII(0x21~0x7E), 포트원 paymentId는 `pay-{orderId}`. entry_opens_at은 있으면 양수 시각이고 9999년을 넘지 않는다.
 * @param nowMs 지금(epoch ms, 쓰임새의 시계)
 * @throws PaymentInputError 입력이 틀림(field = proto 칸 이름)
 */
export function parseConfirmPaymentInput(input: ConfirmPaymentInput, nowMs: number): ConfirmPaymentCommand {
  const orderId = uuidOf(input.orderId, 'order_id');
  const attemptId = uuidOf(input.attemptId, 'attempt_id');
  const eventId = uuidOf(input.eventId, 'event_id');
  if (!(Number.isInteger(input.amount) && input.amount >= 1 && input.amount <= PAYMENT_AMOUNT_MAX)) throw new PaymentInputError('amount');
  if (!(Number.isInteger(input.attemptNo) && input.attemptNo >= 1)) throw new PaymentInputError('attempt_no');
  const authenticatedAtMs = input.authenticatedAtMs;
  if (authenticatedAtMs === undefined || !(Number.isInteger(authenticatedAtMs) && authenticatedAtMs > 0 && authenticatedAtMs <= nowMs + AUTHENTICATED_AT_MAX_FUTURE_MS)) throw new PaymentInputError('authenticated_at');
  if (!isPgName(input.pg)) throw new PaymentInputError('pg');
  const { entryOpensAtMs } = input;
  checkEntryOpensAt(entryOpensAtMs);
  return { orderId, attemptId, attemptNo: input.attemptNo, eventId, pg: input.pg, paymentRef: checkedRef(input.pg, orderId, input.paymentRef), amount: input.amount, authenticatedAtMs, ...(entryOpensAtMs === undefined ? {} : { entryOpensAtMs }), ...(input.virtualAccountAllowed === undefined ? {} : { virtualAccountAllowed: input.virtualAccountAllowed }) };
}

/**
 * BatchGetPayments 입력 검사: 1~BATCH_GET_MAX_ORDERS건의 소문자 UUID. 돌려줄 때 같은 ID의 중복은 합친다.
 * @throws PaymentInputError field = 'order_ids'
 */
export function parseBatchGetOrderIds(orderIds: readonly string[]): string[] {
  if (orderIds.length < 1 || orderIds.length > BATCH_GET_MAX_ORDERS || !orderIds.every(isLowerUuid)) throw new PaymentInputError('order_ids');
  return [...new Set(orderIds)];
}

/**
 * GetPayment 입력 검사: payment_id·order_id 가운데 정확히 하나이고 소문자 UUID다.
 * @throws PaymentInputError field = 'key'
 */
export function parseGetPaymentKey(paymentId: string | undefined, orderId: string | undefined): GetPaymentKey {
  if ((paymentId === undefined) === (orderId === undefined)) throw new PaymentInputError('key');
  if (paymentId !== undefined) return { kind: 'paymentId', paymentId: uuidOf(paymentId, 'payment_id') };
  return { kind: 'orderId', orderId: uuidOf(orderId!, 'order_id') };
}

/** 이미 있는 결제와 같은 명령인가(attempt_id·pg·amount가 모두 같다) */
export function isSameCommand(existing: PaymentRecord, command: ConfirmPaymentCommand): boolean {
  return existing.attemptId === command.attemptId && existing.pg === command.pg && existing.amount === command.amount;
}

const ANSWER_OF: Readonly<Record<PaymentLedgerStatus, ConfirmAnswerResult>> = {
  ACCEPTED: 'IN_PROGRESS',
  UNKNOWN: 'IN_PROGRESS',
  APPROVED: 'APPROVED',
  PARTIAL_CANCELED: 'APPROVED',
  CANCELED: 'APPROVED',
  FAILED: 'DECLINED',
  AWAITING_DEPOSIT: 'WAITING_FOR_DEPOSIT',
};

/**
 * 원장 행 → 답(payment §2 '답'): ACCEPTED·UNKNOWN은 IN_PROGRESS, APPROVED·PARTIAL_CANCELED·CANCELED는 APPROVED,
 * FAILED는 DECLINED(failureCategory가 있으면 함께), AWAITING_DEPOSIT은 WAITING_FOR_DEPOSIT. paymentId는 늘, approvedAtMs는 값이 있을 때 싣는다.
 */
export function confirmAnswerOf(record: PaymentRecord): ConfirmAnswer {
  return {
    result: ANSWER_OF[record.status],
    paymentId: record.paymentId,
    ...(record.approvedAtMs === undefined ? {} : { approvedAtMs: record.approvedAtMs }),
    ...(record.status === 'FAILED' && record.failureCategory !== undefined ? { failureCategory: record.failureCategory } : {}),
  };
}
