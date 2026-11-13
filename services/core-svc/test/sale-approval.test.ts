// 판매 승인 실행(판매 승인 LCH-080, openapi POST /v1/ops/sale-reviews/{productionId}/approvals).
// 메모리 판매 저장소로 pending_revision 적용·규모·설정 사본·반려를 단위 시험한다.
import { describe, expect, test } from 'vitest';
import { fakeClock, ProblemError } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { ApproveSaleReview } from '../src/modules/catalog/application/approve-sale-review.js';
import { applyApproval } from '../src/modules/catalog/domain/sale-approval.js';
import { PublishSaleConfigs } from '../src/modules/catalog/application/publish-sale-configs.js';
import { RejectSaleReview } from '../src/modules/catalog/application/reject-sale-review.js';
import { MemorySaleConfigStore } from '../src/modules/catalog/adapters/memory-sale-config-store.js';
import { MemorySaleStore } from '../src/modules/catalog/adapters/memory-sale-store.js';
import { NoopSaleConfigFacts } from '../src/modules/catalog/adapters/noop-sale-config-facts.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/adapters/memory-catalog-repository.js';

const OPEN = new Date('2026-11-01T09:00:00.000Z');
const START = new Date('2026-11-03T10:00:00.000Z');
const NOW = new Date('2026-11-01T00:00:00.000Z');

const presale: SalePolicyRule = {
  version: 1,
  name: '팬클럽 선예매',
  rounds: 'ALL',
  during: { from: '2026-11-01T10:00:00.000Z', to: '2026-11-01T12:00:00.000Z' },
  rule: { if: { fact: 'buyer.lists', has: 'lumen-fanclub-2026' }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
};
const general: SalePolicyRule = { version: 1, name: '일반', rounds: 'ALL', rule: { then: { limitPerPerson: 4 } } };

function world() {
  const repo = new MemoryCatalogRepository();
  repo.productions.set('prod-1', { id: 'prod-1', promoterId: 'prom-1', placeId: null, title: '공연', genre: '콘서트', saleReview: 'SUBMITTED', saleApprovedAt: null });
  repo.events.set('ev-1', { id: 'ev-1', productionId: 'prod-1', venueId: null, openAt: OPEN, startsAt: START, status: 'SCHEDULED' });
  repo.salePolicies.set('prod-1', { rules: [general], version: 2, pending: [presale, general] });
  repo.eventChanges.set('prod-1', { 'ev-1': { perPersonLimit: 2, lobbyShuffle: false } });
  repo.saleLists.set('l-1', {
    id: 'l-1',
    key: 'lumen-fanclub-2026',
    name: '팬클럽',
    memberCount: 1,
    version: 1,
    copySeq: 1,
    copiedSeq: null,
    uploadedAt: NOW,
    lockedAt: null,
    destroyDueAt: new Date('2026-11-04T10:00:00.000Z'),
    productionId: 'prod-1',
    promoterId: 'prom-1',
    fileSha256: new Uint8Array(),
    uploadedBy: 'acc-1',
    members: new Set(['acc-1']),
  });
  const clock = fakeClock({ now: NOW.getTime() });
  const configs = new MemorySaleConfigStore();
  const sales = new MemorySaleStore(repo);
  const publish = new PublishSaleConfigs(sales, configs, new NoopSaleConfigFacts(), clock);
  return { repo, clock, configs, sales, approve: new ApproveSaleReview(sales, publish, clock), reject: new RejectSaleReview(sales, clock) };
}

describe('판매 승인 실행(LCH-080)', () => {
  test('S-T41 applyApproval은 pending 회차 고침·더한 회차·규모를 공개본에 싣는다', async () => {
    const w = world();
    w.repo.pending.set('prod-1', [
      {
        eventId: 'ev-2',
        openAt: new Date('2026-11-02T09:00:00.000Z'),
        startsAt: new Date('2026-11-04T10:00:00.000Z'),
        endsAt: new Date('2026-11-04T12:30:00.000Z'),
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
    const s = (await w.sales.read('prod-1', 'prom-1'))!;
    const out = applyApproval(s, {
      now: NOW,
      scales: [
        { eventId: 'ev-1', scale: 'SMALL' },
        { eventId: 'ev-2', scale: 'MEDIUM' },
      ],
    });
    expect(out.events.find((e) => e.eventId === 'ev-1')).toMatchObject({ perPersonLimit: 2, lobbyShuffle: false, scale: 'SMALL' });
    expect(out.events.find((e) => e.eventId === 'ev-2')).toMatchObject({ scale: 'MEDIUM', version: 1 });
    expect(out.production.pendingRules).toBeUndefined();
  });

  test('S-T41 승인은 pending 규칙·회차 고침·규모를 적용하고 설정 사본을 쓴다', async () => {
    const w = world();
    await expect(w.approve.run({ productionId: 'prod-1', scales: [{ eventId: 'ev-1', scale: 'SMALL' }], placeId: 'place-1', accessibleSeatingCheck: true })).resolves.toEqual({ applied: true, events: 1 });
    expect(w.repo.productions.get('prod-1')).toMatchObject({ saleReview: 'APPROVED', placeId: 'place-1' });
    expect(w.repo.salePolicies.get('prod-1')?.rules).toEqual([presale, general]);
    expect(w.repo.salePolicies.get('prod-1')?.pending).toBeUndefined();
    expect(w.repo.eventChanges.get('prod-1')).toBeUndefined();
    expect(w.repo.events.get('ev-1')).toMatchObject({ startsAt: START, status: 'SCHEDULED' });
    expect(w.configs.configs.get('ev-1')?.salePolicy).toEqual([presale, general]);
    expect(w.configs.configs.get('ev-1')?.eligGates[0]?.lists).toEqual(['lumen-fanclub-2026']);
  });

  test('S-T41 모든 회차의 규모가 없거나 규칙의 명단이 없으면 승인하지 않는다', async () => {
    const w = world();
    await expect(w.approve.run({ productionId: 'prod-1', scales: [], placeId: 'place-1' })).rejects.toBeInstanceOf(ProblemError);
    w.repo.saleLists.clear();
    await expect(w.approve.run({ productionId: 'prod-1', scales: [{ eventId: 'ev-1', scale: 'SMALL' }], placeId: 'place-1' })).rejects.toMatchObject({ type: 'https://peaket.example/problems/sale-review-list-missing' });
  });

  test('S-T41 반려는 상태만 REJECTED로 바꾸고 pending 규칙을 남긴다', async () => {
    const w = world();
    await expect(w.reject.run({ productionId: 'prod-1', reason: '판매자 정보 보완' })).resolves.toEqual({ applied: true });
    expect(w.repo.productions.get('prod-1')?.saleReview).toBe('REJECTED');
    expect(w.repo.salePolicies.get('prod-1')?.pending).toEqual([presale, general]);
  });
});
