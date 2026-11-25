// 명령 9(비핵심 기능 끄기)의 core-svc 읽는 쪽: 설정 저장소의 'PLATFORM:FEATURE_FLAG:reviews'가 {enabled: false}인 동안 팬 후기 경로는 503이다
// (BUILD_ORDER F-02-5 OPS-300, ADR-0365 결정 13·17, docs/review/plans/F-02-5.md 6절 B17·8.4, docs/features/control-tower.md §3 명령 9).
// - 설정 저장소는 공용 서버 패키지의 실제 SettingsStore(받는 쪽이 Kafka 사건을 넣는 그 저장소)를 쓴다. 사건은 apply로 넣는다(Kafka 소비는 test-int/f025-c-t51.int.test.ts).
// - 정본 값: 꺼진 동안 503 ServiceUnavailable(openapi components.responses.ServiceUnavailable, Retry-After 필수), Problem type review-feature-off,
//   Retry-After 60초 [가정](계획 8.4·14절 9). 값이 없거나 true면 그대로, 바뀜은 다음 요청부터(따로 캐시하지 않는다, 결정 17).
// - 가드는 팬 v1 후기 경로(ReviewController)에만 걸고, 관제(v1/ops/reviews)·내부(internal/v1/reviews) 후기 경로는 그대로다(계획 8.4).
//   openapi의 사진 올리기(POST /v1/review-images)는 아직 core-svc에 경로가 없어(후기 사진은 422 review-images-unavailable) 이 시험 밖이다.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { createService, fakeClock, SettingsStore, type SettingChanged } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type Production } from '../src/modules/catalog/index.js';
import { MemoryReviewEligibility, MemoryReviewStore, REVIEW_FEATURE_FLAG_KEY, ReviewFeatureGuard, reviewsEnabled } from '../src/modules/review/index.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

/** 정본 메시지 키(ADR-0365 결정 13 표, asyncapi control.settings 메시지 키 '<범위>:<종류>:<대상>') */
const FLAG_KEY = 'PLATFORM:FEATURE_FLAG:reviews';
/** 정본 Retry-After(계획 8.4 [가정]) */
const RETRY_AFTER_S = '60';
const ACTOR = '3b0c8f5e-2d41-4a7e-9f10-6c2e1d4b8a77';
const ENDED = new Date('2026-01-01T10:00:00.000Z');

let seq = 0;
/** ops-svc가 내는 꼴(asyncapi SettingChanged, 플랫폼 해독기를 지난 값)의 명령 9 사건. 판은 두 자리가 넘어가도록 9에서 시작해 늘린다 */
function flagEvent(enabled: boolean, o: { version?: number; expiresAt?: number | null } = {}): SettingChanged {
  seq += 1;
  return {
    commandId: randomUUID(),
    key: 'FEATURE_FLAG',
    scope: 'PLATFORM',
    value: { enabled },
    expiresAt: o.expiresAt ?? null,
    actor: ACTOR,
    occurredAt: o.version ?? 8 + seq,
    eventKey: randomUUID(),
  };
}

interface Harness {
  svc: Awaited<ReturnType<typeof createService>>;
  settings: SettingsStore;
  eventId: string;
  reviewId: string;
  author: string;
  identity: FakeIdentity;
}

const opened: Harness[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.svc.close();
});

/** 후기 하나가 있는 회차와 서비스를 띄운다. settings: false면 설정 저장소를 넘기지 않는다(시험·개발 조립) */
async function harness(o: { settings?: boolean } = {}): Promise<Harness> {
  const clock = fakeClock({ now: NOW_MS });
  const settings = new SettingsStore(clock);
  const repo = new MemoryCatalogRepository();
  const store = new MemoryReviewStore();
  const eligibility = new MemoryReviewEligibility();
  const identity = new FakeIdentity();
  const promoter = randomUUID();
  repo.sellerNames.set(promoter, '(주)피켓공연');
  const p: Production = { id: randomUUID(), promoterId: promoter, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') };
  repo.productions.set(p.id, p);
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: p.id, venueId: randomUUID(), openAt: new Date('2026-01-01T00:00:00Z'), startsAt: ENDED, status: 'SCHEDULED' });
  const svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, review: { store, eligibility, ...(o.settings === false ? {} : { settings }) } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const h = { svc, settings, eventId, reviewId: '', author: randomUUID(), identity };
  opened.push(h);
  // 켜진 동안 후기 하나를 써 둔다(쓰기·고치기·신고 경로가 실제 후기를 가리키게)
  eligibility.set(h.author, eventId, { eligible: true, basisOrderId: randomUUID() });
  const created = await svc.http.inject({ method: 'POST', url: `/v1/events/${eventId}/reviews`, headers: { ...fan(h.author), 'content-type': 'application/json' }, payload: JSON.stringify({ rating: 5, body: '정말 좋았습니다! 다음에도 또 보고 싶어요.' }) });
  expect(created.statusCode).toBe(201);
  h.reviewId = (JSON.parse(created.payload) as { reviewId: string }).reviewId;
  return h;
}

const json = { 'content-type': 'application/json' };
/** 팬 v1 후기 경로 전부(ReviewController: 목록·요약·자격·쓰기·하나·고치기·지우기·신고). 계획 8.4 '팬 v1 후기 경로 전부' */
function fanRoutes(h: Harness) {
  const reader = randomUUID();
  return [
    { name: '목록 GET /v1/events/{eventId}/reviews', req: { method: 'GET' as const, url: `/v1/events/${h.eventId}/reviews` } },
    { name: '요약 GET /v1/events/{eventId}/review-summary', req: { method: 'GET' as const, url: `/v1/events/${h.eventId}/review-summary` } },
    { name: '자격 GET /v1/events/{eventId}/review-eligibility', req: { method: 'GET' as const, url: `/v1/events/${h.eventId}/review-eligibility`, headers: fan(reader) } },
    { name: '쓰기 POST /v1/events/{eventId}/reviews', req: { method: 'POST' as const, url: `/v1/events/${h.eventId}/reviews`, headers: { ...fan(reader), ...json }, payload: JSON.stringify({ rating: 4, body: '꺼진 동안 쓰는 후기 본문입니다.' }) } },
    { name: '하나 GET /v1/reviews/{reviewId}', req: { method: 'GET' as const, url: `/v1/reviews/${h.reviewId}` } },
    { name: '고치기 PATCH /v1/reviews/{reviewId}', req: { method: 'PATCH' as const, url: `/v1/reviews/${h.reviewId}`, headers: { ...fan(h.author), ...json }, payload: JSON.stringify({ rating: 3, body: '꺼진 동안 고치는 후기 본문입니다.' }) } },
    { name: '신고 POST /v1/reviews/{reviewId}/reports', req: { method: 'POST' as const, url: `/v1/reviews/${h.reviewId}/reports`, headers: { ...fan(reader), ...json }, payload: JSON.stringify({ category: 'SPAM' }) } },
    { name: '지우기 DELETE /v1/reviews/{reviewId}', req: { method: 'DELETE' as const, url: `/v1/reviews/${h.reviewId}`, headers: fan(h.author) } },
  ];
}

function expectFeatureOff(r: { statusCode: number; headers: Record<string, unknown>; payload: string }, what: string): void {
  expect(r.statusCode, what).toBe(503);
  expect(r.headers['retry-after'], what).toBe(RETRY_AFTER_S);
  expect(String(r.headers['content-type']), what).toMatch(/^application\/problem\+json/);
  expect(JSON.parse(r.payload) as { type?: string; status?: number }, what).toMatchObject({ type: expect.stringMatching(/review-feature-off$/), status: 503 });
}

describe('F025-FLAG 후기 기능 플래그 읽기(ADR-0365 결정 17)', () => {
  test('F025-FLAG ① 공개 키 이름은 정본 메시지 키와 같다', () => {
    expect(REVIEW_FEATURE_FLAG_KEY).toBe(FLAG_KEY);
  });

  test('F025-FLAG ① reviewsEnabled는 값이 {enabled: false}일 때만 거짓이다(없음·true·꼴 틀림·만료·저장소 없음은 참)', () => {
    const clock = fakeClock({ now: NOW_MS });
    const settings = new SettingsStore(clock);
    expect(reviewsEnabled(undefined)).toBe(true);
    expect(reviewsEnabled(settings)).toBe(true);
    settings.apply(FLAG_KEY, flagEvent(true));
    expect(reviewsEnabled(settings)).toBe(true);
    settings.apply(FLAG_KEY, flagEvent(false));
    expect(reviewsEnabled(settings)).toBe(false);
    // 꼴이 틀린 값(enabled가 불리언이 아님, 값 없음)은 끄지 않는다
    settings.apply(FLAG_KEY, { ...flagEvent(false), value: { enabled: 'false' } });
    expect(reviewsEnabled(settings)).toBe(true);
    settings.apply(FLAG_KEY, { ...flagEvent(false), value: null });
    expect(reviewsEnabled(settings)).toBe(true);
    // 다른 플래그 키를 끈 것은 후기와 상관없다
    settings.apply('PLATFORM:FEATURE_FLAG:wishlist', flagEvent(false));
    expect(reviewsEnabled(settings)).toBe(true);
    // 만료가 있는 끈 값(정본은 만료를 싣지 않지만 저장소 규칙대로): 만료 1ms 전은 꺼짐, 만료 정각은 없는 값이라 켜짐
    settings.apply(FLAG_KEY, flagEvent(false, { expiresAt: NOW_MS + 5_000 }));
    clock.advance(4_999);
    expect(reviewsEnabled(settings)).toBe(false);
    clock.advance(1);
    expect(reviewsEnabled(settings)).toBe(true);
  });

  test('F025-FLAG ① ReviewFeatureGuard는 Nest 가드로 내놓는다', () => {
    expect(typeof ReviewFeatureGuard).toBe('function');
    expect(typeof (ReviewFeatureGuard.prototype as { canActivate?: unknown }).canActivate).toBe('function');
  });

  test('F025-FLAG ① 명령 9 사건으로 꺼지면 팬 v1 후기 경로 모두 503 review-feature-off·Retry-After 60이고 후기가 바뀌지 않는다', async () => {
    const h = await harness();
    h.settings.apply(FLAG_KEY, flagEvent(false));
    const before = await h.svc.http.inject({ method: 'GET', url: `/v1/reviews/${h.reviewId}`, headers: fan(h.author) });
    expectFeatureOff(before, '꺼진 뒤 하나 읽기');
    const routes = fanRoutes(h);
    expect(routes).toHaveLength(8);
    for (const r of routes) expectFeatureOff(await h.svc.http.inject(r.req), r.name);
    // 쓰기·고치기·지우기·신고가 실제로 막혔다: 다시 켠 뒤 후기는 처음 그대로다(별점 5, 본문, 신고 0)
    h.settings.apply(FLAG_KEY, flagEvent(true));
    const after = await h.svc.http.inject({ method: 'GET', url: `/v1/reviews/${h.reviewId}`, headers: fan(h.author) });
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.payload)).toMatchObject({ reviewId: h.reviewId, rating: 5, body: '정말 좋았습니다! 다음에도 또 보고 싶어요.', status: 'VISIBLE' });
    const list = JSON.parse((await h.svc.http.inject({ method: 'GET', url: `/v1/events/${h.eventId}/reviews` })).payload) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
  });

  test('F025-FLAG ① 꺼진 동안에도 관제·내부 후기 경로는 가드가 막지 않는다(503이 아니다)', async () => {
    const h = await harness();
    h.settings.apply(FLAG_KEY, flagEvent(false));
    const cs = h.identity.ops('cs_agent');
    const ops = await h.svc.http.inject({ method: 'GET', url: `/v1/ops/reviews/${h.reviewId}`, headers: cs });
    expect(ops.statusCode).toBe(200);
    expect(JSON.parse(ops.payload)).toMatchObject({ review: { reviewId: h.reviewId } });
    const moderated = await h.svc.http.inject({ method: 'POST', url: `/v1/ops/reviews/${h.reviewId}/moderation`, headers: { ...cs, ...json }, payload: JSON.stringify({ action: 'RELEASE', reason: '꺼진 동안 조치' }) });
    expect(moderated.statusCode).not.toBe(503);
    // 내부 경로는 내부 토큰이 없어 막히지만(401·403), 후기 기능 꺼짐 503으로 막히지 않는다
    const internal = await h.svc.http.inject({ method: 'POST', url: `/internal/v1/reviews/accounts/${randomUUID()}/purge`, headers: json, payload: JSON.stringify({ reason: '시험', requestedBy: 'ops-kim' }) });
    expect(internal.statusCode).not.toBe(503);
    expect(internal.headers['retry-after']).toBeUndefined();
  });

  test('F025-FLAG ② 되돌리기 사건(enabled: true)을 받으면 다음 요청부터 경로 모두 다시 200대다(시작 때 한 번만 읽지 않는다)', async () => {
    const h = await harness();
    // 켜진 채 시작 → 꺼짐 → 켜짐: 매번 바뀜이 다음 요청에 보인다
    expect((await h.svc.http.inject({ method: 'GET', url: `/v1/events/${h.eventId}/reviews` })).statusCode).toBe(200);
    h.settings.apply(FLAG_KEY, flagEvent(false));
    expectFeatureOff(await h.svc.http.inject({ method: 'GET', url: `/v1/events/${h.eventId}/reviews` }), '꺼짐');
    h.settings.apply(FLAG_KEY, flagEvent(true));
    const statuses: Record<string, number> = {};
    for (const r of fanRoutes(h)) statuses[r.name] = (await h.svc.http.inject(r.req)).statusCode;
    // 자격 없는 팬의 쓰기는 업무 규칙대로 거절될 수 있다(가드가 아니라 자격 확인이 답한다). 503만 아니면 된다
    expect(statuses['쓰기 POST /v1/events/{eventId}/reviews']).not.toBe(503);
    delete statuses['쓰기 POST /v1/events/{eventId}/reviews'];
    expect(statuses).toEqual({
      '목록 GET /v1/events/{eventId}/reviews': 200,
      '요약 GET /v1/events/{eventId}/review-summary': 200,
      '자격 GET /v1/events/{eventId}/review-eligibility': 200,
      '하나 GET /v1/reviews/{reviewId}': 200,
      '고치기 PATCH /v1/reviews/{reviewId}': 200,
      '신고 POST /v1/reviews/{reviewId}/reports': 201,
      '지우기 DELETE /v1/reviews/{reviewId}': 204,
    });
  });

  test('F025-FLAG ② 판이 작은 옛 사건이 뒤늦게 와도 새 값이 이긴다(뒤 판 10이 앞 판 9를 이긴다)', async () => {
    const h = await harness();
    h.settings.apply(FLAG_KEY, flagEvent(false, { version: 10 }));
    // 판 9(글로 견주면 '9' > '10')의 켜기 사건은 버려진다
    h.settings.apply(FLAG_KEY, flagEvent(true, { version: 9 }));
    expectFeatureOff(await h.svc.http.inject({ method: 'GET', url: `/v1/events/${h.eventId}/reviews` }), '옛 판 뒤');
  });

  test('F025-FLAG ① 설정 저장소를 넘기지 않은 조립은 늘 켜져 있다', async () => {
    const h = await harness({ settings: false });
    // 넘기지 않은 저장소에 끈 값을 넣어도 서비스는 보지 않는다
    h.settings.apply(FLAG_KEY, flagEvent(false));
    expect((await h.svc.http.inject({ method: 'GET', url: `/v1/events/${h.eventId}/reviews` })).statusCode).toBe(200);
    expect((await h.svc.http.inject({ method: 'GET', url: `/v1/reviews/${h.reviewId}` })).statusCode).toBe(200);
  });

  test('TR-04 시작 파일(main.ts)이 controlSync?.sync.settings를 후기 모듈 설정 저장소로 넘긴다', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    // 시작 파일은 createService 뒤에 제어 소비를 켜므로, 나중에 채워지는 저장소를 읽는 꼴을 넘겨야 한다(계획 8.4)
    expect(main).toMatch(/get:\s*\(key[^)]*\)\s*=>\s*controlSync\?\.sync\.settings\.get\(key/);
    const review = /review:\s*\{([^}]*)\}/.exec(main)?.[1] ?? '';
    expect(review, 'main.ts의 review 조립에 settings가 없다').toMatch(/\bsettings\b/);
  });
});
