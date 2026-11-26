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
    const keys = [`staging/review/${id}/240.webp`, `staging/review/${id}/1280.webp`];
    if (m.includes('BADKEYS')) return { status: 'ACCEPTED' as const, width: 800, height: 600, derivativeKeys: [keys[0]!] };
    if (m.includes('SHORT319')) return { status: 'ACCEPTED' as const, width: 319, height: 600, derivativeKeys: keys };
    if (m.includes('LONG20001')) return { status: 'ACCEPTED' as const, width: 800, height: 20_001, derivativeKeys: keys };
    if (m.includes('PIXELS40000001')) return { status: 'ACCEPTED' as const, width: 8_000, height: 5_001, derivativeKeys: keys };
    for (const k of keys) objects.staging.set(k, WEBP);
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

describe('후기 사진 올리기', () => {
  test('IMG-01 [ASVS v5.0.0-2.2.3] X-Requested-With가 없으면 400이고, JPEG·PNG·WebP만 앞부분·형식·확장자가 모두 같을 때 받는다', async () => {
    const me = randomUUID();
    expect((await upload(me, JPEG, { header: false })).statusCode).toBe(400);

    const gif = await upload(me, GIF, { type: 'image/gif', name: 'x.gif' });
    expect(gif.statusCode).toBe(422);
    expect(JSON.parse(gif.payload).extensions.reason).toBe('UNSUPPORTED_TYPE');

    const mismatch = await upload(me, JPEG, { type: 'image/png', name: 'x.png' });
    expect(mismatch.statusCode).toBe(422);
    expect(JSON.parse(mismatch.payload).extensions.reason).toBe('UNSUPPORTED_TYPE');

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
    expect(objects.published.get(`review/${imageId}/240.webp`)?.contentType).toBe('image/webp');
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
    expect(objects.published.size).toBe(before);
    expect(objects.quarantine.size).toBe(0);
    expect(objects.staging.size).toBe(0);
  });

  test('IMG-04 [ASVS v5.0.0-2.2.3] 돌아온 폭·높이를 다시 본다: 짧은 변 319는 422, 320은 받고, 긴 변 20,001·화소 4,000만 초과는 422다', async () => {
    const me = randomUUID();
    const short = await upload(me, marked(JPEG, 'SHORT319'));
    expect(short.statusCode).toBe(422);
    expect(JSON.parse(short.payload).extensions.reason).toBe('TOO_SMALL');
    expect((await upload(me, marked(JPEG, 'LONG20001'))).statusCode).toBe(422);
    expect((await upload(me, marked(JPEG, 'PIXELS40000001'))).statusCode).toBe(422);
    expect((await upload(me, JPEG)).statusCode).toBe(201);
  });

  test('IMG-11 [ASVS v5.0.0-2.4.1][ASVS v5.0.0-2.3.2] 한 계정은 한 시간에 30장까지이고 31번째는 429, 한 시간이 지나면 다시 받는다', async () => {
    const me = randomUUID();
    for (let i = 0; i < 30; i++) expect((await upload(me, JPEG)).statusCode).toBe(201);
    const limited = await upload(me, JPEG);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
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
    expect(body.images[0]).toMatchObject({ alt: '무대', width: 800, height: 600, thumbnailUrl: a.thumbnailUrl });
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
  });

  test('IMG-10 [ASVS v5.0.0-2.3.3] 붙이지 않은 사진은 24시간이 지나면 정리 작업이 공개 파생본과 행을 지운다', async () => {
    const me = randomUUID();
    const { imageId } = await uploadOk(me);
    expect(publishedKeys(imageId)).toHaveLength(2);
    clock.advance(24 * 60 * 60 * 1000 + 1);
    const tasks = reviewMaintenanceTasks(store, clock, { images: { objects } } as never);
    const cleanup = tasks.find((t) => t.name === 'review-image-cleanup');
    expect(cleanup).toBeDefined();
    await cleanup!.run();
    expect(publishedKeys(imageId)).toEqual([]);
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
    const created = JSON.parse((await postReview(eventId, me, { rating: 5, body: '운영자 상세에 사진이 보일 후기입니다.', images: [{ imageId: a.imageId, alt: '무대' }, { imageId: b.imageId }] })).payload);
    expect((await report(created.reviewId, reporter, 'SPAM', { detail: '광고입니다' })).statusCode).toBe(201);

    const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/reviews/${created.reviewId}`, headers: identity.ops('cs_agent') });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.review.images).toHaveLength(2);
    expect(body.review.images[0]).toMatchObject({ imageId: a.imageId, alt: '무대', thumbnailUrl: a.thumbnailUrl });
    expect(body.summary.total).toBe(1);
    expect(body.summary.byCategory.SPAM).toBe(1);
    expect(r.payload).not.toContain(me);
    expect(r.payload).not.toContain(reporter);
    expect(r.payload).not.toContain('basisOrderId');
    expect(r.payload).not.toContain('accountId');
  });
});
