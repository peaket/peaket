// 게이트웨이 차단 상한·검색 IP 한도 측정 시나리오(V-T43, SR-T13 ②, 묶음 BAT-056). 실행: node loadtest/run.mjs gw sweep|capacity|ip-limit …(loadtest/README.md)
// 클러스터 안 발생기 파드에서 게이트웨이 프록시 Service로 바로 보낸다(포트 전달·포트 매핑을 거치지 않는다, docs/infra.md §4.1 '측정(V-T43)').
// 입력 /work/gw.json(loadtest/runner/gw.mjs scenarioInput): 호스트 이름 → 프록시 Service 주소(k6 hosts), 흐름마다 도착률·경로·지연·IP 꼴.
// 흐름마다 예열(phase:warm)·본구간(phase:main) 두 구간(constant-arrival-rate)이고, 꼬리표 stream으로 나눠 센다. 판정은 실행 도구가 한다(gw.mjs).
// 남기는 지표(본구간 꼬리표 지표를 요약에 남기려고 thresholds를 둔다. 판정 기준이 아니다):
//   gw_reqs{stream,cls}             상태별 수(cls: 2xx·503·429·other. 연결 실패·시간 넘김은 other)
//   gw_dur_2xx·gw_dur_503·gw_dur_429{stream}   응답 시간(ms, timings.duration)
//   gw_over_fast{stream}            게이트웨이가 낼 상태(503·429) 가운데 FAST_FAIL_MS를 넘은 수
//   gw_ra{stream,cls,ra}            그 상태 응답의 Retry-After(ra: num 숫자, missing 없음, nonnum 숫자 아님)
//   gw_problem{stream,cls,ok}       그 상태 응답의 Problem 본문이 정본 모양인가(ok: yes·no)
//   콘솔 { kind: 'gw_ra', cls, value }   Retry-After 값마다 가상 사용자당 한 번(값 목록)
// 환경 값: RATE(쓰지 않음, 기록용) WARM_S MAIN_S GW_FILE(기본 /work/gw.json) EVENT_ID (+ common.js의 OUT_DIR USERS_FILE RUN_TAG)
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { envInt, envStr, emit, markScenarios, user, userCount, writeSummary } from './common.js';
import { phaseThresholds } from '../lib/model.mjs';

export { markEnd, markStart } from './common.js';

const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const GW = JSON.parse(open(envStr('GW_FILE', '/work/gw.json')));
const FAST_FAIL_MS = GW.fastFailMs;
const STATUS_CLASSES = ['2xx', '503', '429', 'other'];

const reqs = new Counter('gw_reqs');
const dur = { '2xx': new Trend('gw_dur_2xx', true), 503: new Trend('gw_dur_503', true), 429: new Trend('gw_dur_429', true) };
const overFast = new Counter('gw_over_fast');
const ra = new Counter('gw_ra');
const problem = new Counter('gw_problem');

function scenarios() {
  const out = {};
  for (const s of GW.streams) {
    const phase = (p, start, d) => ({
      executor: 'constant-arrival-rate',
      rate: s.rate,
      timeUnit: '1s',
      duration: `${d}s`,
      startTime: `${start}s`,
      preAllocatedVUs: s.preVUs,
      maxVUs: s.maxVUs,
      exec: 'hit',
      tags: { phase: p, stream: s.name },
    });
    out[`${s.name}_warm`] = phase('warm', 0, WARM_S);
    out[`${s.name}_main`] = phase('main', WARM_S, MAIN_S);
  }
  return out;
}

function thresholds() {
  const t = { ...phaseThresholds([]) };
  for (const s of GW.streams) {
    const sel = (extra) => `{phase:main,stream:${s.name}${extra}}`;
    for (const c of STATUS_CLASSES) t[`gw_reqs${sel(`,cls:${c}`)}`] = ['count>=0'];
    for (const c of ['2xx', '503', '429']) t[`gw_dur_${c}${sel('')}`] = ['max>=0'];
    t[`gw_over_fast${sel('')}`] = ['count>=0'];
    for (const c of ['503', '429']) {
      for (const k of ['num', 'missing', 'nonnum']) t[`gw_ra${sel(`,cls:${c},ra:${k}`)}`] = ['count>=0'];
      for (const k of ['yes', 'no']) t[`gw_problem${sel(`,cls:${c},ok:${k}`)}`] = ['count>=0'];
    }
    t[`dropped_iterations{scenario:${s.name}_main}`] = ['count>=0'];
  }
  return t;
}

const sc = scenarios();
export const options = {
  scenarios: { ...sc, ...markScenarios(WARM_S, WARM_S + MAIN_S) },
  hosts: GW.hosts,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  thresholds: thresholds(),
  // 게이트웨이 TLS는 SNI(호스트 이름)로 맞는 인증서를 고른다. 주소는 hosts가 프록시 Service로 바꾼다
  tlsVersion: { min: 'tls1.2', max: 'tls1.3' },
};

const STREAMS = Object.fromEntries(GW.streams.map((s) => [s.name, s]));

export function setup() {
  if (GW.streams.some((s) => s.token) && userCount() < 1) throw new Error('토큰 파일이 비었다');
}

/** 지연(ms): fixed는 그 값, normal은 정본 분포에서 고른다 */
function delayOf(d) {
  if (d.kind === 'fixed') return d.ms;
  const total = GW.normalDelay.reduce((a, x) => a + x.weight, 0);
  let r = Math.random() * total;
  for (const x of GW.normalDelay) {
    r -= x.weight;
    if (r < 0) return x.ms;
  }
  return GW.normalDelay[GW.normalDelay.length - 1].ms;
}

/** 흐름의 IP 꼴로 이번 요청의 클라이언트 IP(X-Forwarded-For) */
function ipOf(s, i, uIp) {
  if (s.ip.kind === 'single') return s.ip.addr;
  if (s.ip.kind === 'user') return uIp;
  const n = i % s.ip.count;
  // pool: 198.18.0.0/15(시험망)에서 번호대로, v6: 한 /64(2001:db8:0:1::/64) 안 주소
  if (s.ip.kind === 'pool') return `198.${18 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}`;
  return `2001:db8:0:1::${(n + 1).toString(16)}`;
}

const seenRa = new Set();

/** 응답 본문이 정본 Problem 모양(type about:blank, title, status, 칸 셋)이고 형식이 application/problem+json인가 */
function problemOk(r, status, title) {
  const ct = String(r.headers['Content-Type'] ?? '');
  if (!ct.startsWith('application/problem+json')) return false;
  let b;
  try {
    b = JSON.parse(r.body);
  } catch {
    return false;
  }
  return b !== null && typeof b === 'object' && Object.keys(b).length === 3 && b.type === 'about:blank' && b.title === title && b.status === status;
}

export function hit() {
  const s = STREAMS[exec.scenario.name.replace(/_(warm|main)$/, '')];
  const i = exec.scenario.iterationInTest;
  const headers = { 'x-peaket-origin-verify': GW.originVerify, 'x-e2e-delay-ms': String(delayOf(s.delay)) };
  let uIp;
  if (s.token) {
    const u = user(i % userCount());
    headers.authorization = `Bearer ${u.token}`;
    uIp = u.ip;
  }
  headers['x-forwarded-for'] = ipOf(s, i, uIp ?? '198.18.0.1');
  let body = null;
  if (s.method !== 'GET') {
    headers.origin = GW.origin;
    headers['content-type'] = 'application/json';
    body = '{}';
  }
  const r = http.request(s.method, `https://${s.host}${s.path}`, body, { headers, timeout: '15s', responseCallback: http.expectedStatuses({ min: 200, max: 299 }) });
  const cls = r.status >= 200 && r.status < 300 ? '2xx' : r.status === 503 ? '503' : r.status === 429 ? '429' : 'other';
  reqs.add(1, { cls });
  if (dur[cls]) dur[cls].add(r.timings.duration);
  if (r.status === s.expect.status) {
    if (r.timings.duration > FAST_FAIL_MS) overFast.add(1);
    const v = r.headers['Retry-After'];
    const kind = v === undefined || v === '' ? 'missing' : /^\d+$/.test(String(v)) ? 'num' : 'nonnum';
    ra.add(1, { cls, ra: kind });
    if (v !== undefined && !seenRa.has(`${cls}:${v}`)) {
      seenRa.add(`${cls}:${v}`);
      emit({ kind: 'gw_ra', cls, value: String(v) });
    }
    problem.add(1, { cls, ok: problemOk(r, s.expect.status, s.expect.title) ? 'yes' : 'no' });
  }
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
