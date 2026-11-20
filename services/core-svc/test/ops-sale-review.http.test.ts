// 관제 판매 승인 목록·상세·반려 사유·CDN 무효화(S-T41 ④⑤⑩, BAT-616 LCH-080, ADR-0327).
// 메모리 판매 저장소로 상태 필터·커서·역할·개인정보 비노출·반려 사유·CDN 태그를 본다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCdnInvalidation, MemoryCatalogRepository, MemorySaleConfigStore } from '../src/modules/catalog/index.js';
import type { CdnInvalidation } from '../src/modules/catalog/domain/media-ports.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const saleConfigs = new MemorySaleConfigStore();
const cdn = new MemoryCdnInvalidation();
const flakyCdn: CdnInvalidation = {
  invalidate: async (tags) => {
    if (failCdn) throw new Error('cdn down');
    await cdn.invalidate(tags);
  },
  invalidatePaths: async (paths) => cdn.invalidatePaths(paths),
};
let failCdn = false;
const TENANT = randomUUID();
const PLACE = randomUUID();
const P = 'https://peaket.example/problems/';

beforeAll(async () => {
  repo.places.add(PLACE);
  repo.promoters.set(TENANT, sellerRow(TENANT, '(주)피켓공연'));
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, saleConfigs, media: { cdn: flakyCdn } }),
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

const general = { version: 1, name: '일반', rounds: 'ALL' as const, rule: { then: { limitPerPerson: 4 } } };

function production(o: { saleReview?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'; submittedAt?: Date | null; approvedAt?: Date | null; rejectionReason?: string | null; events?: number; placeId?: string | null; rules?: unknown[]; pendingRules?: unknown[] } = {}) {
  const id = randomUUID();
  repo.productions.set(id, {
    id,
    promoterId: TENANT,
    placeId: o.placeId === undefined ? PLACE : o.placeId,
    title: `공연-${id.slice(0, 8)}`,
    genre: '콘서트',
    saleReview: o.saleReview ?? 'SUBMITTED',
    saleApprovedAt: o.approvedAt ?? null,
    saleSubmittedAt: o.submittedAt ?? (o.saleReview === 'SUBMITTED' ? new Date(NOW_MS) : null),
    rejectionReason: o.rejectionReason ?? null,
    ...(o.placeId === null ? { requestedPlace: null } : {}),
  });
  const eventIds = Array.from({ length: o.events ?? 1 }, (_, i) => {
    const eventId = randomUUID();
    repo.events.set(eventId, { id: eventId, productionId: id, venueId: null, openAt: new Date(NOW_MS + (i + 1) * 3_600_000), startsAt: new Date(NOW_MS + (i + 1) * 86_400_000), status: 'SCHEDULED' });
    return eventId;
  });
  if (o.rules !== undefined || o.pendingRules !== undefined) repo.salePolicies.set(id, { rules: (o.rules ?? []) as never[], version: 2, ...(o.pendingRules ? { pending: o.pendingRules as never[] } : {}) });
  return { id, eventIds };
}

const ops = (role: 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead' = 'operator') => identity.ops(role);
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; status: number; title: string };
const list = (headers: Record<string, string>, q = '') => svc.http.inject({ method: 'GET', url: `/v1/ops/sale-reviews${q}`, headers });
const detail = (headers: Record<string, string>, id: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/sale-reviews/${id}`, headers });
const approval = (headers: Record<string, string>, id: string, body: unknown) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/sale-reviews/${id}/approvals`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const rejection = (headers: Record<string, string>, id: string, body: unknown) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/sale-reviews/${id}/rejections`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('관제 판매 승인 목록·상세·반려·CDN(S-T41 ④⑤⑩)', () => {
  test('S-T41 ④_ 반려 사유 1~1,000자를 REJECTED와 함께 남기고 목록·상세·파트너 현황이 같은 사유를 보인다', async () => {
    const p = production({ events: 1 });
    const r = await rejection(ops(), p.id, { reason: '판매자 정보를 보완해 주세요' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ applied: true });
    expect(repo.productions.get(p.id)).toMatchObject({ saleReview: 'REJECTED', rejectionReason: '판매자 정보를 보완해 주세요' });

    const d = await detail(ops('viewer'), p.id);
    expect(d.statusCode).toBe(200);
    expect(JSON.parse(d.payload).rejectionReason).toBe('판매자 정보를 보완해 주세요');
    const l = await list(ops('cs_agent'), '?status=REJECTED&limit=100');
    expect(l.statusCode).toBe(200);
    const item = (JSON.parse(l.payload).items as { productionId: string }[]).find((x) => x.productionId === p.id);
    expect(item).toBeDefined();
    const s = await svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${p.id}/sale-review`, headers: identity.partner(TENANT, 'partner_member') });
    expect(s.statusCode).toBe(200);
    expect(JSON.parse(s.payload)).toMatchObject({ saleReview: 'REJECTED', rejectionReason: '판매자 정보를 보완해 주세요' });

    // 사유 없음·1,001자는 계약의 닫힌 본문 검사가 400으로 막는다(openapi createOpsSaleReviewRejection)
    const p2 = production();
    expect((await rejection(ops(), p2.id, {})).statusCode).toBe(400);
    expect((await rejection(ops(), p2.id, { reason: 'x'.repeat(1001) })).statusCode).toBe(400);
    expect(repo.productions.get(p2.id)?.saleReview).toBe('SUBMITTED');

    // 승인된 공연은 반려할 수 없다
    const p3 = production();
    expect((await approval(ops(), p3.id, { scales: [{ eventId: p3.eventIds[0], scale: 'SMALL' }], placeId: PLACE })).statusCode).toBe(200);
    const late = await rejection(ops(), p3.id, { reason: '늦은 반려' });
    expect(late.statusCode).toBe(409);
    expect(problem(late).type).toBe(`${P}sale-review-not-submitted`);
  });

  test('S-T41 ⑤_ 목록은 기본 SUBMITTED만 상태 필터·커서·limit·오래된 순으로 주고 viewer·CS가 읽되 계좌·연락처·사업자번호를 싣지 않는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.2.3]', async () => {
    const base = NOW_MS;
    const old = production({ submittedAt: new Date(base - 3 * 3_600_000) });
    const mid = production({ submittedAt: new Date(base - 2 * 3_600_000) });
    const recent = production({ submittedAt: new Date(base - 3_600_000) });
    const rejected = production({ saleReview: 'REJECTED', submittedAt: new Date(base - 4 * 3_600_000), approvedAt: new Date(base - 5 * 3_600_000), rejectionReason: '서류 보완' });
    const approved = production({ saleReview: 'APPROVED', submittedAt: null, approvedAt: new Date(base - 6 * 3_600_000) });
    const draft = production({ saleReview: 'DRAFT' });
    const suspended = production({ saleReview: 'SUSPENDED', approvedAt: new Date(base - 7 * 3_600_000) });
    const ids: string[] = [old.id, mid.id, recent.id, rejected.id, approved.id, draft.id, suspended.id];

    const def = await list(ops('viewer'), '?limit=100');
    expect(def.statusCode).toBe(200);
    expect(def.headers['cache-control']).toBe('no-store');
    const defaults = (JSON.parse(def.payload).items as { productionId: string; status: string; submittedAt: string | null }[]).filter((x) => ids.includes(x.productionId));
    expect(defaults.map((x) => x.productionId)).toEqual([old.id, mid.id, recent.id]);
    expect(defaults.every((x) => x.status === 'SUBMITTED')).toBe(true);
    expect(defaults.every((x) => x.submittedAt !== null)).toBe(true);

    const filtered = await list(ops('cs_lead'), '?status=SUBMITTED,REJECTED,SUSPENDED&limit=100');
    expect(filtered.statusCode).toBe(200);
    const filteredIds = (JSON.parse(filtered.payload).items as { productionId: string }[]).map((x) => x.productionId);
    for (const id of [old.id, mid.id, recent.id, rejected.id, suspended.id]) expect(filteredIds).toContain(id);
    expect(filteredIds).not.toContain(approved.id);
    expect(filteredIds).not.toContain(draft.id);

    // 커서: 한 번에 둘씩 넘고 다음 커서로 이어 읽는다
    const page1 = await list(ops(), '?status=SUBMITTED,REJECTED,SUSPENDED&limit=2');
    expect(page1.statusCode).toBe(200);
    const p1 = JSON.parse(page1.payload) as { items: { productionId: string }[]; nextCursor: string | null };
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const page2 = await list(ops(), `?status=SUBMITTED,REJECTED,SUSPENDED&limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`);
    expect(page2.statusCode).toBe(200);
    const p2 = JSON.parse(page2.payload) as { items: { productionId: string }[] };
    expect(new Set([...p1.items, ...p2.items].map((x) => x.productionId)).size).toBe(4);

    // 역할: viewer·CS·CS 팀장은 읽고, 팬·파트너는 이 경로를 못 쓴다. viewer·CS는 승인·반려를 못 한다
    for (const role of ['viewer', 'cs_agent', 'cs_lead'] as const) expect((await list(ops(role))).statusCode, role).toBe(200);
    expect((await list({ 'x-user-id': randomUUID(), 'x-session-id': randomUUID(), 'x-user-aud': 'fan', 'x-user-scope': 'openid' })).statusCode).toBe(401);
    expect((await approval(ops('viewer'), old.id, { scales: [{ eventId: old.eventIds[0], scale: 'SMALL' }], placeId: PLACE })).statusCode).toBe(403);
    expect((await rejection(ops('cs_agent'), old.id, { reason: 'x' })).statusCode).toBe(403);

    // 목록에는 계좌번호 전체·연락처·사업자번호가 없다(판매자 상호만)
    const text = JSON.stringify(JSON.parse(def.payload));
    for (const secret of ['1002-345-678901', '홍길동', '02-1234-5678', '123-45-67890']) expect(text).not.toContain(secret);
    for (const item of JSON.parse(def.payload).items) expect(item).not.toHaveProperty('seller');

    // 잘못된 필터·커서·limit은 400이다
    expect((await list(ops(), '?status=DRAFT')).statusCode).toBe(400);
    expect((await list(ops(), '?cursor=not-a-cursor')).statusCode).toBe(400);
    expect((await list(ops(), '?limit=0')).statusCode).toBe(400);
    expect((await list(ops(), '?limit=101')).statusCode).toBe(400);
  });

  test('S-T41 ⑤_ 잘못된 커서 UUID·반복 쿼리·limit 범위 밖은 400이고 500이 아니다', async () => {
    const nonUuid = Buffer.from(JSON.stringify(['2026-11-07T00:00:00.000Z', 'x'])).toString('base64url');
    const badTime = Buffer.from(JSON.stringify(['언젠가', randomUUID()])).toString('base64url');
    const repeated = Buffer.from(JSON.stringify(['2026-11-07T00:00:00.000Z', randomUUID()])).toString('base64url');
    const cases = [
      `?cursor=${nonUuid}`,
      `?cursor=${badTime}`,
      '?cursor=not-a-cursor',
      '?cursor=',
      '?status=SUBMITTED&status=REJECTED',
      `?cursor=${repeated}&cursor=${repeated}`,
      '?limit=1&limit=2',
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?limit=1.5',
      '?unknown=1',
    ];
    for (const q of cases) {
      const r = await list(ops('viewer'), q);
      expect({ q, status: r.statusCode }).toEqual({ q, status: 400 });
    }
  });

  test('S-T41 ⑤_ 상세는 판매자 정보·회차·규모·판매 정책·수요 예측 링크를 주고 DRAFT·없는 공연은 404이며 no-store다', async () => {
    const p = production({ events: 2, rules: [general], pendingRules: [{ ...general, name: '재승인 대기 규칙' }] });
    repo.eventScales.set(p.eventIds[0]!, 'MEDIUM');
    repo.eventChanges.set(p.id, { [p.eventIds[1]!]: { perPersonLimit: 2 } });
    const d = await detail(ops('viewer'), p.id);
    expect(d.statusCode).toBe(200);
    expect(d.headers['cache-control']).toBe('no-store');
    const out = JSON.parse(d.payload) as {
      seller: Record<string, unknown>;
      events: { eventId: string; scale?: string; demandForecastPath: string }[];
      salePolicy: unknown[];
      suspensionApprovalPending: boolean;
    };
    expect(out.seller).toMatchObject({ legalName: '(주)피켓공연', representative: '대표자', phone: '02-1234-5678', businessRegNo: '123-45-67890' });
    expect(out.events).toHaveLength(2);
    expect(out.events.find((e) => e.eventId === p.eventIds[0])?.scale).toBe('MEDIUM');
    expect(out.events[0]!.demandForecastPath).toBe(`/v1/ops/events/${p.eventIds[0]}/demand-forecast`);
    expect(out.salePolicy).toEqual([{ ...general, name: '재승인 대기 규칙' }]);
    expect(out.suspensionApprovalPending).toBe(false);

    const draft = production({ saleReview: 'DRAFT' });
    expect((await detail(ops(), draft.id)).statusCode).toBe(404);
    const missing = await detail(ops(), randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(problem(missing).type).toBe(`${P}not-found`);
  });

  test('S-T41 ⑩_ 승인은 회차마다 event 태그와 production 태그를 한 번 무효화하고, 반려는 부르지 않으며 CDN 실패에도 200이다', async () => {
    const before = cdn.calls.length;
    const p = production({ events: 2, rules: [general] });
    const r = await approval(ops('commander'), p.id, { scales: p.eventIds.map((eventId) => ({ eventId, scale: 'SMALL' })), placeId: PLACE });
    expect(r.statusCode).toBe(200);
    expect(cdn.calls.length).toBe(before + 1);
    const tags = cdn.calls.at(-1)!;
    expect(new Set(tags)).toEqual(new Set([`event:${p.eventIds[0]!.toLowerCase()}`, `event:${p.eventIds[1]!.toLowerCase()}`, `production:${p.id.toLowerCase()}`]));

    const p2 = production({ events: 1 });
    const afterApprove = cdn.calls.length;
    expect((await rejection(ops(), p2.id, { reason: '공개본이 바뀌지 않는 반려' })).statusCode).toBe(200);
    expect(cdn.calls.length).toBe(afterApprove);
    expect(repo.productions.get(p2.id)?.saleReview).toBe('REJECTED');

    // 무효화가 실패해도 승인은 성공이다(로그만 남긴다)
    const p3 = production({ events: 1, rules: [general] });
    failCdn = true;
    try {
      expect((await approval(ops(), p3.id, { scales: [{ eventId: p3.eventIds[0], scale: 'SMALL' }], placeId: PLACE })).statusCode).toBe(200);
    } finally {
      failCdn = false;
    }
    expect(repo.productions.get(p3.id)?.saleReview).toBe('APPROVED');
  });
});
