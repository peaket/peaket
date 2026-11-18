// 은행 영업일 계산(ADR-0301 결정 5). 주말(토·일)만 건너뛴다. 공휴일 달력은 정산과 같이 후속이다(docs/features/settlement.md §5.1).
// 날짜는 KST 날짜(YYYY-MM-DD) 글자다.
import { addDays, kstDateOnly, kstDayStart } from './merch.js';

/** KST 요일(0 일요일 ~ 6 토요일) */
export function kstWeekday(date: string): number {
  // kstDayStart는 그날 00:00 KST의 UTC 시각이다. 9시간을 더하면 UTC 날짜가 KST 날짜와 같아진다
  return new Date(kstDayStart(date).getTime() + 9 * 60 * 60 * 1000).getUTCDay();
}

/** 은행 영업일인가(주말이 아님) */
export function isBusinessDay(date: string): boolean {
  const d = kstWeekday(date);
  return d !== 0 && d !== 6;
}

/** 그 날짜 다음의 첫 영업일(그 날짜 자신은 넣지 않는다) */
export function nextBusinessDay(date: string): string {
  let d = addDays(date, 1);
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** 시각의 KST 날짜 */
export const kstDateOf = (ms: number): string => kstDateOnly(new Date(ms));

/** 시각의 KST 시·분(분 단위, 0~1439) */
export function kstMinuteOfDay(ms: number): number {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
