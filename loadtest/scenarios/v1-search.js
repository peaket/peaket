// 검색 원본 측정(SR-T13 ①, BAT-165 M-1, docs/features/search.md §8·§7.2, NFR-028 docs/planning/02-requirements.md:189, 계획 docs/review/plans/BAT-165.md §8 M-1).
// 공연 1만·2만 [가정]을 채운 DB(services/core-svc/scripts/fill-search.mjs) 위의 core-svc 원본에 바로 보낸다(CDN·게이트웨이 없음). 두 구간:
// - crowd: 오픈 직전 몰림. 자동완성 키 50개 [가정]를 되풀이하고 그 검색 결과를 본다(CDN을 비켜 가지 않는 꼴이지만 원본 부담을 본다)
// - random: 캐시를 비켜 가는 무작위 입력(한 글자·두 글자·여러 글자 나눠 꼬리표, 리뷰 R165-11). 모두 원본에 온다
// 꼬리표: route(search·suggest), phase(crowd·random), len(1·2·n). 503(검색 전용 연결 묶음 포화)은 search_unavailable로 센다.
// 결과가 비거나(요청 0건) 모든 요청이 실패하면 측정이 통과로 새지 않게 끝에서 실패로 끝낸다(handleSummary, exec.test.abort).
// 실행 예(웨이브 끝 게이트, 측정 중 다른 시험은 돌리지 않는다):
//   k6 run -e BASE=http://127.0.0.1:3001 -e CROWD_RATE=200 -e RANDOM_RATE=200 -e DURATION_S=120 loadtest/scenarios/v1-search.js
// 환경 값: BASE(core-svc 주소) CROWD_RATE RANDOM_RATE(초당 반복) DURATION_S PRE_VUS MAX_VUS
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const envInt = (name, def) => {
  const v = __ENV[name];
  if (v === undefined || v === '') {
    if (def === undefined) throw new Error(`${name}이 없다`);
    return def;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}은 0 이상의 정수여야 한다: ${v}`);
  return n;
};

const BASE = __ENV.BASE || 'http://127.0.0.1:3001';
const CROWD_RATE = envInt('CROWD_RATE', 100);
const RANDOM_RATE = envInt('RANDOM_RATE', 100);
const DURATION_S = envInt('DURATION_S', 120);
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 400);

/** 몰림 키 50개 [가정](채우기 스크립트의 이름 조각과 같은 말) */
const CROWD_KEYS = (() => {
  const words = ['루멘', '오로라', '은하', '별빛', '하늘', '바다', '노을', '새벽', '달빛', '봄날'];
  const tails = ['', ' 콘서트', ' 투어', ' 뮤지컬', ' 팬미팅'];
  return words.flatMap((w) => tails.map((t) => `${w}${t}`)).slice(0, 50);
})();
const SYLLABLES = '가나다라마바사아자차카타파하루멘오로은별빛늘노을새벽달봄콘서투어뮤지컬팬미팅';
const ROMAN = 'abcdefghijklmnopqrstuvwxyz';

export const searchUnavailable = new Counter('search_unavailable');
export const searchOk = new Counter('search_ok');
/** 원본 소요(ms). http_req_duration과 같지만 len 꼬리표로 나눠 본다 */
export const originMs = new Trend('search_origin_ms', true);

export const options = {
  scenarios: {
    crowd: { executor: 'constant-arrival-rate', rate: CROWD_RATE, timeUnit: '1s', duration: `${DURATION_S}s`, preAllocatedVUs: PRE_VUS, maxVUs: MAX_VUS, exec: 'crowd', tags: { phase: 'crowd' } },
    random: { executor: 'constant-arrival-rate', rate: RANDOM_RATE, timeUnit: '1s', duration: `${DURATION_S}s`, preAllocatedVUs: PRE_VUS, maxVUs: MAX_VUS, exec: 'random', tags: { phase: 'random' } },
  },
  // NFR-028(원본 p95 300ms [가정], search.md:242). 기준은 웨이브 끝 기록에 적고 여기서는 값을 내기만 한다(꼬리표별 p95가 요약에 남게)
  thresholds: {
    'http_req_duration{route:search}': ['p(95)>=0'],
    'http_req_duration{route:suggest}': ['p(95)>=0'],
    'search_origin_ms{len:1}': ['p(95)>=0'],
    'search_origin_ms{len:2}': ['p(95)>=0'],
    'search_origin_ms{len:n}': ['p(95)>=0'],
    search_unavailable: ['count>=0'],
    search_ok: ['count>0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

const lenTag = (q) => {
  const n = [...q.replace(/\s/g, '')].length;
  return n <= 1 ? '1' : n === 2 ? '2' : 'n';
};

function get(route, path, q, phase) {
  const r = http.get(`${BASE}${path}?q=${encodeURIComponent(q)}`, { tags: { route, phase, len: lenTag(q) } });
  if (r.status === 503) searchUnavailable.add(1, { route, phase });
  else if (r.status === 200) searchOk.add(1, { route, phase });
  originMs.add(r.timings.duration, { route, phase, len: lenTag(q) });
  check(r, { '200 또는 503': (x) => x.status === 200 || x.status === 503 });
  return r;
}

export function crowd() {
  const key = CROWD_KEYS[Math.floor(Math.random() * CROWD_KEYS.length)];
  get('suggest', '/v1/search/suggestions', key, 'crowd');
  get('search', '/v1/search', key, 'crowd');
}

export function random() {
  const roman = Math.random() < 0.3;
  const pool = roman ? ROMAN : SYLLABLES;
  // 한 글자 30%·두 글자 30%·세~여섯 글자 40%
  const p = Math.random();
  const n = p < 0.3 ? 1 : p < 0.6 ? 2 : 3 + Math.floor(Math.random() * 4);
  let q = '';
  for (let i = 0; i < n; i++) q += pool[Math.floor(Math.random() * pool.length)];
  // 로마자 한 글자는 자동완성이 받지 않으므로(400) 검색 결과만 본다
  if (!(roman && n < 2)) get('suggest', '/v1/search/suggestions', q, 'random');
  get('search', '/v1/search', q, 'random');
}

/** 요청이 0건이거나 성공이 0건이면 측정을 실패로 끝낸다(SKIPPED·0건이 통과로 새지 않게) */
export function handleSummary(data) {
  const reqs = data.metrics.http_reqs?.values?.count ?? 0;
  const ok = data.metrics.search_ok?.values?.count ?? 0;
  const verdict = reqs > 0 && ok > 0 ? 'measured' : 'empty';
  const out = { verdict, requests: reqs, ok, unavailable: data.metrics.search_unavailable?.values?.count ?? 0, metrics: data.metrics };
  if (verdict === 'empty') console.error('v1-search: 요청이나 성공이 0건이다. 측정을 실패로 적는다');
  return { stdout: `${JSON.stringify({ verdict, requests: reqs, ok, unavailable: out.unavailable })}\n`, 'v1-search-summary.json': JSON.stringify(out, null, 1) };
}
