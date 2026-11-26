// 받는 층·유스케이스: 후기 사진 올리기·붙이기·보이기·지우기·정리(FR-016, POL-042 ⑥, ADR-0066, F-07-10).
// 사진 처리 작업(image-worker)은 대역으로 세운다. core-svc는 원본을 디코딩하지 않고 포트에 맡기므로,
// 이 시험은 포트가 돌려준 폭·높이·파생본 키를 core가 다시 검사하는지와 공개·삭제·한도를 본다.
// 기준 트리에서는 /v1/review-images가 없어(404) 새 동작 시험이 실패한다. 구현은 이 시험을 고치지 않는다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, MemoryImageObjectStore, type Production, type SaleReview } from '../src/modules/catalog/index.js';
import {
  MemoryFanProfile,
  MemoryReviewCaseSink,
  MemoryReviewEligibility,
  MemoryReviewNotifier,
  MemoryReviewStore,
  Reviews,
  reviewMaintenanceTasks,
} from '../src/modules/review/index.js';
import { FakeIdentity, fan, IMAGE_ORIGIN_TEST, NOW_MS, quiet, testMedia } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
let reviews: Reviews;
const repo = new MemoryCatalogRepository();
const store = new MemoryReviewStore();
const eligibility = new MemoryReviewEligibility();
const fanProfiles = new MemoryFanProfile();
const notifier = new MemoryReviewNotifier();
const cases = new MemoryReviewCaseSink();
const identity = new FakeIdentity();
const objects = new MemoryImageObjectStore();
const clock = fakeClock({ now: NOW_MS });
const PROMOTER = randomUUID();

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const GIF = new TextEncoder().encode('GIF89a-not-an-image');
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const marked = (base: Uint8Array, marker: string) => Uint8Array.from([...base, ...new TextEncoder().encode(marker)]);

/**
 * image-worker ImageService.ProcessImage 대역. 대역은 격리 위치의 원본을 읽어 결과를 정하고,
 * ACCEPTED면 준비 위치에 파생본 두 개(240·1280 WebP)를 쓴다. core가 그 키·폭·높이·앞부분을 다시 검사한다.
 */
const processing = {
  async process(q: { sourceKey: string; kind: string; timeoutMs: number }) {
    expect(q.kind).toBe('REVIEW_PHOTO');
    const bytes = objects.quarantine.get(q.sourceKey);
    if (!bytes) return { status: 'UNKNOWN' as const };
    const m = text(bytes);
    const id = q.sourceKey.slice('quarantine/review/'.length);
    if (m.includes('MALWARE')) return { status: 'REJECTED' as const, reason: 'MALWARE' as const };
    if (m.includes('SMALL')) return { status: 'REJECTED' as const, reason: 'TOO_SMALL' as const };
    if (m.includes('LARGE')) return { status: 'REJECTED' as const, reason: 'TOO_LARGE' as const };
    if (m.includes('PENDING')) return { status: 'SCAN_PENDING' as const };
    if (m.includes('THROW')) throw new Error('처리 작업이 던졌다');
    if (m.includes('UNKNOWN')) return { status: 'UNKNOWN' as const };
    const keys = [`staging/review/${id}/240.webp`, `staging/review/${id}/1280.webp`];
    if (m.includes('BADKEYS')) return { status: 'ACCEPTED' as const, width: 800, height: 600, derivativeKeys: [keys[0]!] };
    if (m.includes('OUTSIDEKEY')) return { status: 'ACCEPTED' as const, width: 800, height: 600, derivativeKeys: [`staging/other/${id}/240.webp`, `staging/other/${id}/1280.webp`] };
    if (m.includes('EXTRAKEY')) return { status: 'ACCEPTED' as const, width: 800, height: 600, derivativeKeys: [...keys, `staging/review/${id}/640.webp`] };
    if (m.includes('SHORT319')) return { status: 'ACCEPTED' as const, width: 319, height: 600, derivativeKeys: keys };
    if (m.includes('SHORT320')) {
      for (const k of keys) objects.staging.set(k, WEBP);
      return { status: 'ACCEPTED' as const, width: 320, height: 600, derivativeKeys: keys };
    }
    if (m.includes('LONG20000')) {
      for (const k of keys) objects.staging.set(k, WEBP);
      return { status: 'ACCEPTED' as const, width: 800, height: 20_000, derivativeKeys: keys };
    }
    if (m.includes('LONG20001')) return { status: 'ACCEPTED' as const, width: 800, height: 20_001, derivativeKeys: keys };
    if (m.includes('PIXELS40000000')) {
      for (const k of keys) objects.staging.set(k, WEBP);
      return { status: 'ACCEPTED' as const, width: 8_000, height: 5_000, derivativeKeys: keys };
    }
    if (m.includes('PIXELS40000001')) return { status: 'ACCEPTED' as const, width: 8_000, height: 5_001, derivativeKeys: keys };
    for (const k of keys) objects.staging.set(k, m.includes('BIGDERIV') ? new Uint8Array(5 * 1024 * 1024 + 1) : WEBP);
    return { status: 'ACCEPTED' as const, width: 800, height: 600, derivativeKeys: keys };
  },
};

beforeAll(async () => {
  repo.sellerNames.set(PROMOTER, '(주)피켓공연');
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      memory: true,
      catalog: repo,
      media: testMedia({ processing: processing as never, store: objects }),
      review: { store, eligibility, fanProfile: fanProfiles, notifier, cases },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  reviews = svc.app.get(Reviews);
});
afterAll(async () => {
  await svc?.close();
});

function seed(o: { startsAt?: Date; status?: 'SCHEDULED' | 'CANCELLED'; saleReview?: SaleReview; saleApprovedAt?: Date | null } = {}): { eventId: string; productionId: string } {
  const p: Production = { id: randomUUID(), promoterId: PROMOTER, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview: o.saleReview ?? 'APPROVED', saleApprovedAt: o.saleApprovedAt ?? new Date('2026-11-01T00:00:00Z') };
  repo.productions.set(p.id, p);
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: p.id, venueId: randomUUID(), openAt: new Date('2026-01-01T00:00:00Z'), startsAt: o.startsAt ?? new Date('2026-01-01T10:00:00Z'), status: o.status ?? 'SCHEDULED' });
  return { eventId, productionId: p.id };
}

async function upload(account: string, bytes: Uint8Array, o: { type?: string; name?: string; header?: boolean } = {}) {
  const fd = new FormData();
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  fd.append('file', new Blob([ab], { type: o.type ?? 'image/jpeg' }), o.name ?? 'photo.jpg');
  const req = new Request('http://local/', { method: 'POST', body: fd });
  return svc.http.inject({
    method: 'POST',
    url: '/v1/review-images',
    headers: { ...fan(account), 'content-type': req.headers.get('content-type')!, ...(o.header === false ? {} : { 'x-requested-with': 'XMLHttpRequest' }) },
    payload: Buffer.from(await req.arrayBuffer()),
  });
}

async function uploadOk(account: string): Promise<{ imageId: string; thumbnailUrl: string }> {
  const r = await upload(account, JPEG);
  expect(r.statusCode).toBe(201);
  const body = JSON.parse(r.payload);
  expect(body).toMatchObject({ status: 'READY' });
  expect(body.imageId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.thumbnailUrl).toBe(`${IMAGE_ORIGIN_TEST}/review/${body.imageId}/240.webp`);
  return body;
}

const postReview = (eventId: string, account: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/events/${eventId}/reviews`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const patchReview = (reviewId: string, account: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'PATCH', url: `/v1/reviews/${reviewId}`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const getReview = (reviewId: string, account?: string) => svc.http.inject({ method: 'GET', url: `/v1/reviews/${reviewId}`, headers: account ? fan(account) : {} });
const getList = (eventId: string, account?: string) => svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}/reviews`, headers: account ? fan(account) : {} });
const getSummary = (eventId: string) => svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}/review-summary` });
const report = (reviewId: string, account: string, category: string, extra: Record<string, unknown> = {}) =>
  svc.http.inject({ method: 'POST', url: `/v1/reviews/${reviewId}/reports`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify({ category, ...extra }) });

const publishedKeys = (imageId: string) => [...objects.published.keys()].filter((k) => k.startsWith(`review/${imageId}/`));
/** 저장소가 후기 사진 행을 돌려주면 그 행(삭제 표시 포함). 구현 전에는 메서드가 없어 빈 배열이라 시험이 실패한다 */
async function imageRowsOf(reviewId: string): Promise<readonly { status: string }[]> {
  const s = store as unknown as { imagesByReviews?: (ids: readonly string[]) => Promise<Map<string, readonly { status: string }[]>> };
  if (!s.imagesByReviews) return [];
  return (await s.imagesByReviews([reviewId])).get(reviewId) ?? [];
}
/** 그 계정의 사진 행 전부(상태 포함). 거절한 업로드가 행을 남기지 않는지 본다 */
async function imageRowsByAccount(accountId: string): Promise<readonly { status: string; reviewId?: string | null }[]> {
  const s = store as unknown as { imageRowsByAccount?: (id: string) => Promise<readonly { status: string; reviewId?: string | null }[]> };
  expect(s.imageRowsByAccount).toBeTypeOf('function');
  return s.imageRowsByAccount ? s.imageRowsByAccount(accountId) : [];
}
/** 정리 때가 된 행(붙이지 않은 24시간 지난 READY, DELETED). 정리 작업이 행을 지웠는지 본다 */
async function dueImageRows(nowMs: number): Promise<readonly { status: string; imageId?: string }[]> {
  const s = store as unknown as { imageRowsDueForCleanup?: (ms: number, limit: number) => Promise<readonly { status: string; imageId?: string }[]> };
  expect(s.imageRowsDueForCleanup).toBeTypeOf('function');
  return s.imageRowsDueForCleanup ? s.imageRowsDueForCleanup(nowMs, 1000) : [];
}

describe('후기 사진 올리기', () => {
  test('IMG-01 [ASVS v5.0.0-2.2.3] X-Requested-With가 없으면 400이고, JPEG·PNG·WebP만 앞부분·형식·확장자가 모두 같을 때 받는다', async () => {
    const me = randomUUID();
    expect((await upload(me, JPEG, { header: false })).statusCode).toBe(400);

    const gif = await upload(me, GIF, { type: 'image/gif', name: 'x.gif' });
    expect(gif.statusCode).toBe(422);
    expect(JSON.parse(gif.payload).extensions.reason).toBe('UNSUPPORTED_TYPE');

    // 앞부분·Content-Type·확장자 가운데 하나만 틀려도 받지 않는다
    const typeMismatch = await upload(me, JPEG, { type: 'image/png', name: 'x.jpg' });
    expect(typeMismatch.statusCode).toBe(422);
    expect(JSON.parse(typeMismatch.payload).extensions.reason).toBe('UNSUPPORTED_TYPE');
    const extMismatch = await upload(me, JPEG, { type: 'image/jpeg', name: 'x.png' });
    expect(extMismatch.statusCode).toBe(422);
    expect(JSON.parse(extMismatch.payload).extensions.reason).toBe('UNSUPPORTED_TYPE');
    const headMismatch = await upload(me, PNG, { type: 'image/jpeg', name: 'x.jpg' });
    expect(headMismatch.statusCode).toBe(422);
    expect(JSON.parse(headMismatch.payload).extensions.reason).toBe('UNSUPPORTED_TYPE');

    const png = await upload(me, PNG, { type: 'image/png', name: 'x.png' });
    expect(png.statusCode).toBe(201);
    expect(JSON.parse(png.payload).thumbnailUrl).toMatch(/^https:\/\/img\.peaket\.test\/review\/[0-9a-f-]{36}\/240\.webp$/);

    const webp = await upload(me, WEBP, { type: 'image/webp', name: 'x.webp' });
    expect(webp.statusCode).toBe(201);
  });

  test('IMG-02 [ASVS v5.0.0-2.2.3] 통과하면 공개 파생본 두 개만 남기고 격리 원본·준비 위치는 지운다', async () => {
    const me = randomUUID();
    const { imageId } = await uploadOk(me);
    expect(publishedKeys(imageId).sort()).toEqual([`review/${imageId}/1280.webp`, `review/${imageId}/240.webp`]);
    for (const k of publishedKeys(imageId)) {
      const b = objects.published.get(k)!.bytes;
      expect(text(b.subarray(0, 4))).toBe('RIFF');
      expect(text(b.subarray(8, 12))).toBe('WEBP');
      expect(objects.published.get(k)!.contentType).toBe('image/webp');
    }
    expect(objects.quarantine.size).toBe(0);
    expect(objects.staging.size).toBe(0);
  });

  test('IMG-03 [ASVS v5.0.0-1.3.3][ASVS v5.0.0-2.2.3] 거절 사유 넷과 처리 작업의 미완·모르는 답은 422·503이고 아무것도 공개하지 않는다', async () => {
    const me = randomUUID();
    const before = objects.published.size;
    for (const [marker, reason] of [['SMALL', 'TOO_SMALL'], ['LARGE', 'TOO_LARGE'], ['MALWARE', 'MALWARE']] as const) {
      const r = await upload(me, marked(JPEG, marker));
      expect(r.statusCode).toBe(422);
      expect(JSON.parse(r.payload).extensions.reason).toBe(reason);
    }
    expect((await upload(me, marked(JPEG, 'PENDING'))).statusCode).toBe(503);
    expect((await upload(me, marked(JPEG, 'BADKEYS'))).statusCode).toBe(503);
    expect((await upload(me, marked(JPEG, 'OUTSIDEKEY'))).statusCode).toBe(503);
    expect((await upload(me, marked(JPEG, 'EXTRAKEY'))).statusCode).toBe(503);
    expect((await upload(me, marked(JPEG, 'BIGDERIV'))).statusCode).toBe(503);
    expect((await upload(me, marked(JPEG, 'THROW'))).statusCode).toBe(503);
    expect((await upload(me, marked(JPEG, 'UNKNOWN'))).statusCode).toBe(503);
    expect(objects.published.size).toBe(before);
    expect(objects.quarantine.size).toBe(0);
    expect(objects.staging.size).toBe(0);
    expect(await imageRowsByAccount(me)).toEqual([]);
  });

  test('IMG-04 [ASVS v5.0.0-2.2.3] 돌아온 폭·높이를 다시 본다: 짧은 변 319는 422, 320은 받고, 긴 변 20,000·화소 4,000만은 받으며 20,001·4,000만+1은 422다', async () => {
    const me = randomUUID();
    const short = await upload(me, marked(JPEG, 'SHORT319'));
    expect(short.statusCode).toBe(422);
    expect(JSON.parse(short.payload).extensions.reason).toBe('TOO_SMALL');
    expect((await upload(me, marked(JPEG, 'SHORT320'))).statusCode).toBe(201);
    expect((await upload(me, marked(JPEG, 'LONG20000'))).statusCode).toBe(201);
    expect((await upload(me, marked(JPEG, 'LONG20001'))).statusCode).toBe(422);
    expect((await upload(me, marked(JPEG, 'PIXELS40000000'))).statusCode).toBe(201);
    expect((await upload(me, marked(JPEG, 'PIXELS40000001'))).statusCode).toBe(422);

    // 한 장 10MB 경계. 10MB는 받고 10MB+1은 422 TOO_LARGE다(본문 상한은 10MB+64KB 봉투라 게이트웨이 413이 아니다)
    const tenMb = new Uint8Array(10 * 1024 * 1024);
    tenMb.set(JPEG);
    expect((await upload(me, tenMb)).statusCode).toBe(201);
    const over = new Uint8Array(10 * 1024 * 1024 + 1);
    over.set(JPEG);
    const tooLarge = await upload(me, over);
    expect(tooLarge.statusCode).toBe(422);
    expect(JSON.parse(tooLarge.payload).extensions.reason).toBe('TOO_LARGE');
  });

  test('IMG-11 [ASVS v5.0.0-2.4.1][ASVS v5.0.0-2.3.2] 한 계정은 한 시간에 30장까지이고 31번째는 429, 다른 계정은 따로 센다. 한 시간이 지나면 다시 받는다', async () => {
    const me = randomUUID();
    for (let i = 0; i < 30; i++) expect((await upload(me, JPEG)).statusCode).toBe(201);
    const limited = await upload(me, JPEG);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await upload(randomUUID(), JPEG)).statusCode).toBe(201);
    clock.advance(60 * 60 * 1000 + 1);
    expect((await upload(me, JPEG)).statusCode).toBe(201);
  });
});

describe('후기 쓰기·고치기의 사진', () => {
  test('IMG-05 [ASVS v5.0.0-2.2.3] 같은 계정 READY 사진만 3장까지 순서대로 붙고, 목록·요약·단건이 같은 사진을 준다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const a = await uploadOk(me);
    const b = await uploadOk(me);
    const c = await uploadOk(me);

    const created = await postReview(eventId, me, {
      rating: 5,
      body: '사진을 붙인 후기 본문입니다.',
      images: [{ imageId: a.imageId, alt: '무대' }, { imageId: b.imageId }, { imageId: c.imageId, alt: '   ' }],
    });
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.payload);
    expect(body.images.map((i: { imageId: string }) => i.imageId)).toEqual([a.imageId, b.imageId, c.imageId]);
    expect(body.images[0]).toMatchObject({ alt: '무대', width: 800, height: 600, thumbnailUrl: a.thumbnailUrl, url: `${IMAGE_ORIGIN_TEST}/review/${a.imageId}/1280.webp` });
    expect(body.images[1].alt ?? '').toBe('');
    expect(body.images[2].alt ?? '').toBe('');

    const list = JSON.parse((await getList(eventId, randomUUID())).payload);
    expect(list.items[0].images).toHaveLength(3);
    expect(list.items[0].images[0].url).toBe(`${IMAGE_ORIGIN_TEST}/review/${a.imageId}/1280.webp`);
    const summary = JSON.parse((await getSummary(eventId)).payload);
    expect(summary.recent[0].images).toHaveLength(3);
    expect(JSON.parse((await getReview(body.reviewId)).payload).images).toHaveLength(3);
  });

  test('IMG-06 [ASVS v5.0.0-1.3.3] 사진 설명은 제어·양방향 제어 문자를 지우고 100 grapheme까지다(101은 422)', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const a = await uploadOk(me);
    const created = await postReview(eventId, me, { rating: 4, body: '사진 설명을 검사하는 후기입니다.', images: [{ imageId: a.imageId, alt: '무대\u202E설명' }] });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.payload).images[0].alt).toBe('무대설명');

    const { eventId: e2 } = seed();
    eligibility.set(me, e2, { eligible: true, basisOrderId: randomUUID() });
    const fresh = await uploadOk(me);
    const tooLong = await postReview(e2, me, { rating: 4, body: '사진 설명이 너무 긴 후기입니다.', images: [{ imageId: fresh.imageId, alt: '가'.repeat(101) }] });
    expect(tooLong.statusCode).toBe(422);

    const { eventId: e3 } = seed();
    eligibility.set(me, e3, { eligible: true, basisOrderId: randomUUID() });
    const max = await uploadOk(me);
    const exactly = await postReview(e3, me, { rating: 4, body: '사진 설명이 정확히 100자인 후기입니다.', images: [{ imageId: max.imageId, alt: '가'.repeat(100) }] });
    expect(exactly.statusCode).toBe(201);
    expect([...JSON.parse(exactly.payload).images[0].alt].length).toBe(100);
  });

  test('IMG-07 [ASVS v5.0.0-2.2.3] 남의 사진·없는 사진·이미 붙은 사진·4장은 거절하고, 빠진 사진은 지운다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    const other = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const mine = await uploadOk(me);
    const foreign = await uploadOk(other);

    const stolen = await postReview(eventId, me, { rating: 5, body: '남의 사진을 붙이려는 후기입니다.', images: [{ imageId: foreign.imageId }] });
    expect(stolen.statusCode).toBe(422);

    const missing = await postReview(eventId, me, { rating: 5, body: '없는 사진을 붙이려는 후기입니다.', images: [{ imageId: randomUUID() }] });
    expect(missing.statusCode).toBe(422);

    const created = await postReview(eventId, me, { rating: 5, body: '내 사진 하나를 붙인 후기입니다.', images: [{ imageId: mine.imageId, alt: '첫 사진' }] });
    expect(created.statusCode).toBe(201);
    const reviewId = JSON.parse(created.payload).reviewId;

    const { eventId: e2 } = seed();
    eligibility.set(me, e2, { eligible: true, basisOrderId: randomUUID() });
    const reused = await postReview(e2, me, { rating: 5, body: '이미 붙은 사진을 다시 붙이는 후기입니다.', images: [{ imageId: mine.imageId }] });
    expect(reused.statusCode).toBe(422);

    const four = [await uploadOk(me), await uploadOk(me), await uploadOk(me), await uploadOk(me)];
    const tooMany = await patchReview(reviewId, me, { rating: 5, body: '사진을 네 장 붙이는 후기입니다.', images: four.map((x) => ({ imageId: x.imageId })) });
    expect([400, 422]).toContain(tooMany.statusCode);

    const replaced = await patchReview(reviewId, me, { rating: 4, body: '사진을 바꾼 후기입니다.', images: [{ imageId: four[0]!.imageId, alt: '바뀐 사진' }] });
    expect(replaced.statusCode).toBe(200);
    expect(JSON.parse(replaced.payload).images.map((i: { imageId: string }) => i.imageId)).toEqual([four[0]!.imageId]);
    expect(publishedKeys(mine.imageId)).toEqual([]);

    const kept = await patchReview(reviewId, me, { rating: 4, body: '사진을 그대로 두는 후기입니다.' });
    expect(JSON.parse(kept.payload).images).toHaveLength(1);

    const cleared = await patchReview(reviewId, me, { rating: 4, body: '사진을 모두 지우는 후기입니다.', images: [] });
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(cleared.payload).images).toEqual([]);
    expect(publishedKeys(four[0]!.imageId)).toEqual([]);
  });

  test('IMG-08 [ASVS v5.0.0-2.3.3] 사진 하나가 틀리면 후기 저장도 사진 연결도 남지 않는다(한 트랜잭션)', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    const other = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const mine = await uploadOk(me);
    const foreign = await uploadOk(other);

    const failed = await postReview(eventId, me, { rating: 5, body: '한 장이 남의 사진인 후기입니다.', images: [{ imageId: mine.imageId }, { imageId: foreign.imageId }] });
    expect(failed.statusCode).toBe(422);
    expect(JSON.parse((await getList(eventId, me)).payload).items).toHaveLength(0);

    // 사진이 없으면 같은 계정·회차에 쓸 수 있다(실패한 요청이 후기 행을 남기지 않았다)
    const ok = await postReview(eventId, me, { rating: 5, body: '사진 없이 다시 쓴 후기 본문입니다.' });
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.payload).images).toEqual([]);

    // 고치기에서 새 사진이 틀리면 본문·기존 사진이 그대로다
    const kept = JSON.parse(ok.payload);
    const replaced = await patchReview(kept.reviewId, me, { rating: 5, body: '고치다 만 본문입니다.', images: [{ imageId: foreign.imageId }] });
    expect(replaced.statusCode).toBe(422);
    const after = JSON.parse((await getReview(kept.reviewId, me)).payload);
    expect(after.body).toBe('사진 없이 다시 쓴 후기 본문입니다.');
    expect(after.images).toEqual([]);

    // 같은 사진을 두 후기에 동시에 붙이면 하나만 성공한다
    const shared = await uploadOk(me);
    const e3 = seed();
    const e4 = seed();
    eligibility.set(me, e3.eventId, { eligible: true, basisOrderId: randomUUID() });
    eligibility.set(me, e4.eventId, { eligible: true, basisOrderId: randomUUID() });
    const [r3, r4] = await Promise.all([
      postReview(e3.eventId, me, { rating: 5, body: '같은 사진을 붙이는 첫 후기입니다.', images: [{ imageId: shared.imageId }] }),
      postReview(e4.eventId, me, { rating: 5, body: '같은 사진을 붙이는 둘째 후기입니다.', images: [{ imageId: shared.imageId }] }),
    ]);
    expect([r3.statusCode, r4.statusCode].sort()).toEqual([201, 422]);
  });
});

describe('후기 사진 보이기·지우기', () => {
  test('IMG-09 [ASVS v5.0.0-2.2.3] 가린 후기에는 남에게도 본인에게도 사진을 싣지 않고, 지우면 공개 파생본도 지운다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    const reporter = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const a = await uploadOk(me);
    const b = await uploadOk(me);
    const created = await postReview(eventId, me, { rating: 5, body: '불법 촬영물로 신고될 후기 본문입니다.', images: [{ imageId: a.imageId }, { imageId: b.imageId }] });
    expect(created.statusCode).toBe(201);
    const reviewId = JSON.parse(created.payload).reviewId;

    expect((await report(reviewId, reporter, 'ILLEGAL_FILMING')).statusCode).toBe(201);
    expect((await getReview(reviewId, reporter)).statusCode).toBe(404);
    const mineHidden = JSON.parse((await getReview(reviewId, me)).payload);
    expect(mineHidden).toMatchObject({ status: 'HIDDEN' });
    expect(mineHidden.images).toEqual([]);

    const second = seed();
    eligibility.set(me, second.eventId, { eligible: true, basisOrderId: randomUUID() });
    const another = await postReview(second.eventId, me, { rating: 3, body: '지울 후기 본문입니다.' });
    expect(another.statusCode).toBe(201);
    const anotherId = JSON.parse(another.payload).reviewId;
    expect((await svc.http.inject({ method: 'DELETE', url: `/v1/reviews/${anotherId}`, headers: fan(me) })).statusCode).toBe(204);

    expect((await svc.http.inject({ method: 'DELETE', url: `/v1/reviews/${reviewId}`, headers: fan(me) })).statusCode).toBe(204);
    expect(publishedKeys(a.imageId)).toEqual([]);
    expect(publishedKeys(b.imageId)).toEqual([]);
    const rows = await imageRowsOf(reviewId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'DELETED')).toBe(true);
    expect(JSON.parse((await getList(eventId, me)).payload).items).toHaveLength(0);
    expect(JSON.parse((await getSummary(eventId)).payload).count).toBe(0);
  });

  test('IMG-10 [ASVS v5.0.0-2.3.3] 붙이지 않은 사진은 24시간이 지나면 정리하고, 붙인 사진은 남긴다. 같은 정리를 다시 돌려도 결과가 같다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const attached = await uploadOk(me);
    const review = await postReview(eventId, me, { rating: 5, body: '정리 뒤에도 사진이 남을 후기입니다.', images: [{ imageId: attached.imageId }] });
    expect(review.statusCode).toBe(201);
    const reviewId = JSON.parse(review.payload).reviewId;
    const unattached = await uploadOk(me);
    expect(publishedKeys(attached.imageId)).toHaveLength(2);
    expect(publishedKeys(unattached.imageId)).toHaveLength(2);

    clock.advance(24 * 60 * 60 * 1000 + 1);
    const dueBefore = await dueImageRows(clock.now());
    expect(dueBefore.map((r) => r.imageId)).toContain(unattached.imageId);
    expect(dueBefore.map((r) => r.imageId)).not.toContain(attached.imageId);
    const tasks = reviewMaintenanceTasks(store, clock, { images: { objects } } as never);
    const cleanup = tasks.find((t) => t.name === 'review-image-cleanup');
    expect(cleanup).toBeDefined();
    await cleanup!.run();
    expect(publishedKeys(unattached.imageId)).toEqual([]);
    expect(publishedKeys(attached.imageId)).toHaveLength(2);
    expect((await imageRowsOf(reviewId)).every((r) => r.status === 'READY')).toBe(true);
    // 붙이지 않은 사진의 행은 지워지고, 붙인 사진 행만 남는다
    const rowsAfter = await imageRowsByAccount(me);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]!).toMatchObject({ status: 'READY', reviewId });

    await cleanup!.run();
    expect(publishedKeys(unattached.imageId)).toEqual([]);
    expect(publishedKeys(attached.imageId)).toHaveLength(2);

    // 후기를 지우면 DELETED 행이 정리 대상이 되고, 정리가 행과 공개 파생본을 지운다
    expect((await svc.http.inject({ method: 'DELETE', url: `/v1/reviews/${reviewId}`, headers: fan(me) })).statusCode).toBe(204);
    const dueDeleted = await dueImageRows(clock.now());
    expect(dueDeleted.map((r) => r.imageId)).toContain(attached.imageId);
    await cleanup!.run();
    expect(publishedKeys(attached.imageId)).toEqual([]);
    expect(await imageRowsOf(reviewId)).toEqual([]);
    expect(await imageRowsByAccount(me)).toEqual([]);
  });
});

describe('운영자 후기 상세', () => {
  test('OPS-01 [ASVS v5.0.0-14.2.6] 상세는 사진·신고 요약을 주고 신고자·작성자 계정·기준 주문 ID는 싣지 않는다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    const reporter = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const a = await uploadOk(me);
    const b = await uploadOk(me);
    const c = await uploadOk(me);
    const created = JSON.parse((await postReview(eventId, me, { rating: 5, body: '운영자 상세에 사진이 보일 후기입니다.', images: [{ imageId: a.imageId, alt: '무대' }, { imageId: b.imageId }, { imageId: c.imageId }] })).payload);
    expect((await report(created.reviewId, reporter, 'SPAM', { detail: '광고입니다' })).statusCode).toBe(201);

    const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/reviews/${created.reviewId}`, headers: identity.ops('cs_agent') });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.review.images).toHaveLength(3);
    expect(body.review.images[0]).toMatchObject({ imageId: a.imageId, alt: '무대', thumbnailUrl: a.thumbnailUrl, url: `${IMAGE_ORIGIN_TEST}/review/${a.imageId}/1280.webp`, width: 800, height: 600 });
    expect(body.review).toMatchObject({ body: '운영자 상세에 사진이 보일 후기입니다.', rating: 5, status: 'VISIBLE' });
    expect(body.review.notice).toBeUndefined();
    expect(body.review.takedownReason).toBeUndefined();
    expect(body.summary.total).toBe(1);
    expect(body.summary.byCategory.SPAM).toBe(1);
    expect(body.summary.reports[0]).toMatchObject({ category: 'SPAM', detail: '광고입니다' });
    expect(r.payload).not.toContain(me);
    expect(r.payload).not.toContain(reporter);
    expect(r.payload).not.toContain('basisOrderId');
    expect(r.payload).not.toContain('accountId');

    // 사진이 없는 후기는 빈 배열이다
    const plain = seed();
    eligibility.set(me, plain.eventId, { eligible: true, basisOrderId: randomUUID() });
    const noPhoto = JSON.parse((await postReview(plain.eventId, me, { rating: 3, body: '사진이 없는 후기 본문입니다.' })).payload);
    const plainDetail = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/ops/reviews/${noPhoto.reviewId}`, headers: identity.ops('cs_agent') })).payload);
    expect(plainDetail.review.images).toEqual([]);
    expect(plainDetail.summary.total).toBe(0);
  });
});


describe('후기 사진 한도·설명·가림·정리(구현 리뷰 IR-03·04·06·07·08)', () => {
  test('IMG-12 [ASVS v5.0.0-2.4.1] 한도는 성공 장수가 아니라 시도로 세고, 동시에 올려도 30장을 넘지 않는다', async () => {
    const rejectedAccount = randomUUID();
    for (let i = 0; i < 30; i += 1) {
      const rejectedUpload = await upload(rejectedAccount, marked(JPEG, 'MALWARE'));
      expect(rejectedUpload.statusCode).toBe(422);
    }
    const limited = await upload(rejectedAccount, JPEG);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    // 다른 계정은 따로 센다
    expect((await upload(randomUUID(), JPEG)).statusCode).toBe(201);

    // 29장을 올린 뒤 두 요청이 동시에 들어와도 성공은 30장까지다(세고 넣는 사이에 끼어들지 않는다)
    const parallelAccount = randomUUID();
    for (let i = 0; i < 29; i += 1) expect((await upload(parallelAccount, JPEG)).statusCode).toBe(201);
    const results = await Promise.all([upload(parallelAccount, JPEG), upload(parallelAccount, JPEG)]);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(1);
  });

  test('IMG-13 [ASVS v5.0.0-1.3.3] 사진 설명은 서버와 DB가 같은 코드 포인트 단위로 100자를 세어, 결합 이모지 100개를 500이 아니라 422로 닫는다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const a = await uploadOk(me);
    const tooLong = await postReview(eventId, me, { rating: 5, body: '결합 이모지 설명이 너무 긴 후기 본문입니다.', images: [{ imageId: a.imageId, alt: '👍🏽'.repeat(100) }] });
    // DB CHECK(char_length)가 아니라 서버가 422로 먼저 닫는다(500이 아니다)
    expect(tooLong.statusCode).toBe(422);

    const b = await uploadOk(me);
    const exactly = '👍🏽'.repeat(50);
    const ok = await postReview(eventId, me, { rating: 5, body: '결합 이모지 설명이 100 코드 포인트인 후기 본문입니다.', images: [{ imageId: b.imageId, alt: exactly }] });
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.payload).images[0].alt).toBe(exactly);
  });

  test('IMG-14 [ASVS v5.0.0-2.3.3] 공개 파생본 지우기가 실패한 행은 지우지 않고 다음 정리에서 다시 지운다', async () => {
    const me = randomUUID();
    const a = await uploadOk(me);
    clock.advance(24 * 60 * 60 * 1000 + 1);

    let failed = false;
    const flaky = {
      async deletePublic(key: string): Promise<void> {
        if (!failed && key === `review/${a.imageId}/240.webp`) {
          failed = true;
          throw new Error('일시 장애');
        }
        await objects.deletePublic(key);
      },
    };
    const task = reviewMaintenanceTasks(store, clock, { images: { objects: flaky } } as never).find((t) => t.name === 'review-image-cleanup');
    expect(task).toBeDefined();
    await task!.run();
    // 240은 실패했으므로 행을 지우지 않고 다음 정리를 기다린다(1280은 이미 지웠다)
    expect((await imageRowsByAccount(me)).map((r) => r.status)).toEqual(['READY']);
    expect(publishedKeys(a.imageId)).toHaveLength(1);

    await task!.run();
    expect(await imageRowsByAccount(me)).toEqual([]);
    expect(publishedKeys(a.imageId)).toEqual([]);
  });

  test('IMG-15 [ASVS v5.0.0-2.2.3] 불법 촬영물로 가린 후기는 작성자가 고쳐도 다시 보이지 않고, 운영자가 해제한 뒤에만 고칠 수 있다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    const reporter = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const a = await uploadOk(me);
    const created = await postReview(eventId, me, { rating: 5, body: '불법 촬영물로 신고될 사진 후기 본문입니다.', images: [{ imageId: a.imageId }] });
    expect(created.statusCode).toBe(201);
    const reviewId = JSON.parse(created.payload).reviewId;
    expect((await report(reviewId, reporter, 'ILLEGAL_FILMING')).statusCode).toBe(201);

    const edited = await patchReview(reviewId, me, { rating: 5, body: '가림을 피해 고친 후기 본문입니다.', images: [] });
    expect(edited.statusCode).toBe(409);
    const detail = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/ops/reviews/${reviewId}`, headers: identity.ops('cs_agent') })).payload);
    expect(detail.review).toMatchObject({ status: 'HIDDEN', takedownReason: 'FILMING_HOLD' });
    expect((await getReview(reviewId, randomUUID())).statusCode).toBe(404);

    const released = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/reviews/${reviewId}/moderation`,
      headers: { ...identity.ops('cs_agent'), 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'RELEASE', reason: '확인 뒤 되돌림' }),
    });
    expect(released.statusCode).toBe(200);
    const after = await patchReview(reviewId, me, { rating: 5, body: '해제 뒤 고친 후기 본문입니다.', images: [{ imageId: a.imageId }] });
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.payload).images).toHaveLength(1);
  });

  test('IMG-16 [ASVS v5.0.0-2.3.3] 정리는 한 번에 100행을 넘겨도 그날의 24시간 지난 사진을 모두 지운다', async () => {
    const me = randomUUID();
    const old = clock.now() - 24 * 60 * 60 * 1000 - 1;
    const ids: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      const imageId = randomUUID();
      ids.push(imageId);
      store.images.set(imageId, {
        imageId,
        reviewId: null,
        accountId: me,
        status: 'READY',
        altText: '',
        width: 800,
        height: 600,
        sort: 0,
        thumbKey: `review/${imageId}/240.webp`,
        viewKey: `review/${imageId}/1280.webp`,
        createdAtMs: old,
      });
      objects.published.set(`review/${imageId}/240.webp`, { bytes: WEBP, contentType: 'image/webp' });
      objects.published.set(`review/${imageId}/1280.webp`, { bytes: WEBP, contentType: 'image/webp' });
    }
    const task = reviewMaintenanceTasks(store, clock, { images: { objects } } as never).find((t) => t.name === 'review-image-cleanup');
    expect(task).toBeDefined();
    await task!.run();
    expect(await imageRowsByAccount(me)).toEqual([]);
    for (const imageId of ids) expect(publishedKeys(imageId)).toEqual([]);
  });
});
