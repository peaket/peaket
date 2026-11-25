// 재승인 대기 중 공개·판매 계속과 변경 취소(R-T18 ①~③, FR-052·FR-022, ADR-0093 결정 7, ADR-0327).
// 공개본(production·event 행)은 마지막 승인 내용이고, 바뀐 회차 칸은 승인 때까지 pending_revision.eventChanges에만 있다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';
import { readyView, RecordingPayoutRegistration } from './payout-registration-double.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const payout = new RecordingPayoutRegistration();
const TENANT = randomUUID();
const PLACE = randomUUID();
const APPROVED_AT = new Date('2026-11-01T00:00:00.000Z');
const OLD_OPEN = new Date('2026-11-27T09:00:00.000Z');
const NEW_OPEN = new Date('2026-11-28T09:00:00.000Z');

beforeAll(async () => {
  repo.places.add(PLACE);
  repo.placeNames.push({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', aliases: [] });
  repo.sellerNames.set(TENANT, '(주)피켓공연');
  repo.promoters.set(TENANT, {
    promoterId: TENANT,
    legalName: '(주)피켓공연',
    representative: '대표자',
    address: '서울 어딘가 1',
    phone: '02-0000-0000',
    email: 'seller@example.test',
    businessRegNo: '123-45-67890',
    mailOrderReportNo: '2026-서울-0001',
    exemptionBasis: null,
    verifiedAt: new Date('2026-10-01T00:00:00Z'),
    commissionRateBp: 1000,
    pendingContractApprovalId: null,
  });
  payout.views.set(TENANT, readyView());
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, payoutRegistration: payout }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

/** 승인 이력이 있는 공연 하나. 공개본 event 행은 OLD_OPEN이고, 바뀐 칸은 아직 eventChanges에만 둔다 */
function production() {
  const id = randomUUID();
  repo.productions.set(id, {
    id,
    promoterId: TENANT,
    placeId: PLACE,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: 'APPROVED',
    saleApprovedAt: APPROVED_AT,
    saleSubmittedAt: null,
    rejectionReason: null,
  });
  const eventId = randomUUID();
  repo.events.set(eventId, {
    id: eventId,
    productionId: id,
    venueId: randomUUID(),
    openAt: OLD_OPEN,
    startsAt: new Date('2026-11-29T10:00:00.000Z'),
    status: 'SCHEDULED',
  });
  return { id, eventId };
}

function pendingOpenChange(id: string, eventId: string) {
  repo.productions.set(id, { ...repo.productions.get(id)!, saleReview: 'SUBMITTED', saleSubmittedAt: new Date(NOW_MS), rejectionReason: null });
  repo.eventChanges.set(id, { [eventId]: { openAt: NEW_OPEN } });
}

const publicEvent = (eventId: string) => svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}` });
const partnerStatus = (id: string) =>
  svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${id}/sale-review`, headers: identity.partner(TENANT, 'partner_admin') });
const cancel = (id: string) =>
  svc.http.inject({ method: 'DELETE', url: `/v1/partner/productions/${id}/sale-review`, headers: identity.partner(TENANT, 'partner_admin') });
const approve = (id: string, eventId: string) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/sale-reviews/${id}/approvals`,
    headers: { ...identity.ops('operator'), 'content-type': 'application/json' },
    payload: JSON.stringify({ scales: [{ eventId, scale: 'SMALL' }], placeId: PLACE }),
  });

describe('R-T18 재승인 대기 중 공개와 판매', () => {
  test('R-T18 ①_ 재승인을 기다리는 동안 공개 요약은 마지막 승인 내용을 계속 보인다', async () => {
    const { id, eventId } = production();
    pendingOpenChange(id, eventId);

    const r = await publicEvent(eventId);
    expect(r.statusCode).toBe(200);
    // 공개 요약은 마지막 승인본(OLD_OPEN − 로비 10분)을 그대로 보인다
    expect(JSON.parse(r.payload)).toMatchObject({ eventId, lobbyOpensAt: '2026-11-27T08:50:00.000Z' });

    const s = await partnerStatus(id);
    expect(s.statusCode).toBe(200);
    expect(JSON.parse(s.payload)).toMatchObject({ saleReview: 'SUBMITTED', hasApprovalHistory: true });
  });

  test('R-T18 ②_ 변경 취소는 마지막 승인 내용으로 돌아가고 기다리던 변경분을 비운다', async () => {
    const { id, eventId } = production();
    pendingOpenChange(id, eventId);

    const c = await cancel(id);
    expect(c.statusCode).toBe(204);
    expect(repo.productions.get(id)).toMatchObject({ saleReview: 'APPROVED', saleSubmittedAt: null, rejectionReason: null });
    expect(repo.eventChanges.has(id)).toBe(false);

    const r = await publicEvent(eventId);
    expect(JSON.parse(r.payload)).toMatchObject({ lobbyOpensAt: '2026-11-27T08:50:00.000Z' });
  });

  test('R-T18 ③_ 재승인하면 바뀐 회차 값이 공개본에 반영된다', async () => {
    const { id, eventId } = production();
    pendingOpenChange(id, eventId);

    const a = await approve(id, eventId);
    expect(a.statusCode).toBe(200);
    expect(repo.productions.get(id)?.saleReview).toBe('APPROVED');
    expect(repo.events.get(eventId)?.openAt).toEqual(NEW_OPEN);

    const r = await publicEvent(eventId);
    expect(JSON.parse(r.payload)).toMatchObject({ lobbyOpensAt: '2026-11-28T08:50:00.000Z' });
  });
});
