// 검색 품질 사건 수 시험(BAT-165 웨이브 7 T-22, catalog-review 14.2.3).
// 정본: docs/features/search.md §11(279~284줄: 검색어 없이 사건 수만 같은 출처 수집 경로 `/_t/rum`으로 60초 [가정]마다 묶어 보낸다,
// 라벨은 zero·kind(3)·position(1~8)·position_bucket(1~3, 4~10, 11~20)), catalog-review.md:157(14.2.3).
// requery()는 공개 모양에서 빠졌다(R165-5): 바로 다시 찾음은 resultsShown(zero, 정규화한 검색어)로 모듈이 센다.
// 시험이 정한 모양(구현이 다르면 계획의 '시험 이의'): 사건을 부를 때 지난 보냄(처음엔 만든 때)에서 60초가 지났으면 그 사건까지 모은 수를 한 번에 보낸다.
// flush()는 모은 것이 있으면 바로 보낸다. 라벨 값은 글이다(버킷 '1-3'·'4-10'·'11-20').
// 본문은 계약 RumSample 판 2(asyncapi, 선택 칸 counters = [{name, labels, value}])다. 한 표본이거나 표본 배열이다(W7L2-W2·S5, ADR-0271 결정 20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchQuality } from './search-quality.ts';

// 정본 값(search.md:279). 코드 상수를 가져오지 않는다
const WINDOW_MS = 60_000;
const T0 = Date.parse('2026-11-16T00:00:00.000Z');

function harness() {
  let now = T0;
  const sent = [];
  const q = createSearchQuality({ send: async (path, body) => void sent.push({ path, body }), now: () => now });
  return { q, sent, at: (ms) => (now = T0 + ms) };
}

const sampleOf = (body) => {
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed.find((x) => x && Array.isArray(x.counters)) ?? parsed[0] : parsed;
};
const counters = (body) => {
  const out = {};
  for (const c of sampleOf(body)?.counters ?? []) {
    const labels = Object.entries(c.labels ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    out[labels ? `${c.name}{${labels}}` : c.name] = c.value;
  }
  return out;
};

test('검색 품질 사건은 검색어 없이 같은 출처 /_t/rum으로 60초마다 묶어 보낸다 [ASVS v5.0.0-14.2.3]', async () => {
  // 화면 주소·리퍼러에 검색어가 있어도(여러 꼴) 본문에 싣지 않는다
  const queries = ['루멘', 'LUMEN', 'fnaps', '010-1234-5678', 'a@b.kr'];
  const saved = { location: globalThis.location, document: globalThis.document };
  globalThis.location = { href: `https://peaket.example/search?q=${encodeURIComponent(queries[0])}&page=2`, search: `?q=${encodeURIComponent(queries[0])}`, pathname: '/search', origin: 'https://peaket.example' };
  globalThis.document = { referrer: `https://peaket.example/search?q=${queries[1]}`, title: `'${queries[2]}' 검색 결과` };
  try {
    const h = harness();
    // 같은 검색어의 결과를 두 번 보였다(바로 다시 찾음이 아니다). 둘째 인자는 정규화한 검색어(R165-5, ADR-0271 결정 16)
    h.q.resultsShown(false, queries[0]);
    h.q.resultsShown(true, queries[0]);
    h.q.suggestShown();
    h.q.suggestSelected('ARTIST', 2);
    h.q.suggestSelected('PRODUCTION', 8);
    // 위치 1~8 밖·종류 셋 밖은 버린다
    h.q.suggestSelected('PRODUCTION', 0);
    h.q.suggestSelected('PLACE', 9);
    h.q.suggestSelected('VENUE', 1);
    h.q.resultClick(3);
    h.q.resultClick(4);
    h.q.resultClick(10);
    h.q.resultClick(11);
    h.q.resultClick(20);
    // 버킷 밖(0·21)은 버린다
    h.q.resultClick(0);
    h.q.resultClick(21);
    // 60초 − 1ms: 아직 보내지 않는다
    h.at(WINDOW_MS - 1);
    h.q.suggestShown();
    assert.equal(h.sent.length, 0);
    // 60초: 그때까지 모은 것을 한 번에 보낸다
    h.at(WINDOW_MS);
    h.q.suggestShown();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].path, '/_t/rum');
    assert.deepEqual(counters(h.sent[0].body), {
      'search_results_shown_total{zero=false}': 1,
      'search_results_shown_total{zero=true}': 1,
      search_suggest_shown_total: 3,
      'search_suggest_selected_total{kind=ARTIST,position=2}': 1,
      'search_suggest_selected_total{kind=PRODUCTION,position=8}': 1,
      'search_result_click_total{position_bucket=1-3}': 1,
      'search_result_click_total{position_bucket=4-10}': 2,
      'search_result_click_total{position_bucket=11-20}': 2,
    });
    const body = h.sent[0].body;
    // 계약 RumSample 판 2(W7L2-W2): 검사를 통과하고 schemaVersion 2·counters가 남는다(계약 밖 칸이면 검사가 지운다)
    const { RumSample } = await import('@peaket/contracts/asyncapi');
    const checked = RumSample.parse(sampleOf(body));
    assert.equal(checked.schemaVersion, 2);
    assert.ok(Array.isArray(checked.counters) && checked.counters.length > 0, '계약 검사 뒤에도 counters가 있다');
    for (const s of [...queries, ...queries.map(encodeURIComponent), 'q=', '?', 'peaket.example/search']) assert.equal(body.includes(s), false, `본문에 ${s}가 없다`);

    // 보낸 뒤에는 다시 0부터 세고, 다음 창도 60초 − 1ms까지는 보내지 않는다
    h.q.suggestShown();
    h.at(2 * WINDOW_MS - 1);
    h.q.suggestShown();
    assert.equal(h.sent.length, 1);
    // flush는 모은 것을 바로 보낸다(화면을 떠날 때). 모은 것이 없으면 보내지 않는다
    await h.q.flush();
    assert.equal(h.sent.length, 2);
    assert.deepEqual(counters(h.sent[1].body), { search_suggest_shown_total: 2 });
    await h.q.flush();
    assert.equal(h.sent.length, 2);

    // 보내기가 실패해도 부르는 쪽으로 오류가 새지 않는다
    const failing = createSearchQuality({ send: async () => Promise.reject(new Error('끊김')), now: () => T0 });
    failing.resultsShown(true, queries[0]);
    await failing.flush();
  } finally {
    globalThis.location = saved.location;
    globalThis.document = saved.document;
  }
});

test('검색 품질의 바로 다시 찾음은 결과를 보인 뒤 누르지 않고 10초 안에 다른 검색어로 다시 찾았을 때만 센다 [ASVS v5.0.0-14.2.3](R165-5)', async () => {
  // 정본 10초 [가정](search.md §11 search_requery_total). 코드 상수를 가져오지 않는다
  const REQUERY_MS = 10_000;
  const queries = ['루멘', 'lumen 콘서트', 'fnaps', '010-1234-5678', 'a@b.kr', '라이온킹'];
  const run = async (steps) => {
    const h = harness();
    for (const [ms, fn] of steps) {
      h.at(ms);
      fn(h.q);
    }
    await h.q.flush();
    const body = h.sent.map((x) => x.body).join(String.fromCharCode(10));
    for (const s of [...queries, ...queries.map(encodeURIComponent)]) assert.equal(body.includes(s), false, `본문에 ${s}가 없다`);
    // 보낸 것이 없거나 그 칸이 없으면 0으로 본다
    return h.sent.reduce((n, x) => n + (counters(x.body).search_requery_total ?? 0), 0);
  };
  // 9,999ms에 다른 검색어 → 1
  assert.equal(await run([[0, (q) => q.resultsShown(false, queries[0])], [REQUERY_MS - 1, (q) => q.resultsShown(false, queries[1])]]), 1);
  // 10,000ms → 0
  assert.equal(await run([[0, (q) => q.resultsShown(false, queries[0])], [REQUERY_MS, (q) => q.resultsShown(false, queries[1])]]), 0);
  // 사이에 결과를 눌렀으면 → 0
  assert.equal(await run([[0, (q) => q.resultsShown(false, queries[0])], [1_000, (q) => q.resultClick(1)], [2_000, (q) => q.resultsShown(false, queries[1])]]), 0);
  // 같은 검색어(쪽·필터·정렬만 바꾼 결과) → 0
  assert.equal(await run([[0, (q) => q.resultsShown(false, queries[2])], [3_000, (q) => q.resultsShown(true, queries[2])]]), 0);
  // 검색어 여러 꼴로 차례로 바꿔도 본문에는 검색어가 없다(셋 다 10초 안이라 2)
  assert.equal(await run([[0, (q) => q.resultsShown(false, queries[3])], [2_000, (q) => q.resultsShown(true, queries[4])], [4_000, (q) => q.resultsShown(false, queries[5])]]), 2);
});

test('검색 품질 사건은 sendBatch로 쿠키·리퍼러 없이 보내고 화면을 숨길 때와 떠날 때 저마다 보낸다 [ASVS v5.0.0-14.2.3] [ASVS v5.0.0-3.4.5](W7L2-W2, W7L2-S5)', async () => {
  // 브라우저 대역: window·document(사건 대상), fetch·sendBeacon 가짜
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, navigator: globalThis.navigator, Request: globalThis.Request };
  const install = (keepalive) => {
    const calls = [];
    const beacons = [];
    const doc = new EventTarget();
    let state = 'visible';
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => state });
    globalThis.window = new EventTarget();
    globalThis.document = doc;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon: (url, body) => (beacons.push({ url, body }), true) } });
    if (!keepalive) globalThis.Request = function Request() {};
    return { calls, beacons, hide: () => ((state = 'hidden'), doc.dispatchEvent(new Event('visibilitychange'))), leave: () => globalThis.window.dispatchEvent(new Event('pagehide')) };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    // keepalive를 아는 브라우저: fetch(credentials omit, keepalive, referrerPolicy no-referrer)
    const b = install(true);
    const m = await import(`./search-quality-client.ts?w7l2=${Date.now()}`);
    const q = m.searchQuality();
    q.resultsShown(false, '루멘');
    b.hide();
    await settle();
    assert.equal(b.calls.length, 1, '숨길 때 보낸다');
    q.suggestShown();
    b.leave();
    await settle();
    assert.equal(b.calls.length, 2, '떠날 때 보낸다');
    for (const c of b.calls) {
      assert.equal(new URL(c.url, 'https://peaket.example').pathname, '/_t/rum');
      assert.equal(c.init.credentials, 'omit');
      assert.equal(c.init.keepalive, true);
      assert.equal(c.init.referrerPolicy, 'no-referrer');
      assert.equal(String(c.init.body).includes('루멘'), false);
      assert.equal(String(c.init.body).includes('q='), false);
    }
    // keepalive를 모르는 브라우저: sendBeacon
    const k = install(false);
    const m2 = await import(`./search-quality-client.ts?w7l2b=${Date.now()}`);
    const q2 = m2.searchQuality();
    q2.resultsShown(true, '라이온킹');
    k.hide();
    await settle();
    assert.equal(k.calls.length, 0);
    assert.equal(k.beacons.length, 1);
    assert.equal(new URL(k.beacons[0].url, 'https://peaket.example').pathname, '/_t/rum');
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.fetch = saved.fetch;
    globalThis.Request = saved.Request;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: saved.navigator });
  }
});
