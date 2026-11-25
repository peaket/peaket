// 휠체어석 서버 재계산(LCH-090 ㉢, FR-023, data.md production.accessible_seating_check, d5 §6.5·§7.9).
// 판매 승인 요청 때 저장된 좌석맵으로 전체·휠체어·기준·위치 확인·온라인 판매 가능 수를 다시 세어 jsonb에 남긴다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const TENANT = randomUUID();
const PLACE = randomUUID();

beforeAll(async () => {
  repo.places.add(PLACE);
  repo.placeNames.push({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', aliases: [] });
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
    verifiedAt: null,
    commissionRateBp: 1000,
    pendingContractApprovalId: null,
  });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

function production() {
  const id = randomUUID();
  repo.productions.set(id, {
    id,
    promoterId: TENANT,
    placeId: PLACE,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: 'DRAFT',
    saleApprovedAt: null,
  });
  const eventId = randomUUID();
  repo.events.set(eventId, {
    id: eventId,
    productionId: id,
    venueId: null,
    openAt: new Date(NOW_MS + 3_600_000),
    startsAt: new Date(NOW_MS + 86_400_000),
    status: 'SCHEDULED',
  });
  return id;
}

/** 좌석 7개: 일반·일반·휠체어·휠체어(판매 제외)·일반·일반·일반. 위치 확인 2석, 온라인 판매 가능 1석 */
function seedLayout(productionId: string) {
  const seats = Array.from({ length: 7 }, (_, i) => ({
    seatId: `seat-${i + 1}`,
    index: i,
    row: 'A',
    number: i + 1,
    x: 100 + i * 50,
    y: 100,
    ...(i === 2 || i === 3 ? { wheelchair: true as const } : {}),
    ...(i === 3 ? { unavailable: true as const } : {}),
  }));
  repo.layouts.set(productionId, {
    venueId: randomUUID(),
    versionSeq: 1,
    rows: {
      version: 1,
      doc: {
        canvas: { width: 800, height: 600 },
        stage: [],
        sections: [
          {
            sectionId: 'sec-1',
            name: 'A',
            shape: { kind: 'RECT', points: [[0, 0], [800, 0], [800, 600], [0, 600]] },
            seats,
          },
        ],
        priceTiers: [],
      },
    },
    publishedVersion: 1,
    pending: null,
    templateVenueId: null,
  });
}

const body = {
  seller: {
    legalName: '(주)피켓공연',
    representative: '대표자',
    address: '서울 어딘가 1',
    phone: '02-0000-0000',
    email: 'seller@example.test',
    businessRegNo: '123-45-67890',
    mailOrderReportNo: '2026-서울-0001',
  },
  payoutAccount: { bankCode: '88', accountNumber: '1002-345-678901', holderName: '홍길동' },
  accessibleSeating: { confirmed: true, shortfallReason: 'RELAXED_STANDARD' },
};

const request = (productionId: string) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/partner/productions/${productionId}/sale-review`,
    headers: { ...identity.partner(TENANT, 'partner_admin'), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

describe('LCH-090 휠체어석 서버 재계산', () => {
  test('LCH-090 ㉢_ 저장된 좌석맵으로 전체·휠체어·기준·위치 확인·온라인 판매 수를 다시 세어 jsonb에 남긴다', async () => {
    const id = production();
    seedLayout(id);
    const r = await request(id);
    expect(r.statusCode).toBe(202);

    expect(repo.productions.get(id)?.accessibleSeatingCheck).toBe(true);
    const saved = repo.productions.get(id)?.accessibleSeating as unknown as Record<string, unknown>;
    expect(saved).toMatchObject({
      confirmed: true,
      shortfallReason: 'RELAXED_STANDARD',
      totalSeats: 7,
      wheelchairSeats: 2,
      requiredSeats: 1,
      locationCheckSeats: 2,
      onlineWheelchairSeats: 1,
    });

    const d = await svc.http.inject({ method: 'GET', url: `/v1/ops/sale-reviews/${id}`, headers: identity.ops('operator') });
    expect(d.statusCode).toBe(200);
    const out = JSON.parse(d.payload) as { accessibleSeatingCheck: boolean | null; accessibleSeating: Record<string, unknown> | null };
    // 호환 boolean은 true이고, 새 요약은 같은 값을 보인다
    expect(out.accessibleSeatingCheck).toBe(true);
    expect(out.accessibleSeating).toMatchObject({
      confirmed: true,
      totalSeats: 7,
      wheelchairSeats: 2,
      requiredSeats: 1,
      locationCheckSeats: 2,
      onlineWheelchairSeats: 1,
    });
  });

  test('LCH-090 ㉢_ 좌석맵이 없으면 수는 비우고 파트너 확인·부족 이유만 남긴다', async () => {
    const id = production();
    const r = await request(id);
    expect(r.statusCode).toBe(202);

    const saved = repo.productions.get(id)?.accessibleSeating as unknown as Record<string, unknown>;
    expect(saved).toMatchObject({ confirmed: true, shortfallReason: 'RELAXED_STANDARD' });
    expect(saved.totalSeats ?? null).toBeNull();
    expect(saved.wheelchairSeats ?? null).toBeNull();
    expect(saved.requiredSeats ?? null).toBeNull();

    const d = await svc.http.inject({ method: 'GET', url: `/v1/ops/sale-reviews/${id}`, headers: identity.ops('operator') });
    const out = JSON.parse(d.payload) as { accessibleSeating: Record<string, unknown> | null };
    expect(out.accessibleSeating).toMatchObject({ confirmed: true, totalSeats: null, wheelchairSeats: null });
  });
});
