// core-svc support 문의 포트(F-06-5). 접수·기록·건 요청을 한 트랜잭션으로 쓰고, 주문 원천·팬 알림은 포트로 둔다.
import type { InquiryCaseRequestRow, InquiryMessageRow, InquiryRow, InquiryStatus } from './inquiry.js';

export interface InquiryStore {
  /** 문의·첫 기록·Outbox를 한 트랜잭션으로 쓴다 */
  create(inquiry: InquiryRow, message: InquiryMessageRow, caseRequest: InquiryCaseRequestRow): Promise<void>;
  find(inquiryId: string): Promise<InquiryRow | undefined>;
  findByRequestKey(accountId: string, requestKey: string): Promise<InquiryRow | undefined>;
  listByAccount(accountId: string, statuses: readonly InquiryStatus[] | undefined, limit: number, offset: number): Promise<InquiryRow[]>;
  countByAccount(accountId: string, statuses: readonly InquiryStatus[] | undefined): Promise<number>;
  countSince(accountId: string, sinceMs: number): Promise<number>;
  /** 그 달(YYMM) 접수 번호 일련번호. 1부터 */
  nextSequence(ym: string): Promise<number>;
  messages(inquiryId: string): Promise<InquiryMessageRow[]>;
  findMessageByRequestKey(inquiryId: string, requestKey: string): Promise<InquiryMessageRow | undefined>;
  /** 추가 문의를 쓰고 상태를 바꾼다. Outbox가 있으면 같은 트랜잭션에 쓴다 */
  addFanMessage(message: InquiryMessageRow, status: InquiryStatus, caseRequest: InquiryCaseRequestRow): Promise<void>;
  /** 담당자 답변·진행 경과를 쓰고 상태·answered_at을 바꾼다 */
  addAgentMessage(message: InquiryMessageRow, status: InquiryStatus, answeredAtMs: number | null): Promise<void>;
  markViewed(inquiryId: string, nowMs: number): Promise<void>;
  setCaseId(inquiryId: string, caseId: string): Promise<boolean>;
  close(inquiryId: string, nowMs: number, purgeAtMs: number): Promise<void>;
  /** 답변 뒤 14일 지난 문의를 닫는다. 닫은 수를 돌려준다 */
  closeIdle(nowMs: number, idleMs: number, purgeYears: number): Promise<number>;
  outboxRows(): Promise<InquiryCaseRequestRow[]>;
}

/** 관련 주문 원천. 확인하지 못하면 던진다(503) */
export interface InquiryOrderDirectory {
  ownerOf(orderRef: string): Promise<string | undefined>;
  summaryOf(orderRef: string): Promise<string | undefined>;
}

export interface InquiryFanNotifier {
  send(i: { inquiryId: string; accountId: string; event: 'ANSWER' | 'PROGRESS' }): Promise<void>;
}
