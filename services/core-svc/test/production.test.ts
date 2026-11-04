// 공연 카드의 대표 회차·판매 상태와 같은 배치본·공개 여부(ADR-0093 결정 1·7·8, BUILD_ORDER HOT-170 ①)
import { EventSaleChanged } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { type CatalogEvent, cardSaleStatus, EVENT_SALE_STATES, type EventSaleState, isPublic, representativeEvent, sameVenue } from '../src/modules/catalog/domain/production.js';

const D = (s: string) => new Date(`2026-${s}T10:00:00.000Z`);
function ev(id: string, o: Partial<CatalogEvent> = {}): CatalogEvent {
  return { id, productionId: 'p1', venueId: 'v1', openAt: D('11-01'), startsAt: D('12-01'), status: 'SCHEDULED', ...o };
}
const row = (event: CatalogEvent, sale: EventSaleState) => ({ event, sale });
/** 시험의 지금 시각(회차 기본 시작 12-01보다 뒤) */
const NOW = D('12-15');
const rep = (rows: { event: CatalogEvent; sale: EventSaleState }[], now = NOW) => representativeEvent(rows, now);

test('회차 판매 상태는 EventSaleChanged.status의 다섯 값이다(판매 일시정지·판매 중지는 덧씌움 표시, planning/03 §2.15)', () => {
  expect([...EVENT_SALE_STATES].sort()).toEqual([...EventSaleChanged.shape.status.options].sort());
});

describe('대표 회차(결정 8)', () => {
  test('① 판매 중 회차 가운데 판매 종료(공연 시작 − 24시간)가 가장 이른 것. 일시 매진도 판매 중이다', () => {
    const rows = [row(ev('e1', { startsAt: D('12-20') }), 'ON_SALE'), row(ev('e2', { startsAt: D('12-10') }), 'ALL_HELD'), row(ev('e3', { startsAt: D('12-05') }), 'UPCOMING')];
    expect(rep(rows)?.id).toBe('e2');
    expect(rep([row(ev('e4', { startsAt: D('12-30') }), 'ALL_HELD'), row(ev('e5'), 'SOLD_OUT')])?.id).toBe('e4');
  });

  test('② 판매 중이 없으면 오픈 예정 가운데 오픈이 가장 이른 것', () => {
    const rows = [row(ev('e1', { openAt: D('11-20') }), 'UPCOMING'), row(ev('e2', { openAt: D('11-10') }), 'UPCOMING'), row(ev('e3'), 'SOLD_OUT')];
    expect(rep(rows)?.id).toBe('e2');
  });

  test('③ 그것도 없으면 매진 가운데 공연 시작이 가장 이른 것, ④ 그것도 없으면 가장 최근에 공연한 회차', () => {
    expect(rep([row(ev('e1', { startsAt: D('12-20') }), 'SOLD_OUT'), row(ev('e2', { startsAt: D('12-10') }), 'SOLD_OUT'), row(ev('e3'), 'ENDED')])?.id).toBe('e2');
    expect(rep([row(ev('e1', { startsAt: D('10-01') }), 'ENDED'), row(ev('e2', { startsAt: D('10-20') }), 'ENDED')])?.id).toBe('e2');
  });

  test('④는 이미 공연한 회차만 본다: 판매가 끝났지만 아직 공연 전인 회차는 공연한 회차가 있으면 고르지 않고, 없으면 곧 공연할 회차 가운데 가장 이른 것이다', () => {
    const now = new Date('2026-12-15T12:00:00.000Z');
    const done = row(ev('e1', { startsAt: D('12-14') }), 'ENDED');
    const tomorrow = row(ev('e2', { startsAt: D('12-16') }), 'ENDED');
    const later = row(ev('e3', { startsAt: new Date('2026-12-16T11:00:00.000Z') }), 'ENDED');
    expect(rep([done, tomorrow], now)?.id).toBe('e1');
    expect(rep([later, tomorrow], now)?.id).toBe('e2');
  });

  test('취소된 회차는 고르지 않고, 남은 회차가 없으면 없다. 같은 값이면 회차 ID가 작은 것', () => {
    expect(rep([row(ev('e1', { status: 'CANCELLED' }), 'ON_SALE'), row(ev('e2'), 'UPCOMING')])?.id).toBe('e2');
    expect(rep([row(ev('e1', { status: 'CANCELLED' }), 'ON_SALE')])).toBeUndefined();
    expect(rep([row(ev('eb'), 'ON_SALE'), row(ev('ea'), 'ON_SALE')])?.id).toBe('ea');
  });
});

describe('카드 판매 상태(결정 8, data.md search_document.sale_status)', () => {
  test('판매 중 하나라도 → 판매 중(일시 매진 포함), 없고 오픈 예정 → 오픈 예정', () => {
    expect(cardSaleStatus([row(ev('e1'), 'SOLD_OUT'), row(ev('e2'), 'ALL_HELD')])).toBe('ON_SALE');
    expect(cardSaleStatus([row(ev('e1'), 'SOLD_OUT'), row(ev('e2'), 'UPCOMING')])).toBe('UPCOMING');
  });

  test('남은 회차가 모두 매진 → 매진, 모두 판매 종료 → 끝남. 취소 회차는 세지 않는다', () => {
    expect(cardSaleStatus([row(ev('e1'), 'SOLD_OUT'), row(ev('e2'), 'ENDED'), row(ev('e3', { status: 'CANCELLED' }), 'ON_SALE')])).toBe('SOLD_OUT');
    expect(cardSaleStatus([row(ev('e1'), 'ENDED'), row(ev('e2'), 'ENDED')])).toBe('ENDED');
    expect(cardSaleStatus([])).toBe('ENDED');
  });
});

test('한 공연의 회차는 같은 배치본(결정 1)', () => {
  expect(sameVenue([ev('e1'), ev('e2')], 'v1')).toBe(true);
  expect(sameVenue([ev('e1'), ev('e2')], 'v2')).toBe(false);
  expect(sameVenue([], 'v9')).toBe(true);
});

test('공개는 한 번 승인되고 판매 중지가 아닐 때(재승인 대기·반려 중에도 마지막 승인 내용으로 공개, 결정 7)', () => {
  const at = D('10-01');
  expect(isPublic({ saleReview: 'APPROVED', saleApprovedAt: at })).toBe(true);
  expect(isPublic({ saleReview: 'SUBMITTED', saleApprovedAt: at })).toBe(true);
  expect(isPublic({ saleReview: 'REJECTED', saleApprovedAt: at })).toBe(true);
  expect(isPublic({ saleReview: 'SUSPENDED', saleApprovedAt: at })).toBe(false);
  expect(isPublic({ saleReview: 'SUBMITTED', saleApprovedAt: null })).toBe(false);
});
