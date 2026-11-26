// F-06-8 예매번호: 한국 시각 날짜 8자리 + 5자리 일련번호(ADR-0388, docs/features/notify.md §4.9.1).
// 번호는 개인정보가 아니며 CS 문의의 orderRef·화면의 예매번호와 같은 값이다.
export const BOOKING_NO_MAX = 99_999;

/** 한국 시각(UTC+9) 날짜 8자리. 한국은 서머타임이 없어 UTC+9로 계산한다 */
export function kstDayOf(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('시각이 올바르지 않습니다');
  const d = new Date(nowMs + 9 * 60 * 60 * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
}

/** `YYYYMMDD` + 5자리. 1..99,999 밖이면 RangeError(100,000번째는 주문을 닫는다) */
export function formatBookingNo(kstDay: string, seq: number): string {
  if (!/^\d{8}$/.test(kstDay)) throw new RangeError(`예매번호 날짜가 YYYYMMDD가 아닙니다: ${kstDay}`);
  if (!Number.isInteger(seq) || seq < 1 || seq > BOOKING_NO_MAX) throw new RangeError(`예매번호 일련번호가 1~${BOOKING_NO_MAX} 밖입니다: ${String(seq)}`);
  return `${kstDay}${String(seq).padStart(5, '0')}`;
}

/** 예매번호 모양(13자리, 앞 8자리는 날짜, 뒤 5자리는 00001~99999) */
export const BOOKING_NO_PATTERN = /^\d{8}(?!00000)\d{5}$/;

export const isBookingNo = (v: unknown): v is string => typeof v === 'string' && BOOKING_NO_PATTERN.test(v);
