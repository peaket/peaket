// 승인 실행기의 값과 규칙(docs/features/payment.md §2 '승인 실행기의 첫 구현', docs/data.md §2 payment·payment_event, BUILD_ORDER PRF-181,
// 명세 specs/payment.qnt `send`·`expireCommand`·`respond`·`timeout`·`restart`). 실행기(application/payment-confirm-runner.ts)와 저장소가 쓴다.
// 프레임워크·저장소·계약 패키지를 모른다(순수 값과 함수).
// 구현에서 정한 것(정본·설계에 없다):
// - 승인 기한의 경계는 purchase-svc isPastConfirmDeadline과 같다: 지금 >= 인증 시각 + 기한이면 지났다.
// - 어댑터가 없으면 기한을 잴 수 없으므로(기한은 어댑터의 capabilities에서 받는다) 어댑터 없음을 기한보다 먼저 본다.
// - 답의 승인 금액이 없으면 금액이 다른 것으로 본다(맞는지 확인하지 못한 승인을 APPROVED로 쓰지 않는다).
// - 사건의 result는 결제사 답을 정규화한 값이다. 호출하지 않고 끝난 EXPIRED는 싣지 않고, 답을 잃은 restart·기한 넘김 UNKNOWN은 'UNKNOWN'을 싣는다.
// - APPROVED 사건의 occurredAt은 approved_at과 같다(결과 당기기의 답과 사건이 같은 값이어야 한다, ADR-0140).
// - 재전송의 거절은 결제사가 그 결제에 내린 판정(CARD_DECLINED·USER_ABORTED·EXPIRED)만 FAILED다. PG_ERROR·VALIDATION·범주 없음은 UNKNOWN이다(첫 요청이 그 뒤에도 승인될 수 있다, 명세 pgProcess).
import { createHash } from 'node:crypto';
import type { PaymentLedgerStatus } from './confirm-command.js';
import type { ConfirmResult, FailureCategory, PayMethodCategory, PgName } from './payment-gateway.js';
import { linkFinishFields, type PaymentMethodLink } from './payment-method-ref.js';
import type { DepositWrite } from './virtual-account.js';

/** 잡기 주기 100ms [가정] */
export const CONFIRM_RUNNER_POLL_INTERVAL_MS = 100;
/** 임대 75초 [가정](읽기 시간 초과 60초 + 답 반영 여유) */
export const CONFIRM_LEASE_MS = 75_000;
/** 처리 중 재전송의 첫 간격 1초 [가정] */
export const CONFIRM_RETRY_BASE_MS = 1_000;
/** 재전송 간격을 늘리는 배수 2배 [가정] */
export const CONFIRM_RETRY_FACTOR = 2;
/** 재전송 간격 상한 30초 [가정] */
export const CONFIRM_RETRY_MAX_MS = 30_000;
/** 결제사 어댑터가 없을 때 미루는 간격 30초 [가정] */
export const CONFIRM_NO_ADAPTER_DELAY_MS = 30_000;
/** 어댑터 없음 경고 간격(파드당 1분에 한 줄) [가정] */
export const CONFIRM_NO_ADAPTER_WARN_INTERVAL_MS = 60_000;
/** 결제사 오류(PG_ERROR) 로그 간격(채널당 1분에 한 줄) [가정] */
export const CONFIRM_PG_ERROR_LOG_INTERVAL_MS = 60_000;
/** 어댑터가 없는 채널을 잡는 간격 1초 [가정](운영에는 그런 행이 없어 틱마다 묻지 않는다) */
export const CONFIRM_NO_ADAPTER_CLAIM_INTERVAL_MS = 1_000;
/** 어댑터가 없는 채널마다 동시 처리 8건 [가정](부르지 않고 미루기만 하므로 작게 잡는다) */
export const CONFIRM_NO_ADAPTER_CONCURRENCY = 8;
/** 답 반영 쓰기가 실패했을 때 다시 하기 전에 쉬는 시간(ms): 100ms·400ms 두 번 [가정] */
export const CONFIRM_FINISH_RETRY_DELAYS_MS: readonly number[] = Object.freeze([100, 400]);
/** 실행기 트랜잭션의 문장 시간 한도 5초 [가정](요청 밖이라 남은 시간이 없다. 발권 실행기 SAGA_STATEMENT_TIMEOUT_MS와 같은 값) */
export const CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS = 5_000;
/** 실행기가 승인 호출을 감싸는 한도 72초 [가정](어댑터의 시간 합 상한 70초 + 여유. 임대 75초보다 짧아 호출 중인 행을 다음 실행기가 잔해로 잡지 않는다) */
export const CONFIRM_CALL_GUARD_MS = 72_000;
/** 기한 지난 행을 틱마다 채널당 잡는 수(동시에도 이만큼까지) 50건 [가정](BUILD_ORDER PRF-183 코드 리뷰) */
export const CONFIRM_EXPIRED_BATCH = 50;
/** 기한 지난 행을 찾으려고 표 앞쪽에서 살펴보는 행 수 500건 [가정](밀린 표에서 틱마다 표 전체를 조인하지 않게) */
export const CONFIRM_EXPIRED_SCAN = 500;
/** 잡을 때 때가 된 지 이만큼 넘게 지난 명령은 여유 부족으로 재시도 큐에서 기다린 것으로 본다 1초 [가정](잡기 주기 100ms보다 충분히 길다, 경로 지표 retry_queue, BUILD_ORDER PRF-200) */
export const CONFIRM_QUEUED_AFTER_MS = 1_000;

/** payment_event의 내부 표시: 결제사 승인 호출 앞에 남긴다(exported = false, payment §4.2 5번) */
export const CONFIRM_SENT_EVENT_TYPE = 'CONFIRM_SENT';
/** payment_event·trade.payments의 입금 오류 되돌림(T21) 사건 종류(BUILD_ORDER HOT-152) */
export const DEPOSIT_REVERSED_EVENT_TYPE = 'DEPOSIT_REVERSED';

/** payment_confirm_total{outcome}의 값. circuit_open은 서킷이 열려 부르지 않고 미룬 명령이다(BUILD_ORDER PRF-200) */
export const PAYMENT_CONFIRM_OUTCOMES = ['approved', 'already', 'declined', 'waiting', 'in_progress', 'unknown', 'expired', 'restart', 'no_adapter', 'circuit_open'] as const;
export type PaymentConfirmOutcome = (typeof PAYMENT_CONFIRM_OUTCOMES)[number];

/** 잡은 승인 명령 한 행(claimDue의 결과) */
export interface ConfirmJob {
  readonly paymentId: string;
  /** 잡은 채널(claimDue의 pg, 보호기를 고른다) */
  readonly pg: PgName;
  /** 지금까지 결제사 답(처리 중·한도 초과)으로 다시 미룬 횟수(0부터). 잡기·어댑터 없음·읽기 실패로는 오르지 않는다 */
  readonly attempts: number;
  /** 이 잡기가 쓴 lease_owner */
  readonly owner: string;
  /** 이 잡기가 쓴 lease_until(epoch ms) */
  readonly leaseUntilMs: number;
  /** 잡기 전에 lease_owner가 차 있었는가(앞 실행이 임대를 끊긴 채 남긴 행) */
  readonly hadPreviousOwner: boolean;
  /** 이 명령이 여유 부족이나 서킷으로 미뤄진 적이 있다(경로 지표 retry_queue, BUILD_ORDER PRF-200) */
  readonly queued?: true;
}

/** 승인 호출에 필요한 원장 값(read의 결과) */
export interface ConfirmTarget {
  readonly paymentId: string;
  readonly orderId: string;
  /** 회차 ID(사건의 eventId, Kafka 키) */
  readonly eventId: string;
  readonly attemptNo: number;
  readonly pg: PgName;
  /** pg_payment_ref(토스·시뮬레이터 paymentKey, 포트원 paymentId) */
  readonly paymentRef: string;
  /** pg_confirm_token(포트원 결제 토큰). 토스·시뮬레이터는 없다. 어댑터 호출에만 넘기고 로그·사건에 싣지 않는다(BUILD_ORDER HOT-140) */
  readonly confirmToken?: string;
  /** pg_tx_id(포트원 결제 시도 ID). 토스·시뮬레이터는 없다. 승인 본문의 검증값과 조회의 대조값이다(BUILD_ORDER HOT-140, 코드 리뷰) */
  readonly txId?: string;
  readonly amount: number;
  readonly status: PaymentLedgerStatus;
  readonly authenticatedAtMs: number;
  /** payment_event에 CONFIRM_SENT 표시가 있는가 */
  readonly confirmSent: boolean;
  /** 회차의 입장 시작 시각(epoch ms). 답의 입금 기한을 자른다. 승인 명령에 없었으면 없다(BUILD_ORDER PRF-190 코드 리뷰) */
  readonly entryOpensAtMs?: number;
  /** 가상계좌를 내도 되는가(H2). 거짓인데 답이 입금 대기면 입금 전 취소로 끝낸다 */
  readonly virtualAccountAllowed?: boolean;
  /** 승인 접수 시각(epoch ms, ACCEPTED로 쓴 status_changed_at). 결제 확정 소요의 시작점이다(BUILD_ORDER PRF-200) */
  readonly acceptedAtMs?: number;
}

/**
 * 호출 앞의 판단(순서대로 본다):
 * - DROP_JOB: 원장이 ACCEPTED가 아니다. 명령 행만 지운다
 * - UNKNOWN restart: 앞 소유자가 있었고 CONFIRM_SENT가 있다(임대가 끊긴 잔해). 결제사를 다시 부르지 않는다
 * - NO_ADAPTER: 그 결제사의 어댑터가 없다. 30초 [가정] 뒤로 미룬다
 * - EXPIRE: 승인 기한이 지났고 CONFIRM_SENT가 없다. 부르지 않고 FAILED(EXPIRED)
 * - UNKNOWN deadline: 승인 기한이 지났고 CONFIRM_SENT가 있다(기한 전에 보낸 요청은 기한 뒤에도 승인될 수 있다)
 * - SEND: 부른다. markFirst가 참이면(CONFIRM_SENT가 없음) 표시를 쓰고 커밋한 뒤에 부른다
 */
export type ConfirmGate =
  | { readonly kind: 'DROP_JOB' }
  | { readonly kind: 'UNKNOWN'; readonly cause: 'restart' | 'deadline' }
  | { readonly kind: 'NO_ADAPTER' }
  | { readonly kind: 'EXPIRE' }
  | { readonly kind: 'SEND'; readonly markFirst: boolean };

/**
 * 원장에 쓰는 결과(한 트랜잭션: 원장·수출 사건·Outbox·명령 행 지움).
 * latencyMs는 이번 실행에서 결제사를 불렀을 때만 있다(사건의 latencyMs)
 */
export type ConfirmFinish =
  | {
      readonly status: 'APPROVED';
      readonly result: 'APPROVED' | 'ALREADY_APPROVED';
      /** 결제사 값, 없거나 읽지 못하면 지금 */
      readonly approvedAtMs: number;
      readonly payMethodCategory?: PayMethodCategory;
      readonly latencyMs?: number;
      /** 결제 수단 연결값(cardBin과 늘 함께, BUILD_ORDER HOT-145) */
      readonly paymentMethodRef?: string;
      readonly cardBin?: string;
      /** 카드 정보가 있는데 연결값을 계산하지 못했다 */
      readonly refMissing?: true;
    }
  | {
      readonly status: 'FAILED';
      /** 호출하지 않고 끝난 EXPIRED는 없다 */
      readonly result?: 'DECLINED';
      readonly failureCategory: FailureCategory;
      readonly payMethodCategory?: PayMethodCategory;
      readonly latencyMs?: number;
    }
  | {
      readonly status: 'AWAITING_DEPOSIT';
      readonly result: 'WAITING_FOR_DEPOSIT';
      readonly payMethodCategory?: PayMethodCategory;
      readonly latencyMs?: number;
      /** 가상계좌 발급 정보(답에 있을 때만 실행기가 채운다, BUILD_ORDER HOT-151) */
      readonly deposit?: DepositWrite;
      /** 입금 오류 되돌림이면 참이다(사건 종류가 DEPOSIT_REVERSED이고 저장한 해시를 지우지 않는다, BUILD_ORDER HOT-152) */
      readonly reversed?: true;
    }
  | { readonly status: 'UNKNOWN'; readonly result: 'UNKNOWN'; readonly payMethodCategory?: PayMethodCategory; readonly latencyMs?: number }
  /** 대사가 닫는 결제사 전액 취소(돈이 나가지 않았다, BUILD_ORDER HOT-153) */
  | { readonly status: 'CANCELED'; readonly result: 'DECLINED'; readonly payMethodCategory?: PayMethodCategory; readonly latencyMs?: number };

/**
 * 결제사 답 → 할 일.
 * - FINISH: 원장에 finish를 쓴다. outcome은 지표 값이고, amountMismatch가 참이면 SEV1 로그(주문 ID·금액 차이 여부만)를 남긴다
 * - RETRY: 명령 행을 남겨 다시 보낸다(원장은 ACCEPTED 그대로, 수출 사건 없음)
 */
export type ConfirmDecision =
  | { readonly kind: 'FINISH'; readonly finish: ConfirmFinish; readonly outcome: PaymentConfirmOutcome; readonly amountMismatch?: true }
  | { readonly kind: 'RETRY'; readonly outcome: 'in_progress' };

/** trade.payments 값(asyncapi PaymentEvent의 칸. 값 바이트는 어댑터의 코덱이 만든다) */
export interface PaymentEventMessage {
  readonly eventId: string;
  readonly orderId: string;
  readonly pg: PgName;
  readonly type: 'APPROVED' | 'FAILED' | 'AWAITING_DEPOSIT' | 'DEPOSIT_REVERSED' | 'UNKNOWN' | 'RESOLVED' | 'CANCELED';
  readonly amount: number;
  readonly payMethodCategory?: PayMethodCategory;
  /** 결제 수단 연결값(cardBin과 늘 함께 있거나 함께 빈다, BUILD_ORDER HOT-145) */
  readonly paymentMethodRef?: string;
  readonly cardBin?: string;
  /** 카드 정보가 있는데 연결값을 계산하지 못했으면 true(카드 아닌 결제와 승인이 아닌 사건은 false) */
  readonly refMissing: boolean;
  readonly result?: ConfirmFinish['result'];
  /** FAILED일 때만 */
  readonly failureCategory?: FailureCategory;
  readonly attemptNo: number;
  readonly latencyMs?: number;
  /** ISO 8601 */
  readonly occurredAt: string;
  readonly eventSeq: number;
  readonly eventKey: string;
  /** 입금 기한(ISO 8601, 입금 대기 사건에만, BUILD_ORDER HOT-151) */
  readonly depositDueAt?: string;
}

export interface BuildPaymentEventInput {
  readonly target: Pick<ConfirmTarget, 'paymentId' | 'orderId' | 'eventId' | 'attemptNo' | 'pg' | 'amount'>;
  readonly finish: ConfirmFinish;
  /** payment_event의 순번 */
  readonly seq: number;
  /** 지금(epoch ms). APPROVED가 아닌 사건의 occurredAt */
  readonly nowMs: number;
}

/**
 * 실행기가 행 하나를 돈 결과(시험·로그용):
 * - DROPPED: 원장이 ACCEPTED가 아니라 명령 행만 지웠다
 * - FINISHED: 원장·사건·Outbox·명령 행 지움을 커밋했다
 * - STALE: 답을 쓰려니 원장이 ACCEPTED가 아니었다(늦은 답). 원장은 그대로 두고 명령 행만 지웠다
 * - RETRY: 명령 행을 미뤘다
 * - SKIPPED: 아무것도 쓰지 않았다. LEASE_LOST는 임대를 잃음, RELEASED는 멈춘 뒤라 임대를 놓음, READ_FAILED는 원장을 읽지 못해 임대를 그대로 둠(임대가 끝나면 다시 잡힌다), NO_TOKEN은 토큰을 못 얻어 임대를 놓음(다음 틱에 다시 잡힌다, attempts는 오르지 않는다)
 * - WRITE_FAILED: 쓰기가 다시 해도 실패했다. 행을 그대로 두어 임대가 끝나면 다시 잡힌다
 */
export type ConfirmRunOutcome =
  | { readonly kind: 'DROPPED' }
  | { readonly kind: 'FINISHED'; readonly status: ConfirmFinish['status']; readonly outcome: PaymentConfirmOutcome }
  | { readonly kind: 'STALE' }
  | { readonly kind: 'RETRY'; readonly outcome: 'in_progress' | 'no_adapter' | 'circuit_open'; readonly nextAtMs: number }
  | { readonly kind: 'SKIPPED'; readonly reason: 'LEASE_LOST' | 'RELEASED' | 'READ_FAILED' | 'NO_TOKEN' }
  | { readonly kind: 'WRITE_FAILED'; readonly stage: 'mark' | 'finish' | 'reschedule' | 'drop' };

const DROP_JOB: ConfirmGate = { kind: 'DROP_JOB' };
const UNKNOWN_RESTART: ConfirmGate = { kind: 'UNKNOWN', cause: 'restart' };
const UNKNOWN_DEADLINE: ConfirmGate = { kind: 'UNKNOWN', cause: 'deadline' };
const NO_ADAPTER: ConfirmGate = { kind: 'NO_ADAPTER' };
const EXPIRE: ConfirmGate = { kind: 'EXPIRE' };
const SEND_FIRST: ConfirmGate = { kind: 'SEND', markFirst: true };
const SEND_AGAIN: ConfirmGate = { kind: 'SEND', markFirst: false };
const RETRY: ConfirmDecision = { kind: 'RETRY', outcome: 'in_progress' };
/** 거듭제곱의 지수 상한(1초 × 2^6 = 64초가 상한 30초보다 크다) */
const RETRY_EXPONENT_CAP = 6;
/** 재전송의 거절 가운데 결제사가 그 결제에 내린 판정이라 FAILED로 끝내는 범주 */
const RESEND_FINAL_DECLINES: ReadonlySet<FailureCategory> = new Set<FailureCategory>(['CARD_DECLINED', 'USER_ABORTED', 'EXPIRED']);

/**
 * 호출 앞의 판단(ConfirmGate의 차례대로).
 * @param deadlineMs 어댑터 capabilities().confirmDeadlineMs. 어댑터가 없으면 undefined
 * @param nowMs 지금(epoch ms). 지금 >= authenticatedAtMs + deadlineMs이면 기한이 지났다
 */
export function confirmGateOf(target: ConfirmTarget, job: Pick<ConfirmJob, 'hadPreviousOwner'>, deadlineMs: number | undefined, nowMs: number): ConfirmGate {
  if (target.status !== 'ACCEPTED') return DROP_JOB;
  if (job.hadPreviousOwner && target.confirmSent) return UNKNOWN_RESTART;
  if (deadlineMs === undefined) return NO_ADAPTER;
  if (nowMs >= target.authenticatedAtMs + deadlineMs) return target.confirmSent ? UNKNOWN_DEADLINE : EXPIRE;
  return target.confirmSent ? SEND_AGAIN : SEND_FIRST;
}

/**
 * 결제사 답 → 할 일(payment §2.1 '공통 결과 코드 정규화').
 * APPROVED·ALREADY_APPROVED: 금액이 원장과 같으면 APPROVED(outcome approved·already), 다르거나 없으면 UNKNOWN(amountMismatch true, outcome unknown)
 * DECLINED: THROTTLED면 RETRY, 그 밖은 FAILED(failureCategory가 없으면 PG_ERROR, outcome declined).
 * 단 재전송이면 CARD_DECLINED·USER_ABORTED·EXPIRED만 FAILED이고 나머지는 UNKNOWN(outcome unknown)이다
 * WAITING_FOR_DEPOSIT: AWAITING_DEPOSIT(outcome waiting) · IN_PROGRESS: RETRY · UNKNOWN과 형 밖의 값: UNKNOWN(outcome unknown)
 * @param ledgerAmount 원장 금액(원)
 * @param nowMs 지금(epoch ms). 답의 approvedAt이 없거나 읽지 못하면 approvedAtMs가 이 값이다
 * @param latencyMs 결제사 호출에 걸린 시간(ms). 있으면 finish에 그대로 싣는다
 * @param resend 이미 CONFIRM_SENT가 있는 명령을 다시 보낸 호출의 답인가
 * @param linkOf 답의 카드 칸으로 결제 수단 연결값을 계산한다. 금액 대조를 통과해 승인으로 끝날 때만 부른다(어긋난 답은 계산하지 않는다, BUILD_ORDER HOT-145 코드 리뷰)
 */
export function decideConfirmAnswer(answer: ConfirmResult, ledgerAmount: number, nowMs: number, latencyMs?: number, resend = false, linkOf?: () => PaymentMethodLink): ConfirmDecision {
  const extra = {
    ...(answer.method === undefined ? {} : { payMethodCategory: answer.method }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
  const unknown: ConfirmFinish = { status: 'UNKNOWN', result: 'UNKNOWN', ...extra };
  switch (answer.outcome) {
    case 'APPROVED':
    case 'ALREADY_APPROVED': {
      if (answer.amount !== ledgerAmount) return { kind: 'FINISH', finish: unknown, outcome: 'unknown', amountMismatch: true };
      const parsed = answer.approvedAt === undefined ? Number.NaN : Date.parse(answer.approvedAt);
      return {
        kind: 'FINISH',
        finish: { status: 'APPROVED', result: answer.outcome, approvedAtMs: Number.isNaN(parsed) ? nowMs : parsed, ...extra, ...linkFinishFields(linkOf?.()) },
        outcome: answer.outcome === 'APPROVED' ? 'approved' : 'already',
      };
    }
    case 'DECLINED': {
      // 429는 실패로 끝내지 않고 다음 시도만 늦춘다(상한 조정은 PRF-183)
      if (answer.failureCategory === 'THROTTLED') return RETRY;
      const failureCategory = answer.failureCategory ?? 'PG_ERROR';
      if (resend && !RESEND_FINAL_DECLINES.has(failureCategory)) return { kind: 'FINISH', finish: unknown, outcome: 'unknown' };
      return { kind: 'FINISH', finish: { status: 'FAILED', result: 'DECLINED', failureCategory, ...extra }, outcome: 'declined' };
    }
    case 'WAITING_FOR_DEPOSIT':
      return { kind: 'FINISH', finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', ...extra }, outcome: 'waiting' };
    case 'IN_PROGRESS':
      return RETRY;
    default:
      // UNKNOWN과 형 밖의 값: 결과를 가정하지 않는다
      return { kind: 'FINISH', finish: unknown, outcome: 'unknown' };
  }
}

/**
 * 처리 중 재전송의 다음 간격(ms) = min(1초 × 2^(attempts − 1), 30초).
 * @param attempts 이번 미루기를 더한 재전송 횟수(1 → 1초, 2 → 2초, 3 → 4초, …, 6 이상 → 30초). 아주 큰 수에서도 거듭제곱하지 않는다
 * @throws RangeError attempts가 1 이상의 안전한 정수가 아님
 */
export function confirmRetryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError(`시도 수는 1 이상의 안전한 정수다: ${String(attempts)}`);
  // 지수를 잘라 아주 큰 시도 수에서도 거듭제곱이 넘치지 않게 한다(2^RETRY_EXPONENT_CAP초는 이미 상한보다 크다)
  return Math.min(CONFIRM_RETRY_MAX_MS, CONFIRM_RETRY_BASE_MS * CONFIRM_RETRY_FACTOR ** Math.min(attempts - 1, RETRY_EXPONENT_CAP));
}

/**
 * 결제 사건의 eventKey: UUID 버전 8(SHA-256('PaymentEvent:' + 결제 ID + ':' + 순번)의 앞 16바이트에 판·변형 비트를 맞춘 값).
 * 같은 사건은 늘 같은 값이다(purchase-svc orderEventKey와 같은 계산). 내부 표시 행(CONFIRM_SENT)의 event_key도 이 값이다
 * @throws RangeError seq가 1 이상의 안전한 정수가 아님
 */
export function paymentEventKey(paymentId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`사건 순번은 1 이상의 안전한 정수다: ${String(seq)}`);
  const b = Buffer.from(createHash('sha256').update(`PaymentEvent:${paymentId}:${seq}`).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 원장 결과 → trade.payments 값(asyncapi PaymentEvent. 칸 차례는 계약과 같다).
 * type = finish.status, eventKey = paymentEventKey(paymentId, seq), refMissing = 승인인데 연결값을 계산하지 못했을 때만 참,
 * occurredAt = APPROVED면 approvedAtMs, 아니면 nowMs. result·failureCategory·latencyMs·payMethodCategory·paymentMethodRef·cardBin은 값이 있을 때만 싣는다.
 * @throws RangeError 시각이 날짜 범위 밖, seq가 틀림
 */
export function buildPaymentEvent(input: BuildPaymentEventInput): PaymentEventMessage {
  const { target, finish, seq, nowMs } = input;
  const eventKey = paymentEventKey(target.paymentId, seq);
  // toISOString은 날짜 범위 밖이면 RangeError를 던진다
  const occurredAt = new Date(finish.status === 'APPROVED' ? finish.approvedAtMs : nowMs).toISOString();
  // 칸 차례는 asyncapi PaymentEvent와 같다
  return {
    eventId: target.eventId,
    orderId: target.orderId,
    pg: target.pg,
    type: finish.status === 'AWAITING_DEPOSIT' && finish.reversed === true ? DEPOSIT_REVERSED_EVENT_TYPE : finish.status,
    amount: target.amount,
    ...(finish.payMethodCategory === undefined ? {} : { payMethodCategory: finish.payMethodCategory }),
    ...(finish.status === 'APPROVED' && finish.paymentMethodRef !== undefined ? { paymentMethodRef: finish.paymentMethodRef, cardBin: finish.cardBin } : {}),
    refMissing: finish.status === 'APPROVED' && finish.refMissing === true,
    ...(finish.result === undefined ? {} : { result: finish.result }),
    ...(finish.status === 'FAILED' ? { failureCategory: finish.failureCategory } : {}),
    attemptNo: target.attemptNo,
    ...(finish.latencyMs === undefined ? {} : { latencyMs: finish.latencyMs }),
    occurredAt,
    eventSeq: seq,
    eventKey,
    ...depositDueAtField(finish),
  };
}

/** 입금 대기 사건의 입금 기한 칸(기한을 알 때만). 계좌번호는 사건에 싣지 않는다 */
function depositDueAtField(finish: ConfirmFinish): { depositDueAt?: string } {
  const dueAtMs = finish.status === 'AWAITING_DEPOSIT' ? finish.deposit?.dueAtMs : undefined;
  return dueAtMs === undefined ? {} : { depositDueAt: new Date(dueAtMs).toISOString() };
}
