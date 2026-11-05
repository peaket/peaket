// 발권 호출과 재시도 큐의 값과 규칙(ADR-0106 결정 2, docs/features/payment.md §3 T18·T19, docs/data.md §5, BUILD_ORDER PRF-170).
// 결제 승인 반영(PRF-163)이 같은 트랜잭션에서 넣은 ticket_issue_job 행을 발권 실행기(application/ticket-issue.ts)가 돈다:
//   ticket-svc IssueTickets(주문 ID로 멱등) → 성공이면 한 트랜잭션에서 T18(APPROVED → CONFIRMED, 조건부)·좌석별 티켓 ID·큐 행 지우기·Outbox CONFIRMED,
//   다시 보낼 실패면 늘려 쉬기(1초에서 두 배, 최대 60초, ±20% 흔들기 [가정]), 다시 보내지 않을 실패면 자동 재시도를 멈추고 SEV2 오류 로그.
// 따로 틱마다 승인 반영 뒤 60초 [가정] 넘게 남은 행에 ISSUE_DELAYED를 한 번, 발권 기한(승인 + 30분 [가정])을 넘긴 행에 SEV1 신호를 한 번 낸다.
// 자동 재시도마다 주문 이력(T19)을 쓰지 않는다 [정함: 이력이 재시도 수만큼 늘지 않게. T19는 CS가 다시 발권을 부를 때, PRF-173 이후].
// 순수 함수의 입력 검사(RangeError)는 시도 수·흔들기 난수·사건 칸만이다.
// 프레임워크·저장소를 모른다(순수 값과 함수).
// 구현에서 정한 것(정본에 없다):
// - 실패 갈래: 두 묶음 밖의 코드(형 밖에서 들어온 값)는 RETRY로 본다(던지지 않는다. 다시 보내도 주문 ID로 멱등이라 이중 발권이 없다).
// - issuedTicketsMatch: 주문 좌석이 비었거나 좌석 묶음에 같은 좌석이 둘이면 false다(발권할 좌석이 정해지지 않았다).
//   답의 티켓 상태가 있으면 ISSUED·ACTIVE만 맞는 답이다(리뷰 고침 L8). 상태가 없는 티켓(저장소 입력·시험)은 상태를 보지 않는다.
// - isFinalTicketIssueWriteError: 성공 반영 쓰기가 RangeError(좌석 불일치 등)나 SQLSTATE 23(제약 위반)으로 실패하면 다시 해도 같으므로
//   실행기가 BAD_ANSWER로 멈춘다(리뷰 고침 L6). 그 밖의 오류(연결·시간 초과 등)는 임대가 끝난 뒤 다시 한다.
import { type OrderEventMessage, type OrderItem, type OrderRow, type OrderStatus, uuid8 } from './order.js';
import { ISSUE_DELAYED_AFTER_MS } from './payment-status.js';

/** 발권 실행기의 행위자(order_event.actor, ACTOR_PATTERN의 system:<작업 이름>). T18 이력에 쓴다 */
export const TICKET_ISSUE_ACTOR = 'system:ticket-issue';

/** 반복 간격 1초 [가정](모든 API 파드가 기한이 된 큐 행을 잡는다) */
export const TICKET_ISSUE_POLL_INTERVAL_MS = 1000;
/** 한 번에 잡는 큐 행 수 50건 [가정] */
export const TICKET_ISSUE_CLAIM_LIMIT = 50;
/** 임대 30초 [가정](lease_until = 지금 + 이 값. 끝나기 전에는 다른 파드가 잡지 않는다) */
export const TICKET_ISSUE_LEASE_MS = 30_000;
/** 파드마다 동시에 부르는 발권 호출 수 8개 [가정] */
export const TICKET_ISSUE_CONCURRENCY = 8;
/** 발권 호출 gRPC 데드라인 2초 [가정](docs/architecture.md 시간 초과 표 '발권 gRPC' 행) */
export const TICKET_ISSUE_CALL_DEADLINE_MS = 2000;
/**
 * 큐 행 하나를 부르기 전에 남아 있어야 하는 임대 5초 [정함: 정본에 없다. Saga SAGA_LEASE_MIN_REMAINING_MS와 같은 값].
 * 모자라면 부르지 않고 임대를 놓는다(다음 틱에 다시 잡힌다). 데드라인 2초 + 성공 반영 트랜잭션이 임대 안에 끝나게
 */
export const TICKET_ISSUE_LEASE_MIN_REMAINING_MS = 5_000;

/** 다시 보내기 첫 간격 1초 [가정] */
export const TICKET_ISSUE_RETRY_BASE_MS = 1000;
/** 다시 보내기 간격을 늘리는 배수 2배 [가정] */
export const TICKET_ISSUE_RETRY_FACTOR = 2;
/** 다시 보내기 간격 상한 60초 [가정](흔들기 전. ADR-0106 결정 2: 기한을 넘겨도 이 간격으로 이어 간다) */
export const TICKET_ISSUE_RETRY_MAX_MS = 60_000;
/** 흔들기 폭 ±20% [가정](간격 × 0.8 ~ 1.2. 같은 때 실패한 행들이 같은 때 다시 몰리지 않게) */
export const TICKET_ISSUE_JITTER_RATIO = 0.2;

/**
 * ISSUE_DELAYED를 내는 기준 60초 [가정]: 큐 행의 created_at(purchase가 승인을 반영한 시각)부터. long polling issueDelayed(isIssueDelayed)의
 * 60초 조건과 같은 기준이라 그 상수를 그대로 쓴다(설계 10)
 */
export const TICKET_ISSUE_DELAYED_AFTER_MS = ISSUE_DELAYED_AFTER_MS;
/** 한 틱에 ISSUE_DELAYED·기한 넘김 신호를 내는 행 수 상한 100건 [가정](기한 넘김의 상한은 정함: ISSUE_DELAYED와 같은 값) */
export const TICKET_ISSUE_SIGNAL_BATCH = 100;
/** 큐 게이지(행 수·가장 오래된 행의 나이)를 재는 간격 10초 [가정](한 질의. 파드마다 같은 값이라 경보는 최댓값으로 본다) */
export const TICKET_ISSUE_GAUGE_INTERVAL_MS = 10_000;

/** 발권하지 못한 주문의 CS 표시(로그 csCase 칸). CS 건 요청 계약은 아직 없어(asyncapi CaseRequested kind에 없다) 로그 표시로만 둔다(건 요청은 GAT-280) */
export const TICKET_ISSUE_CS_CASE = 'TICKET_NOT_ISSUED';

/** gRPC 상태 코드 이름(차례가 곧 번호다: 0 OK … 16 UNAUTHENTICATED, grpc-js status와 같다) */
export const GRPC_STATUS_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;
export type GrpcStatusName = (typeof GRPC_STATUS_NAMES)[number];

/**
 * 발권 호출 실패의 코드(ticket_issue_job.last_error에 그대로 적는다).
 * - gRPC 상태 이름(OK 빼고). 모르는 번호는 UNKNOWN으로 접는다(어댑터)
 * - CIRCUIT_OPEN: 차단기 ticket-svc가 열려 부르지 않았다
 * - BAD_ANSWER: 답은 받았지만 좌석별 티켓 ID가 주문 좌석과 맞지 않는다(빠짐·남는 좌석·같은 좌석 둘·같은 티켓 ID 둘·빈 ID) [정함: 정본에 없다]
 */
export type TicketIssueFailureCode = Exclude<GrpcStatusName, 'OK'> | 'CIRCUIT_OPEN' | 'BAD_ANSWER';

/**
 * 다시 보낼 실패: UNAVAILABLE·DEADLINE_EXCEEDED·RESOURCE_EXHAUSTED(ADR-0106)와,
 * 정본에 없어 정한 ABORTED·INTERNAL·UNKNOWN·CIRCUIT_OPEN(일시 장애일 수 있다), CANCELLED(이쪽이 끊은 호출. 파드 멈춤 등)
 */
export const TICKET_ISSUE_RETRY_CODES: ReadonlySet<TicketIssueFailureCode> = new Set<TicketIssueFailureCode>([
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'ABORTED',
  'INTERNAL',
  'UNKNOWN',
  'CANCELLED',
  'CIRCUIT_OPEN',
]);

/**
 * 다시 보내지 않을 실패(다시 보내도 결과가 같다): FAILED_PRECONDITION·INVALID_ARGUMENT·NOT_FOUND(ADR-0106)와,
 * 정본에 없어 정한 PERMISSION_DENIED·UNAUTHENTICATED·ALREADY_EXISTS·OUT_OF_RANGE·UNIMPLEMENTED·DATA_LOSS·BAD_ANSWER.
 * next_attempt_at을 비워 자동 재시도를 멈추고 SEV2 오류 로그(csCase TICKET_NOT_ISSUED)와 지표를 남긴다
 */
export const TICKET_ISSUE_STOP_CODES: ReadonlySet<TicketIssueFailureCode> = new Set<TicketIssueFailureCode>([
  'FAILED_PRECONDITION',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'ALREADY_EXISTS',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'DATA_LOSS',
  'BAD_ANSWER',
]);

/** 실패의 갈래: RETRY(늘려 쉬고 다시 보낸다) · STOP(자동 재시도를 멈춘다) */
export type TicketIssueFailureKind = 'RETRY' | 'STOP';

/**
 * 실패 코드 → 갈래. TICKET_ISSUE_RETRY_CODES면 RETRY, TICKET_ISSUE_STOP_CODES면 STOP(두 묶음은 겹치지 않고 모든 코드를 덮는다).
 * 순수 함수다(던지지 않는다)
 */
export function ticketIssueFailureKind(code: TicketIssueFailureCode): TicketIssueFailureKind {
  // 멈추는 묶음에 있을 때만 STOP이다(머리 주석 '구현에서 정한 것': 묶음 밖의 값은 다시 보낸다)
  return TICKET_ISSUE_STOP_CODES.has(code) ? 'STOP' : 'RETRY';
}

/** 1 이상의 안전한 정수(발권 시도 수)인지 보고 아니면 RangeError */
function assertAttempts(attempts: number): void {
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError(`발권 시도 수(attempts)는 1 이상의 안전한 정수다: ${String(attempts)}`);
}

/**
 * 흔들기 전 다시 보내기 간격(ms) = min(1초 × 2^(attempts − 1), 60초).
 * @param attempts 이번 실패를 더한 발권 시도 수(1 이상의 안전한 정수. 1 → 1초, 2 → 2초, 3 → 4초, …, 7 이상 → 60초). 아주 큰 수에서도 거듭제곱을 하지 않는다(Infinity가 되지 않게)
 * @throws RangeError attempts가 1 이상의 안전한 정수가 아님
 */
export function ticketIssueBackoffMs(attempts: number): number {
  assertAttempts(attempts);
  // 두 배씩 늘리다 상한에 닿으면 멈춘다(거듭제곱을 하지 않아 아주 큰 시도 수에서도 몇 바퀴로 끝난다)
  let ms = TICKET_ISSUE_RETRY_BASE_MS;
  for (let i = 1; i < attempts; i += 1) {
    ms *= TICKET_ISSUE_RETRY_FACTOR;
    if (ms >= TICKET_ISSUE_RETRY_MAX_MS) return TICKET_ISSUE_RETRY_MAX_MS;
  }
  return Math.min(ms, TICKET_ISSUE_RETRY_MAX_MS);
}

/**
 * 흔들기를 곱한 다시 보내기 간격(ms) = ticketIssueBackoffMs(attempts) × (1 − 0.2 + 0.4 × unit)를 정수로 내린 값(0.8 ~ 1.2배, 상한 60초도 흔든다).
 * next_attempt_at = 지금 + 이 값이다.
 * @param unit [0, 1)의 난수(실행기가 주입한 random(). 시험은 0·0.5·1 가까이를 준다)
 * @throws RangeError attempts가 1 이상의 안전한 정수가 아님, unit이 [0, 1) 밖이거나 수가 아님
 */
export function ticketIssueRetryDelayMs(attempts: number, unit: number): number {
  const base = ticketIssueBackoffMs(attempts);
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit < 0 || unit >= 1) throw new RangeError(`흔들기 난수(unit)는 [0, 1)의 수다: ${String(unit)}`);
  return Math.floor(base * (1 - TICKET_ISSUE_JITTER_RATIO + 2 * TICKET_ISSUE_JITTER_RATIO * unit));
}

/** 티켓 ID 모양(소문자 UUID, order_item.ticket_id uuid 칸) */
const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 답의 티켓 상태(ticket.proto TicketStatus에서 접두어 TICKET_STATUS_를 뗀 이름, docs/planning/03-policies-glossary.md §2.5).
 * UNSPECIFIED는 칸이 없거나(proto 기본값) 모르는 값이다
 */
export const ISSUED_TICKET_STATUSES = ['UNSPECIFIED', 'ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'CANCEL_REQUESTED', 'REFUNDED', 'VOIDED'] as const;
export type IssuedTicketStatus = (typeof ISSUED_TICKET_STATUSES)[number];
/** 발권 답으로 받는 상태(막 발급됨·입장 가능). 그 밖의 상태가 섞인 답은 BAD_ANSWER다(리뷰 고침 L8) */
export const TICKET_ISSUE_OK_STATUSES: ReadonlySet<IssuedTicketStatus> = new Set<IssuedTicketStatus>(['ISSUED', 'ACTIVE']);

/** ticket-svc가 돌려준 좌석 하나의 티켓(IssueTicketsResponse.tickets의 seat_id·ticket_id·status) */
export interface IssuedTicketRef {
  readonly seatId: string;
  readonly ticketId: string;
  /**
   * 답의 티켓 상태(어댑터 issuedTicketsOf가 늘 싣는다). 없으면 상태를 보지 않는다(저장소 complete 입력·시험) [구현에서 정한 것]
   */
  readonly status?: IssuedTicketStatus;
}

/**
 * 답의 티켓 묶음이 주문 좌석과 맞나: 주문 좌석마다 정확히 하나이고(빠짐·남는 좌석·같은 좌석 둘 없음), 티켓 ID가 비지 않은 소문자 UUID이며 서로 다르고,
 * 상태가 있으면 ISSUED·ACTIVE(TICKET_ISSUE_OK_STATUSES)면 true. 차례는 보지 않는다. false면 실행기가 BAD_ANSWER(다시 보내지 않을 실패)로 본다
 * @param seatIds 주문 항목의 좌석 ID(줄 번호 차례)
 */
export function issuedTicketsMatch(seatIds: readonly string[], tickets: readonly IssuedTicketRef[]): boolean {
  if (!Array.isArray(seatIds) || !Array.isArray(tickets) || seatIds.length === 0) return false;
  const seats = new Set(seatIds);
  if (seats.size !== seatIds.length || tickets.length !== seatIds.length) return false;
  const seenSeats = new Set<string>();
  const seenTickets = new Set<string>();
  for (const t of tickets as readonly unknown[]) {
    if (typeof t !== 'object' || t === null) return false;
    const { seatId, ticketId, status } = t as { seatId?: unknown; ticketId?: unknown; status?: unknown };
    if (typeof seatId !== 'string' || !seats.has(seatId) || seenSeats.has(seatId)) return false;
    if (typeof ticketId !== 'string' || !TICKET_ID.test(ticketId) || seenTickets.has(ticketId)) return false;
    // 양도 중·취소 요청·환급·폐기·모르는 상태의 티켓은 발권 답이 아니다(리뷰 고침 L8)
    if (status !== undefined && !TICKET_ISSUE_OK_STATUSES.has(status as IssuedTicketStatus)) return false;
    seenSeats.add(seatId);
    seenTickets.add(ticketId);
  }
  // 수가 같고 겹침이 없으니 주문 좌석마다 정확히 하나다
  return true;
}

/** SQLSTATE 23 묶음(무결성 제약 위반: 23505 유일·23503 외래 키·23514 검사 등) */
const INTEGRITY_SQLSTATE = /^23[0-9A-Z]{3}$/;

/**
 * 성공 반영 쓰기(TicketIssueJobs.complete)의 오류가 다시 해도 같은 것인가(리뷰 고침 L6): RangeError(입력·좌석 불일치) 또는
 * 오류나 그 원인(cause, 몇 겹이든)의 code가 SQLSTATE 23으로 시작하면 true. 실행기는 true면 BAD_ANSWER로 멈추고(stop), false면 임대를 그대로 둔다(ERROR).
 * 순수 함수다(던지지 않는다)
 */
export function isFinalTicketIssueWriteError(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = err; typeof e === 'object' && e !== null && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (e instanceof RangeError) return true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && INTEGRITY_SQLSTATE.test(code)) return true;
  }
  return false;
}

/**
 * ISSUE_DELAYED 사건의 eventKey: UUID 버전 8(SHA-256('OrderEvent:' + 주문 ID + ':ISSUE_DELAYED')의 앞 16바이트, orderEventKey와 같은 계산에 이력 번호 대신 고정 글).
 * 주문마다 늘 같은 값이라 다시 내도 소비자가 지운다(설계 7 '{orderId}:ISSUE_DELAYED 고정'. asyncapi eventKey가 format uuid라 글 그대로는 쓰지 않는다)
 */
export function issueDelayedEventKey(orderId: string): string {
  return uuid8(`OrderEvent:${orderId}:ISSUE_DELAYED`);
}

export interface BuildIssueDelayedEventInput {
  /** 지금 주문 행(status는 APPROVED여야 한다. 상태 전이 없이 낸다) */
  readonly order: OrderRow;
  /** 줄 번호 차례 */
  readonly items: readonly OrderItem[];
  /** 사건 시각(주입한 시계, 유닉스 밀리초) */
  readonly occurredAtMs: number;
}

/**
 * ISSUE_DELAYED 주문 사건(trade.orders OrderEvent, 상태 전이 없음). 칸 차례는 buildOrderEvent와 같고,
 * type ISSUE_DELAYED, firstInStage false, refMissing false, CREATED에만 싣는 칸(purchaseSessionId·journeyId·contactRef)은 싣지 않는다, eventKey = issueDelayedEventKey.
 * @throws RangeError 항목이 비었음, order.status가 APPROVED가 아님, 시각이 날짜 범위 밖
 */
export function buildIssueDelayedEvent(input: BuildIssueDelayedEventInput): OrderEventMessage {
  const { order, items } = input;
  if (items.length === 0) throw new RangeError('주문 항목이 비었다');
  if (order.status !== 'APPROVED') throw new RangeError(`ISSUE_DELAYED는 APPROVED 주문에만 낸다: ${order.status}`);
  // 칸 차례는 buildOrderEvent(계약 asyncapi OrderEvent)와 같게 둔다(JSON 대역의 바이트가 늘 같은 모양이 되게)
  return {
    eventId: order.eventId,
    orderId: order.id,
    accountId: order.accountId,
    type: 'ISSUE_DELAYED',
    amount: order.amount,
    seatIds: items.map((i) => i.seatId),
    refMissing: false,
    items: items.map((i) => ({ seatId: i.seatId, tierId: i.tierId, sectionId: i.sectionId, price: i.unitPrice })),
    seatAssignment: order.seatAssignment,
    firstInStage: false,
    // 밀리초가 날짜 범위 밖이면 toISOString이 RangeError를 던진다
    occurredAt: new Date(input.occurredAtMs).toISOString(),
    eventKey: issueDelayedEventKey(order.id),
  };
}

/** 발권 시도 지표의 결과 이름표(ticket_issue_attempts_total{result}) */
export const TICKET_ISSUE_ATTEMPT_RESULTS = ['issued', 'retry', 'stopped', 'stale'] as const;
export type TicketIssueAttemptResult = (typeof TICKET_ISSUE_ATTEMPT_RESULTS)[number];

/** 큐 게이지의 상태 이름표(ticket_issue_jobs{state}): pending = next_attempt_at이 있는 행(처음·다시 보낼 행), stopped = 비운 행(멈춘 행) */
export const TICKET_ISSUE_JOB_STATES = ['pending', 'stopped'] as const;
export type TicketIssueJobState = (typeof TICKET_ISSUE_JOB_STATES)[number];

/** 실행기 오류 로그의 단계 이름(TicketIssueLog.runError what) */
export type TicketIssueRunStage = 'claim' | 'issue' | 'complete' | 'retry' | 'stop' | 'release' | 'delayed' | 'overdue' | 'gauges';

/**
 * 큐 행 하나를 돈 결과(실행기 안의 값. 저장소에 쓰는 일은 끝났다).
 * - ISSUED: T18·티켓 ID·큐 행 지우기·Outbox CONFIRMED를 커밋했다(지표 issued)
 * - STALE: 늦게 온 발권 답. 주문이 APPROVED가 아니라(이미 CONFIRMED·보상 등) 상태를 바꾸지 않고 큐 행만 지웠다(지표 stale, 경고 한 줄). current = 지금 상태
 * - RETRY: 다시 보낼 실패로 미뤘다(attempts + 1, last_error = code, next_attempt_at = nextAtMs, 임대 비움. 지표 retry)
 * - STOPPED: 다시 보내지 않을 실패로 멈췄다(attempts + 1, last_error = code, next_attempt_at 비움, 임대 비움. SEV2 오류 로그, 지표 stopped)
 * - SKIPPED: 할 것이 없다. NO_JOB: 행 없음(kick), LEASED: 다른 실행이 임대 중이거나 기한 전·멈춘 행(kick),
 *   NO_SLOT: 파드의 동시 자리(TICKET_ISSUE_CONCURRENCY)가 다 차 있거나 실행기가 멈춘 뒤라 잡지 않았다(kick. 행은 틱이 잡는다, 리뷰 고침 H1),
 *   LEASE_LOST: 부른 뒤 쓰려니 행이 없거나 자기 임대가 아니다(다른 실행이 이어 받았거나 보상이 지웠다. 아무것도 바꾸지 않았다),
 *   RELEASED: 부르기 바로 전에 남은 임대가 TICKET_ISSUE_LEASE_MIN_REMAINING_MS 미만이었거나 실행기가 멈춘 뒤라 부르지 않고 임대를 놓았다
 *   [구현에서 정한 것: 정본·뼈대에 없던 갈래. 다음 틱에 다시 잡힌다. 지표는 세지 않는다]
 * - ERROR: 쓰기(complete·retry·stop)가 일시 오류로 던졌다(purchase DB 연결·시간 초과 등). log.runError 뒤 임대를 그대로 두어 임대가 끝나면 다시 잡힌다
 *   [정함: 정본에 없다. 주문 ID로 멱등이라 다시 불러도 같은 티켓이다]. stage = 던진 쓰기. complete가 다시 해도 같은 오류(isFinalTicketIssueWriteError)면
 *   ERROR가 아니라 BAD_ANSWER로 멈춘 STOPPED다(리뷰 고침 L6)
 */
export type TicketIssueOutcome =
  | { readonly kind: 'ISSUED' }
  | { readonly kind: 'STALE'; readonly current?: OrderStatus }
  | { readonly kind: 'RETRY'; readonly code: TicketIssueFailureCode; readonly nextAtMs: number }
  | { readonly kind: 'STOPPED'; readonly code: TicketIssueFailureCode }
  | { readonly kind: 'SKIPPED'; readonly reason: 'NO_JOB' | 'LEASED' | 'NO_SLOT' | 'LEASE_LOST' | 'RELEASED' }
  | { readonly kind: 'ERROR'; readonly stage: Extract<TicketIssueRunStage, 'complete' | 'retry' | 'stop'> };
