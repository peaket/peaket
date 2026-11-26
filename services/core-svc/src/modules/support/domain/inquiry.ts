// core-svc 고객 문의 도메인(F-06-5, docs/features/transfer-refund.md §7.1, docs/data.md inquiry·inquiry_message).
// 유형 12·상태 4·길이·NFC·제어 문자·접수 번호·영업일 기한. 저장값은 계좌번호를 바꾸지 않는다.
export const INQUIRY_CATEGORIES = [
  'BOOKING_PAYMENT',
  'CANCEL_REFUND',
  'TRANSFER',
  'ENTRY',
  'ACCOUNT',
  'AUTOMATED_DECISION',
  'SELLER_DISPUTE',
  'MINOR_CONTRACT_CANCEL',
  'MERCH',
  'MODERATION_APPEAL',
  'RESALE_POST_REPORT',
  'OTHER',
] as const;
export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number];
export const isInquiryCategory = (v: string): v is InquiryCategory => (INQUIRY_CATEGORIES as readonly string[]).includes(v);

export const INQUIRY_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'ANSWERED', 'CLOSED'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
export const isInquiryStatus = (v: string): v is InquiryStatus => (INQUIRY_STATUSES as readonly string[]).includes(v);

export const INQUIRY_AUTHOR_KINDS = ['FAN', 'AGENT', 'SYSTEM'] as const;
export type InquiryAuthorKind = (typeof INQUIRY_AUTHOR_KINDS)[number];
export const INQUIRY_MESSAGE_KINDS = ['MESSAGE', 'PROGRESS', 'ANSWER'] as const;
export type InquiryMessageKind = (typeof INQUIRY_MESSAGE_KINDS)[number];

export const TITLE_MIN = 5;
export const TITLE_MAX = 50;
export const BODY_MIN = 10;
export const BODY_MAX = 2_000;
export const REPLY_MIN = 1;
export const REPLY_MAX = 2_000;
export const DAILY_LIMIT = 10;
export const CLOSE_IDLE_MS = 14 * 86_400_000;
export const PURGE_YEARS = 3;

/** 영업일을 세는 공휴일(KST 'YYYY-MM-DD') */
export type Holidays = ReadonlySet<string>;

export const normalizeText = (v: string): string => v.normalize('NFC');
/** C0/C1 제어 문자와 양방향 제어 문자를 지운다. 줄바꿈·탭은 남긴다 */
export const stripControl = (v: string): string =>
  v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');

const SEGMENTER = new Intl.Segmenter('ko', { granularity: 'grapheme' });
export const graphemeLength = (v: string): number => [...SEGMENTER.segment(v)].length;

export const cleanTitle = (v: string): string => stripControl(normalizeText(v)).trim();
export const cleanBody = (v: string): string => stripControl(normalizeText(v));

const KST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
export const kstDate = (ms: number): string => KST_DATE.format(new Date(ms));
export const kstYm = (ms: number): string => kstDate(ms).slice(2, 7).replace('-', '');

const weekdayOf = (ms: number): number => {
  const [y, m, d] = kstDate(ms).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

export const isBusinessDay = (ms: number, holidays: Holidays): boolean => {
  const day = weekdayOf(ms);
  return day !== 0 && day !== 6 && !holidays.has(kstDate(ms));
};

/** 시작 시각의 같은 KST 시각에서 영업일 N번 뒤. 토·일·공휴일을 뺀다 */
export function addBusinessDays(startMs: number, days: number, holidays: Holidays): number {
  let left = days;
  let ms = startMs;
  while (left > 0) {
    ms += 86_400_000;
    if (isBusinessDay(ms, holidays)) left -= 1;
  }
  return ms;
}

export function addYears(ms: number, years: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** 문의 유형 → CS 건 종류. 분쟁은 DISPUTE, 미성년자 계약 취소는 같은 이름, 그 밖은 INQUIRY */
export function caseKindOf(category: InquiryCategory): 'INQUIRY' | 'DISPUTE' | 'MINOR_CONTRACT_CANCEL' {
  if (category === 'SELLER_DISPUTE') return 'DISPUTE';
  if (category === 'MINOR_CONTRACT_CANCEL') return 'MINOR_CONTRACT_CANCEL';
  return 'INQUIRY';
}

/** 결과·진행 기한(영업일). 분쟁은 진행 3·결과 10, 나머지는 결과 3 */
export function dueOf(category: InquiryCategory, startMs: number, holidays: Holidays): { progressDueAtMs: number | null; resultDueAtMs: number } {
  if (category === 'SELLER_DISPUTE') return { progressDueAtMs: addBusinessDays(startMs, 3, holidays), resultDueAtMs: addBusinessDays(startMs, 10, holidays) };
  return { progressDueAtMs: null, resultDueAtMs: addBusinessDays(startMs, 3, holidays) };
}

export const inquiryNumber = (ms: number, seq: number): string => `Q-${kstYm(ms)}-${String(seq).padStart(4, '0')}`;

export interface InquiryRow {
  readonly inquiryId: string;
  readonly number: string;
  readonly accountId: string;
  readonly category: InquiryCategory;
  readonly orderRef: string | null;
  readonly orderSummary: string | null;
  readonly title: string;
  readonly body: string;
  readonly status: InquiryStatus;
  readonly caseId: string | null;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly createdAtMs: number;
  readonly answeredAtMs: number | null;
  readonly fanViewedAtMs: number | null;
  readonly closedAtMs: number | null;
  readonly purgeAtMs: number | null;
  readonly progressDueAtMs: number | null;
  readonly resultDueAtMs: number;
}

export interface InquiryMessageRow {
  readonly messageId: string;
  readonly inquiryId: string;
  readonly authorKind: InquiryAuthorKind;
  readonly kind: InquiryMessageKind;
  readonly body: string;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly createdAtMs: number;
}

/** support.cases-requested(문의·추가 문의) */
export interface InquiryCaseRequestRow {
  readonly eventKey: string;
  readonly kind: 'INQUIRY' | 'DISPUTE' | 'MINOR_CONTRACT_CANCEL';
  readonly sourceId: string;
  readonly category: string;
  readonly followUp?: true;
  readonly createdAt: string;
}
