// 받는 층: S-T40 ⑧ 가져오기 결과와 저장 응답의 업무 경고(openapi createPartnerProductionSeatmapImport·putPartnerProductionSeatmap,
// ADR-0264 결정 15, BUILD_ORDER HOT-230). 같은 검사기를 두 경로가 부르고, 경고는 저장을 막지 않으며 좌석 ID는 100개까지다.
import 'reflect-metadata';
import { CreatePartnerProductionSeatmapImportResponse, PutPartnerProductionSeatmapResponse } from '@peaket/contracts/openapi/partner';
import { createService } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { CheckedLayout } from '../src/modules/catalog/domain/seatmap-import.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { multipart } from '../test-int/media-support.js';
import { FakeIdentity, testMedia } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const TENANT = randomUUID();
const PROD = randomUUID();
const EVENT = randomUUID();
const seatIds = Array.from({ length: 101 }, () => randomUUID());
const layout: CheckedLayout = {
  canvas: { width: 1000, height: 600 },
  sections: [
    {
      sectionId: 'A',
      name: 'A구역',
      tierId: 'R',
      shape: { kind: 'POLYGON', points: [[0, 0], [1000, 0], [1000, 600], [0, 600]] },
      seats: seatIds.map((seatId, i) => ({ seatId, row: '1', number: i + 1, x: 10, y: 10, tierId: 'R' })),
    },
  ],
  priceTiers: [{ tierId: 'R', name: 'R석', price: 1000 }],
};
/** 가져오기가 돌려줄 배치. 저장이 매긴 좌석 ID를 그대로 넣어 두 경로의 경고 좌석을 견준다 */
let parsed: CheckedLayout = layout;
const parser = {
  parse: async () => ({ status: 'PARSED' as const, layout: parsed, errors: [], ignored: [] }),
};

beforeAll(async () => {
  repo.productions.set(PROD, { id: PROD, promoterId: TENANT, placeId: null, title: '겨울 콘서트', genre: '콘서트', saleReview: 'DRAFT', saleApprovedAt: null });
  repo.events.set(EVENT, { id: EVENT, productionId: PROD, venueId: null, openAt: new Date('2026-11-20T11:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), status: 'SCHEDULED' });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, media: testMedia({ seatmap: parser }) }),
    env: { PEAKET_ENV: 'ci' },
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const h = () => identity.partner(TENANT, 'partner_member');
const importFile = async () => {
  const { payload, contentType } = await multipart({ format: 'JSON' }, [{ name: 'seatmap.json', type: 'application/json', bytes: new TextEncoder().encode('{}') }]);
  return svc.http.inject({
    method: 'POST',
    url: `/v1/partner/productions/${PROD}/seatmap-imports`,
    headers: { ...h(), 'content-type': contentType, 'x-requested-with': 'peaket-partner' },
    payload,
  });
};

describe('S-T40 ⑧ 가져오기·저장 경고', () => {
  test('S-T40 ⑧ 저장 응답과 가져오기 결과의 warnings가 같은 코드·좌석이고 저장은 200으로 판이 오른다', async () => {
    const saved = await svc.http.inject({
      method: 'PUT',
      url: `/v1/partner/productions/${PROD}/seatmap`,
      headers: { ...h(), 'content-type': 'application/json', 'if-match': '"0"' },
      payload: JSON.stringify({ canvas: layout.canvas, sections: layout.sections, priceTiers: layout.priceTiers }),
    });
    expect([saved.statusCode, saved.headers.etag]).toEqual([200, '"1"']);
    const savedOut = PutPartnerProductionSeatmapResponse.parse(JSON.parse(saved.payload));
    expect(savedOut.layoutVersion).toBe(1);
    const savedOverlap = savedOut.warnings!.find((w) => w.code === 'SEAT_OVERLAP')!;
    expect(savedOverlap.seatCount).toBe(101);
    expect(savedOverlap.seatIds).toHaveLength(100);
    expect(savedOut.warnings!.find((w) => w.code === 'W1')).toMatchObject({ seatCount: 0 });

    // 저장이 매긴 좌석 ID로 같은 배치를 가져오면 같은 코드·좌석이 경고로 나온다
    parsed = { canvas: savedOut.canvas, sections: savedOut.sections as unknown as CheckedLayout['sections'], priceTiers: savedOut.priceTiers };
    const imported = await importFile();
    expect(imported.statusCode).toBe(200);
    const out = CreatePartnerProductionSeatmapImportResponse.parse(JSON.parse(imported.payload));
    const importedWarnings = out.warnings ?? [];
    const importedOverlap = importedWarnings.find((w) => w.code === 'SEAT_OVERLAP')!;
    expect([importedOverlap.seatCount, importedOverlap.seatIds]).toEqual([savedOverlap.seatCount, savedOverlap.seatIds]);
    expect(importedWarnings.map((w) => w.code)).toEqual(savedOut.warnings!.map((w) => w.code));
  });
});
