// ops-svc CS 문의 연결 포트(F-06-5). core SupportCaseService가 주는 기록의 모양.
export interface SupportCaseMessage {
  readonly messageId: string;
  readonly authorKind: string;
  readonly kind: string;
  readonly body: string;
  readonly createdAtMs: number;
}
export interface SupportCaseRecord {
  readonly inquiryId: string;
  readonly accountId: string;
  readonly status: string;
  readonly messages: SupportCaseMessage[];
}
export interface SupportCaseReplyPort {
  reply(i: { requestId: string; inquiryId: string; kind: 'ANSWER' | 'PROGRESS'; body: string; actedBy: string }): Promise<{ result: 'RECORDED' | 'INQUIRY_CLOSED'; message?: SupportCaseMessage; status: string }>;
  close(i: { requestId: string; inquiryId: string; actedBy: string }): Promise<{ status: string; closedAtMs: number | null }>;
  read(inquiryId: string, actedBy: string): Promise<SupportCaseRecord | undefined>;
}
