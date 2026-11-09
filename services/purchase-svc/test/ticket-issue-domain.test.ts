// 발권 호출과 재시도 큐의 값과 규칙(booking domain/ticket-issue.ts, docs/features/payment.md §2 '발권 호출과 재시도 큐의 첫 구현', ADR-0106 결정 2, BUILD_ORDER PRF-170).
// - 상수: 1초 반복·50건·임대 30초·동시 8개·데드라인 2초·남은 임대 5초·늘려 쉬기(1초·2배·60초·±20%)·ISSUE_DELAYED 60초·신호 100건·게이지 10초
// - 실패 분류: 다시 보낼 실패(설계 5)와 다시 보내지 않을 실패(설계 6)가 겹치지 않고 모든 코드를 덮는다(CANCELLED·UNKNOWN·CIRCUIT_OPEN은 다시, BAD_ANSWER는 멈춤)
// - 늘려 쉬기: min(1초 × 2^(attempts − 1), 60초), 흔들기 0.8~1.2배를 정수로 내림
// - issuedTicketsMatch: 답의 티켓이 주문 좌석마다 정확히 하나이고 티켓 ID가 비지 않은 소문자 UUID이며 서로 다른지
// - issueDelayedEventKey: UUID 버전 8(SHA-256('OrderEvent:' + 주문 ID + ':ISSUE_DELAYED')의 앞 16바이트), 주문마다 고정
// - buildIssueDelayedEvent: 상태 전이 없는 ISSUE_DELAYED 주문 사건(칸 차례는 buildOrderEvent와 같고 계약 OrderEvent를 통과)
// 기대 eventKey는 시험 안에서 정본 식으로 직접 계산한다(실패 이유가 섞이지 않게, order-domain.test.ts와 같은 방식).
import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import {
  ACTOR_PATTERN,
  buildIssueDelayedEvent,
  type BuildIssueDelayedEventInput,
  buildOrderEvent,
  GRPC_STATUS_NAMES,
  ISSUE_DELAYED_AFTER_MS,
  issueDelayedEventKey,
  type IssuedTicketRef,
  issuedTicketsMatch,
  type OrderItem,
  type OrderRow,
  type OrderStatus,
  ORDER_STATUSES,
  orderEventKey,
  TICKET_ISSUE_ACTOR,
  TICKET_ISSUE_ATTEMPT_RESULTS,
  TICKET_ISSUE_CALL_DEADLINE_MS,
  TICKET_ISSUE_CLAIM_LIMIT,
  TICKET_ISSUE_CONCURRENCY,
  TICKET_ISSUE_CS_CASE,
  TICKET_ISSUE_DELAYED_AFTER_MS,
  TICKET_ISSUE_GAUGE_INTERVAL_MS,
  TICKET_ISSUE_JITTER_RATIO,
  TICKET_ISSUE_JOB_STATES,
  TICKET_ISSUE_LEASE_MIN_REMAINING_MS,
  TICKET_ISSUE_LEASE_MS,
  TICKET_ISSUE_POLL_INTERVAL_MS,
  TICKET_ISSUE_RETRY_BASE_MS,
  TICKET_ISSUE_RETRY_CODES,
  TICKET_ISSUE_RETRY_FACTOR,
  TICKET_ISSUE_RETRY_MAX_MS,
  TICKET_ISSUE_SIGNAL_BATCH,
  TICKET_ISSUE_STOP_CODES,
  ticketIssueBackoffMs,
  type TicketIssueFailureCode,
  ticketIssueFailureKind,
  ticketIssueRetryDelayMs,
  transitionById,
} from '../src/modules/booking/index.js';

/** 회차·주문·계정·좌석(운영 모양: 소문자 UUID) */
const EV = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const ORDER = '0190f3a1-7c2e-7a00-8000-0000000000d1';
const OTHER_ORDER = '0190f3a1-7c2e-7a00-8000-0000000000d2';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000acc01';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-00000000a001';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-00000000a002';
const SEAT_C = '0190f3a1-7c2e-7a00-8000-00000000a003';
/** ticket-svc가 돌려주는 티켓 ID(소문자 UUID) */
const TICKET_A = '0190f3a1-7c2e-7b00-8000-0000000c0001';
const TICKET_B = '0190f3a1-7c2e-7b00-8000-0000000c0002';
const TICKET_C = '0190f3a1-7c2e-7b00-8000-0000000c0003';
const AT = Date.parse('2026-11-05T03:01:00.123Z');

const UUID8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** SHA-256(입력)의 앞 16바이트에 UUID 버전 8·변형 비트를 맞춘 글(정본 식을 시험 안에서 직접 계산한다) */
function uuid8Of(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 설계 5의 다시 보낼 코드(ADR-0106 셋 + 정한 것). CANCELLED는 이쪽이 끊은 호출(파드 멈춤 등)이라 다시 보낸다(뼈대 주석) */
const RETRY_EXPECTED: readonly TicketIssueFailureCode[] = ['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'ABORTED', 'INTERNAL', 'UNKNOWN', 'CANCELLED', 'CIRCUIT_OPEN'];
/** 설계 6의 다시 보내지 않을 코드(ADR-0106 셋 + 정한 것). BAD_ANSWER는 답이 주문 좌석과 맞지 않음 */
const STOP_EXPECTED: readonly TicketIssueFailureCode[] = [
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
];
/** 실패 코드 전부: gRPC 상태 이름(OK 빼고) + CIRCUIT_OPEN + BAD_ANSWER */
const ALL_CODES: readonly TicketIssueFailureCode[] = [...GRPC_STATUS_NAMES.filter((n) => n !== 'OK'), 'CIRCUIT_OPEN', 'BAD_ANSWER'] as TicketIssueFailureCode[];

describe('상수(설계 1~3·7·9의 [가정]·[정함] 값)', () => {
  test('반복 1초·한 번에 50건·임대 30초·파드 동시 8개·데드라인 2초·부르기 전 남은 임대 5초 (ADR0106)', () => {
    expect({
      poll: TICKET_ISSUE_POLL_INTERVAL_MS,
      claim: TICKET_ISSUE_CLAIM_LIMIT,
      lease: TICKET_ISSUE_LEASE_MS,
      concurrency: TICKET_ISSUE_CONCURRENCY,
      deadline: TICKET_ISSUE_CALL_DEADLINE_MS,
      minRemaining: TICKET_ISSUE_LEASE_MIN_REMAINING_MS,
    }).toEqual({ poll: 1000, claim: 50, lease: 30_000, concurrency: 8, deadline: 2000, minRemaining: 5000 });
    // 데드라인 2초 + 성공 반영이 임대 안에 끝나게 남은 임대가 데드라인보다 길다
    expect(TICKET_ISSUE_LEASE_MIN_REMAINING_MS).toBeGreaterThan(TICKET_ISSUE_CALL_DEADLINE_MS);
  });

  test('늘려 쉬기는 1초에서 2배씩, 상한 60초, 흔들기 ±20%이다 (P-T39 ①, ADR0106) [ASVS v5.0.0-16.5.2]', () => {
    expect([TICKET_ISSUE_RETRY_BASE_MS, TICKET_ISSUE_RETRY_FACTOR, TICKET_ISSUE_RETRY_MAX_MS, TICKET_ISSUE_JITTER_RATIO]).toEqual([1000, 2, 60_000, 0.2]);
  });

  test('ISSUE_DELAYED 기준은 long polling issueDelayed와 같은 60초 상수이고, 신호는 한 틱에 100건, 게이지는 10초마다다 (P-T39 ①)', () => {
    expect(TICKET_ISSUE_DELAYED_AFTER_MS).toBe(60_000);
    expect(TICKET_ISSUE_DELAYED_AFTER_MS).toBe(ISSUE_DELAYED_AFTER_MS);
    expect(TICKET_ISSUE_SIGNAL_BATCH).toBe(100);
    expect(TICKET_ISSUE_GAUGE_INTERVAL_MS).toBe(10_000);
  });

  test('행위자는 system:ticket-issue(ACTOR_PATTERN의 system:<작업 이름>)이고 CS 표시는 TICKET_NOT_ISSUED다 (ADR0106)', () => {
    expect(TICKET_ISSUE_ACTOR).toBe('system:ticket-issue');
    expect(TICKET_ISSUE_ACTOR).toMatch(ACTOR_PATTERN);
    expect(TICKET_ISSUE_CS_CASE).toBe('TICKET_NOT_ISSUED');
  });

  test('지표 이름표 값: attempts result는 issued·retry·stopped·stale, jobs state는 pending·stopped다(설계 9)', () => {
    expect([...TICKET_ISSUE_ATTEMPT_RESULTS]).toEqual(['issued', 'retry', 'stopped', 'stale']);
    expect([...TICKET_ISSUE_JOB_STATES]).toEqual(['pending', 'stopped']);
  });

  test('GRPC_STATUS_NAMES의 차례가 곧 grpc-js status 번호다(0 OK … 16 UNAUTHENTICATED)', () => {
    expect(GRPC_STATUS_NAMES).toHaveLength(17);
    GRPC_STATUS_NAMES.forEach((name, i) => expect((grpc.status as unknown as Record<string, number>)[name], name).toBe(i));
  });
});

describe('실패 분류(ticketIssueFailureKind, 설계 5·6)', () => {
  test('다시 보낼 코드 묶음은 UNAVAILABLE·DEADLINE_EXCEEDED·RESOURCE_EXHAUSTED(ADR-0106)와 ABORTED·INTERNAL·UNKNOWN·CANCELLED·CIRCUIT_OPEN이다 (P-T39 ①, ADR0106) [ASVS v5.0.0-16.5.2]', () => {
    expect([...TICKET_ISSUE_RETRY_CODES].sort()).toEqual([...RETRY_EXPECTED].sort());
  });

  test('다시 보내지 않을 코드 묶음은 FAILED_PRECONDITION·INVALID_ARGUMENT·NOT_FOUND(ADR-0106)와 PERMISSION_DENIED·UNAUTHENTICATED·ALREADY_EXISTS·OUT_OF_RANGE·UNIMPLEMENTED·DATA_LOSS·BAD_ANSWER다 (P-T39 ④, ADR0106)', () => {
    expect([...TICKET_ISSUE_STOP_CODES].sort()).toEqual([...STOP_EXPECTED].sort());
  });

  test('두 묶음은 겹치지 않고 모든 실패 코드(gRPC 이름 16개 + CIRCUIT_OPEN + BAD_ANSWER)를 덮는다', () => {
    for (const c of TICKET_ISSUE_RETRY_CODES) expect(TICKET_ISSUE_STOP_CODES.has(c), c).toBe(false);
    expect([...TICKET_ISSUE_RETRY_CODES, ...TICKET_ISSUE_STOP_CODES].sort()).toEqual([...ALL_CODES].sort());
    expect(ALL_CODES).toHaveLength(18);
  });

  test.each(RETRY_EXPECTED)('%s → RETRY(늘려 쉬고 같은 주문 ID로 다시 보낸다, 결제를 취소하지 않는다) (P-T39 ①, ADR0106) [ASVS v5.0.0-16.5.2]', (code) => {
    expect(ticketIssueFailureKind(code)).toBe('RETRY');
  });

  test.each(STOP_EXPECTED)('%s → STOP(자동 재시도를 멈추고 SEV2·CS 표시) (P-T39 ④, ADR0106)', (code) => {
    expect(ticketIssueFailureKind(code)).toBe('STOP');
  });

  test('차단기 열림(CIRCUIT_OPEN)은 부르지 않은 것이라 다시 보내고, 모르는 번호를 접은 UNKNOWN과 이쪽이 끊은 CANCELLED도 다시 보낸다. 좌석과 맞지 않는 답(BAD_ANSWER)은 멈춘다 (ADR0106) [ASVS v5.0.0-16.5.2]', () => {
    expect(['CIRCUIT_OPEN', 'UNKNOWN', 'CANCELLED', 'BAD_ANSWER'].map((c) => ticketIssueFailureKind(c as TicketIssueFailureCode))).toEqual(['RETRY', 'RETRY', 'RETRY', 'STOP']);
  });
});

describe('늘려 쉬기(ticketIssueBackoffMs·ticketIssueRetryDelayMs, 설계 5)', () => {
  test.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 16_000],
    [6, 32_000],
    [7, 60_000],
    [8, 60_000],
    [30, 60_000],
  ])('attempts %i → 흔들기 전 %ims(1·2·4·8·16·32초, 7번째부터 60초 상한) (P-T39 ①, ADR0106)', (attempts, ms) => {
    expect(ticketIssueBackoffMs(attempts)).toBe(ms);
  });

  test('아주 큰 시도 수(1024, 안전한 정수 최댓값)에서도 Infinity·NaN이 아니라 60초다(거듭제곱을 하지 않는다) (ADR0106)', () => {
    for (const a of [1024, 2 ** 40, Number.MAX_SAFE_INTEGER]) expect(ticketIssueBackoffMs(a), String(a)).toBe(60_000);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('attempts %s는 1 이상의 안전한 정수가 아니라 RangeError다', (attempts) => {
    expect(() => ticketIssueBackoffMs(attempts)).toThrow(RangeError);
    expect(() => ticketIssueRetryDelayMs(attempts, 0.5)).toThrow(RangeError);
  });

  test('흔들기 경계: unit 0이면 0.8배(800ms·48초), unit 0.5면 1배(1초·60초), 1 바로 아래면 1.2배 바로 아래(내림)다 (P-T39 ①, ADR0106) [ASVS v5.0.0-16.5.2]', () => {
    expect(ticketIssueRetryDelayMs(1, 0)).toBe(800);
    expect(ticketIssueRetryDelayMs(1, 0.5)).toBe(1000);
    expect(ticketIssueRetryDelayMs(3, 0.25)).toBe(Math.floor(4000 * 0.9));
    expect(ticketIssueRetryDelayMs(7, 0)).toBe(48_000);
    expect(ticketIssueRetryDelayMs(7, 0.5)).toBe(60_000);
    const almostOne = 1 - Number.EPSILON / 2;
    const top1 = ticketIssueRetryDelayMs(1, almostOne);
    expect(top1).toBeGreaterThanOrEqual(1199);
    expect(top1).toBeLessThanOrEqual(1200);
    const top7 = ticketIssueRetryDelayMs(7, almostOne);
    expect(top7).toBeGreaterThanOrEqual(71_999);
    expect(top7).toBeLessThanOrEqual(72_000);
  });

  test('흔들기는 [0, 1)의 어느 unit이든 정수이고 0.8 ~ 1.2배 안이며 unit이 커지면 줄지 않는다(상한 60초도 흔든다)', () => {
    for (const attempts of [1, 2, 5, 6, 7, 50]) {
      const base = ticketIssueBackoffMs(attempts);
      let prev = -1;
      for (let i = 0; i < 100; i++) {
        const unit = i / 100;
        const d = ticketIssueRetryDelayMs(attempts, unit);
        expect(Number.isSafeInteger(d), `${attempts}/${unit}`).toBe(true);
        expect(d, `${attempts}/${unit}`).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
        expect(d, `${attempts}/${unit}`).toBeLessThanOrEqual(base * 1.2);
        expect(d, `${attempts}/${unit}`).toBeGreaterThanOrEqual(prev);
        prev = d;
      }
    }
  });

  test.each([-0.01, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('unit %s는 [0, 1) 밖이거나 수가 아니라 RangeError다', (unit) => {
    expect(() => ticketIssueRetryDelayMs(1, unit)).toThrow(RangeError);
  });
});

describe('issuedTicketsMatch(답의 티켓 묶음 ↔ 주문 좌석)', () => {
  const ticket = (seatId: string, ticketId: string): IssuedTicketRef => ({ seatId, ticketId });
  const SEATS = [SEAT_A, SEAT_B, SEAT_C];
  const OK_TICKETS = [ticket(SEAT_A, TICKET_A), ticket(SEAT_B, TICKET_B), ticket(SEAT_C, TICKET_C)];

  test('좌석마다 티켓이 정확히 하나이고 티켓 ID가 서로 다른 소문자 UUID면 true다. 차례는 보지 않는다 (P-T15)', () => {
    expect(issuedTicketsMatch(SEATS, OK_TICKETS)).toBe(true);
    expect(issuedTicketsMatch(SEATS, [...OK_TICKETS].reverse())).toBe(true);
    expect(issuedTicketsMatch([SEAT_B], [ticket(SEAT_B, TICKET_C)])).toBe(true);
  });

  test.each<[string, readonly IssuedTicketRef[]]>([
    ['좌석 하나가 빠짐', [ticket(SEAT_A, TICKET_A), ticket(SEAT_B, TICKET_B)]],
    ['답이 비었음', []],
    ['주문에 없는 좌석이 남음', [...OK_TICKETS, ticket('0190f3a1-7c2e-7a00-8000-00000000a009', '0190f3a1-7c2e-7b00-8000-0000000c0009')]],
    ['주문에 없는 좌석으로 바뀜(수는 같음)', [ticket(SEAT_A, TICKET_A), ticket(SEAT_B, TICKET_B), ticket('0190f3a1-7c2e-7a00-8000-00000000a009', TICKET_C)]],
    ['같은 좌석 둘(수는 같음)', [ticket(SEAT_A, TICKET_A), ticket(SEAT_A, TICKET_B), ticket(SEAT_C, TICKET_C)]],
    ['같은 티켓 ID 둘', [ticket(SEAT_A, TICKET_A), ticket(SEAT_B, TICKET_A), ticket(SEAT_C, TICKET_C)]],
    ['빈 티켓 ID', [ticket(SEAT_A, TICKET_A), ticket(SEAT_B, ''), ticket(SEAT_C, TICKET_C)]],
    ['대문자 티켓 ID', [ticket(SEAT_A, TICKET_A.toUpperCase()), ticket(SEAT_B, TICKET_B), ticket(SEAT_C, TICKET_C)]],
    ['UUID가 아닌 티켓 ID', [ticket(SEAT_A, 'T-1'), ticket(SEAT_B, TICKET_B), ticket(SEAT_C, TICKET_C)]],
  ])('%s이면 false다(실행기가 BAD_ANSWER로 멈춘다, 이중 발권·빈 티켓을 주문에 적지 않는다) (P-T15)', (_name, tickets) => {
    expect(issuedTicketsMatch(SEATS, tickets)).toBe(false);
  });

  test('리뷰 고침 L8_답의 티켓 상태가 모두 ISSUED·ACTIVE면 true이고, 하나라도 다른 상태(양도 중·취소 요청·환급·폐기·UNSPECIFIED·모르는 값)면 false다. 상태가 없는 티켓(늘 발권 대역 밖의 저장소 입력)은 상태를 보지 않는다 (P-T15)', () => {
    const withStatus = (status: unknown) => [{ ...ticket(SEAT_A, TICKET_A), status: 'ISSUED' }, { ...ticket(SEAT_B, TICKET_B), status: 'ACTIVE' }, { ...ticket(SEAT_C, TICKET_C), status }] as unknown as IssuedTicketRef[];
    for (const ok of ['ISSUED', 'ACTIVE']) expect(issuedTicketsMatch(SEATS, withStatus(ok)), ok).toBe(true);
    for (const bad of ['TRANSFER_PENDING', 'CANCEL_REQUESTED', 'REFUNDED', 'VOIDED', 'UNSPECIFIED', 'TICKET_STATUS_ISSUED', 'issued', '', 1, null]) {
      expect(issuedTicketsMatch(SEATS, withStatus(bad)), String(bad)).toBe(false);
    }
    expect(issuedTicketsMatch(SEATS, OK_TICKETS)).toBe(true);
  });
});

describe('issueDelayedEventKey(ISSUE_DELAYED의 중복 제거 키, 설계 7)', () => {
  test('UUID 버전 8 모양이고 정본 식 SHA-256("OrderEvent:" + 주문 ID + ":ISSUE_DELAYED")의 앞 16바이트와 같다 (P-T39 ①, ADR0106)', () => {
    for (const id of [ORDER, OTHER_ORDER, 'o-1']) {
      const k = issueDelayedEventKey(id);
      expect(k, id).toMatch(UUID8);
      expect(k, id).toBe(uuid8Of(`OrderEvent:${id}:ISSUE_DELAYED`));
    }
  });

  test('같은 주문이면 늘 같은 값(두 파드가 함께 내도 소비자가 한 번만 처리한다)이고, 다른 주문이면 다른 값이며, 그 주문의 이력 번호 키(orderEventKey)와 겹치지 않는다 (P-T15)', () => {
    expect(issueDelayedEventKey(ORDER)).toBe(issueDelayedEventKey(ORDER));
    expect(issueDelayedEventKey(ORDER)).not.toBe(issueDelayedEventKey(OTHER_ORDER));
    const history = Array.from({ length: 30 }, (_, i) => orderEventKey(ORDER, i + 1));
    expect(history).not.toContain(issueDelayedEventKey(ORDER));
  });
});

describe('재발권의 ISSUE_DELAYED 키(BUILD_ORDER HOT-152)', () => {
  test('P-T36 ④_리뷰 고침 L10: 세대가 있으면 키에 세대가 들어가 재발권 지연 알림이 앞 세대의 키로 지워지지 않는다', () => {
    expect(issueDelayedEventKey(ORDER, 5)).toBe(uuid8Of(`OrderEvent:${ORDER}:ISSUE_DELAYED:5`));
    expect(issueDelayedEventKey(ORDER, 5)).not.toBe(issueDelayedEventKey(ORDER, 8));
    expect(issueDelayedEventKey(ORDER, 5)).toBe(issueDelayedEventKey(ORDER, 5));
  });

  test('P-T36 ④_리뷰 고침 L10: 세대가 없거나 0인 옛 행은 지금 키 그대로다', () => {
    expect(issueDelayedEventKey(ORDER, 0)).toBe(issueDelayedEventKey(ORDER));
    expect(issueDelayedEventKey(ORDER)).toBe(uuid8Of(`OrderEvent:${ORDER}:ISSUE_DELAYED`));
  });
});

describe('buildIssueDelayedEvent(상태 전이 없는 ISSUE_DELAYED 주문 사건, 설계 7)', () => {
  /** 승인된 주문 행(이력 번호 5) */
  const approved = (over: Partial<OrderRow> = {}): OrderRow => ({
    id: ORDER,
    accountId: ACCOUNT,
    eventId: EV,
    status: 'APPROVED',
    amount: 154_000,
    eventSeq: 5,
    paymentEventSeq: 3,
    seatAssignment: 'PICK',
    ...over,
  });
  /** 줄 번호 차례(좌석 ID 정렬 차례가 아니게 둔다) */
  const ITEMS: readonly OrderItem[] = [
    { seatId: SEAT_B, tierId: '일반석-R', sectionId: 'sec-b', unitPrice: 99_000 },
    { seatId: SEAT_A, tierId: 'tier-s', sectionId: 'sec-a', unitPrice: 55_000 },
  ];
  const input = (over: Partial<BuildIssueDelayedEventInput> = {}): BuildIssueDelayedEventInput => ({ order: approved(), items: ITEMS, occurredAtMs: AT, ...over });

  test('주문 행·항목을 싣고 type ISSUE_DELAYED, firstInStage false, refMissing false, occurredAt ISO 8601(UTC, 밀리초), eventKey는 주문마다 고정 키다. CREATED 칸은 없다 (P-T39 ①, ADR0106) [ASVS v5.0.0-2.2.1]', () => {
    const m = buildIssueDelayedEvent(input());
    expect(m).toEqual({
      eventId: EV,
      orderId: ORDER,
      accountId: ACCOUNT,
      type: 'ISSUE_DELAYED',
      amount: 154_000,
      seatIds: [SEAT_B, SEAT_A],
      refMissing: false,
      items: [
        { seatId: SEAT_B, tierId: '일반석-R', sectionId: 'sec-b', price: 99_000 },
        { seatId: SEAT_A, tierId: 'tier-s', sectionId: 'sec-a', price: 55_000 },
      ],
      seatAssignment: 'PICK',
      firstInStage: false,
      occurredAt: '2026-11-05T03:01:00.123Z',
      eventKey: uuid8Of(`OrderEvent:${ORDER}:ISSUE_DELAYED`),
    });
    for (const k of ['purchaseSessionId', 'journeyId', 'contactRef']) expect(Object.keys(m), k).not.toContain(k);
  });

  test('칸 차례가 buildOrderEvent(T18 CONFIRMED 사건)와 같고(JSON 대역 바이트 모양이 같게), 계약 OrderEvent를 통과한다 [ASVS v5.0.0-2.2.1]', () => {
    const m = buildIssueDelayedEvent(input());
    const t18 = buildOrderEvent({ order: approved({ status: 'CONFIRMED' }), items: ITEMS, transition: transitionById('T18')!, seq: 6, occurredAtMs: AT, reachedBefore: false })!;
    expect(Object.keys(m)).toEqual(Object.keys(t18));
    expect(OrderEvent.safeParse(JSON.parse(JSON.stringify(m))).success).toBe(true);
  });

  test('eventKey는 주문 행의 이력 번호와 무관하게 같고(다시 내도 같은 키), 좌석 고르기 방식은 주문 행 그대로다(AUTO) (P-T15)', () => {
    const a = buildIssueDelayedEvent(input());
    const b = buildIssueDelayedEvent(input({ order: approved({ eventSeq: 9, seatAssignment: 'AUTO' }), occurredAtMs: AT + 5_000 }));
    expect(b.eventKey).toBe(a.eventKey);
    expect(b.eventKey).toBe(issueDelayedEventKey(ORDER));
    expect(b.seatAssignment).toBe('AUTO');
  });

  test('항목이 비었으면 RangeError다', () => {
    expect(() => buildIssueDelayedEvent(input({ items: [] }))).toThrow(RangeError);
  });

  test.each(ORDER_STATUSES.filter((s: OrderStatus) => s !== 'APPROVED'))('주문이 %s(APPROVED가 아님)면 RangeError다(발권이 끝났거나 보상으로 간 주문에 내지 않는다) [ASVS v5.0.0-2.3.1]', (status) => {
    expect(() => buildIssueDelayedEvent(input({ order: approved({ status }) }))).toThrow(RangeError);
  });

  test.each([8.64e15 + 1, Number.NaN])('사건 시각 %s가 날짜 범위 밖이면 RangeError다', (occurredAtMs) => {
    expect(() => buildIssueDelayedEvent(input({ occurredAtMs }))).toThrow(RangeError);
  });
});
