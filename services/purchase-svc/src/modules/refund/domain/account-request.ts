// 계좌 입력 요청의 첫 발송·재발송 일정(F-07-15 I-02, transfer-refund §11 R-T20 ②, notify §9).
// 첫 요청은 계좌 대기가 된 즉시, 다음은 다음 영업일·그다음 영업일 10:00(KST), 그 뒤 7일마다 10:00이다.
import { createHash } from 'node:crypto';
import type { EventRefundOutboxMessage } from './event-refund-ports.js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_HOURS_MS = 10 * 60 * 60 * 1000;

export interface AccountNoticeCalendar {
  isBusinessDay(dateKey: string): boolean;
}

/** epoch ms → 한국 날짜 키(YYYY-MM-DD). refund-policy의 seoulDateKey와 같은 규칙 */
const seoulDateKey = (ms: number): string => {
  const d = new Date(ms + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const dayStartMs = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) - KST_OFFSET_MS;
};

const addDays = (key: string, n: number): string => {
  const d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) + n * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const nextBusinessDay = (key: string, calendar: AccountNoticeCalendar): string => {
  let cur = addDays(key, 1);
  for (let i = 0; i < 14; i++) {
    if (calendar.isBusinessDay(cur)) return cur;
    cur = addDays(cur, 1);
  }
  throw new RangeError('다음 영업일을 찾지 못했습니다');
};

/**
 * 계좌 요청을 보낼 시각. sentCount는 지금까지 보낸 횟수다.
 * 0: 계좌 대기가 된 즉시, 1: 다음 영업일 10:00, 2: 그다음 영업일 10:00, 3+: 2번째 + 7일 × (n−2).
 */
export function nextAccountNoticeAt(input: { requiredAtMs: number; sentCount: number; calendar: AccountNoticeCalendar }): number {
  if (!Number.isInteger(input.sentCount) || input.sentCount < 0) throw new RangeError('보낸 횟수가 올바르지 않습니다');
  if (input.sentCount === 0) return input.requiredAtMs;
  const requiredKey = seoulDateKey(input.requiredAtMs);
  const first = nextBusinessDay(requiredKey, input.calendar);
  if (input.sentCount === 1) return dayStartMs(first) + TEN_HOURS_MS;
  const second = nextBusinessDay(first, input.calendar);
  return dayStartMs(addDays(second, 7 * (input.sentCount - 2))) + TEN_HOURS_MS;
}

/** 같은 대상·같은 회차의 Outbox 중복 제거 키(sequence마다 다르다) */
export function accountNoticeKey(kind: 'REFUND' | 'COMPENSATION', id: string, sequence: number): string {
  const h = createHash('sha256').update(`account-notice:${kind}:${id}:${sequence}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 계좌 입력 요청 훑기가 읽는 취소·배상 행 */
export interface AccountNoticeRow {
  readonly id: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly requiredAtMs: number;
  readonly sentCount: number;
  readonly nextAtMs?: number;
}

/** 계좌 입력 요청 훑기의 저장소 포트(어댑터가 구현한다) */
export interface AccountNoticeSource {
  listDue(nowMs: number, limit: number): Promise<readonly AccountNoticeRow[]>;
  claim(i: { id: string; expectedCount: number; nextAtMs: number; outbox: EventRefundOutboxMessage; nowMs: number }): Promise<boolean>;
}
