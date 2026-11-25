// 판매 승인 때 결제사 지정 고정과 채널 확인(R-T19 ③④, LCH-090, ADR-0062 결정 33, payment §2.2).
// 승인 전에는 회차 지정이 비어 있고, 승인 뒤에는 그 시점 플랫폼 기본값이 상세에 남는다. 채널이 꺼졌으면 422, 읽지 못하면 503이다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';
import { problem as payoutProblem, readyView, RecordingPayoutRegistration } from './payout-registration-double.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const payout = new RecordingPayoutRegistration();
const TENANT = randomUUID();
const PLACE = randomUUID();
const P = 'https://peaket.example/problems/';

beforeAll(async () => {
  repo.places.add(PLACE);
  repo.placeNames.push({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', aliases: [] });
  repo.promoters.set(TENANT, sellerRow());
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      memory: true,
      catalog: repo,
      payoutRegistration: payout,
      pgDefaults: { primary: 'PORTONE', fallback: 'TOSS' },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

beforeEach(() => {
  payout.reset();
  payout.views.set(TENANT, readyView());
});

afterAll(async () => {
  await svc?.close();
});

function sellerRow() {
  return {
    promoterId: TENANT,
    legalName: '(주)피켓공연',
    representative: '대표자',
    address: '서울 어딘가 1',
    phone: '02-0000-0000',
    email: 'seller@example.test',
    businessRegNo: '123-45-67890',
    mailOrderReportNo: '2026-서울-0001',
    exemptionBasis: null,
    verifiedAt: null,
    commissionRateBp: 1000,
    pendingContractApprovalId: null,
  };
}

function production(events = 2) {
  const id = randomUUID();
  repo.productions.set(id, {
    id,
    promoterId: TENANT,
    placeId: PLACE,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: 'SUBMITTED',
    saleApprovedAt: null,
    saleSubmittedAt: new Date(NOW_MS),
    rejectionReason: null,
  });
  const eventIds = Array.from({ length: events }, (_, i) => {
    const eventId = randomUUID();
    repo.events.set(eventId, {
      id: eventId,
      productionId: id,
      venueId: null,
      openAt: new Date(NOW_MS + (i + 1) * 3_600_000),
      startsAt: new Date(NOW_MS + (i + 1) * 86_400_000),
      status: 'SCHEDULED',
    });
    return eventId;
  });
  return { id, eventIds };
}

const ops = (role: 'viewer' | 'operator' | 'commander' = 'operator') => identity.ops(role);
const detail = (id: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/sale-reviews/${id}`, headers: ops() });
const approval = (id: string, body: unknown) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/sale-reviews/${id}/approvals`, headers: { ...ops(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; status: number; title: string };

describe('R-T19 판매 승인 때 결제사 지정 고정(HTTP)', () => {
  test('R-T19 ③_ 승인 전 회차 지정은 비어 있고, 승인하면 그 시점 기본값이 상세에 남으며 뒤에 바뀌지 않는다', async () => {
    const p = production(2);
    const before = JSON.parse((await detail(p.id)).payload) as { events: { pgPrimary: string | null; pgFallback: string | null }[] };
    expect(before.events.map((e) => [e.pgPrimary, e.pgFallback])).toEqual([
      [null, null],
      [null, null],
    ]);

    const r = await approval(p.id, { scales: p.eventIds.map((eventId) => ({ eventId, scale: 'SMALL' })), placeId: PLACE });
    expect(r.statusCode).toBe(200);

    const after = JSON.parse((await detail(p.id)).payload) as { events: { pgPrimary: string | null; pgFallback: string | null }[] };
    expect(after.events.map((e) => [e.pgPrimary, e.pgFallback])).toEqual([
      ['PORTONE', 'TOSS'],
      ['PORTONE', 'TOSS'],
    ]);
    // 저장 값(메모리 저장소)도 같다. 뒤에 다른 기본값으로 승인해도 이 회차들은 그대로다
    expect([...repo.events.values()].filter((e) => (p.eventIds as string[]).includes(e.id)).map((e) => [e.pgPrimary, e.pgFallback])).toEqual([
      ['PORTONE', 'TOSS'],
      ['PORTONE', 'TOSS'],
    ]);
  });

  test('R-T19 ④_ 기본 결제사 채널이 꺼져 있으면 422 sale-review-pg-unavailable이고 상태·회차 값이 그대로다', async () => {
    payout.views.set(TENANT, readyView({ portoneEnabled: false, tossEnabled: true }));
    const p = production(1);
    const r = await approval(p.id, { scales: [{ eventId: p.eventIds[0], scale: 'SMALL' }], placeId: PLACE });
    expect(r.statusCode).toBe(422);
    expect(problem(r).type).toBe(`${P}sale-review-pg-unavailable`);
    expect(repo.productions.get(p.id)?.saleReview).toBe('SUBMITTED');
    expect(repo.events.get(p.eventIds[0]!)?.pgPrimary).toBeUndefined();
  });

  test('R-T19 ④_ 채널 상태를 읽지 못하면 503이고 승인하지 않는다', async () => {
    payout.readError = payoutProblem('payout-dependency-unavailable', 503);
    const p = production(1);
    const r = await approval(p.id, { scales: [{ eventId: p.eventIds[0], scale: 'SMALL' }], placeId: PLACE });
    expect(r.statusCode).toBe(503);
    expect(repo.productions.get(p.id)?.saleReview).toBe('SUBMITTED');
    expect(repo.events.get(p.eventIds[0]!)?.pgPrimary).toBeUndefined();
  });
});
