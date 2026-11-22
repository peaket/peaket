// 사람이 일하는 기한의 영업일 달력(docs/features/settlement.md §4.2 '이의 기한', ADR-0368 결정 4).
// 한국 시각(KST) 날짜로 주말과 공휴일을 빼고 센다. 이의 기한(2영업일)·다시 알림(1영업일)·상품 정산서의 '주의 첫 영업일'이 쓴다.
// 지급일(은행 영업일, settlement §5.1)은 이 달력을 쓰지 않는다(settlement.ts addBusinessDays).
// 공휴일은 purchase-svc와 같은 파일(PEAKET_HOLIDAY_CALENDAR_FILE, `["2026-01-01", …]` 또는 `{ "holidays": [...] }`)을 읽는다. 없으면 주말만 뺀다 [가정].

const DAY_MS = 24 * 60 * 60 * 1_000;
/** KST는 일광 절약 시간이 없어 늘 UTC+9다 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** 그 시각의 KST 날짜(YYYY-MM-DD) */
export const kstDateKey = (at: Date): string => new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

/** KST 날짜 키가 영업일인가(주말·공휴일이 아님) */
export function isKstBusinessDay(dateKey: string, holidays: ReadonlySet<string>): boolean {
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(dateKey);
}

/**
 * 그 시각에서 KST 영업일 n일 뒤 같은 시각(벽시계 시각 그대로). 시작한 날이 영업일인지는 보지 않고, 다음 날부터 영업일만 센다.
 * 예: 금 06:00 KST + 2 = 화 06:00 KST, 그 월이 공휴일이면 수 06:00 KST, 토 08:00 KST + 1 = 월 08:00 KST.
 */
export function addBusinessDays(at: Date, n: number, holidays: ReadonlySet<string> = new Set()): Date {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('영업일 수는 0 이상의 정수다');
  let local = at.getTime() + KST_OFFSET_MS;
  let left = n;
  // 공휴일이 이어져도 끝나도록 한 해(366일)를 넘겨 세지 않는다
  for (let guard = 0; left > 0 && guard < 366 + n * 7; guard += 1) {
    local += DAY_MS;
    if (isKstBusinessDay(new Date(local).toISOString().slice(0, 10), holidays)) left -= 1;
  }
  if (left > 0) throw new RangeError('영업일을 셀 수 없다(공휴일 파일을 확인한다)');
  return new Date(local - KST_OFFSET_MS);
}

/** 그 시각이 든 KST 주(월~일)의 월요일 날짜 키 */
export function kstWeekMonday(at: Date): string {
  const local = new Date(at.getTime() + KST_OFFSET_MS);
  const weekday = local.getUTCDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - back * DAY_MS).toISOString().slice(0, 10);
}

/** 그 시각의 KST 날짜가 그 주(월~일)의 첫 영업일인가. 월요일이 공휴일이면 화요일이 첫 영업일이다 */
export function isFirstBusinessDayOfKstWeek(at: Date, holidays: ReadonlySet<string>): boolean {
  const today = kstDateKey(at);
  if (!isKstBusinessDay(today, holidays)) return false;
  for (let day = Date.parse(`${kstWeekMonday(at)}T00:00:00Z`); ; day += DAY_MS) {
    const key = new Date(day).toISOString().slice(0, 10);
    if (key === today) return true;
    if (isKstBusinessDay(key, holidays)) return false;
  }
}

/** 그 시각이 든 KST 주의 바로 앞 주(월~일)의 날짜 키 */
export function previousKstWeek(at: Date): { periodStart: string; periodEnd: string } {
  const monday = Date.parse(`${kstWeekMonday(at)}T00:00:00Z`);
  return { periodStart: new Date(monday - 7 * DAY_MS).toISOString().slice(0, 10), periodEnd: new Date(monday - DAY_MS).toISOString().slice(0, 10) };
}

/** 공휴일 파일 본문을 읽는다. 형식이 틀리면 던진다(시작 파일은 듣기 전에 시작에 실패한다) */
export function parseHolidayCalendar(text: string): ReadonlySet<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`공휴일 달력이 JSON이 아니다: ${(e as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null && Array.isArray((raw as { holidays?: unknown }).holidays) ? (raw as { holidays: unknown[] }).holidays : undefined;
  if (!list) throw new Error('공휴일 달력은 날짜 배열이거나 { holidays: [...] }여야 한다');
  const out = new Set<string>();
  for (const v of list) {
    if (typeof v !== 'string' || !DATE_KEY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
      throw new Error(`공휴일 날짜가 YYYY-MM-DD가 아니다: ${String(v)}`);
    }
    out.add(v);
  }
  return out;
}
