// 파트너 판매 승인 요청·변경 취소·현황(S-T41 ①~③, BAT-616 LCH-080, ADR-0327, docs/planning/03 §2.14).
// 메모리 판매 저장소로 역할·테넌트·닫힌 본문·상태 전이·계좌 미저장·no-store를 본다. 실제 DB·Valkey는 test-int가 맡는다.
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
const OTHER = randomUUID();
const PLACE = randomUUID();
const P = 'https://peaket.example/problems/';

beforeAll(async () => {
  repo.places.add(PLACE);
  repo.promoters.set(TENANT, sellerRow(TENANT, '(주)피켓공연'));
  repo.promoters.set(OTHER, sellerRow(OTHER, '(주)다른공연'));
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

function sellerRow(promoterId: string, legalName: string) {
  return {
    promoterId,
    legalName,
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

const event = (productionId: string, startsAt: string, openAt: string, status: 'SCHEDULED' | 'CANCELLED' = 'SCHEDULED') => {
  const id = randomUUID();
  repo.events.set(id, { id, productionId, venueId: null, openAt: new Date(openAt), startsAt: new Date(startsAt), status });
  return id;
};

/** 판매 승인 대기 공연 하나. 이벤트가 0개인 공연도 만들 수 있다 */
function production(o: { saleReview?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'; saleApprovedAt?: Date | null; saleSubmittedAt?: Date | null; rejectionReason?: string | null; placeId?: string | null; events?: number; tenant?: string } = {}) {
  const id = randomUUID();
  const tenant = o.tenant ?? TENANT;
  repo.productions.set(id, {
    id,
    promoterId: tenant,
    placeId: o.placeId === undefined ? PLACE : o.placeId,
    title: `공연-${id.slice(0, 8)}`,
    genre: '콘서트',
    saleReview: o.saleReview ?? 'DRAFT',
    saleApprovedAt: o.saleApprovedAt ?? null,
    saleSubmittedAt: o.saleSubmittedAt ?? null,
    rejectionReason: o.rejectionReason ?? null,
    ...(o.placeId === null ? { requestedPlace: null } : {}),
  });
  const n = o.events ?? 1;
  const eventIds = Array.from({ length: n }, (_, i) => event(id, `2026-12-${String(2 + i).padStart(2, '0')}T10:00:00Z`, `2026-11-${String(20 + i).padStart(2, '0')}T11:00:00Z`));
  return { id, eventIds };
}

function body(over: Record<string, unknown> = {}) {
  return {
    seller: {
      legalName: '(주)피켓공연',
      representative: '대표자',
      address: '서울 어딘가 1',
      phone: '02-0000-0000',
      email: 'seller@example.test',
      businessRegNo: '123-45-67890',
      mailOrderReportNo: '2026-서울-0001',
    },
    payoutAccount: { bankCode: '004', accountNumber: '1002-345-678901', holderName: '홍길동' },
    accessibleSeating: { confirmed: true },
    ...over,
  };
}

const request = (headers: Record<string, string>, productionId: string, payload: unknown = body()) =>
  svc.http.inject({ method: 'POST', url: `/v1/partner/productions/${productionId}/sale-review`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
const cancel = (headers: Record<string, string>, productionId: string) => svc.http.inject({ method: 'DELETE', url: `/v1/partner/productions/${productionId}/sale-review`, headers });
const status = (headers: Record<string, string>, productionId: string) => svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${productionId}/sale-review`, headers });
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; status: number; title: string };

describe('파트너 판매 승인 요청·변경 취소(S-T41 ①~③)', () => {
  test('S-T41 ①_ partner_admin이 판매자 정보·계좌 모양·휠체어석 확인을 넣으면 202 SUBMITTED이고 promoter·제출 시각이 서며 계좌 원문은 저장·응답에 없다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.2.3]', async () => {
    const p = production({ events: 2 });
    const admin = identity.partner(TENANT, 'partner_admin');
    const r = await request(admin, p.id);
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.payload)).toEqual({ status: 'SUBMITTED' });
    expect(repo.productions.get(p.id)).toMatchObject({ saleReview: 'SUBMITTED', saleSubmittedAt: new Date(NOW_MS), rejectionReason: null });
    expect(repo.promoters.get(TENANT)).toMatchObject({
      legalName: '(주)피켓공연',
      representative: '대표자',
      address: '서울 어딘가 1',
      phone: '02-0000-0000',
      email: 'seller@example.test',
      businessRegNo: '123-45-67890',
      mailOrderReportNo: '2026-서울-0001',
    });
    // 계좌 모양만 보고 저장하지 않는다(지급대행 연동 전, LCH-110)
    expect(JSON.stringify([...repo.promoters.values()]) + r.payload).not.toContain('1002-345-678901');
    expect(JSON.stringify([...repo.promoters.values()]) + r.payload).not.toContain('홍길동');

    const s = await status(admin, p.id);
    expect(s.statusCode).toBe(200);
    expect(s.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(s.payload)).toMatchObject({ saleReview: 'SUBMITTED', rejectionReason: null, hasApprovalHistory: false, seller: { legalName: '(주)피켓공연' } });
    expect(JSON.parse(s.payload).submittedAt).toBe(new Date(NOW_MS).toISOString());
    expect(JSON.parse(s.payload).events).toHaveLength(2);

    // 같은 요청을 다시 보내도 같은 202이고 행·제출 시각을 새로 만들지 않는다
    const again = await request(admin, p.id);
    expect(again.statusCode).toBe(202);
    expect(repo.productions.get(p.id)?.saleSubmittedAt).toEqual(new Date(NOW_MS));
  });

  test('S-T41 ①_ partner_member는 403이고 다른 테넌트·없는 공연은 같은 404, 테넌트 없는 세션은 503이다 [ASVS v5.0.0-8.2.2]', async () => {
    const p = production();
    const member = await request(identity.partner(TENANT, 'partner_member'), p.id);
    expect(member.statusCode).toBe(403);
    expect(repo.productions.get(p.id)?.saleReview).toBe('DRAFT');

    const other = await request(identity.partner(OTHER), p.id);
    const missing = await request(identity.partner(OTHER), randomUUID());
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(problem(other).type).toBe(`${P}not-found`);
    expect(problem(missing).type).toBe(`${P}not-found`);

    // 테넌트가 없는 파트너 세션은 권한을 확인하지 못한 503으로 닫는다(openapi createPartnerProductionSaleReview 503)
    const accountId = randomUUID();
    const sessionId = randomUUID();
    identity.answers.set(`${accountId}/${sessionId}`, { valid: true, role: 'partner_admin' });
    const tenantless = await request({ 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'partner', 'x-user-scope': '' }, p.id);
    expect(tenantless.statusCode).toBe(503);
    expect(problem(tenantless).type).toBe(`${P}authz-unavailable`);
  });

  test('S-T41 ②_ 필수 칸 누락·신고번호와 면제 근거 둘 다/둘 다 없음·계좌 모양·confirmed:false·모르는 칸은 400/422이고 상태·행이 바뀌지 않는다', async () => {
    const admin = identity.partner(TENANT, 'partner_admin');
    const cases: { name: string; body: unknown; status: number }[] = [
      { name: 'seller.legalName 없음', body: body({ seller: { ...body().seller, legalName: undefined } }), status: 400 },
      { name: '신고번호와 면제 근거 둘 다 없음', body: body({ seller: { ...body().seller, mailOrderReportNo: undefined } }), status: 422 },
      { name: '신고번호와 면제 근거 둘 다 있음', body: body({ seller: { ...body().seller, exemptionBasis: '소규모 면제' } }), status: 422 },
      { name: '계좌 은행 코드 없음', body: body({ payoutAccount: { accountNumber: '1002-345-678901', holderName: '홍길동' } }), status: 400 },
      { name: '휠체어석 확인 거짓', body: body({ accessibleSeating: { confirmed: false } }), status: 400 },
      { name: '모르는 칸', body: body({ seller: { ...body().seller, extra: 'x' } }), status: 400 },
    ];
    for (const c of cases) {
      const p = production();
      const r = await request(admin, p.id, c.body);
      expect(r.statusCode, c.name).toBe(c.status);
      expect(repo.productions.get(p.id)?.saleReview, c.name).toBe('DRAFT');
      expect(repo.productions.get(p.id)?.saleSubmittedAt, c.name).toBeNull();
    }
  });

  test('S-T41 ②_ 회차가 없거나 등록 공연장·새 공연장 요청이 없으면 422 sale-review-request-invalid다', async () => {
    const admin = identity.partner(TENANT, 'partner_admin');
    const noEvents = production({ events: 0 });
    const r1 = await request(admin, noEvents.id);
    expect(r1.statusCode).toBe(422);
    expect(problem(r1).type).toBe(`${P}sale-review-request-invalid`);
    expect(repo.productions.get(noEvents.id)?.saleReview).toBe('DRAFT');

    const noPlace = production({ placeId: null });
    const r2 = await request(admin, noPlace.id);
    expect(r2.statusCode).toBe(422);
    expect(problem(r2).type).toBe(`${P}sale-review-request-invalid`);
    expect(repo.productions.get(noPlace.id)?.saleReview).toBe('DRAFT');
  });

  test('S-T41 ③_ 승인 이력이 있는 SUBMITTED에서 DELETE는 204이고 APPROVED로 돌며 pending·변경분·사유를 비운다', async () => {
    const p = production({ saleReview: 'SUBMITTED', saleApprovedAt: new Date(NOW_MS - 86_400_000), saleSubmittedAt: new Date(NOW_MS), rejectionReason: null });
    repo.salePolicies.set(p.id, { rules: [], version: 2, pending: [{ version: 1, name: '선예매', rounds: 'ALL', rule: { then: { limitPerPerson: 2 } } }] });
    repo.eventChanges.set(p.id, { [p.eventIds[0]!]: { perPersonLimit: 2 } });
    repo.pending.set(p.id, []);
    const admin = identity.partner(TENANT, 'partner_admin');
    const r = await cancel(admin, p.id);
    expect(r.statusCode).toBe(204);
    expect(repo.productions.get(p.id)).toMatchObject({ saleReview: 'APPROVED', saleSubmittedAt: null, rejectionReason: null });
    expect(repo.salePolicies.get(p.id)?.pending).toBeUndefined();
    expect(repo.eventChanges.has(p.id)).toBe(false);
    expect(repo.pending.has(p.id)).toBe(false);
    // 취소 뒤 다시 요청하면 202이고 다시 SUBMITTED가 된다
    expect((await request(admin, p.id)).statusCode).toBe(202);
    expect(repo.productions.get(p.id)?.saleReview).toBe('SUBMITTED');
  });

  test('S-T41 ③_ 승인 이력이 없거나 APPROVED·SUSPENDED면 409 sale-review-not-cancellable이다', async () => {
    const admin = identity.partner(TENANT, 'partner_admin');
    const noHistory = production({ saleReview: 'SUBMITTED', saleApprovedAt: null, saleSubmittedAt: new Date(NOW_MS) });
    const approved = production({ saleReview: 'APPROVED', saleApprovedAt: new Date(NOW_MS - 86_400_000), saleSubmittedAt: null });
    const suspended = production({ saleReview: 'SUSPENDED', saleApprovedAt: new Date(NOW_MS - 86_400_000), saleSubmittedAt: new Date(NOW_MS) });
    for (const p of [noHistory, approved, suspended]) {
      const r = await cancel(admin, p.id);
      expect(r.statusCode, p.id).toBe(409);
      expect(problem(r).type).toBe(`${P}sale-review-not-cancellable`);
    }
    // 취소는 partner_admin만 한다(partner_member 403, 다른 테넌트 404)
    expect((await cancel(identity.partner(TENANT, 'partner_member'), noHistory.id)).statusCode).toBe(403);
    expect((await cancel(identity.partner(OTHER), noHistory.id)).statusCode).toBe(404);
  });
});
