// CS 처리함 영업일 달력(F-06-2 GAT-280, R-T50 ①④). 시험 담당 lane3-f062-test가 정본에서 값을 정했다.
// 정본: ADR-0364 결정 1('N영업일 뒤'는 시작 시각의 KST 같은 시각에서 영업일을 N번 넘긴 날의 같은 시각, 비영업일에 시작하면 다음 영업일이 첫째 날,
// '1영업일 전'은 기한에서 영업일 하나를 뺀 같은 시각, 토·일과 공휴일 파일의 날이 비영업일, local·ci는 파일이 없으면 주말만 빼고 staging·prod는 시작하지 않는다),
// docs/features/transfer-refund.md §7.1 '첫 구현'·§11 R-T50 ①④·§12 '영업일 달력'.
// 공휴일은 시험이 만든 날짜다(실제 공휴일에 기대지 않는다): 2026-11-25(수) 하루와 2026-12-03(목)·12-04(금) 이틀 연휴(주말과 이어 나흘 쉰다).
import { describe, expect, test } from 'vitest';
import { addBusinessDays, kstDateOf, loadBusinessCalendar, parseHolidayCalendar, subtractBusinessDays } from '../src/modules/cases/index.js';

const HOLIDAYS = ['2026-11-25', '2026-12-03', '2026-12-04'];
const cal = parseHolidayCalendar(JSON.stringify(HOLIDAYS));
const ms = (iso: string): number => Date.parse(iso);
const iso = (n: number): string => new Date(n).toISOString();

describe('R-T50 ① KST 날짜와 영업일 셈', () => {
  test('R-T50 ① KST 자정 앞뒤의 날짜는 UTC 날짜가 아니라 한국 날짜다', () => {
    // 2026-11-21 00:00 KST = 2026-11-20 15:00Z
    expect(kstDateOf(ms('2026-11-20T15:00:00.000Z'))).toBe('2026-11-21');
    expect(kstDateOf(ms('2026-11-20T14:59:59.999Z'))).toBe('2026-11-20');
  });

  test('R-T50 ① 평일 공휴일과 주말은 세지 않는다(같은 KST 시각, 수요일 공휴일)', () => {
    expect(cal.isBusinessDay('2026-11-24')).toBe(true);
    expect(cal.isBusinessDay('2026-11-25')).toBe(false);
    expect(cal.isBusinessDay('2026-11-21')).toBe(false);
    expect(cal.isBusinessDay('2026-11-22')).toBe(false);
    // 화 10:00 KST + 1영업일: 수(공휴일)를 건너 목 10:00 KST
    expect(iso(addBusinessDays(cal, ms('2026-11-24T01:00:00.000Z'), 1))).toBe('2026-11-26T01:00:00.000Z');
  });

  test('R-T50 ① 금요일 23:30 KST에 시작한 건의 1·3·10영업일', () => {
    const start = ms('2026-11-20T14:30:00.000Z'); // 금 23:30 KST
    expect(iso(addBusinessDays(cal, start, 1))).toBe('2026-11-23T14:30:00.000Z'); // 월 23:30 KST
    expect(iso(addBusinessDays(cal, start, 3))).toBe('2026-11-26T14:30:00.000Z'); // 월·화·(수 공휴일)·목
    // 월23·화24·목26·금27·월30·화1·수2·(목3·금4 연휴)·월7·화8·수9
    expect(iso(addBusinessDays(cal, start, 10))).toBe('2026-12-09T14:30:00.000Z');
  });

  test('R-T50 ① 토요일 08:00 KST(UTC로는 금요일)에 시작하면 다음 영업일인 월요일이 첫째 날이다', () => {
    const start = ms('2026-11-20T23:00:00.000Z'); // 토 08:00 KST
    expect(iso(addBusinessDays(cal, start, 1))).toBe('2026-11-22T23:00:00.000Z'); // 월 08:00 KST
    expect(iso(addBusinessDays(cal, start, 3))).toBe('2026-11-25T23:00:00.000Z'); // 목 08:00 KST
    expect(iso(addBusinessDays(cal, start, 10))).toBe('2026-12-08T23:00:00.000Z'); // 수 12-09 08:00 KST
  });

  test('R-T50 ① 공휴일에 시작하면 다음 영업일이 첫째 날이고, 연휴 앞날의 1영업일은 연휴와 주말을 넘긴 월요일이다', () => {
    expect(iso(addBusinessDays(cal, ms('2026-11-25T01:00:00.000Z'), 1))).toBe('2026-11-26T01:00:00.000Z'); // 수(공휴일) 10:00 → 목 10:00
    expect(iso(addBusinessDays(cal, ms('2026-12-02T09:00:00.000Z'), 1))).toBe('2026-12-07T09:00:00.000Z'); // 수 18:00 → (목·금 연휴·토·일) 월 18:00
    expect(iso(addBusinessDays(cal, ms('2026-12-03T09:00:00.000Z'), 1))).toBe('2026-12-07T09:00:00.000Z'); // 연휴 첫날 시작 → 월이 첫째 날
  });

  test('R-T50 ① KST 자정(금 00:00 KST = 목 15:00Z)에 시작한 1영업일은 월 00:00 KST다', () => {
    expect(iso(addBusinessDays(cal, ms('2026-11-19T15:00:00.000Z'), 1))).toBe('2026-11-22T15:00:00.000Z');
  });

  test('R-T50 ① 1영업일 전은 기한에서 영업일 하나를 뺀 같은 KST 시각이다(월 08:00 KST 기한 → 금 08:00 KST, 공휴일 다음 날 기한 → 공휴일 앞날)', () => {
    expect(iso(subtractBusinessDays(cal, ms('2026-11-22T23:00:00.000Z'), 1))).toBe('2026-11-19T23:00:00.000Z');
    expect(iso(subtractBusinessDays(cal, ms('2026-11-26T01:00:00.000Z'), 1))).toBe('2026-11-24T01:00:00.000Z');
    expect(iso(subtractBusinessDays(cal, ms('2026-12-07T09:00:00.000Z'), 1))).toBe('2026-12-02T09:00:00.000Z');
  });
});

describe('R-T50 ④ 공휴일 파일과 시작', () => {
  const readOk = (text: string) => () => text;
  const unreadable = () => {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  };

  test('R-T50 ④ 파일 꼴 둘(날짜 배열, { holidays: [...] })은 같은 달력이다', () => {
    for (const text of [JSON.stringify(HOLIDAYS), JSON.stringify({ holidays: HOLIDAYS })]) {
      const c = loadBusinessCalendar({ PEAKET_ENV: 'staging', PEAKET_HOLIDAY_CALENDAR_FILE: '/etc/peaket/holidays.json' }, readOk(text));
      expect(['2026-11-24', '2026-11-25', '2026-12-03', '2026-12-04', '2026-12-07'].map((d) => c.isBusinessDay(d))).toEqual([true, false, false, false, true]);
    }
  });

  test('R-T50 ④ local·ci는 파일 없이 주말만 빼고 시작한다', () => {
    for (const env of ['local', 'ci']) {
      const read = () => {
        throw new Error('읽지 않아야 한다');
      };
      const c = loadBusinessCalendar({ PEAKET_ENV: env }, read);
      expect(['2026-11-25', '2026-12-03', '2026-11-21', '2026-11-22'].map((d) => c.isBusinessDay(d)), env).toEqual([true, true, false, false]);
    }
  });

  test('R-T50 ④ staging·prod는 공휴일 파일 없이 시작하지 않는다', () => {
    for (const env of ['staging', 'prod']) {
      expect(() => loadBusinessCalendar({ PEAKET_ENV: env }, readOk('[]')), env).toThrow(/PEAKET_HOLIDAY_CALENDAR_FILE/);
      expect(() => loadBusinessCalendar({ PEAKET_ENV: env, PEAKET_HOLIDAY_CALENDAR_FILE: '  ' }, readOk('[]')), `${env} 빈 값`).toThrow(/PEAKET_HOLIDAY_CALENDAR_FILE/);
    }
  });

  test('R-T50 ④ 읽지 못하는 파일·꼴이 틀린 파일로는 어느 환경이든 시작하지 않는다', () => {
    for (const env of ['local', 'ci', 'staging', 'prod']) {
      const at = { PEAKET_ENV: env, PEAKET_HOLIDAY_CALENDAR_FILE: '/nope/holidays.json' };
      expect(() => loadBusinessCalendar(at, unreadable), `${env} 없는 파일`).toThrow();
      expect(() => loadBusinessCalendar(at, readOk('{not json')), `${env} JSON 아님`).toThrow();
      expect(() => loadBusinessCalendar(at, readOk('{"days":["2026-11-25"]}')), `${env} 다른 꼴`).toThrow();
      expect(() => loadBusinessCalendar(at, readOk('["2026/11/25"]')), `${env} 날짜 꼴`).toThrow();
    }
  });
});
