// 받는 층: gRPC PaymentService(docs/api/proto/peaket/payment/v1/payment.proto)를 유스케이스에 잇는다(BUILD_ORDER PRF-180).
// ConfirmPayment·BatchGetPayments·GetPayment(BUILD_ORDER HOT-151)·CancelPayment(입금 전 취소, BUILD_ORDER HOT-152)·PrepareCheckout(BUILD_ORDER PRF-190)만 처리기를 둔다. 나머지 RPC는 처리기를 넣지 않아 grpc-js가 UNIMPLEMENTED로 답한다(identity-svc의 부분 구현과 같다).
// 업무 오류는 상태 코드로(PaymentInputError → INVALID_ARGUMENT, PaymentCommandMismatchError → FAILED_PRECONDITION), 저장소 오류는 statusOfStoreError로 고른 코드와 고정 문구로
// 돌려주고 이유는 서버 쪽 기록에만 남긴다(docs/api/proto/README.md §2 'gRPC 상태 코드').
// 데드라인: 처음에 call.getDeadline()을 보고 남은 시간이 MIN_CALL_REMAINING_MS보다 모자라면 시작하지 않고 DEADLINE_EXCEEDED다(같은 표 '데드라인'). 넉넉하면 남은 시간을 쓰임새에 넘긴다.
// 부르는 쪽 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다(payment §2 '승인 명령 접수의 첫 구현' 부르는 쪽 제한).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import type { AcceptPaymentCommand } from '../application/accept-payment-command.js';
import type { BatchGetPaymentStates } from '../application/batch-get-payment-states.js';
import type { CancelDepositPayment } from '../application/cancel-deposit-payment.js';
import type { GetPaymentDetail } from '../application/get-payment-detail.js';
import { type DepositCancelAnswer, type DepositCancelInput, PaymentCancelStateError } from '../domain/deposit-cancel.js';
import { type ConfirmAnswer, type ConfirmPaymentInput, type ConfirmPaymentRef, isLowerUuid, MIN_CALL_REMAINING_MS, PaymentCommandMismatchError, PaymentDeadlineError, type PaymentDetail, PaymentInputError, PaymentNotFoundError, type PaymentState } from '../domain/confirm-command.js';
import type { CallBudget } from '../domain/ports.js';
import type { CheckoutValues, TossCheckoutValues } from '../domain/payment-gateway.js';
import { PaymentPgUnavailableError, type PrepareCheckoutInput } from '../domain/pg-selection.js';
import type { PrepareCheckout, PrepareCheckoutAnswer } from '../application/prepare-checkout.js';

export interface PaymentPackage {
  PaymentService: grpc.ServiceClientConstructor;
}

/** 설명자를 읽는 선택지: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸을 단다 */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

let pkg: PaymentPackage | undefined;
/** peaket.payment.v1 패키지(계약 설명자에서 한 번 만든다. 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
export function paymentPackage(): PaymentPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: PaymentPackage } } }).peaket.payment.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const childOf = (v: unknown): Req | undefined => (typeof v === 'object' && v !== null ? (v as Req) : undefined);

function paymentRefOf(r: Req): ConfirmPaymentRef | undefined {
  if (r.payment_ref === 'toss') {
    const toss = childOf(r.toss);
    return toss && { kind: 'toss', paymentKey: text(toss.payment_key) };
  }
  if (r.payment_ref === 'portone') {
    const portone = childOf(r.portone);
    return portone && { kind: 'portone', paymentId: text(portone.payment_id), txId: text(portone.tx_id), paymentToken: text(portone.payment_token) };
  }
  return undefined;
}

/** google.protobuf.Timestamp → epoch ms. 칸이 없으면 undefined */
function msOf(v: unknown): number | undefined {
  const t = childOf(v);
  return t && Number(t.seconds) * 1000 + Math.floor(Number(t.nanos) / 1_000_000);
}

const timestampOf = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

/** 요청(proto 칸 이름) → 검사 전 입력. 앞머리 PG_PROVIDER_를 떼고, Money.krw와 Timestamp를 수로 바꾼다. 칸이 없으면 ConfirmPaymentInput의 규칙대로 둔다 */
export function confirmInputOf(request: Record<string, unknown>): ConfirmPaymentInput {
  const krw = childOf(request.amount)?.krw;
  const paymentRef = paymentRefOf(request);
  const authenticatedAtMs = msOf(request.authenticated_at);
  const entryOpensAtMs = msOf(request.entry_opens_at);
  return {
    orderId: text(request.order_id),
    attemptId: text(request.attempt_id),
    attemptNo: typeof request.attempt_no === 'number' ? request.attempt_no : 0,
    eventId: text(request.event_id),
    pg: text(request.pg).replace(/^PG_PROVIDER_/, '') || 'UNSPECIFIED',
    ...(paymentRef ? { paymentRef } : {}),
    amount: typeof krw === 'number' ? krw : Number.NaN,
    ...(authenticatedAtMs === undefined ? {} : { authenticatedAtMs }),
    ...(entryOpensAtMs === undefined ? {} : { entryOpensAtMs }),
  };
}

/** 답 → ConfirmPaymentResponse(proto 칸 이름, result는 CONFIRM_RESULT_ 앞머리를 붙인다) */
export function confirmResponseOf(answer: ConfirmAnswer): Record<string, unknown> {
  return {
    result: `CONFIRM_RESULT_${answer.result}`,
    payment_id: answer.paymentId,
    ...(answer.approvedAtMs === undefined ? {} : { approved_at: timestampOf(answer.approvedAtMs) }),
    ...(answer.failureCategory === undefined ? {} : { failure_category: `FAILURE_CATEGORY_${answer.failureCategory}` }),
  };
}

/** 결과 → OrderPaymentState(proto 칸 이름). lastEvent가 없으면 event_key·event_seq를 비운다 */
export function orderPaymentStateOf(state: PaymentState): Record<string, unknown> {
  return {
    order_id: state.orderId,
    payment_id: state.paymentId,
    pg: `PG_PROVIDER_${state.pg}`,
    status: `PAYMENT_STATUS_${state.status}`,
    amount: { krw: state.amount },
    ...(state.approvedAtMs === undefined ? {} : { approved_at: timestampOf(state.approvedAtMs) }),
    ...(state.failureCategory === undefined ? {} : { failure_category: `FAILURE_CATEGORY_${state.failureCategory}` }),
    ...(state.lastEvent ? { event_key: state.lastEvent.eventKey, event_seq: state.lastEvent.eventSeq } : {}),
    ...(state.depositDueAtMs === undefined ? {} : { deposit_due_at: timestampOf(state.depositDueAtMs) }),
  };
}

/** 결과 → GetPaymentResponse(proto 칸 이름). 값이 없는 칸은 싣지 않는다 */
export function getPaymentResponseOf(detail: PaymentDetail): Record<string, unknown> {
  const va = detail.virtualAccount;
  return {
    payment_id: detail.paymentId,
    order_id: detail.orderId,
    pg: `PG_PROVIDER_${detail.pg}`,
    status: `PAYMENT_STATUS_${detail.status}`,
    amount: { krw: detail.amount },
    cancelled_amount: { krw: detail.cancelledAmount },
    ...(detail.approvedAtMs === undefined ? {} : { approved_at: timestampOf(detail.approvedAtMs) }),
    ...(va === undefined
      ? {}
      : { virtual_account: { ...(va.bank === undefined ? {} : { bank: va.bank }), ...(va.accountNumber === undefined ? {} : { account_number: va.accountNumber }), ...(va.dueAtMs === undefined ? {} : { due_at: timestampOf(va.dueAtMs) }) } }),
  };
}

/** 요청(proto 칸 이름) → 검사 전 입력. 금액 칸이 없으면 amount를 뺀다 */
export function cancelInputOf(request: Record<string, unknown>): DepositCancelInput {
  const krw = childOf(request.amount)?.krw;
  return { paymentId: text(request.payment_id), cancellationId: text(request.cancellation_id), reason: text(request.reason), ...(typeof krw === 'number' ? { amount: krw } : {}) };
}

/** 답 → CancelPaymentResponse(proto 칸 이름, result는 CANCEL_RESULT_ 앞머리를 붙인다) */
export function cancelResponseOf(answer: DepositCancelAnswer): Record<string, unknown> {
  return { result: `CANCEL_RESULT_${answer.result}`, cancelled_amount: { krw: 0 } };
}

const tossCheckoutOf = (v: TossCheckoutValues): Record<string, unknown> => ({ client_key: v.clientKey, customer_key: v.customerKey, order_id: v.orderId, order_name: v.orderName, amount: { krw: v.amount }, success_url: v.successUrl, fail_url: v.failUrl });

/** 결제창 값 → oneof checkout의 칸 하나 */
function checkoutFieldsOf(values: CheckoutValues): Record<string, unknown> {
  if ('toss' in values) return { toss: tossCheckoutOf(values.toss) };
  if ('simulator' in values) return { simulator: tossCheckoutOf(values.simulator) };
  const v = values.portone;
  return { portone: { store_id: v.storeId, channel_key: v.channelKey, payment_id: v.paymentId, order_name: v.orderName, total_amount: { krw: v.totalAmount }, currency: v.currency, redirect_url: v.redirectUrl, custom_data: { order_id: v.customData.orderId } } };
}

/** 요청(proto 칸 이름) → 검사 전 입력(BUILD_ORDER PRF-190) */
export function prepareCheckoutInputOf(request: Record<string, unknown>): PrepareCheckoutInput {
  const krw = childOf(request.amount)?.krw;
  const customerKey = text(request.customer_key);
  const entryOpensAtMs = msOf(request.entry_opens_at);
  // UNSPECIFIED(칸 없음)는 입력 검사가 '고정 안 함'으로 읽는다
  const pinnedPg = text(request.pinned_pg).replace(/^PG_PROVIDER_/, '');
  return {
    orderKind: text(request.order_kind).replace(/^ORDER_KIND_/, '') || 'UNSPECIFIED',
    orderId: text(request.order_id),
    attemptId: text(request.attempt_id),
    eventId: text(request.event_id),
    amount: typeof krw === 'number' ? krw : Number.NaN,
    orderName: text(request.order_name),
    payMethod: text(request.pay_method),
    ...(customerKey === '' ? {} : { customerKey }),
    // proto3 optional: 칸이 없으면 undefined로 온다
    ...(typeof request.virtual_account_allowed === 'boolean' ? { virtualAccountAllowed: request.virtual_account_allowed } : {}),
    ...(entryOpensAtMs === undefined ? {} : { entryOpensAtMs }),
    ...(pinnedPg === '' || pinnedPg === 'UNSPECIFIED' ? {} : { pinnedPg }),
  };
}

/** 답 → PrepareCheckoutResponse(proto 칸 이름, BUILD_ORDER PRF-190) */
export function prepareCheckoutResponseOf(answer: PrepareCheckoutAnswer): Record<string, unknown> {
  return {
    pg: `PG_PROVIDER_${answer.pg}`,
    switched: answer.switched,
    ...checkoutFieldsOf(answer.checkout),
    allowed_pay_methods: [...answer.allowedPayMethods],
    ...(answer.depositDueAtMs === undefined ? {} : { deposit_due_at: timestampOf(answer.depositDueAtMs) }),
  };
}

export interface PaymentGrpcUseCases {
  accept: Pick<AcceptPaymentCommand, 'execute'>;
  batchGet: Pick<BatchGetPaymentStates, 'execute'>;
  /** 없으면 GetPayment는 UNIMPLEMENTED다 */
  getPayment?: Pick<GetPaymentDetail, 'execute'>;
  /** 없으면 CancelPayment는 UNIMPLEMENTED다 */
  cancelPayment?: Pick<CancelDepositPayment, 'execute'>;
  /** 없으면 PrepareCheckout은 UNIMPLEMENTED다 */
  prepareCheckout?: Pick<PrepareCheckout, 'execute'>;
}

/** 문장 시간 초과(statement_timeout)의 SQLSTATE */
const STATEMENT_TIMEOUT = '57014';
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** 다시 보내도 똑같이 실패할 SQL 오류의 SQLSTATE 앞 두 글자: 0A 미지원 기능, 21 개수 위반, 22 값 형식, 23 제약 위반, 42 문법·권한, P0 PL/pgSQL 예외 */
const SQL_BUG_CLASSES: ReadonlySet<string> = new Set(['0A', '21', '22', '23', '42', 'P0']);

const isCodeBug = (e: unknown): boolean => e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError;

/**
 * 입력·불일치 오류 밖의 오류 → gRPC 상태(오류와 그 원인 cause를 본다). 문장 시간 초과 57014와 남은 시간 모자람은 DEADLINE_EXCEEDED, 코드 오류로 보이는 것(SQL_BUG_CLASSES, JS 코드 결함)만 INTERNAL,
 * 나머지는 UNAVAILABLE이다(코드 없는 연결 끊김, 읽기 전용 25006, 연결 수 초과 53300, 풀 대기 초과 등). 부르는 쪽(purchase-svc)은 앞의 둘을 다시 하기·물러나기로, INTERNAL은 거절로 다룬다
 */
function statusOfStoreError(err: unknown): grpc.status {
  let e = err as { code?: unknown; cause?: unknown } | undefined;
  for (let n = 0; e && n < 4; n++) {
    if (e instanceof PaymentDeadlineError) return grpc.status.DEADLINE_EXCEEDED;
    if (isCodeBug(e)) return grpc.status.INTERNAL;
    const code = typeof e.code === 'string' ? e.code : '';
    if (code === STATEMENT_TIMEOUT) return grpc.status.DEADLINE_EXCEEDED;
    if (SQLSTATE.test(code) && SQL_BUG_CLASSES.has(code.slice(0, 2))) return grpc.status.INTERNAL;
    e = e.cause as typeof e;
  }
  return grpc.status.UNAVAILABLE;
}

/** 응답 글(내부 정보 없는 고정 문구) */
const STORE_ERROR_DETAILS: Partial<Record<grpc.status, string>> = {
  [grpc.status.DEADLINE_EXCEEDED]: '시간 안에 처리하지 못했다',
  [grpc.status.UNAVAILABLE]: '지금 처리할 수 없다',
};

/** 호출에 남은 시간(ms). 데드라인 없는 호출(grpc-js는 Infinity)은 Infinity다 */
const remainingMsOf = (deadline: grpc.Deadline): number => (deadline instanceof Date ? deadline.getTime() : deadline) - Date.now();

/**
 * PaymentService 처리기.
 * @param onError 예상하지 못한 오류(INTERNAL·UNAVAILABLE·저장소가 낸 DEADLINE_EXCEEDED로 답한 것)를 받는다. 오류의 글에는 SQL 문장 값(결제 키·토큰)이 실릴 수 있으니 그대로 로그에 싣지 않는다(main.ts는 safeErrorCode만 남긴다).
 *   orderId는 ConfirmPayment이고 요청의 값이 소문자 UUID일 때만 넘긴다(로그 줄에 틀린 값을 실지 않게). 시작하지 않은 호출(남은 시간 모자람)은 부르지 않는다
 */
export function paymentServiceHandlers(useCases: PaymentGrpcUseCases, onError: (method: string, err: unknown, orderId?: string) => void): grpc.UntypedServiceImplementation {
  const unary =
    (method: string, fn: (r: Req, budget: CallBudget) => Promise<object>, orderIdOf?: (r: Req) => string | undefined): grpc.handleUnaryCall<Req, object> =>
    (call, cb) => {
      const remainingMs = remainingMsOf(call.getDeadline());
      if (remainingMs < MIN_CALL_REMAINING_MS) {
        cb({ code: grpc.status.DEADLINE_EXCEEDED, details: '시간 안에 처리하지 못했다' });
        return;
      }
      fn(call.request, { remainingMs }).then(
        (v) => cb(null, v),
        (err: unknown) => {
          if (err instanceof PaymentInputError || err instanceof PaymentCommandMismatchError || err instanceof PaymentNotFoundError || err instanceof PaymentCancelStateError || err instanceof PaymentPgUnavailableError) {
            cb({ code: grpc.status[err.code], details: err.message });
            return;
          }
          onError(method, err, orderIdOf?.(call.request));
          const code = statusOfStoreError(err);
          cb({ code, details: STORE_ERROR_DETAILS[code] ?? '처리하지 못했다' });
        },
      );
    };
  return {
    ConfirmPayment: unary(
      'ConfirmPayment',
      async (r, budget) => confirmResponseOf(await useCases.accept.execute(confirmInputOf(r), budget)),
      (r) => (isLowerUuid(text(r.order_id)) ? text(r.order_id) : undefined),
    ),
    BatchGetPayments: unary('BatchGetPayments', async (r, budget) => ({
      payments: (await useCases.batchGet.execute(Array.isArray(r.order_ids) ? r.order_ids.map(text) : [], budget)).map(orderPaymentStateOf),
    })),
    ...(useCases.prepareCheckout === undefined ? {} : { PrepareCheckout: unary('PrepareCheckout', async (r, budget) => prepareCheckoutResponseOf(await useCases.prepareCheckout!.execute(prepareCheckoutInputOf(r), budget))) }),
    ...(useCases.cancelPayment === undefined ? {} : { CancelPayment: unary('CancelPayment', async (r, budget) => cancelResponseOf(await useCases.cancelPayment!.execute(cancelInputOf(r), budget))) }),
    ...(useCases.getPayment === undefined
      ? {}
      : {
          GetPayment: unary('GetPayment', async (r, budget) => {
            // oneof key의 어느 칸인지는 oneofs 선택지의 이름 칸(key)으로 본다
            const key = r.key === 'payment_id' ? { paymentId: text(r.payment_id) } : r.key === 'order_id' ? { orderId: text(r.order_id) } : {};
            return getPaymentResponseOf(await useCases.getPayment!.execute(key, budget));
          }),
        }),
  };
}
