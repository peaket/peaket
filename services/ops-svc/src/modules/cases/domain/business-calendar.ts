// CS 처리함 영업일 달력(F-06-2 GAT-280, ADR-0364 결정 1, docs/features/transfer-refund.md §7.1 '첫 구현'·§12 '영업일 달력').
// 날짜는 한국 표준시(KST, 서머타임 없음)로 센다. 토·일과 공휴일 파일의 날짜가 비영업일이다. 코드에 날짜를 박지 않는다.
// 공휴일 파일은 purchase-svc와 같은 꼴·같은 환경 값(PEAKET_HOLIDAY_CALENDAR_FILE, `["2026-01-01", …]` 또는 `{ "holidays": [...] }`)이다.
// 'N영업일 뒤'는 시작 시각의 KST 같은 시각에서 영업일을 N번 넘긴 날의 같은 시각이다. 시작한 날이 비영업일이어도 그날은 세지 않는다.
// '1영업일 전'은 기한에서 영업일 하나를 뺀 같은 시각이다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 영업일 하나를 찾느라 넘기는 날의 상한(설·추석 연휴와 대체 공휴일을 넉넉히 넘는다). 넘기면 달력 파일이 잘못된 것이다 */
const MAX_SKIP_DAYS = 60;
/** 공휴일 파일 없이 시작하지 않는 환경(ADR-0364 결정 1) */
const CALENDAR_REQUIRED_ENVS: readonly string[] = ['staging', 'prod'];

export interface BusinessCalendar {
  isBusinessDay(kstDate: string): boolean;
}

/** KST 날짜('YYYY-MM-DD') */
export function kstDateOf(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError('시각이 유한한 수가 아니다');
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 있는 날짜인 'YYYY-MM-DD'인가(2026-02-30 같은 값은 아니다) */
function isDateKey(v: string): boolean {
  const m = DATE_KEY.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

/** 주말 + 넘긴 공휴일을 비영업일로 보는 달력 */
export class WeekendHolidayCalendar implements BusinessCalendar {
  readonly #holidays: ReadonlySet<string>;

  constructor(holidays: Iterable<string> = []) {
    const list = [...holidays];
    for (const h of list) {
      if (!isDateKey(h)) throw new RangeError(`공휴일 날짜가 YYYY-MM-DD가 아니다: ${h}`);
    }
    this.#holidays = new Set(list);
  }

  /** 넘긴 공휴일 수(시작 로그용) */
  get holidayCount(): number {
    return this.#holidays.size;
  }

  isBusinessDay(kstDate: string): boolean {
    const m = DATE_KEY.exec(kstDate);
    if (!m) throw new RangeError(`날짜가 YYYY-MM-DD가 아니다: ${kstDate}`);
    const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
    return day !== 0 && day !== 6 && !this.#holidays.has(kstDate);
  }
}

/** 공휴일 파일이 없을 때(local·ci)의 달력: 주말만 뺀다 */
export const weekendOnlyCalendar: BusinessCalendar = new WeekendHolidayCalendar();

function stepBusinessDays(cal: BusinessCalendar, ms: number, n: number, dir: 1 | -1): number {
  if (!Number.isFinite(ms)) throw new RangeError('시각이 유한한 수가 아니다');
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('영업일 수는 0 이상의 정수다');
  let t = ms;
  for (let counted = 0; counted < n; counted++) {
    let skipped = 0;
    do {
      t += dir * DAY_MS;
      if (++skipped > MAX_SKIP_DAYS) throw new RangeError(`${MAX_SKIP_DAYS}일 동안 영업일이 없다(공휴일 달력을 확인한다)`);
    } while (!cal.isBusinessDay(kstDateOf(t)));
  }
  return t;
}

/** ms에서 n영업일 뒤의 같은 KST 시각. n = 0이면 그대로 */
export function addBusinessDays(cal: BusinessCalendar, ms: number, n: number): number {
  return stepBusinessDays(cal, ms, n, 1);
}

/** ms에서 n영업일 전의 같은 KST 시각('1영업일 전' 알림 시각) */
export function subtractBusinessDays(cal: BusinessCalendar, ms: number, n: number): number {
  return stepBusinessDays(cal, ms, n, -1);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 공휴일 달력 파일 글을 읽는다. `["2026-01-01", ...]` 또는 `{"holidays": [...]}`이고, 틀리면 던진다 */
export function parseHolidayCalendar(text: string): WeekendHolidayCalendar {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`공휴일 달력이 JSON이 아니다: ${(e as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.holidays) ? raw.holidays : undefined;
  if (!list) throw new Error('공휴일 달력은 날짜 배열이거나 { holidays: [...] }여야 한다');
  return new WeekendHolidayCalendar(
    list.map((v) => {
      if (typeof v !== 'string') throw new Error('공휴일 날짜는 문자열이어야 한다');
      return v;
    }),
  );
}

/**
 * 시작 때 달력을 고른다(ADR-0364 결정 1). 파일이 있으면 읽고, 읽지 못하거나 꼴이 틀리면 어느 환경이든 던진다(시작하지 않는다).
 * 파일이 없으면 staging·prod는 던지고, 그 밖(local·ci 등)은 주말만 빼는 달력이다.
 */
export function loadBusinessCalendar(env: { PEAKET_ENV?: string | undefined; PEAKET_HOLIDAY_CALENDAR_FILE?: string | undefined }, read: (path: string) => string): BusinessCalendar & { readonly fromFile: boolean } {
  const file = env.PEAKET_HOLIDAY_CALENDAR_FILE?.trim();
  if (file) {
    let text: string;
    try {
      text = read(file);
    } catch (e) {
      throw new Error(`PEAKET_HOLIDAY_CALENDAR_FILE을 읽지 못했다: ${e instanceof Error ? e.message : String(e)}`);
    }
    const cal = parseHolidayCalendar(text);
    return Object.assign(cal, { fromFile: true as const });
  }
  const peaketEnv = env.PEAKET_ENV?.trim() ?? '';
  if (CALENDAR_REQUIRED_ENVS.includes(peaketEnv)) {
    throw new Error(`PEAKET_HOLIDAY_CALENDAR_FILE이 없다(PEAKET_ENV=${peaketEnv}에서는 공휴일 달력 파일이 있어야 CS 처리함 기한을 센다)`);
  }
  return Object.assign(new WeekendHolidayCalendar(), { fromFile: false as const });
}
