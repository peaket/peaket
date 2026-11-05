// 계약 모양 가짜 API의 응답이 계약 Zod(@peaket/contracts 생성물)를 지나는지(ADR-0199 결정 2, BUILD_ORDER HOT-300).
// 계약이 바뀌면 이 시험이 고정 자료(mock-api/cards.json)도 함께 고치게 한다.
import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GetEventResponse, GetHomeRankingsResponse, GetHomeResponse } from '@peaket/contracts/openapi/catalog';
import { ListSubscriptionsResponse, ListWishesResponse } from '@peaket/contracts/openapi/identity';
import { GetEventReviewSummaryResponse } from '@peaket/contracts/openapi/reviews';
import { INITIAL_WISHES, eventDetail, homeFeed, placeholderSvg, rankingFile, reviewSummary, startMockApi, subscriptionPage, wishPage } from './mock-api.mjs';

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
