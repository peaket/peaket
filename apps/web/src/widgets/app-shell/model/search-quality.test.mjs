// 검색 품질 사건 수 시험(BAT-165 웨이브 7 T-22, catalog-review 14.2.3).
// 정본: docs/features/search.md §11(279~284줄: 검색어 없이 사건 수만 같은 출처 수집 경로 `/_t/rum`으로 60초 [가정]마다 묶어 보낸다,
// 라벨은 zero·kind(3)·position(1~8)·position_bucket(1~3, 4~10, 11~20)), catalog-review.md:157(14.2.3).
// 시험이 정한 모양(구현이 다르면 계획의 '시험 이의'): 사건을 부를 때 지난 보냄(처음엔 만든 때)에서 60초가 지났으면 그 사건까지 모은 수를 한 번에 보낸다.
// flush()는 모은 것이 있으면 바로 보낸다. 본문은 JSON {"counters":[{"name","labels","value"}]}이고 라벨 값은 글이다(버킷 '1-3'·'4-10'·'11-20').
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

const counters = (body) => {
  const parsed = JSON.parse(body);
  const out = {};
  for (const c of parsed.counters) {
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
    h.q.resultsShown(false);
    h.q.resultsShown(true);
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
    h.q.requery();
    assert.equal(h.sent.length, 0);
    // 60초: 그때까지 모은 것을 한 번에 보낸다
    h.at(WINDOW_MS);
    h.q.requery();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].path, '/_t/rum');
    assert.deepEqual(counters(h.sent[0].body), {
      'search_results_shown_total{zero=false}': 1,
      'search_results_shown_total{zero=true}': 1,
      search_suggest_shown_total: 1,
      'search_suggest_selected_total{kind=ARTIST,position=2}': 1,
      'search_suggest_selected_total{kind=PRODUCTION,position=8}': 1,
      'search_result_click_total{position_bucket=1-3}': 1,
      'search_result_click_total{position_bucket=4-10}': 2,
      'search_result_click_total{position_bucket=11-20}': 2,
      search_requery_total: 2,
    });
    const body = h.sent[0].body;
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
    failing.resultsShown(true);
    await failing.flush();
  } finally {
    globalThis.location = saved.location;
    globalThis.document = saved.document;
  }
});
