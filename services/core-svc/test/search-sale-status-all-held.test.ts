// F-07-12 RV-02: search_document가 ALL_HELD를 담아도 공개 카드 계약은 네 값 그대로인지,
// 파트너 목록이 회차 원값을 모아 saleStatus=ALL_HELD로 거르는지, 사본이 없는 회차는 시간으로 계산하는지 본다.
// 정본: openapi ProductionCard.saleStatus, docs/data.md search_document·event_sale, ADR-0093 결정 8·ADR-0122.
// 기준 트리에는 catalog/domain/event-sale-state.ts가 없어 이 시험이 실패한다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { type DocumentRow, documentOfRow } from '../src/modules/catalog/adapters/db/search-rows.js';
import {
  effectiveEventSaleStatus,
  publicSaleStatusOf,
  saleStatesByProduction,
  searchSaleStatusOf,
  shouldApplyEventSale,
} from '../src/modules/catalog/domain/event-sale-state.js';
import { matchesPartnerQuery, type PartnerProductionSummaryRow } from '../src/modules/catalog/domain/partner-home.js';

const T0 = Date.parse('2026-11-27T03:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const documentRow = (saleStatus: string): DocumentRow => ({
  production_id: '0190f3a1-7c2e-7a00-8000-00000000a001',
  representative_event_id: null,
  title: '루멘 콘서트',
  genre: '콘서트',
  place_id: null,
  place_name: null,
  artists: [],
  aliases: [],
  period_start: null,
  period_end: null,
  next_open_at: null,
  next_open_event_id: null,
  sale_status: saleStatus,
  sale_ends_at: null,
  min_price: null,
  poster_image_id: null,
  poster_alt: null,
  interest: 0,
});

const partnerRow = (states: PartnerProductionSummaryRow['saleStates']): PartnerProductionSummaryRow => ({
  productionId: '0190f3a1-7c2e-7a00-8000-00000000a001',
  title: '루멘 콘서트',
  eventCount: 2,
  saleReview: 'APPROVED',
  hasApprovalHistory: true,
  rejectionReason: null,
  suspensionReasonCode: null,
  firstOpenAt: new Date(T0 + DAY),
  saleStates: states,
});

describe('F-07-12 RV-02 공개 카드·파트너 목록의 ALL_HELD', () => {
  test('RV2-07 두 회차가 ON_SALE·ALL_HELD이면 사본을 모두 모으고 ALL_HELD 필터가 그 공연을 반환한다', () => {
    const byProduction = saleStatesByProduction([
      { productionId: 'p1', status: 'ON_SALE' },
      { productionId: 'p1', status: 'ALL_HELD' },
      { productionId: 'p2', status: 'SOLD_OUT' },
    ]);
    expect(byProduction.get('p1')).toEqual(['ON_SALE', 'ALL_HELD']);
    expect(byProduction.get('p2')).toEqual(['SOLD_OUT']);
    expect(matchesPartnerQuery(partnerRow(byProduction.get('p1') ?? []), { saleStatus: ['ALL_HELD'], limit: 20 })).toBe(true);
    expect(matchesPartnerQuery(partnerRow(byProduction.get('p2') ?? []), { saleStatus: ['ALL_HELD'], limit: 20 })).toBe(false);
  });

  test('RV2-08 사본이 없는 회차는 지금처럼 오픈·시작 시각으로 계산한다', () => {
    const openAt = new Date(T0 - DAY);
    const startsAt = new Date(T0 + 5 * DAY);
    const before = { openAt: new Date(T0 + DAY), startsAt: new Date(T0 + 8 * DAY) };
    expect(effectiveEventSaleStatus(null, before, new Date(T0))).toBe('UPCOMING');
    expect(effectiveEventSaleStatus(null, { openAt, startsAt }, new Date(T0))).toBe('ON_SALE');
    expect(effectiveEventSaleStatus(null, { openAt, startsAt }, new Date(startsAt.getTime() - DAY))).toBe('ENDED');
    // 사본이 있으면 시각과 상관없이 사본이 이긴다
    expect(effectiveEventSaleStatus('ALL_HELD', { openAt, startsAt }, new Date(T0))).toBe('ALL_HELD');
    expect(effectiveEventSaleStatus('SOLD_OUT', { openAt, startsAt }, new Date(T0))).toBe('SOLD_OUT');
  });

  test('RV2-11 DB의 ALL_HELD는 공개 카드에서 ON_SALE로 접고 나머지 네 값은 그대로다', () => {
    expect(publicSaleStatusOf('ALL_HELD')).toBe('ON_SALE');
    expect(documentOfRow(documentRow('ALL_HELD'), undefined).saleStatus).toBe('ON_SALE');
    for (const status of ['UPCOMING', 'ON_SALE', 'SOLD_OUT', 'ENDED'] as const) {
      expect(publicSaleStatusOf(status)).toBe(status);
      expect(documentOfRow(documentRow(status), undefined).saleStatus).toBe(status);
    }
  });

  test('RV2-12 공연 합성은 판매 중 → 일시 매진 → 오픈 예정 → 매진 → 끝남 차례다', () => {
    expect(searchSaleStatusOf([])).toBe('ENDED');
    expect(searchSaleStatusOf(['ALL_HELD'])).toBe('ALL_HELD');
    expect(searchSaleStatusOf(['ON_SALE', 'ALL_HELD'])).toBe('ON_SALE');
    expect(searchSaleStatusOf(['ALL_HELD', 'UPCOMING'])).toBe('ALL_HELD');
    expect(searchSaleStatusOf(['UPCOMING'])).toBe('UPCOMING');
    expect(searchSaleStatusOf(['SOLD_OUT', 'SOLD_OUT'])).toBe('SOLD_OUT');
    expect(searchSaleStatusOf(['ENDED', 'SOLD_OUT'])).toBe('SOLD_OUT');
    expect(searchSaleStatusOf(['ENDED'])).toBe('ENDED');
  });

  test('RV2-04-보조 판 번호 비교는 처음 쓰기와 큰 판만 허용한다', () => {
    expect(shouldApplyEventSale(null, 1)).toBe(true);
    expect(shouldApplyEventSale(1, 1)).toBe(false);
    expect(shouldApplyEventSale(1, 2)).toBe(true);
    expect(shouldApplyEventSale(2, 1)).toBe(false);
  });

  test('RV2-13 파트너 목록 질의는 search_document 한 값이 아니라 회차 원값 event_sale_state를 읽는다', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/modules/catalog/adapters/db/drizzle-catalog-repository.ts', import.meta.url)), 'utf8');
    expect(src).toContain('left join event_sale_state s on s.event_id = e.id');
    expect(src).toContain('coalesce(s.status');
    expect(src).toContain('p.promoter_id = ${tenantId}::uuid');
    // 예전의 search_document 사본 한 값 읽기가 남아 있지 않다
    expect(src).not.toContain('d.sale_status');
    expect(src).not.toContain('from search_document d');
  });

  test('RV2-14 공개 검색의 ON_SALE 필터·순위는 ALL_HELD를 판매 중으로 센다', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/modules/catalog/adapters/db/drizzle-search-index.ts', import.meta.url)), 'utf8');
    expect(src).toContain("case sale_status when 'ON_SALE' then 0 when 'ALL_HELD' then 0");
    expect(src).toContain("sale_status in ('ON_SALE', 'ALL_HELD')");
  });
});
