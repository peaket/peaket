// J-T35 ⑦ 이의 기한의 KST 공휴일 달력(F-07-5 LCH-100, ADR-0368 결정 4, docs/features/settlement.md §4.2 '이의 기한').
// 정본의 세 예: 금 06:00 KST 통지 → 화 06:00 KST, 그 월요일이 공휴일이면 수 06:00 KST, 토 08:00 KST 기각 → 월 08:00 KST.
// 시험 공휴일은 공휴일 파일에서 받은 값이고 코드 기본값(빈 달력)과 다르다. 06:00·08:00 KST는 UTC로 전날이라 KST 날짜로 세는지를 본다.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { addKstBusinessDays, parseHolidayCalendar } from '../src/modules/settlement/index.js';
import { fact, settlementFlow, type SettlementFlow } from './settlement-flow-support.js';

/** 2026-11-20(금) 06:00 KST */
const FRIDAY_6 = Date.parse('2026-11-19T21:00:00.000Z');
/** 2026-11-24(화) 06:00 KST */
const TUESDAY_6 = '2026-11-23T21:00:00.000Z';
/** 2026-11-25(수) 06:00 KST */
const WEDNESDAY_6 = '2026-11-24T21:00:00.000Z';
/** 2026-11-21(토) 08:00 KST */
const SATURDAY_8 = Date.parse('2026-11-20T23:00:00.000Z');
/** 2026-11-23(월) 08:00 KST */
const MONDAY_8 = '2026-11-22T23:00:00.000Z';
const MONDAY_HOLIDAY = new Set(['2026-11-23']);

describe('J-T35 ⑦ 달력 함수', () => {
  test('J-T35 ⑦ 금 06:00 KST + 2영업일은 화 06:00 KST이고, 월요일이 공휴일이면 수 06:00 KST다', () => {
    expect(addKstBusinessDays(new Date(FRIDAY_6), 2, new Set()).toISOString()).toBe(TUESDAY_6);
    expect(addKstBusinessDays(new Date(FRIDAY_6), 2, MONDAY_HOLIDAY).toISOString()).toBe(WEDNESDAY_6);
  });

  test('J-T35 ⑦ 토 08:00 KST + 1영업일은 월 08:00 KST다(UTC 날짜로 세면 화요일이 된다)', () => {
    expect(addKstBusinessDays(new Date(SATURDAY_8), 1, new Set()).toISOString()).toBe(MONDAY_8);
  });

  test('J-T35 ⑦ 공휴일 파일은 날짜 배열만 받고 틀린 형식은 던진다(시작 실패)', () => {
    expect([...parseHolidayCalendar('["2026-01-01", "2026-11-23"]')]).toEqual(['2026-01-01', '2026-11-23']);
    for (const bad of ['{"days":["2026-01-01"]}', '["2026/01/01"]', '["2026-13-01"]', 'not-json', '[20260101]']) {
      expect(() => parseHolidayCalendar(bad), bad).toThrow();
    }
  });
});

describe('J-T35 ⑦ 정산서 흐름이 달력을 쓴다', () => {
  // 모듈 조립은 시험마다 한 벌씩(공휴일 있음·없음) 미리 띄운다. 시계는 각자 앞으로만 간다
  let holidayFlow: SettlementFlow;
  let plainFlow: SettlementFlow;
  beforeAll(async () => {
    holidayFlow = await settlementFlow({ now: FRIDAY_6, holidays: MONDAY_HOLIDAY });
    plainFlow = await settlementFlow({ now: FRIDAY_6 });
  });
  afterAll(async () => {
    await holidayFlow?.close();
    await plainFlow?.close();
  });

  const calculate = async (f: SettlementFlow) => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await f.settlements.recordKyc(promoterId, 'VERIFIED');
    f.payments.set(eventId, 'TOSS', [fact({ amount: 3_000_000 })]);
    return { promoterId, ...(await f.settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' })) };
  };

  test('J-T35 ⑦ 금 06:00 KST 통지의 이의 기한은 공휴일 파일의 월요일을 빼고 수 06:00 KST이고, 그 직전까지 이의를 받는다', async () => {
    const flow = holidayFlow;
    const s = await calculate(flow);
    expect(s.disputeDueAt).toBe(WEDNESDAY_6);
    // 화 06:00 KST(주말만 뺀 기한)에도 아직 이의를 받는다
    flow.at(Date.parse(TUESDAY_6));
    expect((await flow.settlements.confirmDueStatements()).confirmed).toBe(0);
    flow.at(Date.parse(WEDNESDAY_6) - 1);
    expect((await flow.dispute(s.promoterId, s.statementId, { reasonCode: 'GROSS_AMOUNT' })).statusCode).toBe(202);
  });

  test('J-T35 ⑦ 토 08:00 KST에 기각하면 다시 알린 기한은 월 08:00 KST다', async () => {
    const flow = plainFlow;
    const s = await calculate(flow);
    expect(s.disputeDueAt).toBe(TUESDAY_6);
    expect((await flow.dispute(s.promoterId, s.statementId, { reasonCode: 'OFFSET' })).statusCode).toBe(202);
    flow.at(SATURDAY_8);
    const res = await flow.internal(`/internal/v1/settlements/statements/${s.statementId}/dispute-dismissal`, { reason: '상계 내역이 맞습니다', actorId: randomUUID() });
    expect(res.statusCode, res.payload).toBe(200);
    expect((await flow.store.findStatementById(s.statementId))?.disputeDueAt?.toISOString()).toBe(MONDAY_8);
  });
});

describe('J-T35 ⑦ 시작 파일 조립', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('J-T35 ⑦ start()는 형식이 틀린 PEAKET_HOLIDAY_CALENDAR_FILE이면 듣기 전에 실패한다', async () => {
    const { start } = await import('../src/start.js');
    const dir = mkdtempSync(join(tmpdir(), 'peaket-holidays-'));
    dirs.push(dir);
    const file = join(dir, 'holidays.json');
    writeFileSync(file, '{"2026-11-23": true}', 'utf8');
    // 다른 설정 오류로 먼저 실패한 것과 가르려고 까닭(공휴일 달력)을 본다
    await expect(start({ env: { PEAKET_ENV: 'ci', PEAKET_DATABASE_URL: 'postgres://peaket@127.0.0.1:1/never', PEAKET_HOLIDAY_CALENDAR_FILE: file } })).rejects.toThrow(/공휴일/);
  });
});
