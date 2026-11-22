// 판매 중지·재개 판정(ADR-0123, LCH-090). 정본: docs/features/transfer-refund.md §2.1, docs/features/control-tower.md §5 제어 상태 표.
// 순수 함수만 둔다: 저장소·프레임워크를 모르고, 같은 입력에 같은 결정을 낸다.
import { describe, expect, test } from 'vitest';
import type { SaleReview } from '../src/modules/catalog/domain/production.js';
import {
  decideSaleSuspension,
  SaleSuspensionConflict,
  type LockedSaleSuspension,
  type SaleSuspensionEvent,
} from '../src/modules/catalog/domain/sale-suspension.js';

const NOW = new Date('2026-11-22T03:00:00.000Z');
const H = 3_600_000;

const ev = (id: string, openAtMs: number, over: Partial<SaleSuspensionEvent> = {}): SaleSuspensionEvent => ({
  eventId: id,
  status: 'SCHEDULED',
  openAt: new Date(openAtMs),
  startsAt: new Date(openAtMs + 30 * 24 * H),
  ...over,
});

function state(over: Partial<LockedSaleSuspension> = {}): LockedSaleSuspension {
  return {
    productionId: 'prod-1',
    saleReview: 'APPROVED' as SaleReview,
    saleApprovedAt: new Date(NOW.getTime() - 10 * 24 * H),
    suspendedAt: null,
    suspensionApprovalId: null,
    suspensionOpenEventIds: [],
    events: [],
    ...over,
  };
}

const suspend = (current: LockedSaleSuspension, approvalId = 'AP-1') =>
  decideSaleSuspension(current, { kind: 'SUSPENDED', approvalId, reasonCode: 'SELLER_IDENTITY', reason: '판매자 신원 확인' }, NOW);
const resume = (current: LockedSaleSuspension, approvalId = 'AP-2') => decideSaleSuspension(current, { kind: 'RESUMED', approvalId }, NOW);

describe('LCH-090 판매 중지·재개 판정', () => {
  test('판매 승인된 공연을 내리면 지금 판매 중인 회차만 다시 열 목록에 남기고, 커밋할 값을 만든다', () => {
    const open = ev('e-open', NOW.getTime() - 2 * H);
    const future = ev('e-future', NOW.getTime() + 48 * H);
    const ended = ev('e-ended', NOW.getTime() - 50 * H, { startsAt: new Date(NOW.getTime() - 26 * H) });
    const cancelled = ev('e-cancelled', NOW.getTime() - 2 * H, { status: 'CANCELLED' });
    const current = state({ events: [open, future, ended, cancelled] });

    expect(suspend(current)).toEqual({
      write: {
        kind: 'SUSPENDED',
        approvalId: 'AP-1',
        at: NOW,
        reasonCode: 'SELLER_IDENTITY',
        reason: '판매자 신원 확인',
        openEventIds: ['e-open'],
      },
      eventIds: ['e-open', 'e-future', 'e-ended'],
      resumeEventIds: [],
    });
  });

  test('승인 이력이 없거나 아직 승인 대기여도 이력이 없으면 409 not-approved다', () => {
    for (const current of [state({ saleReview: 'DRAFT', saleApprovedAt: null }), state({ saleReview: 'SUBMITTED', saleApprovedAt: null })]) {
      expect(() => suspend(current)).toThrowError(SaleSuspensionConflict);
      try {
        suspend(current);
      } catch (e) {
        expect((e as SaleSuspensionConflict).reason).toBe('not-approved');
      }
    }
  });

  test('재승인 대기·반려 중이어도 승인 이력이 있으면 내릴 수 있고, 기다리던 변경분은 거둔다', () => {
    for (const saleReview of ['SUBMITTED', 'REJECTED'] as const) {
      const d = suspend(state({ saleReview }));
      expect(d.write).toMatchObject({ kind: 'SUSPENDED', approvalId: 'AP-1', openEventIds: [] });
    }
  });

  test('같은 승인 업무로 다시 내리면 바꾸지 않고(멱등), 다른 업무로 또 내리면 409 already-suspended다', () => {
    const current = state({
      saleReview: 'SUSPENDED',
      suspendedAt: new Date(NOW.getTime() - H),
      suspensionApprovalId: 'AP-1',
      suspensionOpenEventIds: ['e-open'],
      events: [ev('e-open', NOW.getTime() - 3 * H)],
    });
    expect(suspend(current, 'AP-1')).toEqual({ write: undefined, eventIds: ['e-open'], resumeEventIds: [] });
    expect(() => suspend(current, 'AP-9')).toThrowError(SaleSuspensionConflict);
  });

  test('재개는 판매 중이던 회차와 아직 오픈 전인 회차만 다시 열고, 중지 동안 오픈 시각이 지난 회차는 열지 않는다', () => {
    const wasOpen = ev('e-open', NOW.getTime() - 5 * H);
    const passedWhileSuspended = ev('e-passed', NOW.getTime() - 2 * H);
    const future = ev('e-future', NOW.getTime() + 72 * H);
    const cancelled = ev('e-cancelled', NOW.getTime() + 72 * H, { status: 'CANCELLED' });
    const current = state({
      saleReview: 'SUSPENDED',
      suspendedAt: new Date(NOW.getTime() - 4 * H),
      suspensionApprovalId: 'AP-1',
      suspensionOpenEventIds: ['e-open'],
      events: [wasOpen, passedWhileSuspended, future, cancelled],
    });
    expect(resume(current)).toEqual({
      write: { kind: 'RESUMED', approvalId: 'AP-2', at: NOW },
      eventIds: ['e-open', 'e-passed', 'e-future'],
      resumeEventIds: ['e-open', 'e-future'],
    });
  });

  test('판매 중지가 아닌 공연의 재개는 409 not-suspended이고, 이미 승인된 공연의 재개는 아무것도 바꾸지 않는다', () => {
    expect(() => resume(state({ saleReview: 'SUBMITTED' }))).toThrowError(SaleSuspensionConflict);
    try {
      resume(state({ saleReview: 'SUBMITTED' }));
    } catch (e) {
      expect((e as SaleSuspensionConflict).reason).toBe('not-suspended');
    }
    expect(resume(state({ saleReview: 'APPROVED' }))).toEqual({ write: undefined, eventIds: [], resumeEventIds: [] });
  });

  test('취소된 회차는 중지·재개 어느 목록에도 넣지 않는다', () => {
    const cancelled = ev('e-cancelled', NOW.getTime() - 2 * H, { status: 'CANCELLED' });
    const current = state({ events: [cancelled] });
    expect(suspend(current).eventIds).toEqual([]);
    const suspended = state({ saleReview: 'SUSPENDED', suspensionApprovalId: 'AP-1', events: [cancelled] });
    expect(resume(suspended)).toMatchObject({ eventIds: [], resumeEventIds: [] });
  });
});
