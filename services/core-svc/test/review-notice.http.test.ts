// 법정 통보의 적용·철회·결과 조회 내부 경로와 C-T22 같은 내용 차단(F-07-11, LCH-160, POL-024·POL-044, ADR-0066).
// 정본: docs/features/control-tower.md C-T22(508행), docs/design/d5 §7.5(3295행), docs/data.md §2 takedown_action·review_hidden_fingerprint,
// docs/api/openapi.yaml /v1/ops/compliance/notices/{noticeId}/takedown·withdrawal, docs/api/guidelines.md §2~§4.
// 단언 값은 정본에서 온다: 기한 24시간·10시간, 후기 목록 100개, 사유 1~2,000자, 같은 내용 지문은 NFKC·공백·문장부호 제거.
// 이 시험은 구현 전 트리에서 내부 경로가 없어 404로 실패한다(모듈 import 실패가 아니다).
import 'reflect-metadata';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type Production, type SaleReview } from '../src/modules/catalog/index.js';
import { MemoryFanProfile, MemoryReviewCaseSink, MemoryReviewEligibility, MemoryReviewNotifier, MemoryReviewStore } from '../src/modules/review/index.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

const TOKEN = 'f0711-core-internal-5c1d';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const INTERNAL = { 'x-peaket-internal-token': TOKEN, 'content-type': 'application/json' };

let svc: Awaited<ReturnType<typeof createService>>;
let clock: FakeClock;
const repo = new MemoryCatalogRepository();
const store = new MemoryReviewStore();
const eligibility = new MemoryReviewEligibility();
const fanProfiles = new MemoryFanProfile();
const notifier = new MemoryReviewNotifier();
const cases = new MemoryReviewCaseSink();
const identity = new FakeIdentity();
const PROMOTER = randomUUID();
const ENDED = new Date('2026-01-01T10:00:00.000Z');
const originalToken = process.env.PEAKET_INTERNAL_TOKEN;

beforeAll(async () => {
  process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
  repo.sellerNames.set(PROMOTER, '(주)피켓공연');
  clock = fakeClock({ now: NOW_MS });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, review: { store, eligibility, fanProfile: fanProfiles, notifier, cases } }),
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: TOKEN },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
  if (originalToken === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
  else process.env.PEAKET_INTERNAL_TOKEN = originalToken;
});

function seed(o: { startsAt?: Date; saleReview?: SaleReview; saleApprovedAt?: Date | null } = {}): { eventId: string; productionId: string } {
  const p: Production = {
    id: randomUUID(),
    promoterId: PROMOTER,
    placeId: randomUUID(),
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.saleReview ?? 'APPROVED',
    saleApprovedAt: o.saleApprovedAt ?? new Date('2026-11-01T00:00:00Z'),
  };
  repo.productions.set(p.id, p);
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: p.id, venueId: randomUUID(), openAt: new Date('2026-01-01T00:00:00Z'), startsAt: o.startsAt ?? ENDED, status: 'SCHEDULED' });
  return { eventId, productionId: p.id };
}

const postReview = (eventId: string, account: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/events/${eventId}/reviews`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const getReviews = (eventId: string, account?: string) => svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}/reviews`, headers: account ? fan(account) : {} });

async function makeReview(eventId: string, account: string, body: string): Promise<string> {
  eligibility.set(account, eventId, { eligible: true, basisOrderId: randomUUID() });
  const r = await postReview(eventId, account, { rating: 5, body });
  expect(r.statusCode).toBe(201);
  return (JSON.parse(r.payload) as { reviewId: string }).reviewId;
}

const notice = (body: Record<string, unknown>, token: string | null = TOKEN) =>
  svc.http.inject({
    method: 'POST',
    url: '/internal/v1/reviews/notice-takedowns',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { 'x-peaket-internal-token': token }) },
    payload: JSON.stringify(body),
  });
const withdraw = (noticeId: string, body: Record<string, unknown>, token: string | null = TOKEN) =>
  svc.http.inject({
    method: 'POST',
    url: `/internal/v1/reviews/notice-takedowns/${noticeId}/withdrawal`,
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { 'x-peaket-internal-token': token }) },
    payload: JSON.stringify(body),
  });
const noticeReport = (noticeId: string, token: string | null = TOKEN) =>
  svc.http.inject({
    method: 'GET',
    url: `/internal/v1/reviews/notice-takedowns/${noticeId}`,
    headers: token === null ? {} : { 'x-peaket-internal-token': token },
  });

const applyBody = (noticeId: string, reviewIds: readonly string[], receivedAtMs = NOW_MS - HOUR, deadline: 'H24' | 'H10' = 'H24', reason = '신고기관 통보') => ({
  noticeId,
  reviewIds,
  receivedAt: new Date(receivedAtMs).toISOString(),
  deadline,
  reason,
});

const moderation = (reviewId: string, action: string, reason: string) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/reviews/${reviewId}/moderation`,
    headers: { ...identity.ops('cs_agent'), 'content-type': 'application/json' },
    payload: JSON.stringify({ action, reason }),
  });

describe('법정 통보 내부 경로', () => {
  test('NTC-01 [C-T22] 통보를 접수하면 한 트랜잭션으로 후기를 가리고, 같은 통보를 다시 보내도 조치 기록이 하나다', async () => {
    const { eventId } = seed();
    const a = await makeReview(eventId, randomUUID(), '첫 번째 통보 대상 후기 본문입니다.');
    const b = await makeReview(eventId, randomUUID(), '두 번째 통보 대상 후기 본문입니다.');
    const noticeId = randomUUID();
    const receivedAtMs = NOW_MS - HOUR;
    const first = await notice(applyBody(noticeId, [a, b], receivedAtMs));
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.payload)).toMatchObject({
      noticeId,
      applied: 2,
      skipped: 0,
      deadlineAt: new Date(receivedAtMs + DAY).toISOString(),
    });
    expect((await store.takedownsByReview(a)).filter((t) => t.reason === 'NOTICE')).toHaveLength(1);
    expect((await store.takedownsByReview(b)).filter((t) => t.reason === 'NOTICE')).toHaveLength(1);
    expect((JSON.parse((await getReviews(eventId, randomUUID())).payload) as { items: unknown[] }).items).toHaveLength(0);

    const again = await notice(applyBody(noticeId, [a, b], receivedAtMs));
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload)).toMatchObject({ applied: 0, skipped: 2 });
    expect((await store.takedownsByReview(a)).filter((t) => t.reason === 'NOTICE')).toHaveLength(1);
  });

  test('NTC-02 [C-T22][ASVS v5.0.0-2.2.3] 같은 내용 지문으로 새 후기를 쓰면 바로 HIDDEN이 되고, 조치 결과서에 SAME_CONTENT로 나온다', async () => {
    const { eventId } = seed();
    const a = await makeReview(eventId, randomUUID(), '정말 좋았습니다! 다음에도 또 보고 싶어요.');
    const noticeId = randomUUID();
    expect((await notice(applyBody(noticeId, [a]))).statusCode).toBe(200);

    const b = await makeReview(eventId, randomUUID(), '정말 좋았습니다 다음에도 또 보고싶어요');
    const hidden = await svc.http.inject({ method: 'GET', url: `/v1/reviews/${b}`, headers: fan(randomUUID()) });
    expect(hidden.statusCode).toBe(404);
    const mine = await svc.http.inject({ method: 'GET', url: `/v1/reviews/${b}`, headers: fan((await store.findReview(b))!.accountId) });
    expect(mine.statusCode).toBe(200);
    expect(JSON.parse(mine.payload)).toMatchObject({ reviewId: b, status: 'HIDDEN' });

    const takedowns = await store.takedownsByReview(b);
    expect(takedowns).toHaveLength(1);
    expect(takedowns[0]).toMatchObject({ reason: 'SAME_CONTENT' });
    expect(takedowns[0]!.contentFingerprint).toBe((await store.takedownsByReview(a)).find((t) => t.reason === 'NOTICE')!.contentFingerprint);
    expect(await store.hasHiddenFingerprint(takedowns[0]!.contentFingerprint)).toBe(true);

    const report = await noticeReport(noticeId);
    expect(report.statusCode).toBe(200);
    expect(JSON.parse(report.payload)).toMatchObject({
      noticeId,
      counts: { notice: 1, sameContent: 1, restored: 0, activeSameContent: 1 },
    });
    expect((JSON.parse(report.payload) as { reviews: { reviewId: string; reason: string }[] }).reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reviewId: a, reason: 'NOTICE' }),
        expect.objectContaining({ reviewId: b, reason: 'SAME_CONTENT' }),
      ]),
    );
  });

  test('NTC-03 [C-T22] 통보를 철회하면 그 통보로 가린 후기와 같은 내용 자동 숨김 후기를 함께 되살리고 지문을 지운다', async () => {
    const { eventId } = seed();
    const viewer = randomUUID();
    const a = await makeReview(eventId, randomUUID(), '철회 복구 시험용 후기 본문입니다.');
    const noticeId = randomUUID();
    await notice(applyBody(noticeId, [a]));
    const b = await makeReview(eventId, randomUUID(), '철회 복구 시험용 후기 본문입니다!');
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${b}`, headers: fan(viewer) })).statusCode).toBe(404);

    const out = await withdraw(noticeId, { reason: '통보 철회' });
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.payload)).toMatchObject({ noticeId, restored: 2, sameContentRestored: 1, fingerprintsCleared: 1 });

    const list = JSON.parse((await getReviews(eventId, viewer)).payload) as { items: { reviewId: string }[] };
    expect(list.items.map((x) => x.reviewId).sort()).toEqual([a, b].sort());
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${b}`, headers: fan(viewer) })).statusCode).toBe(200);

    const fingerprint = (await store.takedownsByReview(a)).find((t) => t.reason === 'NOTICE')!.contentFingerprint;
    expect(await store.hasHiddenFingerprint(fingerprint)).toBe(false);
    const c = await makeReview(eventId, randomUUID(), '철회 복구 시험용 후기 본문입니다');
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${c}`, headers: fan(viewer) })).statusCode).toBe(200);

    const report = JSON.parse((await noticeReport(noticeId)).payload);
    expect(report).toMatchObject({ counts: { notice: 1, sameContent: 1, restored: 2, activeSameContent: 0 } });
    expect((report.reviews as { restoredAt: string | null }[]).every((r) => typeof r.restoredAt === 'string')).toBe(true);
  });

  test('NTC-04 [C-T22] 같은 지문의 다른 통보가 살아 있으면 하나를 철회해도 지문과 같은 내용 차단이 남는다', async () => {
    const { eventId } = seed();
    const body = '같은 내용 차단 유지 시험용 후기 본문입니다.';
    const a = await makeReview(eventId, randomUUID(), body);
    const b = await makeReview(eventId, randomUUID(), body);
    const noticeA = randomUUID();
    const noticeB = randomUUID();
    expect((await notice(applyBody(noticeA, [a]))).statusCode).toBe(200);
    expect((await notice(applyBody(noticeB, [b]))).statusCode).toBe(200);
    const viewer = randomUUID();
    const c = await makeReview(eventId, randomUUID(), `${body}!`);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${c}`, headers: fan(viewer) })).statusCode).toBe(404);

    expect((await withdraw(noticeA, { reason: '통보 A 철회' })).statusCode).toBe(200);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${a}`, headers: fan(viewer) })).statusCode).toBe(200);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${b}`, headers: fan(viewer) })).statusCode).toBe(404);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${c}`, headers: fan(viewer) })).statusCode).toBe(404);

    const d = await makeReview(eventId, randomUUID(), `${body}?`);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${d}`, headers: fan(viewer) })).statusCode).toBe(404);

    expect((await withdraw(noticeB, { reason: '통보 B 철회' })).statusCode).toBe(200);
    for (const id of [b, c, d]) expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${id}`, headers: fan(viewer) })).statusCode).toBe(200);
    const e = await makeReview(eventId, randomUUID(), `${body}.`);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${e}`, headers: fan(viewer) })).statusCode).toBe(200);
  });

  test('NTC-05 [C-T22] 철회는 같은 지문의 SAME_CONTENT만 되살리고, 불법 촬영물로 가린 후기는 그대로 둔다', async () => {
    const { eventId } = seed();
    const viewer = randomUUID();
    const body = '다른 사유로 가린 후기 철회 시험 본문입니다.';
    const a = await makeReview(eventId, randomUUID(), body);
    const b = await makeReview(eventId, randomUUID(), body);
    const reporter = randomUUID();
    const reported = await svc.http.inject({
      method: 'POST',
      url: `/v1/reviews/${b}/reports`,
      headers: { ...fan(reporter), 'content-type': 'application/json' },
      payload: JSON.stringify({ category: 'ILLEGAL_FILMING' }),
    });
    expect(reported.statusCode).toBe(201);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${b}`, headers: fan(viewer) })).statusCode).toBe(404);

    const noticeId = randomUUID();
    await notice(applyBody(noticeId, [a]));
    const out = await withdraw(noticeId, { reason: '통보 철회' });
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.payload)).toMatchObject({ restored: 1, sameContentRestored: 0, fingerprintsCleared: 1 });
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${a}`, headers: fan(viewer) })).statusCode).toBe(200);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${b}`, headers: fan(viewer) })).statusCode).toBe(404);
    expect((await store.takedownsByReview(b)).find((t) => t.reason === 'FILMING_HOLD')?.restoredAtMs).toBeUndefined();
  });

  test('NTC-06 [C-T22][ASVS v5.0.0-2.3.3] 적용은 없는·지운 후기를 건너뛰고 applied와 skipped를 정확히 센다', async () => {
    const { eventId } = seed();
    const a = await makeReview(eventId, randomUUID(), '살아 있는 후기 적용 시험 본문입니다.');
    const gone = await makeReview(eventId, randomUUID(), '곧 지울 후기 적용 시험 본문입니다.');
    expect((await svc.http.inject({ method: 'DELETE', url: `/v1/reviews/${gone}`, headers: fan((await store.findReview(gone))!.accountId) })).statusCode).toBe(204);
    const noticeId = randomUUID();
    const r = await notice(applyBody(noticeId, [a, gone, randomUUID()]));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ applied: 1, skipped: 2 });
    const report = JSON.parse((await noticeReport(noticeId)).payload) as { reviews: { reviewId: string }[]; counts: { notice: number } };
    expect(report.counts.notice).toBe(1);
    expect(report.reviews.map((x) => x.reviewId)).toEqual([a]);
  });

  test('NTC-07 [C-T22] 기한은 접수 시각 기준 24시간이고 고시 사항은 10시간이다', async () => {
    const { eventId } = seed();
    const a = await makeReview(eventId, randomUUID(), '고시 통보 기한 시험용 후기 본문입니다.');
    const b = await makeReview(eventId, randomUUID(), '일반 통보 기한 시험용 후기 본문입니다.');
    const receivedAtMs = NOW_MS - 2 * HOUR;
    const ministry = await notice(applyBody(randomUUID(), [a], receivedAtMs, 'H10'));
    expect(JSON.parse(ministry.payload)).toMatchObject({ deadlineAt: new Date(receivedAtMs + 10 * HOUR).toISOString() });
    const general = await notice(applyBody(randomUUID(), [b], receivedAtMs, 'H24'));
    expect(JSON.parse(general.payload)).toMatchObject({ deadlineAt: new Date(receivedAtMs + DAY).toISOString() });
  });

  test('NTC-08 [ASVS v5.0.0-1.3.3] 사유는 NFC 뒤 제어·양방향 제어 문자를 지우고 1~2,000자다', async () => {
    const { eventId } = seed();
    const a = await makeReview(eventId, randomUUID(), '사유 정규화 시험용 후기 본문입니다.');
    const noticeId = randomUUID();
    const controls = await notice(applyBody(noticeId, [a], NOW_MS - HOUR, 'H24', '통\u202e보\u0007 사유'));
    expect(controls.statusCode).toBe(200);
    const long = await notice(applyBody(randomUUID(), [await makeReview(eventId, randomUUID(), '사유 길이 시험용 후기 본문입니다.')], NOW_MS - HOUR, 'H24', '가'.repeat(2_000)));
    expect(long.statusCode).toBe(200);
    const tooLong = await notice(applyBody(randomUUID(), [await makeReview(eventId, randomUUID(), '사유 초과 시험용 후기 본문입니다.')], NOW_MS - HOUR, 'H24', '가'.repeat(2_001)));
    expect(tooLong.statusCode).toBe(422);
    const empty = await notice(applyBody(randomUUID(), [await makeReview(eventId, randomUUID(), '사유 없음 시험용 후기 본문입니다.')], NOW_MS - HOUR, 'H24', ''));
    expect(empty.statusCode).toBe(422);
  });

  test('NTC-09 [ASVS v5.0.0-2.3.2] 통보 후기 목록은 100개까지이고 101개·중복은 400이다', async () => {
    const ids = Array.from({ length: 100 }, () => randomUUID());
    const max = await notice(applyBody(randomUUID(), ids));
    expect(max.statusCode).toBe(200);
    expect(JSON.parse(max.payload)).toMatchObject({ applied: 0, skipped: 100 });
    const over = await notice(applyBody(randomUUID(), [...ids, randomUUID()]));
    expect(over.statusCode).toBe(400);
    const duplicate = await notice(applyBody(randomUUID(), [ids[0]!, ids[0]!]));
    expect(duplicate.statusCode).toBe(400);
  });

  test('NTC-10 [C-T22] 통보로 가린 후기는 신고 처리(RELEASE)로 풀 수 없고 법정 철회 경로만 푼다', async () => {
    const { eventId } = seed();
    const a = await makeReview(eventId, randomUUID(), '법정 철회 경로 시험용 후기 본문입니다.');
    const noticeId = randomUUID();
    expect((await notice(applyBody(noticeId, [a]))).statusCode).toBe(200);
    const blocked = await moderation(a, 'RELEASE', '이의 인정');
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.payload)).toMatchObject({ type: 'review-not-moderation-target' });
    expect((await withdraw(noticeId, { reason: '통보 철회' })).statusCode).toBe(200);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/reviews/${a}`, headers: fan(randomUUID()) })).statusCode).toBe(200);
  });

  test('NTC-11 [C-T22] 조치 결과서는 철회 뒤 복원 시각과 지문을 싣고, 없는 통보는 404다', async () => {
    const { eventId } = seed();
    const a = await makeReview(eventId, randomUUID(), '결과서 시험용 후기 본문입니다.');
    const noticeId = randomUUID();
    await notice(applyBody(noticeId, [a]));
    const before = JSON.parse((await noticeReport(noticeId)).payload) as { reviews: { reviewId: string; reason: string; fingerprint: string; restoredAt: string | null }[]; counts: Record<string, number> };
    expect(before.counts).toMatchObject({ notice: 1, sameContent: 0, restored: 0, activeSameContent: 0 });
    expect(before.reviews[0]).toMatchObject({ reviewId: a, reason: 'NOTICE', restoredAt: null });
    expect(before.reviews[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await withdraw(noticeId, { reason: '통보 철회' });
    const after = JSON.parse((await noticeReport(noticeId)).payload) as { reviews: { restoredAt: string | null }[]; counts: Record<string, number> };
    expect(after.counts).toMatchObject({ notice: 1, restored: 1, activeSameContent: 0 });
    expect(typeof after.reviews[0]!.restoredAt).toBe('string');
    expect((await noticeReport(randomUUID())).statusCode).toBe(404);
  });

  test('NTC-12 [ASVS v5.0.0-2.2.3][ASVS v5.0.0-2.3.3] 내부 경로는 공유 토큰이 없거나 틀리면 401이고 상태를 바꾸지 않는다', async () => {
    const { eventId } = seed();
    const a = await makeReview(eventId, randomUUID(), '내부 토큰 시험용 후기 본문입니다.');
    const noticeId = randomUUID();
    expect((await notice(applyBody(noticeId, [a]), null)).statusCode).toBe(401);
    expect((await notice(applyBody(noticeId, [a]), 'wrong-token')).statusCode).toBe(401);
    expect((await noticeReport(noticeId, null)).statusCode).toBe(401);
    expect((await withdraw(noticeId, { reason: '통보 철회' }, null)).statusCode).toBe(401);
    expect((await store.takedownsByReview(a))).toHaveLength(0);
  });
});
