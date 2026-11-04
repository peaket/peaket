// 계약 모양 가짜 API의 응답이 계약 Zod(@peaket/contracts 생성물)를 지나는지(ADR-0199 결정 2, BUILD_ORDER HOT-300).
// 계약이 바뀌면 이 시험이 고정 자료(mock-api/cards.json)도 함께 고치게 한다.
import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetHomeRankingsResponse, GetHomeResponse } from '@peaket/contracts/openapi/catalog';
import { ListSubscriptionsResponse, ListWishesResponse } from '@peaket/contracts/openapi/identity';
import { homeFeed, placeholderSvg, rankingFile, startMockApi, subscriptionPage, wishPage } from './mock-api.mjs';

const ORIGIN = 'http://127.0.0.1:4010';
const NOW = new Date('2026-11-05T03:00:00Z');

test('가짜 API의 홈 피드·랭킹 파일·찜·알림 상태가 계약 Zod를 지난다', () => {
  for (const s of ['normal', 'empty']) GetHomeResponse.parse(homeFeed(ORIGIN, s, NOW));
  for (const s of ['normal', 'stale', 'old']) GetHomeRankingsResponse.parse(rankingFile(ORIGIN, s, NOW));
  ListWishesResponse.parse(wishPage(ORIGIN));
  ListSubscriptionsResponse.parse(subscriptionPage(['e1'], new Set(['e1'])));
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
