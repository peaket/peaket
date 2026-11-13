// 예매 취소 공제율·환급액 계산(POL-032, docs/features/payment.md §4.1, BUILD_ORDER GAT-070).
import { describe, expect, test } from 'vitest';
import {
  businessHoursBetween,
  calendarDaysBefore,
  deductionBpFor,
  parseHolidayCalendar,
  quoteRefund,
  seoulDateKey,
  WeekendBusinessCalendar,
} from '../src/modules/refund/index.js';

const kst = (s: string): number => Date.parse(`${s}+09:00`);
const EVENT = kst('2026-11-20T19:00:00');
const SALE_ENDS = EVENT - 24 * 60 * 60 * 1000;
const calendar = new WeekendBusinessCalendar();

describe('POL-032 공제 구간과 끝수', () => {
  test('공연일까지 남은 달력일수를 한국 날짜로 센다', () => {
    expect(seoulDateKey(EVENT)).toBe('2026-11-20');
    expect(calendarDaysBefore(EVENT, kst('2026-11-13T10:00:00'))).toBe(7);
    expect(calendarDaysBefore(EVENT, kst('2026-11-19T23:59:59'))).toBe(1);
    expect(calendarDaysBefore(EVENT, kst('2026-11-20T10:00:00'))).toBe(0);
    expect(calendarDaysBefore(EVENT, kst('2026-11-21T10:00:00'))).toBe(0);
  });

  test('10일 전까지 0%, 7~9일 10%, 3~6일 20%, 1~2일 30%, 당일 90%다', () => {
    expect(deductionBpFor(10, false)).toBe(0);
    expect(deductionBpFor(9, false)).toBe(1000);
    expect(deductionBpFor(7, false)).toBe(1000);
    expect(deductionBpFor(6, false)).toBe(2000);
    expect(deductionBpFor(3, false)).toBe(2000);
    expect(deductionBpFor(2, false)).toBe(3000);
    expect(deductionBpFor(1, false)).toBe(3000);
    expect(deductionBpFor(0, false)).toBe(9000);
    expect(deductionBpFor(4, true)).toBe(0);
  });

  test('공제액은 원 미만을 버리고, 환급액은 티켓 금액 − 공제액이다', () => {
    const q = quoteRefund({
      ticketPrice: 33_333,
      eventStartsAtMs: EVENT,
      bookedAtMs: kst('2026-11-01T10:00:00'),
      nowMs: kst('2026-11-13T10:00:00'),
      calendar,
    });
    expect(q.status).toBe('OK');
    if (q.status !== 'OK') return;
    expect(q.quote.daysBefore).toBe(7);
    expect(q.quote.deductionRate).toBe(0.1);
    expect(q.quote.deductionAmount).toBe(3_333);
    expect(q.quote.refundAmount).toBe(30_000);

    const q20 = quoteRefund({
      ticketPrice: 33_333,
      eventStartsAtMs: EVENT,
      bookedAtMs: kst('2026-11-01T10:00:00'),
      nowMs: kst('2026-11-15T10:00:00'),
      calendar,
    });
    expect(q20.status).toBe('OK');
    if (q20.status !== 'OK') return;
    expect(q20.quote.daysBefore).toBe(5);
    expect(q20.quote.deductionAmount).toBe(6_666);
    expect(q20.quote.refundAmount).toBe(26_667);
  });

  test('공연이 시작됐거나 금액이 틀리면 견적을 내지 않는다', () => {
    expect(quoteRefund({ ticketPrice: 10_000, eventStartsAtMs: EVENT, bookedAtMs: SALE_ENDS, nowMs: EVENT, calendar })).toEqual({ status: 'EVENT_STARTED' });
    expect(quoteRefund({ ticketPrice: -1, eventStartsAtMs: EVENT, bookedAtMs: SALE_ENDS, nowMs: EVENT - 1, calendar })).toEqual({ status: 'INVALID_AMOUNT' });
  });

  test('입장 시작 뒤 취소는 환급을 입장 기록 마감 뒤로 미룬다', () => {
    const q = quoteRefund({
      ticketPrice: 10_000,
      eventStartsAtMs: EVENT,
      bookedAtMs: kst('2026-11-01T10:00:00'),
      nowMs: kst('2026-11-20T18:30:00'),
      calendar,
      entryOpensAtMs: kst('2026-11-20T18:00:00'),
    });
    expect(q.status).toBe('OK');
    if (q.status !== 'OK') return;
    expect(q.quote.refundAfterEntryClose).toBe(true);
    expect(q.quote.deductionAmount).toBe(9_000);
  });
});

describe('영업시간 24시간과 공휴일', () => {
  test('금요일 18시 예매, 월요일 10시 취소는 영업시간 16시간이라 24시간 이내다', () => {
    expect(businessHoursBetween(kst('2026-11-13T18:00:00'), kst('2026-11-16T10:00:00'), calendar)).toBe(16);
    expect(businessHoursBetween(kst('2026-11-13T10:00:00'), kst('2026-11-16T11:00:00'), calendar)).toBe(25);
  });

  test('공휴일은 영업시간에서 빼고, 24시간 이내이면서 3일 전까지면 공제하지 않는다', () => {
    const withHoliday = parseHolidayCalendar('{"holidays":["2026-11-17"]}');
    expect(businessHoursBetween(kst('2026-11-16T18:00:00'), kst('2026-11-18T10:00:00'), withHoliday)).toBe(16);
    const q = quoteRefund({
      ticketPrice: 50_000,
      eventStartsAtMs: kst('2026-11-23T19:00:00'),
      bookedAtMs: kst('2026-11-16T18:00:00'),
      nowMs: kst('2026-11-18T10:00:00'),
      calendar: withHoliday,
    });
    expect(q.status).toBe('OK');
    if (q.status !== 'OK') return;
    expect(q.quote.daysBefore).toBe(5);
    expect(q.quote.within24h).toBe(true);
    expect(q.quote.deductionBp).toBe(0);
    expect(q.quote.refundAmount).toBe(50_000);

    // 같은 16시간이라도 공연이 2일 뒤면 24시간 특례(3일 전까지) 밖이라 30% 공제다.
    const near = quoteRefund({
      ticketPrice: 50_000,
      eventStartsAtMs: EVENT,
      bookedAtMs: kst('2026-11-16T18:00:00'),
      nowMs: kst('2026-11-18T10:00:00'),
      calendar: withHoliday,
    });
    expect(near.status).toBe('OK');
    if (near.status !== 'OK') return;
    expect(near.quote.daysBefore).toBe(2);
    expect(near.quote.within24h).toBe(false);
    expect(near.quote.deductionBp).toBe(3000);
  });

  test('공휴일 파일이 틀리면 시작하지 않는다', () => {
    expect(() => parseHolidayCalendar('not json')).toThrow('JSON');
    expect(() => parseHolidayCalendar('{"holidays":["2026-1-1"]}')).toThrow('YYYY-MM-DD');
    expect(() => parseHolidayCalendar('{"days":[]}')).toThrow('holidays');
  });
});
