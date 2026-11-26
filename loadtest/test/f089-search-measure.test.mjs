// F-08-9 검색 측정 준비 시험(F089-5~8): SR-T13 ①·NFR-028 판정.
// 정본: docs/features/search.md SR-T13(307행)·§8(255행)·§10(269행), docs/planning/02-requirements.md NFR-028(189행),
// 계획 docs/review/plans/F-08-9.md 6.4·7.2. 단언 값은 정본에서 가져와 이 파일에 적는다(구현 상수를 가져오지 않는다).
// Docker·kind·k6를 쓰지 않는다. 실행: node --test loadtest/test/f089-search-measure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 새 모듈을 읽고 공개 이름이 있는지 먼저 본다. 기준 트리에서는 모듈이 없어 여기서 실패한다(계획 9절). */
async function search() {
  let m;
  try {
    m = await import('../runner/search-measure.mjs');
  } catch (e) {
    assert.fail(`runner/search-measure.mjs를 읽지 못했다: ${e?.message ?? e}`);
  }
  for (const name of [
    'parseSearchArgs', 'parseK6Csv', 'judgeSearchRep', 'judgeSearchRun',
    'parseGoldenReport', 'nfr028Verdict', 'parsePromSeries',
  ]) assert.equal(typeof m[name], 'function', `${name} 공개 함수가 없다`);
  return m;
}

/** NFR-028 [가정]: 자동완성 p95 50ms, 검색 p95 300ms, 1위 90%, 3위 안 98%, 사전 판 지연 60초. */
const SUGGEST_P95_MS = 50;
const SEARCH_P95_MS = 300;
const TOP1 = 0.9;
const TOP3 = 0.98;
const VERSION_LAG_SECONDS = 60;
/** SR-T13 ① [가정]: 검색 503 1% 이하, 그 밖의 5xx 0, search_pool_waiting 0이 아닌 표본 5% 이하. */
const CASES = 100;

const usage = (fn) =>
  assert.throws(fn, (e) => e?.name === 'UsageError', 'UsageError로 거부해야 한다');

const cell = ({ ok = 100, unavailable = 0, other5xx = 0, p95 = 50 } = {}) => ({
  count: ok + unavailable + other5xx,
  ok,
  unavailable,
  other5xx,
  p95,
});

/** k6 CSV 표본 하나(구간·경로마다 200 응답) */
function samples(over = {}) {
  return {
    requests: 400,
    dropped: 0,
    phases: {
      crowd: { search: cell({ p95: 100 }), suggest: cell({ p95: 20 }) },
      random: { search: cell({ p95: 100 }), suggest: cell({ p95: 20 }) },
    },
    ...over,
  };
}

/** 1초마다 읽은 게이지 값: 0이 아닌 표본 비율을 만든다 */
const pool = (nonZero, total) => Array.from({ length: total }, (_, i) => (i < nonZero ? 1 : 0));

/** k6 --out csv 꼴(머리 칸 이름으로 읽는다). 표본은 작게 만들어 p95를 손으로 셀 수 있게 한다 */
function k6Csv({ firstSearchStatus = 200, dropped = 0 } = {}) {
  const header = [
    'metric_name', 'timestamp', 'metric_value', 'check', 'error', 'error_code', 'expected_response',
    'group', 'scenario', 'proto', 'subproto', 'status', 'method', 'name', 'url', 'route', 'phase', 'len',
  ];
  const rows = [];
  const add = (o) => rows.push({ ...o, timestamp: '1700000000', check: 'false', expected_response: 'true', proto: 'http', subproto: 'http', method: 'GET', name: 'http://x', url: 'http://x' });
  const durations = (route, phase, statuses) => {
    for (const status of statuses) add({ metric_name: 'http_req_duration', metric_value: '10', status: String(status), route, phase, len: 'n' });
  };
  durations('search', 'crowd', Array.from({ length: 100 }, () => 200));
  durations('search', 'crowd', [firstSearchStatus]);
  durations('suggest', 'crowd', Array.from({ length: 50 }, () => 200));
  durations('search', 'random', Array.from({ length: 100 }, () => 200));
  durations('suggest', 'random', Array.from({ length: 50 }, () => 200));
  add({ metric_name: 'dropped_iterations', metric_value: String(dropped), status: '', route: '', phase: '', len: '' });
  return [header.join(','), ...rows.map((r) => header.map((h) => r[h] ?? '').join(','))].join('\n');
}

test('F089-5 ① search 인자는 크기 1만·2만과 회차 1~3을 읽고 범위 밖을 거부한다', async () => {
  const { parseSearchArgs } = await search();
  const a = parseSearchArgs([
    '--size', '10000',
    '--reps', '3',
    '--out', '.cache/peaket-f09/search/10k',
    '--record',
    '--run-id', '2026-11-27-search-10k-f089',
    '--prom-url', 'http://127.0.0.1:9090',
  ]);
  assert.equal(a.size, 10000);
  assert.equal(a.reps, 3);
  assert.equal(a.record, true);
  assert.equal(a.runId, '2026-11-27-search-10k-f089');

  usage(() => parseSearchArgs(['--size', '9999', '--reps', '3']));
  usage(() => parseSearchArgs(['--size', '20001', '--reps', '3']));
  usage(() => parseSearchArgs(['--size', '10000', '--reps', '0']));
  usage(() => parseSearchArgs(['--size', '10000', '--reps', '4']));
  usage(() => parseSearchArgs(['--size', '10000', '--reps', '3', '--wat', 'x']));
});

test('F089-5 ② parseK6Csv는 꼬리표별 요청·200·503·그 밖의 5xx·p95·놓친 반복을 센다', async () => {
  const { parseK6Csv } = await search();
  const s = parseK6Csv(k6Csv());
  assert.equal(s.dropped, 0);
  assert.equal(s.phases.crowd.search.count, 101);
  assert.equal(s.phases.crowd.search.ok, 100);
  assert.equal(s.phases.crowd.search.unavailable, 1);
  assert.equal(s.phases.crowd.search.other5xx, 0);
  assert.equal(s.phases.crowd.search.p95, 10);
  assert.equal(s.phases.crowd.suggest.count, 50);
  assert.equal(s.phases.random.search.count, 100);
  assert.equal(s.phases.random.suggest.count, 50);

  const o = parseK6Csv(k6Csv({ firstSearchStatus: 500 }));
  assert.equal(o.phases.crowd.search.other5xx, 1);

  const dropped = parseK6Csv(k6Csv({ dropped: 1 }));
  assert.equal(dropped.dropped, 1);
});

test('F089-6 ① judgeSearchRep는 빈 결과를 무효로, p95·503·5xx·대기 경계를 통과/실패로 가른다', async () => {
  const { judgeSearchRep } = await search();
  const ok = judgeSearchRep({ samples: samples(), poolWaiting: pool(1, 20) });
  assert.equal(ok.valid, true);
  assert.equal(ok.verdict, 'pass');

  const withCell = (phase, route, over) => ({
    samples: samples({ phases: { ...samples().phases, [phase]: { ...samples().phases[phase], [route]: cell(over) } } }),
    poolWaiting: pool(0, 20),
  });
  // 경계 양쪽: p95
  assert.equal(judgeSearchRep(withCell('crowd', 'search', { p95: SEARCH_P95_MS })).verdict, 'pass');
  assert.equal(judgeSearchRep(withCell('crowd', 'search', { p95: SEARCH_P95_MS + 0.1 })).verdict, 'fail');
  assert.equal(judgeSearchRep(withCell('crowd', 'suggest', { p95: SUGGEST_P95_MS })).verdict, 'pass');
  assert.equal(judgeSearchRep(withCell('crowd', 'suggest', { p95: SUGGEST_P95_MS + 0.1 })).verdict, 'fail');

  // 경계 양쪽: 503 1% (100건 가운데 1건 통과, 2건 실패)
  assert.equal(judgeSearchRep(withCell('crowd', 'search', { ok: 99, unavailable: 1 })).verdict, 'pass');
  assert.equal(judgeSearchRep(withCell('crowd', 'search', { ok: 98, unavailable: 2 })).verdict, 'fail');

  // 그 밖의 5xx는 1건이라도 실패
  assert.equal(judgeSearchRep(withCell('crowd', 'search', { other5xx: 1 })).verdict, 'fail');

  // 대기 비율 5% 정각은 통과, 넘으면 실패
  assert.equal(judgeSearchRep({ samples: samples(), poolWaiting: pool(1, 20) }).verdict, 'pass');
  assert.equal(judgeSearchRep({ samples: samples(), poolWaiting: pool(2, 20) }).verdict, 'fail');

  // 놓친 반복·구간 요청 0·게이지 표본 0은 무효(통과가 아니다)
  assert.equal(judgeSearchRep({ samples: samples({ dropped: 1 }), poolWaiting: pool(0, 20) }).verdict, 'invalid');
  assert.equal(judgeSearchRep({ samples: samples({ phases: { ...samples().phases, random: { ...samples().phases.random, suggest: cell({ ok: 0 }) } } }), poolWaiting: pool(0, 20) }).verdict, 'invalid');
  assert.equal(judgeSearchRep({ samples: samples(), poolWaiting: [] }).verdict, 'invalid');
  assert.equal(judgeSearchRep({ samples: null, poolWaiting: pool(0, 20) }).verdict, 'invalid');
});

test('F089-6 ② judgeSearchRun은 유효 회차 2회 미만을 무효, 유효 회차의 실패를 실패로 낸다', async () => {
  const { judgeSearchRep, judgeSearchRun } = await search();
  const pass = judgeSearchRep({ samples: samples(), poolWaiting: pool(0, 20) });
  const fail = judgeSearchRep({ samples: samples({ phases: { ...samples().phases, crowd: { ...samples().phases.crowd, search: cell({ p95: 400 }) } } }), poolWaiting: pool(0, 20) });
  const invalid = judgeSearchRep({ samples: samples({ dropped: 1 }), poolWaiting: pool(0, 20) });

  assert.equal(judgeSearchRun([pass, pass, pass]).verdict, 'pass');
  assert.equal(judgeSearchRun([pass, pass, invalid]).verdict, 'pass');
  assert.equal(judgeSearchRun([pass, pass, invalid]).validReps, 2);
  assert.equal(judgeSearchRun([pass, invalid, invalid]).verdict, 'invalid');
  assert.equal(judgeSearchRun([pass, pass, fail]).verdict, 'fail');
});

test('F089-7 ① parseGoldenReport는 경우 수·목표 값을 보고, 모자라거나 다르면 무효다', async () => {
  const { parseGoldenReport } = await search();
  const good = parseGoldenReport({ cases: CASES, top1: TOP1, top3: TOP3, target: { top1: TOP1, top3: TOP3 }, misses: [] });
  assert.equal(good.valid, true);
  assert.equal(good.cases, CASES);
  assert.equal(good.rates.top1, TOP1);
  assert.equal(good.rates.top3, TOP3);

  assert.equal(parseGoldenReport({ cases: CASES - 1, top1: TOP1, top3: TOP3, target: { top1: TOP1, top3: TOP3 }, misses: [] }).valid, false);
  assert.equal(parseGoldenReport({ cases: CASES, top1: TOP1, top3: TOP3, target: { top1: 0.8, top3: TOP3 }, misses: [] }).valid, false);
  // 보고서 모양은 맞지만 정답률이 목표 아래인 것은 유효한 보고서다(판정은 nfr028Verdict가 한다)
  assert.equal(parseGoldenReport({ cases: CASES, top1: 0.89, top3: TOP3, target: { top1: TOP1, top3: TOP3 }, misses: [] }).valid, true);
});

test('F089-7 ② nfr028Verdict는 다섯 부분의 빠짐을 미측정으로 두고, 모두 통과할 때만 통과한다', async () => {
  const { parseGoldenReport, nfr028Verdict } = await search();
  const goodGolden = parseGoldenReport({ cases: CASES, top1: TOP1, top3: TOP3, target: { top1: TOP1, top3: TOP3 }, misses: [] });
  const all = nfr028Verdict({
    search: { suggestP95: SUGGEST_P95_MS, searchP95: SEARCH_P95_MS },
    golden: goodGolden,
    versionLag: VERSION_LAG_SECONDS,
  });
  assert.equal(all.verdict, 'pass');
  assert.deepEqual(all.parts, { suggest: 'pass', search: 'pass', top1: 'pass', top3: 'pass', versionLag: 'pass' });

  const missingSearch = nfr028Verdict({ search: { suggestP95: SUGGEST_P95_MS, searchP95: null }, golden: goodGolden, versionLag: VERSION_LAG_SECONDS });
  assert.equal(missingSearch.parts.search, '미측정');
  assert.notEqual(missingSearch.verdict, 'pass');

  const lowTop1 = nfr028Verdict({
    search: { suggestP95: SUGGEST_P95_MS, searchP95: SEARCH_P95_MS },
    golden: parseGoldenReport({ cases: CASES, top1: 0.89, top3: TOP3, target: { top1: TOP1, top3: TOP3 }, misses: [] }),
    versionLag: VERSION_LAG_SECONDS,
  });
  assert.equal(lowTop1.parts.top1, 'fail');
  assert.equal(lowTop1.verdict, 'fail');

  const late = nfr028Verdict({
    search: { suggestP95: SUGGEST_P95_MS, searchP95: SEARCH_P95_MS },
    golden: goodGolden,
    versionLag: VERSION_LAG_SECONDS + 1,
  });
  assert.equal(late.parts.versionLag, 'fail');

  const noLag = nfr028Verdict({ search: { suggestP95: SUGGEST_P95_MS, searchP95: SEARCH_P95_MS }, golden: goodGolden, versionLag: null });
  assert.equal(noLag.parts.versionLag, '미측정');

  const badGolden = nfr028Verdict({ search: { suggestP95: SUGGEST_P95_MS, searchP95: SEARCH_P95_MS }, golden: { valid: false }, versionLag: VERSION_LAG_SECONDS });
  assert.equal(badGolden.parts.top1, '미측정');
  assert.equal(badGolden.parts.top3, '미측정');
});

test('F089-8 ① parsePromSeries는 빈 응답·NaN을 missing으로 남기고 0으로 바꾸지 않는다', async () => {
  const { parsePromSeries } = await search();
  const vector = (value) => ({ status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1700000000, value] }] } });
  const ok = parsePromSeries(vector('0.1'), 'search_pool_waiting');
  assert.deepEqual(ok.values, [0.1]);
  assert.deepEqual(ok.missing, []);

  const empty = parsePromSeries({ status: 'success', data: { resultType: 'vector', result: [] } }, 'search_pool_waiting');
  assert.deepEqual(empty.values, []);
  assert.ok(empty.missing.includes('search_pool_waiting'));

  const nan = parsePromSeries(vector('NaN'), 'search_dictionary_version_lag_seconds');
  assert.deepEqual(nan.values, []);
  assert.ok(nan.missing.includes('search_dictionary_version_lag_seconds'));
});
