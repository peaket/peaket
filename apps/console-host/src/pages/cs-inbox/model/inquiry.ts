// SCR-045 문의 스레드·답변 화면 값 해석(F-06-5). 정본 CsCaseDetail.messages를 쓴다.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface InquiryMessageView {
  messageId: string;
  authorKind: string;
  authorDisplay: string;
  kind: string;
  body: string;
  createdAt: string;
}
export interface InquiryThreadView {
  inquiryId: string;
  resultDueAt: string | null;
  messages: InquiryMessageView[];
}

/** 정본 messages만 옮긴다. 담당자 ID·이름·계정은 싣지 않고, 계좌번호 가림은 서버 값을 그대로 둔다 */
export function inquiryThreadOf(raw: unknown): InquiryThreadView | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.messages) && !text(raw.targetRef)) return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter(isRecord).map((m) => ({
        messageId: text(m.messageId),
        authorKind: text(m.authorKind),
        authorDisplay: text(m.authorDisplay),
        kind: text(m.kind),
        body: text(m.body),
        createdAt: text(m.createdAt),
      })).filter((m) => m.messageId !== '')
    : [];
  return { inquiryId: text(raw.targetRef), resultDueAt: typeof raw.resultDueAt === 'string' ? raw.resultDueAt : null, messages };
}

export const replyBodyValid = (i: { kind: string; body: string }): boolean => {
  if (i.kind !== 'ANSWER' && i.kind !== 'PROGRESS') return false;
  const body = i.body.normalize('NFC');
  const n = [...body].length;
  return body.trim() !== '' && n >= 1 && n <= 2_000;
};

export type ReplyErrorKind = 'forbidden' | 'not-inquiry' | 'resolved' | 'closed' | 'invalid' | 'not-found' | 'unavailable' | 'other';
export interface ReplyError {
  kind: ReplyErrorKind;
  retry: boolean;
  text: string;
}
export function replyErrorOf(e: { status?: unknown; type?: unknown } | null | undefined): ReplyError {
  const status = typeof e?.status === 'number' ? e.status : 0;
  const type = typeof e?.type === 'string' ? (e.type.split('/').pop() ?? '') : '';
  if (status === 403) return { kind: 'forbidden', retry: false, text: '답변을 보낼 수 있는 역할이 아닙니다' };
  if (status === 404) return { kind: 'not-found', retry: false, text: '없는 건입니다' };
  if (status === 409 && type === 'case-not-inquiry') return { kind: 'not-inquiry', retry: false, text: '문의가 이어진 건이 아닙니다' };
  if (status === 409 && type === 'case-already-resolved') return { kind: 'resolved', retry: false, text: '이미 해결한 건입니다' };
  if (status === 409 && type === 'inquiry-closed') return { kind: 'closed', retry: false, text: '닫힌 문의입니다. 새 문의로 안내해 주세요' };
  if (status === 409) return { kind: 'other', retry: false, text: '지금 상태에서는 답변할 수 없습니다' };
  if (status === 422) return { kind: 'invalid', retry: false, text: '답변 본문을 확인해 주세요' };
  if (status === 503) return { kind: 'unavailable', retry: true, text: '잠시 답변을 보내지 못했습니다. 다시 시도해 주세요' };
  return { kind: 'other', retry: true, text: '답변을 보내지 못했습니다. 다시 시도해 주세요' };
}

export const inquiryHref = (inquiryId: string): string => `/help/inquiries/${encodeURIComponent(inquiryId)}`;
