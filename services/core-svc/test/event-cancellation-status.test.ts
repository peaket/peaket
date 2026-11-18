// core 회차 상태 반영의 판정(R-T41 ②④⑤, BUILD_ORDER GAT-110, BAT-420-rest, 시험 담당 l3-b420-test). DB 없이 돈다.
// 정본: docs/features/transfer-refund.md §5 'core 회차 상태 반영'(멱등 204, CANCELLED 회차의 연기·지금보다 이른 연기 시작은 409 event-status-conflict),
// 'core 반영의 구현에서 정한 것' ①(연기는 시작·끝·입장 시작을 같은 만큼 옮김) ②(같은 상태의 판정). 실제 PostgreSQL·HTTP·검색 동기화는 test-int/search-read-model.int.test.ts.
import { describe, expect, test } from 'vitest';
import { decideEventStatus, EventStatusConflict, type LockedEventStatus } from '../src/modules/catalog/domain/event-cancellation-status.js';

const NOW = new Date('2026-11-19T01:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const PRODUCTION = '0193a000-0000-7000-8000-000000000501';
const base = (over: Partial<LockedEventStatus> = {}): LockedEventStatus => ({
  productionId: PRODUCTION,
  status: 'SCHEDULED',
  startsAt: new Date(NOW.getTime() + 20 * D),
  endsAt: new Date(NOW.getTime() + 20 * D + 150 * 60_000),
  entryOpensAt: new Date(NOW.getTime() + 20 * D - 90 * 60_000),
  ...over,
});

describe('R-T41 회차 상태 판정', () => {
  test('R-T41 ① CANCEL은 SCHEDULED·POSTPONED를 CANCELLED로 쓰고, 이미 CANCELLED면 바꾸지 않는다(멱등)', () => {
    expect(decideEventStatus(base(), { kind: 'CANCEL' }, NOW)).toEqual({ status: 'CANCELLED' });
    expect(decideEventStatus(base({ status: 'POSTPONED' }), { kind: 'CANCEL' }, NOW)).toEqual({ status: 'CANCELLED' });
    expect(decideEventStatus(base({ status: 'CANCELLED' }), { kind: 'CANCEL' }, NOW)).toBeUndefined();
  });

  test('R-T41 ④ POSTPONE은 POSTPONED와 바뀐 시작이고 끝·입장 시작을 같은 만큼(+7일 3시간) 옮겨 공연 길이 150분·입장 간격 90분을 지킨다', () => {
    const b = base();
    const to = new Date(b.startsAt.getTime() + 7 * D + 3 * H);
    expect(decideEventStatus(b, { kind: 'POSTPONE', postponedTo: to }, NOW)).toEqual({
      status: 'POSTPONED',
      startsAt: to,
      endsAt: new Date(to.getTime() + 150 * 60_000),
      entryOpensAt: new Date(to.getTime() - 90 * 60_000),
    });
    // 입장 시작이 없는 회차는 그 칸을 싣지 않는다
    const noEntry = { ...b };
    delete (noEntry as { entryOpensAt?: Date }).entryOpensAt;
    expect(decideEventStatus(noEntry, { kind: 'POSTPONE', postponedTo: to }, NOW)).not.toHaveProperty('entryOpensAt');
  });

  test('R-T41 ② POSTPONED이고 시작이 postponedTo와 같으면 바꾸지 않고, 다른 시각이면 다시 연기한다', () => {
    const to = new Date(NOW.getTime() + 30 * D);
    expect(decideEventStatus(base({ status: 'POSTPONED', startsAt: to, endsAt: new Date(to.getTime() + H) }), { kind: 'POSTPONE', postponedTo: to }, NOW)).toBeUndefined();
    const later = new Date(to.getTime() + 1);
    expect(decideEventStatus(base({ status: 'POSTPONED', startsAt: to, endsAt: new Date(to.getTime() + H) }), { kind: 'POSTPONE', postponedTo: later }, NOW)).toMatchObject({ status: 'POSTPONED', startsAt: later });
  });

  test('R-T41 ⑤ CANCELLED 회차의 연기는 EventStatusConflict(CANCELLED)다', () => {
    expect(() => decideEventStatus(base({ status: 'CANCELLED' }), { kind: 'POSTPONE', postponedTo: new Date(NOW.getTime() + 30 * D) }, NOW)).toThrow(EventStatusConflict);
    try {
      decideEventStatus(base({ status: 'CANCELLED' }), { kind: 'POSTPONE', postponedTo: new Date(NOW.getTime() + 30 * D) }, NOW);
    } catch (e) {
      expect((e as EventStatusConflict).reason).toBe('CANCELLED');
    }
  });

  test('R-T41 ⑤ 경계: 연기 시작이 지금보다 이르거나 같으면 409(POSTPONE_IN_PAST), 지금 + 1ms면 받는다. postponedTo가 없어도 409다', () => {
    const at = (ms: number) => () => decideEventStatus(base(), { kind: 'POSTPONE', postponedTo: new Date(NOW.getTime() + ms) }, NOW);
    expect(at(-1)).toThrow(EventStatusConflict);
    expect(at(0)).toThrow(EventStatusConflict);
    expect(at(1)()).toMatchObject({ status: 'POSTPONED' });
    expect(() => decideEventStatus(base(), { kind: 'POSTPONE' }, NOW)).toThrow(EventStatusConflict);
  });
});
