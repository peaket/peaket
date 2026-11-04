// 공연 등록·회차 더하기의 회차 판정(ADR-0198 결정 2, POL-003·030·041, BUILD_ORDER HOT-171)
import { describe, expect, test } from 'vitest';
import { checkEventDraft, checkOpenSlot, type EventDraft, inMaintenanceWindow, withEventDefaults } from '../src/modules/catalog/domain/registration.js';

const NOW = new Date('2026-11-05T00:00:00.000Z');
/** 2026-11-20(금) 11:00 UTC = 20:00 KST 오픈, 12-24 공연 */
function draft(o: Partial<EventDraft> = {}): EventDraft {
  return withEventDefaults({ openAt: new Date('2026-11-20T11:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), endsAt: new Date('2026-12-24T12:30:00Z'), ...o });
}
const MIN = 60_000;

describe('회차 일정과 정렬 설정', () => {
  test('기본값은 로비 10분·재입장 불허·정렬 두 값 켬·직접 선택·1인 4매다', () => {
    expect(draft()).toMatchObject({ lobbyMinutes: 10, reentryAllowed: false, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4 });
    expect(checkEventDraft(draft(), NOW)).toBeNull();
  });

  test('지금<오픈<판매종료(시작−24시간)<시작<종료가 아니면_event-schedule-invalid다', () => {
    expect(checkEventDraft(draft({ openAt: new Date('2026-11-04T23:59:00Z') }), NOW)).toBe('event-schedule-invalid');
    // 오픈이 판매 종료(12-23 10:00) 뒤면 팔 수 있는 시간이 없다
    expect(checkEventDraft(draft({ openAt: new Date('2026-12-23T10:00:00Z') }), NOW)).toBe('event-schedule-invalid');
    expect(checkEventDraft(draft({ openAt: new Date('2026-12-23T09:59:00Z') }), NOW)).toBeNull();
    expect(checkEventDraft(draft({ endsAt: new Date('2026-12-24T10:00:00Z') }), NOW)).toBe('event-schedule-invalid');
  });

  test('입장시작은_공연시작이하다', () => {
    expect(checkEventDraft(draft({ entryOpensAt: new Date('2026-12-24T10:00:00Z') }), NOW)).toBeNull();
    expect(checkEventDraft(draft({ entryOpensAt: new Date('2026-12-24T10:01:00Z') }), NOW)).toBe('event-schedule-invalid');
  });

  test('로비셔플과오픈직후묶음을_둘다끄면_queue-order-invalid다(ADR-0118)', () => {
    expect(checkEventDraft(draft({ lobbyShuffle: false, openBatch: false }), NOW)).toBe('queue-order-invalid');
    expect(checkEventDraft(draft({ lobbyShuffle: false }), NOW)).toBeNull();
    expect(checkEventDraft(draft({ openBatch: false }), NOW)).toBeNull();
  });
});

describe('정비 창(수요일 03:00~06:30 KST, 양 끝은 된다)', () => {
  // 2026-11-25는 수요일. 03:00 KST = 11-24 18:00 UTC
  test('수요일_03:00과06:30은되고_그사이는막힌다', () => {
    expect(inMaintenanceWindow(new Date('2026-11-24T18:00:00Z'))).toBe(false);
    expect(inMaintenanceWindow(new Date('2026-11-24T18:00:01Z'))).toBe(true);
    expect(inMaintenanceWindow(new Date('2026-11-24T21:29:59Z'))).toBe(true);
    expect(inMaintenanceWindow(new Date('2026-11-24T21:30:00Z'))).toBe(false);
  });

  test('다른요일의같은시각은_막지않는다', () => {
    // 화요일 04:00 KST
    expect(inMaintenanceWindow(new Date('2026-11-23T19:00:00Z'))).toBe(false);
  });
});

describe('오픈 간격(다른 공연과 5분)', () => {
  const t = new Date('2026-11-20T11:00:00Z');
  test('5분안이면_open-too-close이고_가장이른가능시각을준다', () => {
    const r = checkOpenSlot(t, [new Date(t.getTime() - 2 * MIN)]);
    expect(r).toEqual({ ok: false, reason: 'open-too-close', suggestedOpenAt: new Date(t.getTime() + 3 * MIN) });
  });

  test('정확히5분떨어지면_된다', () => {
    expect(checkOpenSlot(t, [new Date(t.getTime() - 5 * MIN), new Date(t.getTime() + 5 * MIN)])).toEqual({ ok: true });
  });

  test('제안시각은_이어진다른공연들을모두피한다', () => {
    const others = [t, new Date(t.getTime() + 4 * MIN), new Date(t.getTime() + 8 * MIN)];
    expect(checkOpenSlot(t, others)).toEqual({ ok: false, reason: 'open-too-close', suggestedOpenAt: new Date(t.getTime() + 13 * MIN) });
  });

  test('정비창이면_open-maintenance-window이고_제안은창이끝나는06:30이다', () => {
    const inWindow = new Date('2026-11-24T19:00:00Z');
    expect(checkOpenSlot(inWindow, [])).toEqual({ ok: false, reason: 'open-maintenance-window', suggestedOpenAt: new Date('2026-11-24T21:30:00Z') });
  });

  test('제안시각이판매종료를넘으면_제안을싣지않는다(그대로다시보내도일정오류가되지않게)', () => {
    const latest = new Date(t.getTime() + 2 * MIN);
    expect(checkOpenSlot(t, [new Date(t.getTime() - 2 * MIN)], latest)).toEqual({ ok: false, reason: 'open-too-close' });
    expect(checkOpenSlot(t, [new Date(t.getTime() - 2 * MIN)], new Date(t.getTime() + 3 * MIN))).toEqual({ ok: false, reason: 'open-too-close', suggestedOpenAt: new Date(t.getTime() + 3 * MIN) });
  });

  test('정비창끝이다른공연과5분안이면_그다음가능시각을준다', () => {
    const inWindow = new Date('2026-11-24T19:00:00Z');
    expect(checkOpenSlot(inWindow, [new Date('2026-11-24T21:31:00Z')])).toEqual({
      ok: false,
      reason: 'open-maintenance-window',
      suggestedOpenAt: new Date('2026-11-24T21:36:00Z'),
    });
  });
});
