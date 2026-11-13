// 티켓 저장소 포트(BUILD_ORDER HOT-160). 메모리 구현은 단위 시험, Drizzle 구현은 운영 DB가 쓴다.
import type { CancelTicketOutcome, CancelTicketsInput, IssueTicketsInput, IssueTicketsResult, ListTicketsInput, ListTicketsResult, TicketRecord } from './ticket.js';

/** 발권 저장 입력: 앱이 만든 멱등 지문을 함께 넘긴다. */
export interface IssueStoreInput extends IssueTicketsInput {
  readonly fingerprint: string;
}

export interface TicketStore {
  /**
   * 주문·세대 단위로 한 번만 발권한다. 같은 주문·세대의 재요청이면 처음 티켓을 그대로 돌려주고 replayed=true다.
   * 같은 주문·세대에 다른 내용(지문)이면 TicketConflictError다.
   * @param candidates 새로 만들 때 저장할 티켓(키 원문 포함)
   */
  issue(input: IssueStoreInput, candidates: readonly TicketRecord[]): Promise<IssueTicketsResult>;

  /** 티켓마다 행 잠금 안에서 조건을 보고 취소한다. cancellation_id·ticket_id 단위로 멱등하다. */
  cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]>;

  /** 계정의 월렛 목록. 발권 최신순, 커서 페이지. */
  list(input: ListTicketsInput): Promise<ListTicketsResult>;
}
