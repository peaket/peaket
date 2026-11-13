// 결제 확정 뒤 발권 호출의 경계(BUILD_ORDER HOT-160, BAT-050, docs/features/payment.md §2 '발권 출력과 재시도').
// 실제 Saga 연결은 후속이다. purchase-svc가 이 포트를 호출하고, 재시도 분류는 이 값으로 정한다.
import * as grpc from '@grpc/grpc-js';

export interface TicketIssueRequest {
  readonly orderId: string;
  readonly eventId: string;
  readonly payerAccountId: string;
  readonly seatIds: readonly string[];
  readonly issueGeneration: number;
  readonly eventStartsAtMs?: number;
}

export interface IssuedTicketRef {
  readonly ticketId: string;
  readonly seatId: string;
  readonly status: 'ISSUED' | 'ACTIVE';
}

/** UNAVAILABLE·DEADLINE_EXCEEDED·RESOURCE_EXHAUSTED만 다시 보낸다(ADR-0106). 나머지는 사람이 본다. */
export type TicketIssueFailure = 'unavailable' | 'deadline' | 'resource_exhausted' | 'rejected' | 'unknown';

export type TicketIssueResult = { readonly kind: 'issued'; readonly tickets: readonly IssuedTicketRef[] } | { readonly kind: 'failed'; readonly failure: TicketIssueFailure; readonly code?: number; readonly message?: string };

export interface TicketIssuer {
  /** 데드라인 2초 [가정](docs/architecture.md §5). budget이 있으면 남은 시간 안으로 줄인다. */
  issue(i: TicketIssueRequest, budget?: { readonly remainingMs: number }): Promise<TicketIssueResult>;
}

/** gRPC 코드 → 재시도 분류. 모르는 코드는 unknown으로 두어 자동 재시도를 막는다. */
export function ticketIssueFailureOf(code: number): TicketIssueFailure {
  switch (code) {
    case grpc.status.UNAVAILABLE:
      return 'unavailable';
    case grpc.status.DEADLINE_EXCEEDED:
      return 'deadline';
    case grpc.status.RESOURCE_EXHAUSTED:
      return 'resource_exhausted';
    case grpc.status.FAILED_PRECONDITION:
    case grpc.status.INVALID_ARGUMENT:
    case grpc.status.NOT_FOUND:
    case grpc.status.ALREADY_EXISTS:
    case grpc.status.PERMISSION_DENIED:
      return 'rejected';
    default:
      return 'unknown';
  }
}
