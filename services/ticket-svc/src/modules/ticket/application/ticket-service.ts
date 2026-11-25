// 티켓 발권·취소·월렛 목록 유스케이스(BUILD_ORDER HOT-160, docs/features/payment.md §2·§4.1).
// 저장소가 멱등·행 잠금을 맡고, 여기서는 입력 검사·티켓 키/QR 만들기·목록 커서만 다룬다.
import { uuidv7, type Clock } from '@peaket/platform';
import type { TicketStore } from '../domain/ports.js';
import {
  type BlockTicketIssuanceInput,
  type BlockTicketIssuanceResult,
  type CancelTicketOutcome,
  type CancelTicketsInput,
  type EntryRecord,
  type EventCancelInput,
  type EventCancelOutcome,
  HELD_TICKET_STATUSES,
  type HeldTicket,
  type IssueTicketsInput,
  type IssueTicketsResult,
  issueFingerprint,
  type ListHeldTicketsInput,
  type ListTicketsInput,
  type ListTicketsResult,
  type OperatorCancelInput,
  type OperatorCancelOutcome,
  newTicketKey,
  normalizeBlockIssueInput,
  normalizeCancelInput,
  normalizeEntryRecordsInput,
  normalizeEventCancelInput,
  normalizeIssueInput,
  normalizeListHeldTicketsInput,
  normalizeListInput,
  normalizeOperatorCancelInput,
  normalizeReviewEligibilityInput,
  qrPayloadOf,
  type ReviewEligibilityInput,
  type ReviewEligibilityResult,
  reviewEligibilityOf,
  type TicketRecord,
  ticketKeyHash,
} from '../domain/ticket.js';

export interface TicketServiceDeps {
  readonly store: TicketStore;
  readonly clock: Clock;
}

export class TicketService {
  constructor(private readonly deps: TicketServiceDeps) {}

  /** 주문 ID·발권 세대 단위 멱등 발권. 새 발권에만 ticketKey를 싣는다. */
  async issue(input: IssueTicketsInput): Promise<IssueTicketsResult> {
    const n = normalizeIssueInput(input);
    const fingerprint = issueFingerprint(n);
    const now = this.deps.clock.now();
    const candidates: TicketRecord[] = n.seatIds.map((seatId, index) => {
      const ticketId = uuidv7(this.deps.clock);
      const ticketKey = newTicketKey();
      return {
        ticketId,
        accountId: n.payerAccountId,
        payerAccountId: n.payerAccountId,
        orderId: n.orderId,
        eventId: n.eventId,
        seatId,
        ...(n.seatLabels?.[index] !== undefined ? { seatLabel: n.seatLabels[index] } : {}),
        gateZone: '',
        status: 'ISSUED',
        issueGeneration: n.issueGeneration,
        qrPayload: qrPayloadOf(ticketId),
        keyHash: ticketKeyHash(ticketKey),
        ticketKey,
        transferPending: false,
        version: 0,
        issuedAtMs: now,
        ...(n.eventStartsAtMs === undefined ? {} : { eventStartsAtMs: n.eventStartsAtMs }),
      };
    });
    // 저장소가 같은 주문·세대의 경합을 하나로 모은다. 지문은 저장소가 비교한다.
    return this.deps.store.issue({ ...n, fingerprint, nowMs: now }, candidates);
  }

  /** 요청자=결제자=보유자, 양도 요청 없음, 입장 전/후를 저장소 행 잠금 안에서 본다. */
  async cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]> {
    return this.deps.store.cancel(normalizeCancelInput(input));
  }

  /**
   * 주문 단위 발권 막기(BAT-011, ticket.proto BlockTicketIssuance). 입력을 정규화한 뒤 저장소가 guard 행·티켓 행 잠금 안에서
   * 이미 만든 티켓을 VOIDED로 바꾸고 입장 기록 수를 센다. 주문 ID로 멱등하다. @throws TicketInputError 소문자 UUID가 아님
   */
  async blockIssue(input: BlockTicketIssuanceInput): Promise<BlockTicketIssuanceResult> {
    const n = normalizeBlockIssueInput({ ...input, nowMs: input.nowMs ?? this.deps.clock.now() });
    return this.deps.store.blockIssue(n);
  }

  /** 부정 예매 운영자 취소(BAT-415 몫 F): 입력 검사 뒤 저장소가 행 잠금 안에서 표마다 가른다. @throws TicketInputError */
  async operatorCancel(input: OperatorCancelInput): Promise<readonly OperatorCancelOutcome[]> {
    return this.deps.store.operatorCancel(normalizeOperatorCancelInput(input));
  }

  /**
   * 회차 취소 표 끝내기(BAT-420 GAT-110 E, R-T24). 결제자·보유자·양도·입장·공연 시작은 보지 않고, 환급·무효인 표는 그대로 둔다.
   * (cancellation_id, ticket_id)로 멱등하다. 없는 표·다른 회차 표가 하나라도 있으면 아무것도 바꾸지 않는다. @throws TicketInputError
   */
  async eventCancel(input: EventCancelInput): Promise<readonly EventCancelOutcome[]> {
    return this.deps.store.eventCancel(normalizeEventCancelInput(input));
  }

  /** 입장 기록 대조(BAT-420 GAT-090 A, P-T19). 들어감·통과 스캔만 입장이고 읽기만 한다. 요청 차례. @throws TicketInputError */
  async entryRecords(ticketIds: readonly string[]): Promise<readonly EntryRecord[]> {
    return this.deps.store.entryRecords(normalizeEntryRecordsInput(ticketIds));
  }

  /** 계정의 월렛 목록(최신 발권순). */
  async list(input: ListTicketsInput): Promise<ListTicketsResult> {
    return this.deps.store.list(normalizeListInput(input));
  }

  /** 후기 작성 자격(FR-016, BAT-585). 종료 시각·결제자·유효 티켓을 ticket 데이터로 본다. */
  async reviewEligibility(input: ReviewEligibilityInput): Promise<ReviewEligibilityResult> {
    const n = normalizeReviewEligibilityInput(input);
    const tickets = await this.deps.store.listReviewEligibility(n.eventId);
    return reviewEligibilityOf(tickets, n);
  }

  /** 보유 티켓 확인(ListHeldTickets, ADR-0301 결정 1): 그 계정이 지금 가진 그 회차의 ISSUED·ACTIVE 티켓. 읽기만. @throws TicketInputError 소문자 UUID가 아님 */
  async heldTickets(input: ListHeldTicketsInput): Promise<readonly HeldTicket[]> {
    const n = normalizeListHeldTicketsInput(input);
    return this.deps.store.listHeld(n.accountId, n.eventId, HELD_TICKET_STATUSES);
  }
}
