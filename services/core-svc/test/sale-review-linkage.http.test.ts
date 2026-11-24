// 판매 승인의 아티스트·공연장 연결(LCH-080 잔여, ADR-0093 결정 4·ADR-0198 결정 4, d5 §7.9 ②).
// 파트너가 새 이름으로 요청한 아티스트·공연장을 운영자가 승인과 함께 잇는다. 연결이 빠지면 실제 DB 제약(production_approved_place_check)에
// 닿기 전에 422로 막고, 연결되면 production_artist와 place_id가 남고 요청 칸이 빈다. 메모리 저장소로 바깥 경계를 본다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCdnInvalidation, MemoryCatalogRepository, MemorySaleConfigStore } from '../src/modules/catalog/index.js';
import type { Production } from '../src/modules/catalog/domain/production.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';
import { readyView, RecordingPayoutRegistration } from './payout-registration-double.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const saleConfigs = new MemorySaleConfigStore();
const cdn = new MemoryCdnInvalidation();
const payout = new RecordingPayoutRegistration();
const TENANT = randomUUID();
const PLACE = randomUUID();
const OTHER_PLACE = randomUUID();
const LUMEN = randomUUID();
const P = 'https://peaket.example/problems/';

/** 시험용 저장소에만 있는 관계(구현 I-04가 더한다). 기준 트리에서는 없으므로 안전하게 만든다 */
type Link = { artistId: string; sortOrder: number };
const links = ((repo as unknown as { productionArtists?: Map<string, Link[]> }).productionArtists ??= new Map<string, Link[]>());
const closedPlaces = ((repo as unknown as { closedPlaces?: Set<string> }).closedPlaces ??= new Set<string>());

beforeAll(async () => {
  repo.places.add(PLACE);
  repo.places.add(OTHER_PLACE);
  repo.placeNames.push({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', aliases: [] });
  repo.placeNames.push({ id: OTHER_PLACE, name: '닫힌 공연장', address: '서울 어딘가 3', aliases: [] });
  closedPlaces.add(OTHER_PLACE);
  repo.artists.add(LUMEN);
  repo.artistNames.push({ id: LUMEN, name: 'LUMEN', aliases: ['루멘'] });
  repo.promoters.set(TENANT, sellerRow(TENANT, '(주)피켓공연'));
  payout.views.set(TENANT, readyView());
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, saleConfigs, media: { cdn }, payoutRegistration: payout }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

function sellerRow(promoterId: string, legalName: string) {
  return {
    promoterId,
    legalName,
    representative: '대표자',
    address: '서울 어딘가 1',
    phone: '02-1234-5678',
    email: 'seller@example.test',
    businessRegNo: '123-45-67890',
    mailOrderReportNo: '2026-서울-0001',
    exemptionBasis: null,
    verifiedAt: new Date('2026-10-01T00:00:00Z'),
    commissionRateBp: 1000,
    pendingContractApprovalId: null,
  };
}

function production(o: { requestedPlace?: { name: string; address: string } | null; requestedArtists?: { name: string; sortOrder: number }[]; linked?: Link[]; saleReview?: 'SUBMITTED' | 'REJECTED' | 'APPROVED' } = {}) {
  const id = randomUUID();
  const requestedPlace = o.requestedPlace ?? null;
  repo.productions.set(id, {
    id,
    promoterId: TENANT,
    placeId: requestedPlace === null ? PLACE : null,
    title: `공연-${id.slice(0, 8)}`,
    genre: '콘서트',
    saleReview: o.saleReview ?? 'SUBMITTED',
    saleApprovedAt: null,
    saleSubmittedAt: new Date(NOW_MS),
    rejectionReason: null,
    requestedPlace,
    requestedArtists: o.requestedArtists ?? null,
    createdAt: new Date(NOW_MS - 3_600_000),
  } as unknown as Production);
  if (o.linked !== undefined) links.set(id, o.linked.map((x) => ({ ...x })));
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: id, venueId: null, openAt: new Date(NOW_MS + 3_600_000), startsAt: new Date(NOW_MS + 86_400_000), status: 'SCHEDULED' });
  return { id, eventId };
}

const ops = (role: 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead' = 'operator') => identity.ops(role);
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; status: number; title: string };
const approval = (headers: Record<string, string>, id: string, body: unknown) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/sale-reviews/${id}/approvals`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const detail = (headers: Record<string, string>, id: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/sale-reviews/${id}`, headers });

describe('판매 승인의 아티스트·공연장 연결(LCH-080 잔여)', () => {
  test('LCH-080 ㉣_ 요청 아티스트 이름마다 ID를 이어 production_artist를 요청 순서로 쓰고 requested_artists를 비운다', async () => {
    const p = production({ requestedArtists: [{ name: 'LUMEN', sortOrder: 0 }, { name: '새 이름', sortOrder: 1 }] });
    const newArtist = randomUUID();
    repo.artists.add(newArtist);
    repo.artistNames.push({ id: newArtist, name: '새 이름', aliases: [] });

    const before = await detail(ops(), p.id);
    expect(before.statusCode).toBe(200);
    const beforeArtists = JSON.parse(before.payload).artists as { artistId: string | null; name: string }[];
    expect(beforeArtists).toEqual([
      { artistId: null, name: 'LUMEN' },
      { artistId: null, name: '새 이름' },
    ]);

    const r = await approval(ops(), p.id, {
      scales: [{ eventId: p.eventId, scale: 'MEDIUM' }],
      artists: [
        { name: 'LUMEN', artistId: LUMEN },
        { name: '새 이름', artistId: newArtist },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ applied: true, events: 1 });
    expect(links.get(p.id)).toEqual([
      { artistId: LUMEN, sortOrder: 0 },
      { artistId: newArtist, sortOrder: 1 },
    ]);
    expect(repo.productions.get(p.id)?.requestedArtists ?? null).toBeNull();

    const after = await detail(ops(), p.id);
    expect(after.statusCode).toBe(200);
    expect((JSON.parse(after.payload).artists as { artistId: string | null; name: string }[]).map((x) => [x.artistId, x.name])).toEqual([
      [LUMEN, 'LUMEN'],
      [newArtist, '새 이름'],
    ]);
  });

  test('LCH-080 ㉣_ 요청 이름이 빠지거나 모르는 아티스트 ID면 422 sale-review-artists-missing이고 아무것도 쓰지 않는다', async () => {
    const p = production({ requestedArtists: [{ name: 'LUMEN', sortOrder: 0 }] });
    const base = { scales: [{ eventId: p.eventId, scale: 'SMALL' }] };

    const missing = await approval(ops(), p.id, base);
    expect(missing.statusCode).toBe(422);
    expect(problem(missing).type).toBe(`${P}sale-review-artists-missing`);

    const unknown = await approval(ops(), p.id, { ...base, artists: [{ name: 'LUMEN', artistId: randomUUID() }] });
    expect(unknown.statusCode).toBe(422);
    expect(problem(unknown).type).toBe(`${P}sale-review-artists-missing`);

    const wrongName = await approval(ops(), p.id, { ...base, artists: [{ name: '다른 이름', artistId: LUMEN }] });
    expect(wrongName.statusCode).toBe(422);
    expect(problem(wrongName).type).toBe(`${P}sale-review-artists-missing`);

    expect(repo.productions.get(p.id)).toMatchObject({ saleReview: 'SUBMITTED', saleApprovedAt: null });
    expect(links.get(p.id) ?? []).toEqual([]);
  });

  test('LCH-080 ㉥_ 상세는 등록 아티스트와 요청 이름을 보이는 순서대로 함께 주고 요청 공연장 이름을 유지한다', async () => {
    const p = production({
      linked: [{ artistId: LUMEN, sortOrder: 0 }],
      requestedArtists: [{ name: '새 이름', sortOrder: 1 }],
      requestedPlace: { name: '새 공연장', address: '서울 어딘가 2' },
    });
    const d = await detail(ops('viewer'), p.id);
    expect(d.statusCode).toBe(200);
    const payload = JSON.parse(d.payload) as { artists: { artistId: string | null; name: string }[]; placeId: string | null; placeName: string | null; requestedPlace: boolean };
    expect(payload.artists).toEqual([
      { artistId: LUMEN, name: 'LUMEN' },
      { artistId: null, name: '새 이름' },
    ]);
    expect(payload.placeId).toBeNull();
    expect(payload.placeName).toBe('새 공연장');
    expect(payload.requestedPlace).toBe(true);

    // CS 두 역할은 계좌를 보지 않는다(지급대행 값은 F-07-7이 준다)
    const cs = await detail(ops('cs_agent'), p.id);
    expect(cs.statusCode).toBe(200);
    expect(JSON.parse(cs.payload).payoutAccount).toBeNull();
  });

  test('LCH-080 ㉤_ 새 공연장 요청은 placeId가 없거나 쓸 수 없는 공연장이면 422 sale-review-place-missing이다', async () => {
    const p = production({ requestedPlace: { name: '새 공연장', address: '서울 어딘가 2' } });
    const base = { scales: [{ eventId: p.eventId, scale: 'SMALL' }] };

    const missing = await approval(ops(), p.id, base);
    expect(missing.statusCode).toBe(422);
    expect(problem(missing).type).toBe(`${P}sale-review-place-missing`);

    const unknown = await approval(ops(), p.id, { ...base, placeId: randomUUID() });
    expect(unknown.statusCode).toBe(422);
    expect(problem(unknown).type).toBe(`${P}sale-review-place-missing`);

    const closed = await approval(ops(), p.id, { ...base, placeId: OTHER_PLACE });
    expect(closed.statusCode).toBe(422);
    expect(problem(closed).type).toBe(`${P}sale-review-place-missing`);

    expect(repo.productions.get(p.id)).toMatchObject({ saleReview: 'SUBMITTED', saleApprovedAt: null, placeId: null });
  });

  test('LCH-080 ㉤_ 새 공연장을 고르면 place_id를 채우고 requested_place를 비우며, 기존 공연장 공연은 placeId 없이도 승인된다', async () => {
    const requested = production({ requestedPlace: { name: '새 공연장', address: '서울 어딘가 2' } });
    const ok = await approval(ops(), requested.id, { scales: [{ eventId: requested.eventId, scale: 'SMALL' }], placeId: PLACE });
    expect(ok.statusCode).toBe(200);
    expect(repo.productions.get(requested.id)).toMatchObject({ saleReview: 'APPROVED', placeId: PLACE, requestedPlace: null });

    const registered = production();
    const plain = await approval(ops(), registered.id, { scales: [{ eventId: registered.eventId, scale: 'SMALL' }] });
    expect(plain.statusCode).toBe(200);
    expect(repo.productions.get(registered.id)).toMatchObject({ saleReview: 'APPROVED', placeId: PLACE });
  });

  test('LCH-080 ㉣_ 이미 승인된 공연은 연결 검사보다 상태 검사가 먼저라 409 sale-review-not-submitted다', async () => {
    const p = production({ requestedArtists: [{ name: 'LUMEN', sortOrder: 0 }], saleReview: 'APPROVED' });
    const r = await approval(ops(), p.id, { scales: [{ eventId: p.eventId, scale: 'SMALL' }] });
    expect(r.statusCode).toBe(409);
    expect(problem(r).type).toBe(`${P}sale-review-not-submitted`);
  });
});
