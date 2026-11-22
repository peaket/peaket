// 판매 승인 계약·생성물·MSW 처리기 시험(BAT-617, LCH-080, RV-05). 실행: pnpm --filter @peaket/api-client test
// 승인 본문은 scales·placeId(선택)·accessibleSeatingCheck(선택)만 받고, artistIds·aliases는 계약과 생성물에 없다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { CreateOpsSaleReviewApprovalBody } from '../../contracts/src/gen/openapi/ops';
import { getGetOpsSaleReviewMockHandler, getCreateOpsSaleReviewApprovalMockHandler, getListOpsSaleReviewsMockHandler } from '../src/gen/endpoints/ops/ops.msw';
import { getCreatePartnerProductionSaleReviewMockHandler, getGetPartnerProductionSaleReviewMockHandler } from '../src/gen/endpoints/partner/partner.msw';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const spec = parse(readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8')) as {
  paths: Record<string, { post?: { requestBody?: { content: { 'application/json': { schema: Record<string, unknown> } } } } }>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};
const approval = spec.paths['/v1/ops/sale-reviews/{productionId}/approvals']!.post!.requestBody!.content['application/json'].schema as {
  required: string[];
  properties: Record<string, unknown>;
};

const server = setupServer(
  getListOpsSaleReviewsMockHandler({ items: [], nextCursor: null }),
  getGetOpsSaleReviewMockHandler({
    productionId: 'prd-1',
    title: '겨울 콘서트',
    placeId: '3f1c2d9e-0000-4000-8000-000000000001',
    placeName: '피켓 아레나',
    requestedPlace: false,
    accessibleSeatingCheck: true,
    events: [],
  }),
  getCreateOpsSaleReviewApprovalMockHandler(),
  getGetPartnerProductionSaleReviewMockHandler({ title: '겨울 콘서트', saleReview: 'SUBMITTED', hasApprovalHistory: false, events: [] }),
  getCreatePartnerProductionSaleReviewMockHandler(),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('판매 승인 계약과 생성물', () => {
  test('S-T41 ⑫_[ASVS v5.0.0-8.2.2] 승인 본문은 scales와 placeId·accessibleSeatingCheck만 받는다', () => {
    expect(approval.required).toEqual(['scales']);
    expect(Object.keys(approval.properties).sort()).toEqual(['accessibleSeatingCheck', 'placeId', 'scales']);
    expect(Object.keys(approval.properties)).not.toContain('artistIds');
    expect(Object.keys(approval.properties)).not.toContain('aliases');

    const ok = CreateOpsSaleReviewApprovalBody.safeParse({ scales: [{ eventId: 'ev-1', scale: 'LARGE' }], placeId: '3f1c2d9e-0000-4000-8000-000000000001' });
    expect(ok.success).toBe(true);
    for (const extra of [{ artistIds: [] }, { aliases: ['LUMEN CONCERT'] }]) {
      const bad = CreateOpsSaleReviewApprovalBody.safeParse({ scales: [{ eventId: 'ev-1', scale: 'LARGE' }], ...extra });
      expect(bad.success, JSON.stringify(extra)).toBe(false);
    }
    expect(CreateOpsSaleReviewApprovalBody.safeParse({ scales: [] }).success).toBe(false);
  });

  test('S-T41 ⑫ 관제 상세와 파트너 현황의 새 읽기 칸이 계약에 있다', () => {
    const detail = spec.components.schemas.OpsSaleReviewDetail!.properties!;
    for (const key of ['placeId', 'placeName', 'requestedPlace', 'accessibleSeatingCheck']) expect(detail).toHaveProperty(key);
    expect(spec.components.schemas.PartnerSaleReviewStatus!.properties!).toHaveProperty('title');
    // 생성 TS 모델도 같은 칸을 쓴다(생성기 밖에서 손으로 고치지 않는다)
    const model = readFileSync(join(ROOT, 'packages/api-client/src/gen/model/createOpsSaleReviewApprovalBody.ts'), 'utf8');
    expect(model).not.toContain('artistIds');
    expect(model).not.toContain('aliases');
  });

  test('S-T41 ⑫ MSW 처리기가 새 계약 모양의 목록·상세·승인·파트너 현황을 답한다', async () => {
    const detail = await fetch('http://api.test/v1/ops/sale-reviews/prd-1');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ placeId: '3f1c2d9e-0000-4000-8000-000000000001', placeName: '피켓 아레나', requestedPlace: false, accessibleSeatingCheck: true });

    const partner = await fetch('http://api.test/v1/partner/productions/prd-1/sale-review');
    expect(partner.status).toBe(200);
    expect(await partner.json()).toMatchObject({ title: '겨울 콘서트', saleReview: 'SUBMITTED' });

    const approved = await fetch('http://api.test/v1/ops/sale-reviews/prd-1/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scales: [{ eventId: 'ev-1', scale: 'LARGE' }], placeId: '3f1c2d9e-0000-4000-8000-000000000001' }),
    });
    expect(approved.status).toBe(200);

    const requested = await fetch('http://api.test/v1/partner/productions/prd-1/sale-review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seller: { legalName: '(주)피켓공연', representative: '김대표', address: '서울', phone: '02-1234-5678', email: 'seller@example.test', businessRegNo: '123-45-67890', mailOrderReportNo: '2026-서울-1234' },
        payoutAccount: { bankCode: '004', accountNumber: '1002-345-678901', holderName: '김대표' },
        accessibleSeating: { confirmed: true },
      }),
    });
    expect(requested.status).toBe(202);
  });
});
