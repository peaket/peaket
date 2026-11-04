// 계약 모양 가짜 API(ADR-0199 결정 2, BUILD_ORDER HOT-300). 로컬 개발·브라우저 확인 전용이다. 운영·CI 배포에는 쓰지 않는다.
// 서버가 아직 없는 화면 경로를 고정 자료(scripts/mock-api/cards.json)로 답한다. 응답이 계약 Zod를 지나는지는 mock-api.test.mjs가 본다.
// - 127.0.0.1에만 묶는다. 소비자 웹 출처 하나에만 자격 증명 포함 CORS를 연다(PEAKET_WEB_ORIGIN, 기본 http://localhost:3000)
// - 상태 바꾸기: GET /__mock/state?home=normal|empty&ranking=normal|stale|old|missing&fan=member|guest&detail=normal|suspended (화면 상태를 보려고)
// - 파생본 이미지 주소(/img/{이름}/{폭}.{avif|webp})에는 자리 그림(SVG)을 낸다
// - 공연 상세(GET /v1/events/{eventId}, ADR-0200)는 고정 자료 카드의 모든 회차를 답하고 그 밖은 404다.
//   detail=suspended면 모두 410 event-suspended(한 번 공개된 뒤 판매 중지, ADR-0200 결정 3)
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

const SELLER = { legalName: '(주)피켓공연', representative: '김피켓', address: '서울 어딘가 1', phone: '02-0000-0000', email: 'seller@peaket.example', businessRegNo: '000-00-00000', mailOrderReportNo: '2026-서울-0000' };
const PLACES = { '피켓 아레나': { placeId: 'a1d2c3b4-0000-4000-8000-000000000001', placeAddress: '서울 어딘가 1' }, '서울 소극장': { placeId: 'a1d2c3b4-0000-4000-8000-000000000002', placeAddress: '서울 어딘가 2' }, '피켓 아트홀': { placeId: 'a1d2c3b4-0000-4000-8000-000000000003', placeAddress: '서울 어딘가 3' } };
const QUEUE_ORDERS = ['HYBRID', 'PREQUEUE_SHUFFLE', 'FIFO'];
const LOBBY_MINUTES = 10;
/** 판매 중·매진 카드의 오픈(이미 지남): 첫 회차 30일 전, 늦어도 2026-11-01 20:00 KST */
const PAST_OPEN_LIMIT = Date.parse('2026-11-01T11:00:00Z');

/**
 * 카드 하나의 회차들(시작 순). 기간 첫날~끝날 하루 한 회차이고, 시작 시각은 마지막 회차(카드 saleEndsAt + 24시간)의 시각이다.
 * 첫 회차가 카드의 대표 회차(eventId)다. 다른 회차 ID는 대표 회차 ID의 끝 12자리 가운데 둘을 차례로 바꾼다.
 * 오픈 예정 카드는 모든 회차가 nextOpenAt에 연다(같은 공연의 회차끼리는 오픈 간격을 보지 않는다, ADR-0198 결정 2).
 */
function cardRounds(c) {
  const last = Date.parse(c.saleEndsAt) + DAY;
  const timeOfDay = (last + KST) % DAY;
  const first = Date.parse(`${c.periodStart}T00:00:00Z`) - KST + timeOfDay;
  const count = Math.min(Math.round((last - first) / DAY) + 1, 60);
  const open = c.nextOpenAt ? Date.parse(c.nextOpenAt) : Math.min(first - 30 * DAY, PAST_OPEN_LIMIT);
  return Array.from({ length: count }, (_, i) => {
    const startsAt = first + i * DAY;
    const eventId = i === 0 ? c.eventId : `${c.eventId.slice(0, -4)}${(0x60 + i).toString(16)}${c.eventId.slice(-2)}`;
    return { eventId, startsAt, openAt: open, saleEndsAt: startsAt - DAY };
  });
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * 공연 상세(openapi getEvent 200, EventPublicSummary + ADR-0200 칸). 고정 자료 카드의 모든 회차가 있고 그 밖은 없음(404).
 * 회차 목록은 판매 종료가 지난 회차를 빼되 이 회차는 늘 넣는다(ADR-0200 결정 1).
 */
export function eventDetail(origin, eventId, now = new Date()) {
  for (const c of Object.values(CARDS)) {
    const rounds = cardRounds(c);
    const r = rounds.find((x) => x.eventId === eventId);
    if (!r) continue;
    const order = (c.badges ?? []).find((b) => QUEUE_ORDERS.includes(b)) ?? 'HYBRID';
    const place = PLACES[c.placeName] ?? { placeId: 'a1d2c3b4-0000-4000-8000-000000000009', placeAddress: '서울 어딘가' };
    const tierBase = c.minPrice ?? 0;
    return withOrigin(
      {
        eventId: r.eventId,
        productionId: c.productionId,
        title: c.title,
        startsAt: iso(r.startsAt),
        sellerName: SELLER.legalName,
        genre: c.genre,
        ageRating: '만 7세 이상',
        runningMinutes: 120,
        posterUrl: c.posterUrl,
        posterAlt: c.posterAlt,
        descriptionText: `${c.title} 공연 안내입니다.\n출연진과 관람 유의사항은 이 글에 함께 적습니다.`,
        detailImages: [{ url: c.posterUrl, alt: `${c.title} 상세 안내 이미지` }],
        artists: [{ artistId: 'b1d2c3b4-0000-4000-8000-000000000001', name: '피켓밴드' }],
        placeId: place.placeId,
        placeName: c.placeName,
        placeAddress: place.placeAddress,
        openAt: iso(r.openAt),
        lobbyOpensAt: order === 'FIFO' ? null : iso(r.openAt - LOBBY_MINUTES * 60_000),
        entryOpensAt: iso(r.startsAt - 60 * 60_000),
        endsAt: iso(r.startsAt + 2 * 60 * 60_000),
        saleEndsAt: iso(r.saleEndsAt),
        status: 'SCHEDULED',
        queueOrder: order,
        seatAssignment: (c.badges ?? []).includes('AUTO_SEAT') ? 'AUTO' : 'PICK',
        perPersonLimit: 4,
        reentryAllowed: false,
        badges: c.badges ?? [],
        rounds: rounds
          .filter((x) => x === r || x.saleEndsAt > now.getTime())
          .map((x) => ({ eventId: x.eventId, startsAt: iso(x.startsAt), openAt: iso(x.openAt), saleEndsAt: iso(x.saleEndsAt), status: 'SCHEDULED' })),
        priceTiers: [
          { tierId: 'tier-r', name: 'R석', price: tierBase + 44000 },
          { tierId: 'tier-s', name: 'S석', price: tierBase + 22000 },
          { tierId: 'tier-a', name: 'A석', price: tierBase },
        ],
        seller: SELLER,
      },
      origin,
    );
  }
  return undefined;
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
  const state = { home: 'normal', ranking: 'normal', fan: 'member', detail: 'normal' };
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
      for (const k of /** @type {const} */ (['home', 'ranking', 'fan', 'detail'])) {
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
    const ev = /^\/v1\/events\/([^/]+)$/.exec(p);
    if (ev && req.method === 'GET') {
      const d = ID.test(ev[1]) ? eventDetail(origin, ev[1]) : undefined;
      if (d && state.detail === 'suspended') return send(410, { type: 'https://peaket.example/problems/event-suspended', title: '판매가 중지된 공연입니다', status: 410 }, 'application/problem+json');
      // 캐시 태그는 회차·공연 둘이고 소문자다(core-svc event-summary.controller.ts와 같다, ADR-0200 결정 5)
      const tags = d ? `event:${d.eventId.toLowerCase()},production:${d.productionId.toLowerCase()}` : '';
      return d ? send(200, d, undefined, { 'cache-control': 'public, max-age=300, stale-if-error=86400', 'x-peaket-cache-tag': tags }) : send(404, { type: 'https://peaket.example/problems/not-found', title: '찾을 수 없습니다', status: 404 }, 'application/problem+json');
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
