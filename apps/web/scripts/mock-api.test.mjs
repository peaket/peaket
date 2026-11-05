// 계약 모양 가짜 API의 응답이 계약 Zod(@peaket/contracts 생성물)를 지나는지(ADR-0199 결정 2, BUILD_ORDER HOT-300).
// 계약이 바뀌면 이 시험이 고정 자료(mock-api/cards.json)도 함께 고치게 한다.
import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GetEventResponse, GetHomeRankingsResponse, GetHomeResponse } from '@peaket/contracts/openapi/catalog';
import {
  CreateIdentityNicknameCheckBody,
  CreateIdentityNicknameCheckResponse,
  CreateIdentitySignupCancellationBody,
  CreateIdentitySignupCompletionBody,
  CreateIdentitySignupCompletionResponse,
  CreateIdentityVerificationBody,
  CreateIdentityVerificationResponse,
  CreateIdentityVerificationResultBody,
  CreateIdentityVerificationResultResponse,
  GetIdentityVerificationResultResponse,
  GetIdentityMeResponse,
  ListSubscriptionsResponse,
  ListWishesResponse,
} from '@peaket/contracts/openapi/identity';
import { GetEventReviewSummaryResponse } from '@peaket/contracts/openapi/reviews';
import { GetSearchSuggestionsResponse, ListSearchResultsResponse } from '@peaket/contracts/openapi/catalog';
import { ARTISTS, INITIAL_WISHES, searchResults, suggestions, suggestQueryOk, eventDetail, homeFeed, placeholderSvg, rankingFile, reviewSummary, startMockApi, subscriptionPage, wishPage } from './mock-api.mjs';

const ORIGIN = 'http://127.0.0.1:4010';
const NOW = new Date('2026-11-05T03:00:00Z');

test('가짜 API의 홈 피드·랭킹 파일·찜·알림 상태가 계약 Zod를 지난다', () => {
  for (const s of ['normal', 'empty']) GetHomeResponse.parse(homeFeed(ORIGIN, s, NOW));
  for (const s of ['normal', 'stale', 'old']) GetHomeRankingsResponse.parse(rankingFile(ORIGIN, s, NOW));
  ListWishesResponse.parse(wishPage(ORIGIN));
  ListSubscriptionsResponse.parse(subscriptionPage(['e1'], new Set(['e1'])));
  assert.equal(eventDetail(ORIGIN, 'no-such-event'), undefined);
});

const KST_MS = 9 * 60 * 60_000;
const kstDate = (iso) => new Date(Date.parse(iso) + KST_MS).toISOString().slice(0, 10);

test('가짜 API의 공연 상세는 카드 7장의 모든 회차가 계약 Zod를 지나고(모르는 칸 없음) 카드 값과 맞는다(ADR-0200)', () => {
  const all = Object.values(JSON.parse(readFileSync(new URL('./mock-api/cards.json', import.meta.url), 'utf8')));
  assert.equal(all.length, 7);
  const early = new Date('2026-10-01T00:00:00Z'); // 모든 회차가 판매 종료 전인 때
  for (const raw of all) {
    const card = JSON.parse(JSON.stringify(raw).replaceAll('{MOCK}', ORIGIN));
    const rep = eventDetail(ORIGIN, card.eventId, early);
    assert.ok(rep, card.title);
    // parse는 모르는 칸을 버린다. 같으면 계약에 없는 칸이 없다
    assert.deepEqual(GetEventResponse.parse(rep), rep, card.title);
    const rounds = rep.rounds;
    assert.ok(rounds.length >= 1 && rounds.length <= 60);
    assert.deepEqual([...rounds].sort((a, b) => a.startsAt.localeCompare(b.startsAt)), rounds, `${card.title} 회차는 시작 순`);
    assert.equal(rounds[0].eventId, card.eventId, `${card.title} 첫 회차가 대표 회차`);
    assert.equal(kstDate(rounds[0].startsAt), card.periodStart, `${card.title} 첫 회차 = 기간 시작`);
    assert.equal(kstDate(rounds.at(-1).startsAt), card.periodEnd, `${card.title} 마지막 회차 = 기간 끝`);
    assert.equal(rounds.at(-1).saleEndsAt, new Date(card.saleEndsAt).toISOString(), `${card.title} 마지막 회차 판매 종료 = 카드 saleEndsAt`);
    if (card.saleStatus === 'UPCOMING') assert.equal(rep.openAt, new Date(card.nextOpenAt).toISOString(), card.title);
    else assert.ok(Date.parse(rep.openAt) < NOW.getTime(), `${card.title} 판매 중·매진이면 오픈이 지났다`);
    assert.equal(rep.seatAssignment, card.badges.includes('AUTO_SEAT') ? 'AUTO' : 'PICK');
    for (const r of rounds) {
      const d = eventDetail(ORIGIN, r.eventId, early);
      assert.deepEqual(GetEventResponse.parse(d), d);
      assert.equal(d.eventId, r.eventId);
      assert.ok(d.rounds.some((x) => x.eventId === d.eventId), '회차 목록에 이 회차가 있다');
      assert.equal(Date.parse(d.saleEndsAt), Date.parse(d.startsAt) - 24 * 60 * 60_000, '판매 종료 = 시작 − 24시간');
      assert.ok(Date.parse(d.openAt) < Date.parse(d.saleEndsAt), '오픈 < 판매 종료');
      if (d.queueOrder === 'FIFO') assert.equal(d.lobbyOpensAt, null);
      else assert.equal(Date.parse(d.lobbyOpensAt), Date.parse(d.openAt) - 10 * 60_000, '로비 = 오픈 − 10분');
    }
  }
  // 정렬 방식 셋과 배정 방식 둘이 모두 나온다(화면 상태 확인용)
  const details = all.map((c) => eventDetail(ORIGIN, c.eventId, early));
  assert.deepEqual(new Set(details.map((d) => d.queueOrder)), new Set(['HYBRID', 'PREQUEUE_SHUFFLE', 'FIFO']));
  assert.deepEqual(new Set(details.map((d) => d.seatAssignment)), new Set(['PICK', 'AUTO']));
});

test('가짜 API의 회차 목록은 판매 종료가 지난 회차를 빼되 이 회차는 넣는다', () => {
  const play = Object.values(JSON.parse(readFileSync(new URL('./mock-api/cards.json', import.meta.url), 'utf8'))).find((c) => c.title === '연극 창문 너머');
  const first = eventDetail(ORIGIN, play.eventId, new Date('2026-11-20T00:00:00Z'));
  assert.equal(first.rounds[0].eventId, play.eventId, '이 회차는 판매 종료가 지나도 있다');
  assert.ok(first.rounds.slice(1).every((r) => Date.parse(r.saleEndsAt) > Date.parse('2026-11-20T00:00:00Z')));
  assert.ok(first.rounds.length < eventDetail(ORIGIN, play.eventId, new Date('2026-10-01T00:00:00Z')).rounds.length);
});

test('가짜 API의 이미지 주소는 파생본 이름 규칙의 기준 주소다(ADR-0199 결정 4)', () => {
  const feed = homeFeed(ORIGIN, 'normal', NOW);
  assert.match(feed.upcoming[0].posterUrl, /^http:\/\/127\.0\.0\.1:4010\/img\/poster-[a-z]+$/);
  assert.ok(placeholderSvg('poster-lumen', 640).startsWith('<svg'));
});

test('가짜 API는 127.0.0.1 이름에만 답하고, 비로그인 상태면 찜 목록이 401이다', async () => {
  const server = await startMockApi({ port: 0 });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/v1/home`)).status, 200);
    assert.equal((await fetch(`${base}/v1/wishes`)).status, 200);
    await fetch(`${base}/__mock/state?fan=guest`);
    assert.equal((await fetch(`${base}/v1/wishes`)).status, 401);
    // fetch는 Host 머리를 바꾸지 못해 node:http로 보낸다(DNS 리바인딩 흉내)
    const status = await new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/v1/home', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(status, 421);
  } finally {
    server.close();
  }
});

test('가짜 API의 공연 상세 경로는 회차·공연 소문자 태그를 싣고, detail=suspended면 410 event-suspended다', async () => {
  const server = await startMockApi({ port: 0 });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    const { eventId, productionId } = homeFeed(ORIGIN, 'normal', NOW).upcoming[0];
    const upper = await fetch(`${base}/v1/events/${eventId.toUpperCase()}`);
    assert.equal(upper.status, 404, '대문자 ID는 고정 자료에 없다');
    const r = await fetch(`${base}/v1/events/${eventId}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-peaket-cache-tag'), `event:${eventId},production:${productionId}`);
    await fetch(`${base}/__mock/state?detail=suspended`);
    const gone = await fetch(`${base}/v1/events/${eventId}`);
    assert.equal(gone.status, 410);
    assert.equal((await gone.json()).type, 'https://peaket.example/problems/event-suspended');
    assert.equal((await fetch(`${base}/v1/events/no-such-event`)).status, 404, '없는 회차는 판매 중지 상태에서도 404');
  } finally {
    server.close();
  }
});

test('가짜 API의 찜 목록은 productionIds로 고르고(HOT-311), 찜 저장·해제가 목록에 남으며, 후기 요약이 계약 Zod를 지난다', async () => {
  const [a, b] = INITIAL_WISHES;
  assert.deepEqual(wishPage(ORIGIN, new Set(INITIAL_WISHES), [a, 'x']).items.map((c) => c.productionId), [a]);
  ListWishesResponse.parse(wishPage(ORIGIN, new Set(INITIAL_WISHES), [a]));
  const { eventId } = homeFeed(ORIGIN, 'normal', NOW).upcoming[0];
  const sum = reviewSummary(eventId);
  assert.deepEqual(GetEventReviewSummaryResponse.parse(sum), sum);
  assert.equal(sum.recent.length, 2);
  assert.equal(reviewSummary('no-such-event'), undefined);
  const server = await startMockApi({ port: 0 });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    const list = async (ids) => (await (await fetch(`${base}/v1/wishes?productionIds=${ids.join(',')}`)).json()).items.map((c) => c.productionId);
    assert.deepEqual(new Set(await list([a, b, 'x'])), new Set([a, b]));
    assert.equal((await fetch(`${base}/v1/productions/${a}/wish`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await list([a]), []);
    assert.equal((await fetch(`${base}/v1/productions/${a}/wish`, { method: 'PUT' })).status, 204);
    assert.deepEqual(await list([a]), [a]);
    const r = await fetch(`${base}/v1/events/${eventId}/review-summary`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  } finally {
    server.close();
  }
});

test('가짜 API의 검색 결과가 계약 Zod를 모르는 칸 없이 지나고, 0건 제안·바꿔 찾기·필터·관련 공연·쪽 규칙을 따른다(HOT-312)', () => {
  const parse = (x) => assert.deepEqual(ListSearchResultsResponse.parse(x), x);
  const titles = (r) => r.items.map((c) => c.title);
  // 아티스트 다른 이름으로 맞는다(관련 공연 없음: 필터가 없어 빠진 공연이 없다)
  const lumen = searchResults(ORIGIN, { q: '루멘' });
  parse(lumen);
  assert.deepEqual(new Set(titles(lumen)), new Set(['LUMEN 콘서트 2026 서울', '봄날 팬미팅']));
  assert.equal(lumen.related, null);
  // 필터로 빠진 그 아티스트의 공연이 있으면 관련 공연(ARTIST)
  const lumenConcert = searchResults(ORIGIN, { q: '루멘', genre: '콘서트' });
  parse(lumenConcert);
  assert.deepEqual(titles(lumenConcert), ['LUMEN 콘서트 2026 서울']);
  assert.equal(lumenConcert.related.basis.kind, 'ARTIST');
  assert.deepEqual(lumenConcert.related.items.map((c) => c.title), ['봄날 팬미팅']);
  // 로마자만인 입력이 0건이면 한/영 변환 값으로 찾고, noConvert면 바꾸지 않는다
  const conv = searchResults(ORIGIN, { q: 'fnaps' });
  parse(conv);
  assert.deepEqual(conv.query.converted, { from: 'fnaps', to: '루멘' });
  assert.equal(conv.total, 2);
  assert.equal(searchResults(ORIGIN, { q: 'fnaps', noConvert: true }).total, 0);
  // 0건: 비슷한 이름과 오픈 예정 인기 공연, 필터가 있으면 필터를 뺀 수
  const typo = searchResults(ORIGIN, { q: '루맨' });
  parse(typo);
  assert.equal(typo.didYouMean, '루멘');
  assert.equal(typo.related.basis.kind, 'UPCOMING_POPULAR');
  assert.equal(typo.relaxedTotal, null);
  const filtered = searchResults(ORIGIN, { q: '뮤지컬', status: 'UPCOMING' });
  parse(filtered);
  assert.equal(filtered.total, 0);
  assert.equal(filtered.relaxedTotal, 1);
  // 검색어 없이 필터만: 오픈 임박 순(오픈 예정이 앞), 공연장·아티스트 필터 이름
  const all = searchResults(ORIGIN, {});
  parse(all);
  assert.equal(all.total, 7);
  assert.equal(all.items[0].title, 'LUMEN 콘서트 2026 서울');
  const placeId = 'a1d2c3b4-0000-4000-8000-000000000001';
  const arena = searchResults(ORIGIN, { placeId, artistId: ARTISTS[1].artistId });
  parse(arena);
  assert.deepEqual(arena.filterNames, { placeName: '피켓 아레나', artistName: '피켓밴드' });
  assert.deepEqual(titles(arena), ['가을 야외 페스티벌']);
  // 쪽: 20개 고정, 없는 쪽은 빈 목록과 전체 쪽 수
  const p2 = searchResults(ORIGIN, { page: 2 });
  assert.deepEqual([p2.items.length, p2.totalPages, p2.limit], [0, 1, 20]);
  // 인기순은 정해진 순위
  assert.equal(searchResults(ORIGIN, { sort: 'POPULAR' }).items[0].title, '뮤지컬 별빛 정원');
});

test('가짜 API의 자동완성이 계약 Zod를 모르는 칸 없이 지나고, 다른 이름·초성·한/영 변환·종류별 몫·굵게 위치를 따른다(HOT-313)', () => {
  const parse = (x) => assert.deepEqual(GetSearchSuggestionsResponse.parse(x), x);
  const lumen = suggestions(ORIGIN, '루멘');
  parse(lumen);
  const prod = lumen.items.find((i) => i.label === 'LUMEN 콘서트 2026 서울');
  assert.deepEqual(prod.matches, [{ start: 0, length: 5 }], '다른 이름으로 맞으면 원래 이름의 대응 부분');
  assert.deepEqual(lumen.items.find((i) => i.kind === 'ARTIST'), { kind: 'ARTIST', label: 'LUMEN', matches: [{ start: 0, length: 5 }], artistId: ARTISTS[0].artistId });
  // 초성(호환 자모, NFKC 뒤 되돌림)
  const cho = suggestions(ORIGIN, 'ㄹㅁ');
  parse(cho);
  assert.equal(cho.query, 'ㄹㅁ');
  assert.ok(cho.items.some((i) => i.kind === 'ARTIST' && i.label === 'LUMEN'));
  // 한/영 변환
  assert.deepEqual(suggestions(ORIGIN, 'fnaps').items.map((i) => i.label), lumen.items.map((i) => i.label));
  // 공연장·아티스트가 함께 맞고 위치는 UTF-16
  const picket = suggestions(ORIGIN, '피켓');
  parse(picket);
  assert.ok(picket.items.length <= 8);
  assert.deepEqual(picket.items.find((i) => i.kind === 'PLACE')?.matches, [{ start: 0, length: 2 }]);
  // 공연(아티스트로 맞음) 2·아티스트 1뿐이라 빈 몫을 공연장으로 채운다. 몫 안의 공연장 하나가 넘친 공연장보다 앞이다
  assert.deepEqual(picket.items.map((i) => i.kind), ['PRODUCTION', 'PRODUCTION', 'ARTIST', 'PLACE', 'PLACE']);
  // 최소 길이: 한글 음절은 1자, 로마자는 2자
  assert.equal(suggestQueryOk('루'), true);
  assert.equal(suggestQueryOk('l'), false);
  assert.deepEqual(suggestions(ORIGIN, '없는말').items, []);
});

test('팬 계정 요약(GET /v1/identity/me, ADR-0202): 상태 fan=member·unverified·pending은 계약 모양 그대로, guest는 401', async () => {
  const server = await startMockApi({ port: 0 });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const me = async () => {
    const r = await fetch(`${base}/v1/identity/me`);
    return { status: r.status, cache: r.headers.get('cache-control'), body: r.status === 200 ? await r.json() : undefined };
  };
  try {
    const member = await me();
    assert.equal(member.status, 200);
    assert.equal(member.cache, 'no-store');
    assert.deepEqual(GetIdentityMeResponse.parse(member.body), member.body, '모르는 칸이 없다');
    assert.deepEqual(member.body, { nickname: '지민', signupCompleted: true, verified: true, hasStaffAssignment: false });
    await fetch(`${base}/__mock/state?fan=unverified`);
    assert.deepEqual((await me()).body, { nickname: '지민', signupCompleted: true, verified: false, hasStaffAssignment: false });
    await fetch(`${base}/__mock/state?fan=pending`);
    const pending = (await me()).body;
    assert.deepEqual(GetIdentityMeResponse.parse(pending), pending);
    assert.deepEqual(pending, { nickname: null, signupCompleted: false, verified: false, hasStaffAssignment: false });
    await fetch(`${base}/__mock/state?fan=guest`);
    assert.equal((await me()).status, 401);
    // 토큰 갱신도 비로그인이면 401(거절), 로그인이면 204
    assert.equal((await fetch(`${base}/v1/identity/access-tokens`, { method: 'POST' })).status, 401);
    // 찜·알림은 로그인한 팬이면 상태와 상관없이 답한다
    await fetch(`${base}/__mock/state?fan=unverified`);
    assert.equal((await fetch(`${base}/v1/wishes`)).status, 200);
  } finally {
    server.close();
  }
});

test('가입 마무리·닉네임 확인·가입 취소(ADR-0203): 계약 Zod 그대로, 가입 전 계정만 받고 마치면 계정 요약이 바뀐다', async () => {
  const server = await startMockApi({ port: 0 });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : undefined, cookies: r.headers.getSetCookie() };
  };
  const input = { ageOver14: true, consents: { terms: true, privacy: true, marketing: false, phone: true }, nickname: '피켓팬', phone: '01012345678' };
  try {
    await fetch(`${base}/__mock/state?fan=pending`);
    // 닉네임 확인
    const check = async (nickname) => (await post('/v1/identity/nickname-checks', CreateIdentityNicknameCheckBody.parse({ nickname }))).body;
    assert.deepEqual(CreateIdentityNicknameCheckResponse.parse(await check('피켓팬')), { available: true });
    assert.deepEqual(await check('지민'), { available: false, reason: 'taken' });
    assert.deepEqual(await check('PEAKET'), { available: false, reason: 'taken' }, '대소문자 접기');
    assert.deepEqual(await check('루멘🎤'), { available: false, reason: 'invalid' });
    // 가입 마무리
    assert.equal((await post('/v1/identity/signup-completions', { ...input, nickname: '지민' })).status, 409);
    assert.equal((await post('/v1/identity/signup-completions', { ...input, consents: { ...input.consents, terms: false } })).status, 400);
    assert.equal((await post('/v1/identity/signup-completions', { ...input, consents: { ...input.consents, phone: false } })).status, 400, '동의 없는 휴대폰 번호');
    const done = await post('/v1/identity/signup-completions', CreateIdentitySignupCompletionBody.parse(input));
    assert.equal(done.status, 200);
    assert.deepEqual(CreateIdentitySignupCompletionResponse.parse(done.body), done.body);
    assert.deepEqual(done.body, { nickname: '피켓팬', signupCompleted: true, verified: false, hasStaffAssignment: false });
    assert.equal((await (await fetch(`${base}/v1/identity/me`)).json()).nickname, '피켓팬');
    const again = await post('/v1/identity/signup-completions', input);
    assert.equal(again.status, 409);
    assert.match(again.body.type, /signup-already-completed$/);
    // 가입 취소: 마친 뒤에는 409, 가입 전이면 204와 쿠키 지우기, 그 뒤 401
    assert.equal((await post('/v1/identity/signup-cancellations', { reason: 'UNDER_14' })).status, 409);
    await fetch(`${base}/__mock/state?fan=pending`);
    const cancel = await post('/v1/identity/signup-cancellations', CreateIdentitySignupCancellationBody.parse({ reason: 'UNDER_14' }));
    assert.equal(cancel.status, 204);
    assert.ok(cancel.cookies.some((c) => /^__Secure-peaket_at=;.*Max-Age=0/.test(c)));
    assert.equal((await fetch(`${base}/v1/identity/me`)).status, 401);
  } finally {
    server.close();
  }
});

test('휴대폰 본인확인(identity §5 모의 기관과 기관 창 흐름): 계약 Zod 그대로, 정본 모의 기관이 봉한 결과를 identity-svc와 같은 규칙으로 읽는다', async () => {
  const { sealResult } = await import('../../../services/identity-svc/scripts/mock-idv.mjs');
  // 환경 변수의 비밀과 상관없이 같은 비밀을 준다(개발 PC에 PEAKET_TEST_VERIFICATION_SECRET가 있어도 시험이 흔들리지 않게)
  const secret = Buffer.from('mock-api-test-secret-0123456789');
  let clock = Date.parse('2026-11-05T03:00:00Z');
  const server = await startMockApi({ port: 0, idvUrl: 'http://127.0.0.1:4020/verify', idvSecret: secret, now: () => clock });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : undefined, retryAfter: r.headers.get('retry-after') };
  };
  const state = (q) => fetch(`${base}/__mock/state?${q}`);
  const me = async () => (await call('GET', '/v1/identity/me')).body;
  const start = (next = '/events/x?round=2', purpose) => call('POST', '/v1/identity/verifications', CreateIdentityVerificationBody.parse({ next, ...(purpose ? { purpose } : {}) }));
  const seal = (id, outcome, extra = {}) => sealResult(secret, { v: 1, tx: id, outcome, iat: clock, ...extra });
  const confirm = (id, providerResult) => call('POST', `/v1/identity/verifications/${id}/result`, CreateIdentityVerificationResultBody.parse({ providerResult }));
  const result = (id) => call('GET', `/v1/identity/verifications/${id}/result`);
  const adult = { person: 'tester-1', birth: '2000-01-01' };
  const fresh = async (purpose) => (await start('/events/x?round=2', purpose)).body.verificationId;
  try {
    await state('fan=guest');
    assert.equal((await start()).status, 401);
    await state('fan=member');
    assert.match((await start()).body.type, /already-verified$/, '이미 본인확인한 계정의 FIRST');
    await state('fan=unverified');
    assert.match((await call('POST', '/v1/identity/verifications', { next: '//evil.example' })).body.type, /next-invalid$/);
    assert.match((await start('/x', 'MINOR_CONTRACT')).body.type, /purpose-not-supported$/);

    // 완료: 창 값은 모의 기관 주소, 확정하면 계정 요약이 본인확인 완료로 바뀐다. 다시 보내면 같은 결과
    const s1 = await start();
    assert.equal(s1.status, 201);
    assert.deepEqual(CreateIdentityVerificationResponse.parse(s1.body), s1.body);
    const id = s1.body.verificationId;
    assert.deepEqual(s1.body.window, { url: 'http://127.0.0.1:4020/verify', method: 'POST', fields: { verificationId: id }, mode: 'POPUP' });
    assert.equal(GetIdentityVerificationResultResponse.parse((await result(id)).body).status, 'PENDING');
    const done = await confirm(id, seal(id, 'VERIFIED', adult));
    assert.equal(done.status, 200);
    assert.deepEqual(CreateIdentityVerificationResultResponse.parse(done.body), { verificationId: id, purpose: 'FIRST', status: 'VERIFIED', next: '/events/x?round=2', restrictedUntil: null });
    assert.equal((await me()).verified, true);
    assert.equal((await confirm(id, seal(id, 'CANCELLED'))).body.status, 'VERIFIED', '확정된 건은 같은 결과');
    // 조회 기간: 확정한 건은 1일 동안 같은 결과(만든 지 10분이 지나도), 처리 중인 건은 10분
    await state('fan=unverified');
    const pending = await fresh();
    clock += 11 * 60_000;
    assert.equal((await result(id)).body.status, 'VERIFIED');
    assert.equal((await result(pending)).status, 404);
    clock += 24 * 3_600_000;
    assert.equal((await result(id)).status, 404);

    // 기관 값 규칙(시험 어댑터와 같다): 서명·다른 건·10분·이름표 없음·이름표 64자 넘음은 FAILED
    const failedWith = async (make) => {
      const v = await fresh();
      return (await confirm(v, make(v))).body.status;
    };
    assert.equal(await failedWith((v) => ({ ...seal(v, 'VERIFIED', adult), mac: 'x'.repeat(43) })), 'FAILED');
    const other = await fresh();
    assert.equal(await failedWith(() => seal(other, 'VERIFIED', adult)), 'FAILED');
    assert.equal(await failedWith((v) => sealResult(secret, { v: 1, tx: v, outcome: 'VERIFIED', ...adult, iat: clock - 11 * 60_000 })), 'FAILED', '10분 지난 값');
    assert.equal(await failedWith((v) => seal(v, 'VERIFIED', { birth: '2000-01-01' })), 'FAILED', '이름표 없음');
    assert.equal(await failedWith((v) => seal(v, 'VERIFIED', { person: 'p'.repeat(65), birth: '2000-01-01' })), 'FAILED', '이름표 64자 넘음');
    // 만 나이를 확인할 수 없는 날(ageOnKst): 생년월일 없음·오늘 뒤·달력에 없는 날·1900년 전
    for (const birth of [undefined, '2099-01-01', '2000-02-30', '1899-12-31']) {
      assert.equal(await failedWith((v) => seal(v, 'VERIFIED', { person: 'p', ...(birth ? { birth } : {}) })), 'FAILED', String(birth));
    }
    assert.equal((await me()).verified, false, '실패한 결과는 계정을 바꾸지 않는다');
    assert.equal(await failedWith((v) => seal(v, 'CANCELLED')), 'CANCELLED');
    // 기관 장애: 503, 결과 조회는 PROVIDER_DOWN, 다시 보내도 503
    const down = await fresh();
    const d1 = await confirm(down, seal(down, 'DOWN'));
    assert.deepEqual([d1.status, d1.retryAfter], [503, '30']);
    assert.equal((await result(down)).body.status, 'PROVIDER_DOWN');
    assert.equal((await confirm(down, seal(down, 'VERIFIED', adult))).status, 503);
    // 다른 계정의 본인(가짜 API는 이름표 duplicate로 흉내 낸다)
    const dup = await fresh();
    assert.match((await confirm(dup, seal(dup, 'VERIFIED', { person: 'duplicate', birth: '2000-01-01' }))).body.type, /duplicate-account$/);

    // 다시 본인확인(REVERIFY): 기록이 없는 계정은 FAILED, 본인확인한 계정은 같은 사람만 VERIFIED이고 미성년이 나오면 정리하지 않고 FAILED
    const noRecord = await fresh('REVERIFY');
    assert.equal((await confirm(noRecord, seal(noRecord, 'VERIFIED', adult))).body.status, 'FAILED');
    assert.equal((await me()).verified, false);
    await state('fan=member');
    const same = await fresh('REVERIFY');
    assert.equal((await confirm(same, seal(same, 'VERIFIED', adult))).body.status, 'VERIFIED');
    const otherPerson = await fresh('REVERIFY');
    assert.equal((await confirm(otherPerson, seal(otherPerson, 'VERIFIED', { person: 'other', birth: '2000-01-01' }))).body.status, 'FAILED');
    const young = new Date(clock - 13 * 365 * 86_400_000).toISOString().slice(0, 10);
    const minorReverify = await fresh('REVERIFY');
    assert.equal((await confirm(minorReverify, seal(minorReverify, 'VERIFIED', { person: 'tester-1', birth: young }))).body.status, 'FAILED');
    assert.equal((await me()).verified, true, '본인확인한 계정은 정리하지 않는다');

    // 만 14세 미만(FIRST): 403, 계정은 정리 중(세션은 살아 있어 결과 조회·계정 요약은 된다), 다시 시작·확정은 403 under-14
    await state('fan=unverified');
    const minor = await fresh();
    assert.match((await confirm(minor, seal(minor, 'VERIFIED', { person: 'kid', birth: young }))).body.type, /under-14$/);
    assert.equal((await result(minor)).body.status, 'UNDER_14');
    assert.deepEqual(await me(), { nickname: '지민', signupCompleted: true, verified: false, hasStaffAssignment: false });
    assert.match((await start()).body.type, /under-14$/);
    // 기관 창 방식·기관 장애 바꾸기, 없는 건·꼴이 틀린 건 ID(잘못된 퍼센트 인코딩 포함)는 404이고 서버는 계속 답한다
    await state('fan=unverified&verify=redirect');
    assert.equal((await start()).body.window.mode, 'REDIRECT');
    await state('verify=down');
    assert.equal((await start()).status, 503);
    assert.equal((await result('00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await result('%E0%A4%A')).status, 404);
    assert.equal((await call('GET', '/v1/identity/me')).status, 200);
  } finally {
    server.close();
  }
});
