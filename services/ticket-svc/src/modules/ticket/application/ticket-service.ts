// 티켓 발권·취소·월렛 목록 유스케이스(BUILD_ORDER HOT-160, docs/features/payment.md §2·§4.1).
// 저장소가 멱등·행 잠금을 맡고, 여기서는 입력 검사·티켓 키/QR 만들기·목록 커서만 다룬다.
import { uuidv7, type Clock } from '@peaket/platform';
import type { TicketStore } from '../domain/ports.js';
import {
  type CancelTicketOutcome,
  type CancelTicketsInput,
  type IssueTicketsInput,
  type IssueTicketsResult,
  issueFingerprint,
  type ListTicketsInput,
  type ListTicketsResult,
  newTicketKey,
  normalizeCancelInput,
  normalizeIssueInput,
  normalizeListInput,
  qrPayloadOf,
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
    const candidates: TicketRecord[] = n.seatIds.map((seatId) => {
      const ticketId = uuidv7(this.deps.clock);
      const ticketKey = newTicketKey();
      return {
        ticketId,
        accountId: n.payerAccountId,
        payerAccountId: n.payerAccountId,
        orderId: n.orderId,
        eventId: n.eventId,
        seatId,
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
    return this.deps.store.issue({ ...n, fingerprint }, candidates);
  }

  /** 요청자=결제자=보유자, 양도 요청 없음, 입장 전/후를 저장소 행 잠금 안에서 본다. */
  async cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]> {
    return this.deps.store.cancel(normalizeCancelInput(input));
  }

  /** 계정의 월렛 목록(최신 발권순). */
  async list(input: ListTicketsInput): Promise<ListTicketsResult> {
    return this.deps.store.list(normalizeListInput(input));
  }
}
