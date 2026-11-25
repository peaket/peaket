// 판매 승인 때 결제사 지정 고정(R-T19 ①②③, LCH-090, ADR-0062 결정 33, payment §2.2).
// 지정 없는 회차는 승인 시점의 플랫폼 기본값을 쓰고, 이미 지정된 회차와 재승인 뒤 기존 회차는 그대로 둔다.
import { describe, expect, test } from 'vitest';
import { fakeClock } from '@peaket/platform';
import { applyApproval, type SaleApprovalInput } from '../src/modules/catalog/domain/sale-approval.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/adapters/memory-catalog-repository.js';
import { MemorySaleStore } from '../src/modules/catalog/adapters/memory-sale-store.js';

const NOW = new Date('2026-11-25T00:00:00.000Z');
const OPEN = new Date('2026-11-27T09:00:00.000Z');
const START = new Date('2026-11-29T10:00:00.000Z');

function seed(o: { approved?: boolean; pgPrimary?: 'TOSS' | 'PORTONE' } = {}) {
  const repo = new MemoryCatalogRepository();
  repo.promoters.set('prom-1', {
    promoterId: 'prom-1',
    legalName: '(주)피켓공연',
    representative: '대표자',
    address: '서울',
    phone: '02-0000-0000',
    email: 'seller@example.test',
    businessRegNo: '123-45-67890',
    mailOrderReportNo: '2026-서울-0001',
    exemptionBasis: null,
    verifiedAt: null,
    commissionRateBp: 1000,
    pendingContractApprovalId: null,
  });
  repo.productions.set('prod-1', {
    id: 'prod-1',
    promoterId: 'prom-1',
    placeId: 'place-1',
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.approved ? 'SUBMITTED' : 'SUBMITTED',
    saleApprovedAt: o.approved ? new Date('2026-11-01T00:00:00.000Z') : null,
  });
  repo.events.set('ev-1', {
    id: 'ev-1',
    productionId: 'prod-1',
    venueId: null,
    openAt: OPEN,
    startsAt: START,
    status: 'SCHEDULED',
    ...(o.pgPrimary ? { pgPrimary: o.pgPrimary } : {}),
  });
  repo.events.set('ev-2', {
    id: 'ev-2',
    productionId: 'prod-1',
    venueId: null,
    openAt: new Date('2026-11-28T09:00:00.000Z'),
    startsAt: new Date('2026-11-30T10:00:00.000Z'),
    status: 'SCHEDULED',
  });
  const clock = fakeClock({ now: NOW.getTime() });
  const sales = new MemorySaleStore(repo);
  return { repo, sales, clock };
}

const defaults = { primary: 'PORTONE' as const, fallback: 'TOSS' as const };

describe('R-T19 판매 승인 때 결제사 지정 고정', () => {
  test('R-T19 ①_ 지정 없는 회차 둘을 승인하면 그 시점 기본값이 모든 회차에 저장된다', async () => {
    const w = seed();
    const state = (await w.sales.read('prod-1', 'prom-1'))!;
    const out = applyApproval(state, {
      now: NOW,
      scales: [
        { eventId: 'ev-1', scale: 'SMALL' },
        { eventId: 'ev-2', scale: 'SMALL' },
      ],
      pgDefaults: defaults,
    } as SaleApprovalInput);

    expect(out.events.map((e) => ({ eventId: e.eventId, pgPrimary: e.pgPrimary, pgFallback: e.pgFallback }))).toEqual([
      { eventId: 'ev-1', pgPrimary: 'PORTONE', pgFallback: 'TOSS' },
      { eventId: 'ev-2', pgPrimary: 'PORTONE', pgFallback: 'TOSS' },
    ]);
  });

  test('R-T19 ②_ 재승인은 이미 지정된 회차 값을 지키고 새로 더한 회차에만 기본값을 쓴다', async () => {
    const w = seed({ approved: true, pgPrimary: 'TOSS' });
    w.repo.pending.set('prod-1', [
      {
        eventId: 'ev-3',
        openAt: new Date('2026-12-01T09:00:00.000Z'),
        startsAt: new Date('2026-12-03T10:00:00.000Z'),
        endsAt: new Date('2026-12-03T12:00:00.000Z'),
        lobbyMinutes: 10,
        lobbyShuffle: true,
        openBatch: true,
        seatAssignment: 'PICK',
        perPersonLimit: 4,
        reentryAllowed: false,
        addedAt: NOW,
        venueId: null,
      },
    ]);
    const state = (await w.sales.read('prod-1', 'prom-1'))!;
    const out = applyApproval(state, {
      now: NOW,
      scales: [
        { eventId: 'ev-1', scale: 'MEDIUM' },
        { eventId: 'ev-2', scale: 'MEDIUM' },
        { eventId: 'ev-3', scale: 'MEDIUM' },
      ],
      pgDefaults: { primary: 'PORTONE' },
    } as SaleApprovalInput);

    expect(out.events.find((e) => e.eventId === 'ev-1')).toMatchObject({ pgPrimary: 'TOSS' });
    expect(out.events.find((e) => e.eventId === 'ev-2')).toMatchObject({ pgPrimary: 'PORTONE' });
    expect(out.events.find((e) => e.eventId === 'ev-3')).toMatchObject({ pgPrimary: 'PORTONE' });
    // 대체가 없으면 기존 값을 덮지 않는다
    expect(out.events.find((e) => e.eventId === 'ev-2')?.pgFallback).toBeUndefined();
  });

  test('R-T19 ③_ 승인 뒤 플랫폼 기본값을 바꿔도 저장된 회차 값은 그대로다', async () => {
    const w = seed();
    const first = applyApproval((await w.sales.read('prod-1', 'prom-1'))!, {
      now: NOW,
      scales: [{ eventId: 'ev-1', scale: 'SMALL' }],
      pgDefaults: defaults,
    } as SaleApprovalInput);
    expect(first.events.find((e) => e.eventId === 'ev-1')).toMatchObject({ pgPrimary: 'PORTONE', pgFallback: 'TOSS' });

    // 기본값을 바꾼 새 승인 입력은 이미 지정된 ev-1을 바꾸지 않는다
    const second = applyApproval(
      { ...first, production: { ...first.production, saleReview: 'SUBMITTED' } },
      {
        now: new Date(NOW.getTime() + 60_000),
        scales: [{ eventId: 'ev-1', scale: 'MEDIUM' }],
        pgDefaults: { primary: 'TOSS', fallback: 'PORTONE' },
      } as SaleApprovalInput,
    );
    expect(second.events.find((e) => e.eventId === 'ev-1')).toMatchObject({ pgPrimary: 'PORTONE', pgFallback: 'TOSS' });
  });
});
