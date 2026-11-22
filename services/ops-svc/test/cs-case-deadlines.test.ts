// CS 처리함 건 종류별 기한과 기한 상태(F-06-2 GAT-280, R-T48 ①, R-T12, R-T20 ①). 시험 담당 lane3-f062-test.
// 정본(기한 값): docs/features/transfer-refund.md §7.1 표·docs/design/d5-screen-blueprint.md §7.6 건 종류 표의 '기한' 칸,
// docs/data.md cs_case.progress_due_at·result_due_at(두 기한인 건은 두 칸, 하나인 건은 결과 칸), ADR-0364 결정 1~3·6.
// R-T12: 분쟁 접수 3영업일·10영업일과 1영업일 전 알림. R-T20 ①: 추가 검증 이의 10영업일·미보고 스캐너 3영업일·환불 대기 3영업일과 1영업일 전 알림.
// 공휴일은 시험이 만든 날(2026-11-25 수, 2026-12-03·04 목·금)이다. 시작은 금요일 23:30 KST(2026-11-20T14:30Z).
import { describe, expect, test } from 'vitest';
import { deadlinesOf, dueStateOf, parseHolidayCalendar, type CsCaseKind } from '../src/modules/cases/index.js';

const cal = parseHolidayCalendar('["2026-11-25","2026-12-03","2026-12-04"]');
const BASE = Date.parse('2026-11-20T14:30:00.000Z'); // 금 23:30 KST
// 위 달력으로 손으로 센 같은 KST 시각(cs-business-calendar.test.ts R-T50 ①과 같은 값)
const BD1 = '2026-11-23T14:30:00.000Z';
const BD3 = '2026-11-26T14:30:00.000Z';
const BD10 = '2026-12-09T14:30:00.000Z';

const iso = (n: number | null): string | null => (n === null ? null : new Date(n).toISOString());
const due = (kind: CsCaseKind, category = '', inheritedDueMs?: number | null) => {
  const d = deadlinesOf({ kind, category, baseMs: BASE, ...(inheritedDueMs !== undefined ? { inheritedDueMs } : {}) }, cal);
  return { progress: iso(d.progressDueMs), result: iso(d.resultDueMs) };
};

describe('R-T48 ① 받는 종류마다 두 기한(§7.1·d5 §7.6 기한 칸)', () => {
  test('R-T48 ① R-T12 분쟁 접수(DISPUTE)는 진행 경과 3영업일·결과 10영업일이다(양도 회수 실패도 같다)', () => {
    expect(due('DISPUTE')).toEqual({ progress: BD3, result: BD10 });
    expect(due('DISPUTE', 'TRANSFER_RECALL_FAILED')).toEqual({ progress: BD3, result: BD10 });
  });

  test('R-T48 ① R-T20 ① 추가 검증 이의 결과 10영업일, 미보고 스캐너 진행 1영업일·결과 3영업일, 환불 대기 3영업일', () => {
    expect(due('VERIFICATION_APPEAL')).toEqual({ progress: null, result: BD10 });
    expect(due('SCANNER_UNREPORTED')).toEqual({ progress: BD1, result: BD3 });
    expect(due('REFUND_ACCOUNT_PENDING')).toEqual({ progress: null, result: BD3 });
  });

  test('R-T48 ① 정산 이의(STATEMENT_DISPUTE, F-07-5가 받는 종류로 더함)는 진행 경과 3영업일·결과 10영업일이다', () => {
    // d5 §7.6 '정산 이의' 행 '3·10영업일', transfer-refund §7.1 '정산 이의' 행
    expect(due('STATEMENT_DISPUTE', 'SETTLEMENT')).toEqual({ progress: BD3, result: BD10 });
  });

  test('R-T48 ① 환급 실패 3영업일, 배상 대기 10영업일, 판정 대기 1영업일', () => {
    expect(due('REFUND_FAILED', 'REFUND')).toEqual({ progress: null, result: BD3 });
    expect(due('COMPENSATION_PENDING')).toEqual({ progress: null, result: BD10 });
    expect(due('JUDGEMENT_PENDING', 'EVENT_CANCELLATION')).toEqual({ progress: null, result: BD1 });
  });

  test('R-T48 ① 이상 표시는 다음 영업일이고, 예외 통과 사후 검토·현장 확인 부정 의심·판단 불가는 3영업일이다', () => {
    expect(due('FLAGGED', 'ENTRY_AFTER_CANCEL')).toEqual({ progress: null, result: BD1 });
    for (const category of ['OVERRIDE_REVIEW', 'SUSPECT', 'UNDETERMINED']) {
      expect(due('FLAGGED', category), category).toEqual({ progress: null, result: BD3 });
    }
  });

  test('R-T48 ① 승인 업무 실행 실패는 원래 승인 업무의 기한을 이어받고, 기한이 없는 승인이면 두 칸이 빈다', () => {
    const inherited = Date.parse('2026-12-01T03:21:00.000Z');
    expect(due('APPROVAL_EXECUTION_FAILED', 'COMMANDER_ROLE_CHANGE', inherited)).toEqual({ progress: null, result: '2026-12-01T03:21:00.000Z' });
    expect(due('APPROVAL_EXECUTION_FAILED', 'CONTRACT_TERMS_CHANGE', null)).toEqual({ progress: null, result: null });
  });

  test('R-T48 ① 결제 뒤 미발권은 벽시계 4시간이고, 기한이 \'—\'인 지급 건은 두 칸이 빈다', () => {
    expect(due('TICKET_NOT_ISSUED')).toEqual({ progress: null, result: '2026-11-20T18:30:00.000Z' });
    for (const kind of ['PAYOUT_FAILED', 'PAYOUT_ERROR', 'PG_BALANCE_MISMATCH', 'KOPIS_REPORT_FAILED'] as const) {
      expect(due(kind), kind).toEqual({ progress: null, result: null });
    }
  });
});

describe('R-T12 R-T20 ① 기한 상태와 1영업일 전(ADR-0364 결정 1·3)', () => {
  const open = (progressDueAtMs: number | null, resultDueAtMs: number | null) => ({ progressDueAtMs, resultDueAtMs, status: 'OPEN' as const });
  const result3 = Date.parse(BD3); // 목 11-26 23:30 KST
  const soonAt = Date.parse('2026-11-24T14:30:00.000Z'); // 1영업일 전: 수(공휴일)를 건너 화 11-24 23:30 KST

  test('R-T12 ① 1영업일 전 − 1ms는 기한 안, 1영업일 전 정각부터 임박, 기한 − 1ms까지 임박, 기한 정각부터 넘김', () => {
    expect(dueStateOf(open(null, result3), soonAt - 1, cal)).toBe('ON_TRACK');
    expect(dueStateOf(open(null, result3), soonAt, cal)).toBe('DUE_SOON');
    expect(dueStateOf(open(null, result3), result3 - 1, cal)).toBe('DUE_SOON');
    expect(dueStateOf(open(null, result3), result3, cal)).toBe('OVERDUE');
  });

  test('R-T12 ① 두 기한인 분쟁 건은 이른 기한(진행 3영업일)으로 센다', () => {
    const d = deadlinesOf({ kind: 'DISPUTE', category: '', baseMs: BASE }, cal);
    expect(dueStateOf({ progressDueAtMs: d.progressDueMs, resultDueAtMs: d.resultDueMs, status: 'IN_PROGRESS' }, soonAt, cal)).toBe('DUE_SOON');
    expect(dueStateOf({ progressDueAtMs: d.progressDueMs, resultDueAtMs: d.resultDueMs, status: 'IN_PROGRESS' }, result3, cal)).toBe('OVERDUE');
  });

  test('R-T20 ① 기한까지 1영업일이 안 남은 건(판정 대기 1영업일)은 열리자마자 임박이다', () => {
    const d = deadlinesOf({ kind: 'JUDGEMENT_PENDING', category: 'EVENT_CANCELLATION', baseMs: BASE }, cal);
    expect(dueStateOf({ progressDueAtMs: d.progressDueMs, resultDueAtMs: d.resultDueMs, status: 'OPEN' }, BASE, cal)).toBe('DUE_SOON');
  });

  test('R-T20 ① 해결된 건과 기한 없는 건은 NONE이다', () => {
    expect(dueStateOf({ progressDueAtMs: null, resultDueAtMs: result3, status: 'RESOLVED' }, result3 + 1, cal)).toBe('NONE');
    expect(dueStateOf(open(null, null), result3, cal)).toBe('NONE');
  });
});
