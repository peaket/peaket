// 회차 판매 설정 사본(판매 승인 LCH-080, docs/features/seat-hold.md §4, docs/data.md `q:{event:E}:cfg`).
// BAT-051(purchase-svc 홀드의 판매 정책 평가)이 읽을 salePolicy·eligGates·eligLists의 모양과 값을 단위 시험으로 본다.
import { describe, expect, test } from 'vitest';
import { fakeClock, ProblemError } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { buildEventSaleConfigs, eligibleListKeys } from '../src/modules/catalog/domain/event-sale-config.js';
import { PublishSaleConfigs } from '../src/modules/catalog/application/publish-sale-configs.js';
import { MemorySaleConfigStore } from '../src/modules/catalog/adapters/memory-sale-config-store.js';
import { NoopSaleConfigFacts } from '../src/modules/catalog/adapters/noop-sale-config-facts.js';
import type { SaleEventRow, SaleState, SaleStore } from '../src/modules/catalog/domain/sale-ports.js';

const OPEN = new Date('2026-11-01T09:00:00.000Z');
const START = new Date('2026-11-03T10:00:00.000Z');
const SALE_END = new Date(START.getTime() - 24 * 60 * 60_000);

const presale: SalePolicyRule = {
  version: 1,
  name: '팬클럽 선예매',
  rounds: 'ALL',
  during: { from: '2026-11-01T10:00:00.000Z', to: '2026-11-01T12:00:00.000Z' },
  rule: { if: { fact: 'buyer.lists', has: 'lumen-fanclub-2026' }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
};
const general: SalePolicyRule = { version: 1, name: '일반', rounds: 'ALL', rule: { then: { limitPerPerson: 4 } } };

function eventRow(over: Partial<SaleEventRow> = {}): SaleEventRow {
  return {
    eventId: 'ev-1',
    status: 'SCHEDULED',
    version: 3,
    openAt: OPEN,
    startsAt: START,
    endsAt: new Date(START.getTime() + 2 * 3_600_000),
    entryOpensAt: null,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: true,
    seatAssignment: 'PICK',
    perPersonLimit: 4,
    ...over,
  };
}

function state(over: Partial<SaleState> = {}): SaleState {
  return {
    production: {
      id: 'prod-1',
      promoterId: 'prom-1',
      saleReview: 'APPROVED',
      saleApprovedAt: new Date('2026-10-30T00:00:00.000Z'),
      rules: [presale, general],
      pendingRules: undefined,
      salePolicyVersion: 2,
    },
    events: [eventRow()],
    eventChanges: {},
    addedEvents: [],
    grades: ['VIP', 'R'],
    lists: [],
    ...over,
  };
}

describe('회차 판매 설정 사본(LCH-080)', () => {
  test('S-T41 승인된규칙으로_salePolicy_eligGates_eligLists를_만든다', () => {
    const [c] = buildEventSaleConfigs(state(), new Map([['ev-1', { layoutVersion: 7, pgKey: 'toss-a', pgTps: 300 }]]), new Date());
    expect(c).toMatchObject({
      eventId: 'ev-1',
      productionId: 'prod-1',
      promoterId: 'prom-1',
      rev: 3,
      opensAtMs: OPEN.getTime(),
      startsAtMs: START.getTime(),
      lobbyMinutes: 10,
      lobbyShuffle: true,
      openBatch: true,
      perPersonLimit: 4,
      saleEndsAtMs: SALE_END.getTime(),
      layoutVersion: 7,
      pgKey: 'toss-a',
      pgTps: 300,
    });
    expect(c!.salePolicy).toEqual([presale, general]);
    expect(c!.eligGates).toEqual([{ fromMs: Date.parse('2026-11-01T10:00:00.000Z'), toMs: Date.parse('2026-11-01T12:00:00.000Z'), lists: ['lumen-fanclub-2026'] }]);
    expect(c!.eligLists).toEqual(['lumen-fanclub-2026']);
  });

  test('S-T41 취소회차는_빼고_규칙의명단키를_중첩조건에서도_모은다', () => {
    const nested: SalePolicyRule = {
      version: 1,
      name: '중첩',
      rounds: ['ev-1'],
      rule: { if: { all: [{ any: [{ fact: 'buyer.lists', has: 'a-list' }, { not: { fact: 'buyer.lists', has: 'b-list' } }] }] }, then: { allow: true } },
    };
    const s = state({ production: { ...state().production, rules: [nested] }, events: [eventRow(), eventRow({ eventId: 'ev-2', status: 'CANCELLED' })] });
    const configs = buildEventSaleConfigs(s, new Map(), new Date());
    expect(configs.map((c) => c.eventId)).toEqual(['ev-1']);
    expect(configs[0]!.eligLists.sort()).toEqual(['a-list', 'b-list']);
    expect(eligibleListKeys([nested], 'ev-1').sort()).toEqual(['a-list', 'b-list']);
  });

  test('S-T41 승인전공연은_회차설정을_쓰지않는다', async () => {
    const store = new MemorySaleConfigStore();
    const sales = { read: async () => state({ production: { ...state().production, saleReview: 'SUBMITTED', saleApprovedAt: null } }) } as unknown as SaleStore;
    const publish = new PublishSaleConfigs(sales, store, new NoopSaleConfigFacts(), fakeClock());
    await expect(publish.run({ productionId: 'prod-1', tenantId: 'prom-1' })).rejects.toBeInstanceOf(ProblemError);
  });

  test('S-T41 승인공연은_coreDB와_대기열사본에_같은값을_쓴다', async () => {
    const store = new MemorySaleConfigStore();
    const sales = { read: async () => state() } as unknown as SaleStore;
    const clock = fakeClock();
    const publish = new PublishSaleConfigs(sales, store, new NoopSaleConfigFacts(), clock);
    await expect(publish.run({ productionId: 'prod-1', tenantId: 'prom-1' })).resolves.toEqual({ events: 1, rev: 3 });
    const saved = await store.get('ev-1');
    expect(saved?.salePolicy).toEqual([presale, general]);
    expect(saved?.eligGates[0]?.lists).toEqual(['lumen-fanclub-2026']);
    expect(store.admission.get('ev-1')).toBe(START.getTime());
  });
});
