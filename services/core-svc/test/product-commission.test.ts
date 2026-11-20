// 판매 승인·상품 게시 때 수수료율 고정(BAT-615 LCH-070, J-T30 ①~④, ADR-0320, settlement §4.1·§4.5).
// 상품은 계약 표의 지금 수수료율을 처음 게시할 때만 복사하고, 판매 승인은 그 트랜잭션 안에서 읽은 값을
// event.commission_rate_bp와 회차 설정 사본에 고정한다. payment-svc는 내부 commission-rate 경로로 같은 값을 읽는다.
import 'reflect-metadata';
import { fakeClock, createService, ProblemError } from '@peaket/platform';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { MemoryPromoterStore } from '../src/modules/catalog/index.js';
import { MemorySaleConfigStore, QueueSaleConfigStore } from '../src/modules/catalog/index.js';
import type { EventSaleConfig } from '../src/modules/catalog/index.js';
import { MemorySaleStore } from '../src/modules/catalog/adapters/memory-sale-store.js';
import { ApproveSaleReview } from '../src/modules/catalog/application/approve-sale-review.js';
import { PublishSaleConfigs } from '../src/modules/catalog/application/publish-sale-configs.js';
import { NoopSaleConfigFacts } from '../src/modules/catalog/adapters/noop-sale-config-facts.js';
import { MemoryProductStore } from '../src/modules/shop/index.js';
import { MemoryProductTypeDirectory } from '../src/modules/shop/index.js';
import { MemoryProductEventDirectory } from '../src/modules/shop/index.js';
import { MemoryMerchStock } from '../src/modules/shop/index.js';
import { Products } from '../src/modules/shop/index.js';
import { silentShopLogger } from '../src/modules/shop/index.js';
import type { ProductInput } from '../src/modules/shop/index.js';
import type { CommissionRateSource } from '../src/modules/shop/domain/ports.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

const NOW = new Date(NOW_MS);
const T1 = new Date('2026-11-20T01:00:00.000Z');
const T2 = new Date('2026-11-21T00:00:00.000Z');
const general: SalePolicyRule = { version: 1, name: '일반', rounds: 'ALL', rule: { then: { limitPerPerson: 4 } } };

/** 계약 표(메모리 promoter_contract)의 지금 기간을 심는다 */
function seedPromoter(repo: MemoryCatalogRepository, promoterId: string, commissionRateBp: number): void {
  repo.promoters.set(promoterId, {
    promoterId,
    legalName: `파트너-${promoterId}`,
    representative: null,
    address: null,
    phone: null,
    email: null,
    businessRegNo: null,
    mailOrderReportNo: null,
    exemptionBasis: null,
    verifiedAt: null,
    commissionRateBp,
    pendingContractApprovalId: null,
  });
  repo.sellerNames.set(promoterId, `파트너-${promoterId}`);
  repo.promoterContracts.set(promoterId, [{ id: randomUUID(), commissionRateBp, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', validFrom: T1, validUntil: null, approvalId: null, createdBy: randomUUID() }]);
}

/** 계약 변경 승인의 결과와 같은 모양: 옛 기간을 자르고 새 기간을 더한다 */
function changeContract(repo: MemoryCatalogRepository, promoterId: string, commissionRateBp: number, at: Date): void {
  const periods = repo.promoterContracts.get(promoterId) ?? [];
  const current = periods.find((p) => p.validUntil === null)!;
  repo.promoterContracts.set(
    promoterId,
    periods
      .map((p) => (p.id === current.id ? { ...p, validUntil: at } : p))
      .concat({ id: randomUUID(), commissionRateBp, guaranteeRateBp: 650, guaranteeKind: 'DEPOSIT', validFrom: at, validUntil: null, approvalId: randomUUID(), createdBy: randomUUID() }),
  );
  const promoter = repo.promoters.get(promoterId);
  if (promoter) repo.promoters.set(promoterId, { ...promoter, commissionRateBp });
}

/** 계약 표를 읽는 상품 수수료율 원천. 계약도 promoter 값도 없으면 1000bp로 대신하지 않고 실패한다 */
function commissionOf(promoters: MemoryPromoterStore): CommissionRateSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async rateBp(promoterId: string) {
      calls.push(promoterId);
      const bp = await promoters.currentCommissionRateBp(promoterId);
      if (bp === undefined) throw new Error('계약 조건이 없어 상품 수수료율을 정할 수 없다');
      return bp;
    },
  };
}

const productInput = (o: Partial<ProductInput> = {}): ProductInput => ({
  type: 'MERCH',
  name: '겨울 응원봉',
  price: 45_000,
  ticketLinked: false,
  fulfillments: ['PICKUP'],
  status: 'PUBLISHED',
  ...o,
});

describe('J-T30 ④ 상품 게시 수수료율의 원천은 계약 표다', () => {
  test('J-T30 ④_첫_게시는_계약_875bp를_복사하고_계약이_바뀌어도_이미_게시된_상품은_그대로다', async () => {
    const repo = new MemoryCatalogRepository();
    const promoters = new MemoryPromoterStore(repo);
    const commission = commissionOf(promoters);
    const store = new MemoryProductStore();
    const products = new Products({
      store,
      directory: new MemoryProductEventDirectory(),
      commission,
      clock: fakeClock({ now: NOW_MS }),
      types: new MemoryProductTypeDirectory(),
      stock: new MemoryMerchStock(),
      logger: silentShopLogger,
    });
    seedPromoter(repo, 'p-875', 875);

    const first = await products.create('p-875', productInput());
    const firstRecord = store.rows.get(first.productId)!;
    expect(firstRecord.commissionRateBp).toBe(875);
    expect(commission.calls).toEqual(['p-875']);

    changeContract(repo, 'p-875', 900, T2);
    const edited = await products.update('p-875', first.productId, { name: '겨울 응원봉 리뉴얼' }, '"1"');
    expect(edited.version).toBe(2);
    expect(store.rows.get(first.productId)!.commissionRateBp).toBe(875);

    const second = await products.create('p-875', productInput({ name: '봄 응원봉' }));
    expect(store.rows.get(second.productId)!.commissionRateBp).toBe(900);
    expect(commission.calls).toEqual(['p-875', 'p-875']);
  });

  test('J-T30 ④_초안은_수수료율을_읽지_않고_계약이_없으면_1000bp로_대신하지_않는다', async () => {
    const repo = new MemoryCatalogRepository();
    const promoters = new MemoryPromoterStore(repo);
    const commission = commissionOf(promoters);
    const store = new MemoryProductStore();
    const products = new Products({
      store,
      directory: new MemoryProductEventDirectory(),
      commission,
      clock: fakeClock({ now: NOW_MS }),
      types: new MemoryProductTypeDirectory(),
      stock: new MemoryMerchStock(),
      logger: silentShopLogger,
    });
    const draft = await products.create('p-none', productInput({ status: 'DRAFT' }));
    expect(store.rows.get(draft.productId)!.commissionRateBp).toBeNull();
    expect(commission.calls).toEqual([]);

    await expect(products.create('p-none', productInput({ name: '계약 없는 게시' }))).rejects.toThrow('계약 조건이 없어');
    expect(store.rows.size).toBe(1);
  });

  test('J-T30 ④_database_조립은_DrizzleCommissionRate를_COMMISSION_RATE_SOURCE로_넘긴다', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const shop = readFileSync(new URL('../src/modules/shop/shop.module.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/commission:\s*new DrizzleCommissionRate\(partnerDatabase\)/);
    expect(shop).toMatch(/COMMISSION_RATE_SOURCE/);
    expect(shop).toContain("o.storage === 'memory' ? o.wiring?.commission : o.commission");
  });
});

interface SaleWorld {
  repo: MemoryCatalogRepository;
  configs: MemorySaleConfigStore;
  approve: ApproveSaleReview;
}

function saleWorld(): SaleWorld {
  const repo = new MemoryCatalogRepository();
  const clock = fakeClock({ now: NOW_MS });
  const configs = new MemorySaleConfigStore();
  const sales = new MemorySaleStore(repo);
  const publish = new PublishSaleConfigs(sales, configs, new NoopSaleConfigFacts(), clock);
  return { repo, configs, approve: new ApproveSaleReview(sales, publish, clock) };
}

function addProduction(repo: MemoryCatalogRepository, productionId: string, promoterId: string, eventIds: string[], saleReview: 'SUBMITTED' | 'APPROVED' = 'SUBMITTED'): void {
  repo.productions.set(productionId, { id: productionId, promoterId, placeId: null, title: productionId, genre: '콘서트', saleReview, saleApprovedAt: saleReview === 'APPROVED' ? T1 : null });
  for (const [i, eventId] of eventIds.entries()) {
    repo.events.set(eventId, {
      id: eventId,
      productionId,
      venueId: null,
      openAt: new Date(NOW_MS + (i + 1) * 24 * 3_600_000),
      startsAt: new Date(NOW_MS + (i + 10) * 24 * 3_600_000),
      status: 'SCHEDULED',
    });
  }
  repo.salePolicies.set(productionId, { rules: [general], version: 1 });
}

describe('J-T30 ①~③ 판매 승인 트랜잭션의 수수료율 고정', () => {
  test('J-T30 ①_첫_승인은_모든_회차에_계약_875bp를_고정하고_설정_사본에_싣는다', async () => {
    const w = saleWorld();
    seedPromoter(w.repo, 'p-875', 875);
    addProduction(w.repo, 'prod-1', 'p-875', ['ev-1', 'ev-2']);

    await expect(w.approve.run({ productionId: 'prod-1', scales: [{ eventId: 'ev-1', scale: 'SMALL' }, { eventId: 'ev-2', scale: 'MEDIUM' }], placeId: randomUUID() })).resolves.toEqual({ applied: true, events: 2 });

    expect(w.repo.eventCommissionRates.get('ev-1')).toBe(875);
    expect(w.repo.eventCommissionRates.get('ev-2')).toBe(875);
    expect(w.configs.configs.get('ev-1')).toMatchObject({ commissionRateBp: 875 });
    expect(w.configs.configs.get('ev-2')).toMatchObject({ commissionRateBp: 875 });
  });

  test('J-T30 ②_계약이_900bp로_바뀌어도_이미_승인된_회차와_사본은_875다', async () => {
    const w = saleWorld();
    seedPromoter(w.repo, 'p-875', 875);
    addProduction(w.repo, 'prod-1', 'p-875', ['ev-1']);
    await w.approve.run({ productionId: 'prod-1', scales: [{ eventId: 'ev-1', scale: 'SMALL' }], placeId: randomUUID() });

    changeContract(w.repo, 'p-875', 900, T2);
    // 정비 일이 사본을 다시 써도 회차 값이 875라 875다
    await new PublishSaleConfigs(new MemorySaleStore(w.repo), w.configs, new NoopSaleConfigFacts(), fakeClock({ now: NOW_MS })).run({ productionId: 'prod-1', tenantId: 'p-875' });
    expect(w.repo.eventCommissionRates.get('ev-1')).toBe(875);
    expect(w.configs.configs.get('ev-1')?.commissionRateBp).toBe(875);

    addProduction(w.repo, 'prod-2', 'p-875', ['ev-2']);
    await w.approve.run({ productionId: 'prod-2', scales: [{ eventId: 'ev-2', scale: 'SMALL' }], placeId: randomUUID() });
    expect(w.repo.eventCommissionRates.get('ev-2')).toBe(900);
    expect(w.configs.configs.get('ev-2')?.commissionRateBp).toBe(900);
  });

  test('J-T30 ③_재승인은_기존_회차를_그대로_두고_더한_회차에만_그때의_900bp를_쓴다', async () => {
    const w = saleWorld();
    seedPromoter(w.repo, 'p-875', 875);
    addProduction(w.repo, 'prod-1', 'p-875', ['ev-1']);
    await w.approve.run({ productionId: 'prod-1', scales: [{ eventId: 'ev-1', scale: 'SMALL' }], placeId: randomUUID() });

    changeContract(w.repo, 'p-875', 900, T2);
    const production = w.repo.productions.get('prod-1')!;
    w.repo.productions.set('prod-1', { ...production, saleReview: 'SUBMITTED' });
    w.repo.pending.set('prod-1', [
      {
        eventId: 'ev-2',
        openAt: new Date(NOW_MS + 5 * 24 * 3_600_000),
        startsAt: new Date(NOW_MS + 15 * 24 * 3_600_000),
        endsAt: new Date(NOW_MS + 15 * 24 * 3_600_000 + 2 * 3_600_000),
        lobbyMinutes: 10,
        lobbyShuffle: true,
        openBatch: true,
        seatAssignment: 'PICK',
        perPersonLimit: 4,
        reentryAllowed: false,
        addedAt: T2,
        venueId: null,
      },
    ]);
    await w.approve.run({ productionId: 'prod-1', scales: [{ eventId: 'ev-1', scale: 'SMALL' }, { eventId: 'ev-2', scale: 'MEDIUM' }], placeId: randomUUID() });

    expect(w.repo.eventCommissionRates.get('ev-1')).toBe(875);
    expect(w.repo.eventCommissionRates.get('ev-2')).toBe(900);
    expect(w.configs.configs.get('ev-1')?.commissionRateBp).toBe(875);
    expect(w.configs.configs.get('ev-2')?.commissionRateBp).toBe(900);
  });

  test('J-T30 ⑤_계약이_없어_수수료율을_읽지_못하면_회차에_비워_두고_설정에도_넣지_않는다', () => {
    const w = saleWorld();
    addProduction(w.repo, 'prod-1', 'p-none', ['ev-1']);
    const sales = new MemorySaleStore(w.repo);
    return sales.withLockedProduction('prod-1', 'p-none', async (tx) => {
      expect(await tx.currentCommissionRateBp('p-none')).toBeUndefined();
      const state = await tx.state();
      const [config] = (await import('../src/modules/catalog/domain/event-sale-config.js')).buildEventSaleConfigs(state, new Map(), NOW);
      expect(config?.commissionRateBp).toBeUndefined();
    });
  });
});

describe('J-T30 ① 대기열 사본 q:{event:E}:cfg의 config JSON', () => {
  test('J-T30 ①_대기열_사본에도_commissionRateBp_875가_들어간다', async () => {
    const calls: string[][] = [];
    const redis = {
      async sendCommand(args: string[]) {
        calls.push(args);
        if (args[0] === 'HGETALL') return [];
        return 1;
      },
    };
    const queue = new QueueSaleConfigStore(redis as never);
    const config: EventSaleConfig = {
      eventId: 'ev-queue',
      productionId: 'prod-queue',
      promoterId: 'p-875',
      rev: 2,
      opensAtMs: T1.getTime(),
      startsAtMs: NOW_MS + 10 * 24 * 3_600_000,
      lobbyMinutes: 10,
      lobbyShuffle: true,
      openBatch: true,
      perPersonLimit: 4,
      saleEndsAtMs: NOW_MS + 9 * 24 * 3_600_000,
      commissionRateBp: 875,
      salePolicy: [general],
      eligGates: [],
      eligLists: [],
    };
    await queue.put([config], [{ eventId: 'ev-queue', startsAtMs: config.startsAtMs }]);
    const hset = calls.find((c) => c[0] === 'HSET')!;
    const fields = new Map<string, string>();
    for (let i = 2; i + 1 < hset.length; i += 2) fields.set(hset[i]!, hset[i + 1]!);
    expect(hset[1]).toBe('q:{event:ev-queue}:cfg');
    expect((JSON.parse(fields.get('config')!) as EventSaleConfig).commissionRateBp).toBe(875);
    expect(JSON.parse(fields.get('config')!)).toMatchObject({ eventId: 'ev-queue', productionId: 'prod-queue', promoterId: 'p-875', commissionRateBp: 875 });
  });
});

const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;
let configs: MemorySaleConfigStore;
const EVENT = randomUUID();
const PRODUCTION = randomUUID();

beforeAll(async () => {
  configs = new MemorySaleConfigStore();
  const config: EventSaleConfig = {
    eventId: EVENT,
    productionId: PRODUCTION,
    promoterId: 'p-875',
    rev: 2,
    opensAtMs: T1.getTime(),
    startsAtMs: NOW_MS + 10 * 24 * 3_600_000,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: true,
    perPersonLimit: 4,
    saleEndsAtMs: NOW_MS + 9 * 24 * 3_600_000,
    endsAtMs: NOW_MS + 10 * 24 * 3_600_000 + 2 * 3_600_000,
    commissionRateBp: 875,
    salePolicy: [general],
    eligGates: [],
    eligLists: [],
  };
  const noRate: EventSaleConfig = { ...config, eventId: randomUUID(), commissionRateBp: undefined };
  await configs.put([config, noRate], []);
  svc = await createService({
    name: 'core-svc-product-commission',
    module: AppModule.register({ memory: true, saleConfigs: configs }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

describe('J-T30 ① payment-svc용 내부 commission-rate 경로', () => {
  const rate = (eventId: string) => svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/commission-rate` });
  const saleConfig = (eventId: string) => svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-config` });

  test('J-T30 ①_회차_수수료율과_설정_사본이_같은_875bp를_준다', async () => {
    const r = await rate(EVENT);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toEqual({ commissionRateBp: 875 });

    const c = await saleConfig(EVENT);
    expect(c.statusCode).toBe(200);
    expect(c.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(c.payload)).toMatchObject({ eventId: EVENT, productionId: PRODUCTION, promoterId: 'p-875', commissionRateBp: 875 });
  });

  test('J-T30 ①_수수료율이_없으면_404이고_1000bp로_대신하지_않는다', async () => {
    const missing = await rate(randomUUID());
    expect(missing.statusCode).toBe(404);
    const noRate = [...configs.configs.values()].find((c) => c.commissionRateBp === undefined)!;
    const r = await rate(noRate.eventId);
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload).type).toContain('not-found');
  });
});