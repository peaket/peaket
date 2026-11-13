// 예매 취소 공제율·환급액 계산(docs/features/payment.md §4.1 '공제율 계산 표준', docs/features/transfer-refund.md §3.1, POL-032, BUILD_ORDER GAT-070).
// 화면 견적·결제사 부분 취소·정산서 환급이 모두 이 함수 하나의 결과를 쓴다(1원도 어긋나지 않게, 추천 적용 2026-10-28, 기술 검토 낮음-095).

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 공연장 현지(한국) 달력일. DST가 없어 UTC+9 고정으로 센다 */
const dateKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** epoch ms → 한국 날짜 키(YYYY-MM-DD) */
export function seoulDateKey(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError(`시각이 유한한 수가 아니다: ${String(ms)}`);
  const parts = dateKeyFormat.formatToParts(new Date(ms));
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const key = `${pick('year')}-${pick('month')}-${pick('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new RangeError(`한국 날짜를 만들지 못했다: ${key}`);
  return key;
}

/** 날짜 키 → UTC 자정 기준 일 번호(날짜끼리 빼기용) */
function utcDayOf(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new RangeError(`날짜 키가 YYYY-MM-DD가 아니다: ${key}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 한국 날짜의 0시(UTC epoch ms). 한국은 UTC+9라 그 날 00:00 KST = 전날 15:00 UTC다 */
function kstDayStartMs(key: string): number {
  return utcDayOf(key) - KST_OFFSET_MS;
}

function addDays(key: string, n: number): string {
  const d = new Date(utcDayOf(key) + n * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 공연일까지 남은 한국 달력일수(공연일 당일이 0, 지난 날은 0으로 자른다) */
export function calendarDaysBefore(eventStartsAtMs: number, nowMs: number): number {
  const diff = Math.round((utcDayOf(seoulDateKey(eventStartsAtMs)) - utcDayOf(seoulDateKey(nowMs))) / DAY_MS);
  return Math.max(0, diff);
}

/** 비영업일(주말·공휴일)을 빼고 센 영업시간. 24시간 이내인지만 보므로 31일을 넘으면 31일로 자른다 */
export function businessHoursBetween(fromMs: number, toMs: number, calendar: BusinessCalendar): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new RangeError('시각이 유한한 수가 아니다');
  if (toMs <= fromMs) return 0;
  if (toMs - fromMs > 31 * DAY_MS) return 31 * 24;
  let hours = 0;
  let key = seoulDateKey(fromMs);
  const endKey = seoulDateKey(toMs);
  for (let i = 0; i < 32; i++) {
    const start = kstDayStartMs(key);
    const end = start + DAY_MS;
    const overlap = Math.max(0, Math.min(toMs, end) - Math.max(fromMs, start));
    if (overlap > 0 && calendar.isBusinessDay(key)) hours += overlap / HOUR_MS;
    if (key === endKey) break;
    key = addDays(key, 1);
  }
  return hours;
}

/** 영업일 달력. 주말은 늘 비영업일이고, 공휴일은 넘긴 날짜 키 집합이다 */
export interface BusinessCalendar {
  isBusinessDay(dateKey: string): boolean;
}

/** 주말 + 넘긴 공휴일을 비영업일로 보는 달력(대한민국 공휴일 파일을 읽어 만든다) */
export class WeekendBusinessCalendar implements BusinessCalendar {
  readonly #holidays: ReadonlySet<string>;

  constructor(holidays: Iterable<string> = []) {
    for (const h of holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) throw new RangeError(`공휴일 날짜가 YYYY-MM-DD가 아니다: ${h}`);
    }
    this.#holidays = new Set(holidays);
  }

  isBusinessDay(dateKey: string): boolean {
    const day = new Date(utcDayOf(dateKey)).getUTCDay();
    return day !== 0 && day !== 6 && !this.#holidays.has(dateKey);
  }
}

/**
 * 공휴일 달력 파일을 읽는다. 파일은 `["2026-01-01", ...]` 또는 `{"holidays": [...]}`다.
 * 출처는 운영자가 공공데이터포털 특일 정보나 은행 영업일 달력에서 받아 갱신하는 파일이다(코드에 날짜를 박지 않는다).
 */
export function parseHolidayCalendar(text: string): WeekendBusinessCalendar {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`공휴일 달력이 JSON이 아니다: ${(e as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.holidays) ? raw.holidays : undefined;
  if (!list) throw new Error('공휴일 달력은 날짜 배열이거나 { holidays: [...] }여야 한다');
  return new WeekendBusinessCalendar(list.map((v) => {
    if (typeof v !== 'string') throw new Error('공휴일 날짜는 문자열이어야 한다');
    return v;
  }));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const ZERO_BP = 0;
export const TEN_PERCENT_BP = 1000;
export const TWENTY_PERCENT_BP = 2000;
export const THIRTY_PERCENT_BP = 3000;
export const NINETY_PERCENT_BP = 9000;

/** 공제율 기준점(1% = 100, 10% = 1000). POL-032 구간 */
export function deductionBpFor(daysBefore: number, within24h: boolean): number {
  if (within24h) return ZERO_BP;
  if (daysBefore >= 10) return ZERO_BP;
  if (daysBefore >= 7) return TEN_PERCENT_BP;
  if (daysBefore >= 3) return TWENTY_PERCENT_BP;
  if (daysBefore >= 1) return THIRTY_PERCENT_BP;
  return NINETY_PERCENT_BP;
}

export interface RefundQuote {
  readonly daysBefore: number;
  readonly within24h: boolean;
  /** 공제율 기준점(1% = 100) */
  readonly deductionBp: number;
  /** 화면에 보여 주는 공제율(0·0.1·0.2·0.3·0.9). 금액 계산에는 쓰지 않는다 */
  readonly deductionRate: number;
  readonly deductionAmount: number;
  readonly refundAmount: number;
  readonly basis: string;
  /** 입장 시작 뒤 취소라 환급을 입장 기록 마감 뒤에 한다 */
  readonly refundAfterEntryClose: boolean;
}

export type RefundQuoteResult =
  | { readonly status: 'OK'; readonly quote: RefundQuote }
  | { readonly status: 'EVENT_STARTED' }
  | { readonly status: 'INVALID_AMOUNT' };

export interface RefundQuoteInput {
  readonly ticketPrice: number;
  readonly eventStartsAtMs: number;
  readonly bookedAtMs: number;
  readonly nowMs: number;
  readonly calendar: BusinessCalendar;
  /** 회차 취소·부정 예매·미성년자 계약 취소처럼 공제하지 않는 사유 */
  readonly zeroDeduction?: boolean;
  readonly zeroDeductionBasis?: string;
  readonly entryOpensAtMs?: number;
}

/**
 * 견적 하나. 공연 시작 전이 아니면 EVENT_STARTED, 금액이 0 이상 정수가 아니면 INVALID_AMOUNT다.
 * `within24h`는 '공연 3일 전까지'이면서 '예매 뒤 영업시간 24시간 이내'일 때만 참이다(POL-032).
 */
export function quoteRefund(i: RefundQuoteInput): RefundQuoteResult {
  if (!Number.isInteger(i.ticketPrice) || i.ticketPrice < 0) return { status: 'INVALID_AMOUNT' };
  if (![i.eventStartsAtMs, i.bookedAtMs, i.nowMs].every(Number.isFinite)) throw new RangeError('시각이 유한한 수가 아니다');
  if (i.nowMs >= i.eventStartsAtMs) return { status: 'EVENT_STARTED' };
  const daysBefore = calendarDaysBefore(i.eventStartsAtMs, i.nowMs);
  const within24h = daysBefore >= 3 && businessHoursBetween(i.bookedAtMs, i.nowMs, i.calendar) <= 24;
  const deductionBp = i.zeroDeduction ? ZERO_BP : deductionBpFor(daysBefore, within24h);
  const basis = i.zeroDeduction
    ? (i.zeroDeductionBasis ?? '공제 없음(회차 취소·부정 예매·미성년자 계약 취소 등)')
    : within24h
      ? '예매 뒤 영업시간 24시간 이내이면서 공연일 3일 전까지'
      : daysBefore >= 10
        ? '공연일 10일 전까지'
        : daysBefore >= 7
          ? '공연일 7~9일 전'
          : daysBefore >= 3
            ? '공연일 3~6일 전'
            : daysBefore >= 1
              ? '공연일 1~2일 전'
              : '공연 당일 시작 전';
  const deductionAmount = Math.floor((i.ticketPrice * deductionBp) / 10_000);
  const refundAmount = i.ticketPrice - deductionAmount;
  return {
    status: 'OK',
    quote: {
      daysBefore,
      within24h,
      deductionBp,
      deductionRate: deductionBp / 10_000,
      deductionAmount,
      refundAmount,
      basis,
      refundAfterEntryClose: i.entryOpensAtMs !== undefined && i.nowMs >= i.entryOpensAtMs,
    },
  };
}
