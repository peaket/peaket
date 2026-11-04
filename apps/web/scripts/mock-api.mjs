// 계약 모양 가짜 API(ADR-0199 결정 2, BUILD_ORDER HOT-300). 로컬 개발·브라우저 확인 전용이다. 운영·CI 배포에는 쓰지 않는다.
// 서버가 아직 없는 화면 경로를 고정 자료(scripts/mock-api/cards.json)로 답한다. 응답이 계약 Zod를 지나는지는 mock-api.test.mjs가 본다.
// - 127.0.0.1에만 묶는다. 소비자 웹 출처 하나에만 자격 증명 포함 CORS를 연다(PEAKET_WEB_ORIGIN, 기본 http://localhost:3000)
// - 상태 바꾸기: GET /__mock/state?home=normal|empty&ranking=normal|stale|old|missing&fan=member|guest (화면 상태를 보려고)
// - 파생본 이미지 주소(/img/{이름}/{폭}.{avif|webp})에는 자리 그림(SVG)을 낸다
// 실행: node scripts/mock-api.mjs [포트, 기본 4010]
//   소비자 웹은 PEAKET_API_ORIGIN·NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:4010, PEAKET_DEV_STATIC_ORIGIN=http://127.0.0.1:4010,
//   PEAKET_CSP_ORIGINS='{"api":"http://127.0.0.1:4010","img":"http://127.0.0.1:4010"}'로 띄운다(apps/README.md)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const CARDS = JSON.parse(readFileSync(new URL('./mock-api/cards.json', import.meta.url), 'utf8'));
const KST = 9 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;

/** 고정 자료의 {MOCK} 자리를 가짜 API 주소로 */
function withOrigin(value, origin) {
  return JSON.parse(JSON.stringify(value).replaceAll('{MOCK}', origin));
}

/** @param {string[]} keys */
const cards = (keys) => keys.map((k) => {
  const c = CARDS[k];
  if (!c) throw new Error(`고정 자료에 없는 카드: ${k}`);
  return c;
});

/** 홈 피드(openapi HomeFeed) */
export function homeFeed(origin, state = 'normal', now = new Date()) {
  if (state === 'empty') return { banners: [], upcoming: [], onSale: [], themes: [], places: [], rankingsPath: '/v1/home/rankings.json', generatedAt: now.toISOString() };
  return withOrigin(
    {
      banners: [
        { bannerId: 'bn-lumen', productionId: CARDS.lumen.productionId, eventId: CARDS.lumen.eventId, title: 'LUMEN 콘서트 2026 서울', subtitle: '12/24(목)~12/26(토) · 피켓 아레나', imageUrl: '{MOCK}/img/banner-lumen', alt: 'LUMEN 콘서트 2026 서울, 12월 24일부터 26일까지 피켓 아레나', displayUntil: '2026-12-26T15:00:00Z' },
        { bannerId: 'bn-musical', productionId: CARDS.musical.productionId, eventId: CARDS.musical.eventId, title: '뮤지컬 별빛 정원', subtitle: '11/28~1/18 · 피켓 아트홀', imageUrl: '{MOCK}/img/banner-musical', alt: '뮤지컬 별빛 정원, 11월 28일부터 1월 18일까지 피켓 아트홀', displayUntil: '2027-01-18T15:00:00Z' },
        { bannerId: 'bn-fest', productionId: CARDS.fest.productionId, eventId: CARDS.fest.eventId, imageUrl: '{MOCK}/img/banner-fest', alt: '가을 야외 페스티벌, 11월 14일부터 15일까지 피켓 아레나', displayUntil: '2026-11-15T15:00:00Z' },
      ],
      upcoming: cards(['lumen', 'jazz', 'fanmeet']),
      onSale: cards(['fest', 'play', 'musical']),
      themes: [{ themeId: 'th-weekend', name: '이번 주말, 같이 갈 공연', productions: cards(['fest', 'musical', 'play', 'lumen', 'orchestra']) }],
      places: [
        { placeId: 'a1d2c3b4-0000-4000-8000-000000000001', name: '피켓 아레나', initial: '피' },
        { placeId: 'a1d2c3b4-0000-4000-8000-000000000002', name: '서울 소극장', initial: '서' },
        { placeId: 'a1d2c3b4-0000-4000-8000-000000000003', name: '피켓 아트홀', initial: '아' },
      ],
      rankingsPath: '/v1/home/rankings.json',
      generatedAt: now.toISOString(),
    },
    origin,
  );
}

/** 한국 날짜 'YYYY-MM-DD'에서 days일 앞 */
function kstDaysAgo(now, days) {
  return new Date(now.getTime() + KST - days * DAY).toISOString().slice(0, 10);
}

/** 장르별 랭킹 파일(openapi RankingFile). 받아야 할 판매일(10시 전에는 그제, 뒤에는 어제)에서 stale은 하루, old는 2일 밀린 파일(화면이 숨긴다) */
export function rankingFile(origin, state = 'normal', now = new Date()) {
  const expected = new Date(now.getTime() + KST).getUTCHours() < 10 ? 2 : 1;
  const lag = expected + (state === 'stale' ? 1 : state === 'old' ? 2 : 0);
  const ranked = (keys) => cards(keys).map((c, i) => ({ ...c, rank: i + 1 }));
  return withOrigin(
    {
      basisDate: kstDaysAgo(now, lag),
      generatedAt: now.toISOString(),
      overall: ranked(['musical', 'fest', 'orchestra', 'play', 'lumen', 'jazz']),
      genres: [
        { genre: '콘서트', items: ranked(['lumen', 'jazz']) },
        { genre: '뮤지컬', items: ranked(['musical']) },
        { genre: '연극', items: ranked(['play']) },
        { genre: '클래식', items: ranked(['orchestra']) },
        { genre: '페스티벌', items: ranked(['fest']) },
      ],
    },
    origin,
  );
}

/** 찜 목록(openapi listWishes 200) */
export function wishPage(origin) {
  return withOrigin({ items: cards(['musical', 'lumen', 'orchestra']), nextCursor: null }, origin);
}

/** 알림 신청 상태(openapi listSubscriptions 200) */
export function subscriptionPage(eventIds, alerts) {
  return { items: eventIds.map((eventId) => ({ eventId, open: alerts.has(eventId), cancellation: false, nightPush: false, cancellationStatus: null, endReason: null })), nextCursor: null };
}

/** 자리 그림: 이름마다 다른 색과 이름 글자 */
export function placeholderSvg(name, width) {
  const banner = name.startsWith('banner-');
  const h = banner ? Math.round((width * 400) / 1240) : Math.round((width * 4) / 3);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const label = name.replace(/^(banner|poster)-/, '').toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 38%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 65% 22%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="${banner ? '50%' : '42%'}" fill="#fff" font-family="sans-serif" font-size="${Math.round(width / (banner ? 14 : 7))}" font-weight="700" text-anchor="middle">${label}</text></svg>`;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;

export function startMockApi({ port = 4010, webOrigin = process.env.PEAKET_WEB_ORIGIN || 'http://localhost:3000' } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const state = { home: 'normal', ranking: 'normal', fan: 'member' };
  const alerts = new Set();
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(421).end();
      return;
    }
    const url = new URL(req.url ?? '/', origin);
    const cors = req.headers.origin === webOrigin ? { 'access-control-allow-origin': webOrigin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {};
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, { ...cors, 'cache-control': 'no-store', ...(body === undefined ? {} : { 'content-type': type }), ...extra });
      res.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      send(204, undefined, undefined, {
        'access-control-allow-methods': 'GET, POST, PUT, DELETE',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? 'content-type',
        'access-control-max-age': '60',
      });
      return;
    }
    const p = url.pathname;
    const unauthorized = () => send(401, { type: 'about:blank', title: 'Unauthorized', status: 401 }, 'application/problem+json');
    if (p === '/__mock/state' && req.method === 'GET') {
      for (const k of /** @type {const} */ (['home', 'ranking', 'fan'])) {
        const v = url.searchParams.get(k);
        if (v) state[k] = v;
      }
      send(200, state);
      return;
    }
    if (p === '/v1/home' && req.method === 'GET') return send(200, homeFeed(origin, state.home));
    if (p === '/v1/home/rankings.json' && req.method === 'GET') {
      if (state.ranking === 'missing') return send(404, { type: 'about:blank', title: 'Not Found', status: 404 }, 'application/problem+json');
      return send(200, rankingFile(origin, state.ranking));
    }
    if (p === '/v1/wishes' && req.method === 'GET') return state.fan === 'guest' ? unauthorized() : send(200, wishPage(origin));
    if (p === '/v1/subscriptions' && req.method === 'GET') {
      if (state.fan === 'guest') return unauthorized();
      const ids = (url.searchParams.get('eventIds') ?? '').split(',').filter((x) => ID.test(x)).slice(0, 50);
      return send(200, subscriptionPage(ids, alerts));
    }
    const sub = /^\/v1\/events\/([^/]+)\/subscriptions$/.exec(p);
    if (sub && ID.test(sub[1])) {
      if (state.fan === 'guest') return unauthorized();
      if (req.method === 'POST') {
        alerts.add(sub[1]);
        return send(200, subscriptionPage([sub[1]], alerts).items[0]);
      }
      if (req.method === 'DELETE') {
        alerts.delete(sub[1]);
        return send(204);
      }
    }
    const wish = /^\/v1\/productions\/([^/]+)\/wish$/.exec(p);
    if (wish && ID.test(wish[1]) && (req.method === 'PUT' || req.method === 'DELETE')) return state.fan === 'guest' ? unauthorized() : send(204);
    const img = /^\/img\/([a-z0-9-]{1,40})\/(\d{3,4})\.(avif|webp)$/.exec(p);
    if (img && req.method === 'GET') return send(200, placeholderSvg(img[1], Math.min(Number(img[2]), 1280)), 'image/svg+xml', { 'cache-control': 'public, max-age=60' });
    send(404, { type: 'about:blank', title: 'Not Found', status: 404 }, 'application/problem+json');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? 4010);
  await startMockApi({ port });
  console.log(`가짜 API: http://127.0.0.1:${port} (상태 바꾸기 /__mock/state?home=empty&ranking=stale&fan=guest)`);
}
