// V-T41 k6 시나리오(docs/verification.md V-T41). 오픈 모델(constant-arrival-rate)로 예열 뒤 본구간을 재고, 장부 요약에는 본구간만 넣는다.
// 닫힌 모델(MODE=closed, constant-vus)은 최대 처리량을 잴 때만 쓴다(지연은 참고값).
// 환경 값: BASE(http://vt41:8080) ROUTE(hold|entry) RATE DURATION WARMUP MODE(open|closed) VUS NAME
import http from 'k6/http';
import { check } from 'k6';
import { handleSummary as ledger } from '/repo/tools/perf-ledger/k6-summary.js';

const BASE = __ENV.BASE || 'http://vt41:8080';
// 앱 관리 포트. 본구간 시작에 통계를 비우고 끝에 뜬다(k6가 직접 해 본구간과 같은 창이 된다, 코드 리뷰 2026-11-01)
const ADMIN = __ENV.ADMIN || 'http://vt41:9465';
const WARM_S = Number(__ENV.WARM_S || 15);
const DUR_S = Number(__ENV.DUR_S || 60);
const ROUTE = __ENV.ROUTE || 'hold';
const RATE = Number(__ENV.RATE || 1000);
const DURATION = __ENV.DURATION || '60s';
const WARMUP = __ENV.WARMUP || '15s';
const MODE = __ENV.MODE || 'open';
const VUS = Number(__ENV.VUS || 64);
const req = {
  hold: { path: '/v1/events/e1/holds', body: '{"seatIds":["A-1","A-2"]}', headers: { 'content-type': 'application/json' }, status: 201 },
  entry: { path: '/v1/queues/e1/entries', body: '{"preverifyToken":"t","entryRequestId":"0190f3a1-7c2e-4a00-8000-000000000002"}', headers: { 'content-type': 'text/plain' }, status: 202 },
}[ROUTE];

// 가상 사용자를 넉넉히 미리 만든다: 모자라면 k6가 그 순간 요청을 보내지 못하고(dropped_iterations) 측정이 무효가 된다(2026-11-01 첫 회차에서 겪음)
const PREVUS = Number(__ENV.PREVUS || 2000);
const open = (startTime, duration, phase) => ({ executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration, startTime, preAllocatedVUs: PREVUS, maxVUs: PREVUS * 3, exec: 'call', tags: { phase } });
export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  // 닫힌 모델도 예열을 따로 둔다(장부의 예열 칸과 맞게, 코드 리뷰 2026-11-01)
  scenarios: {
    ctl_reset: { executor: 'shared-iterations', vus: 1, iterations: 1, startTime: `${WARM_S}s`, exec: 'reset', tags: { phase: 'ctl' } },
    ctl_snapshot: { executor: 'shared-iterations', vus: 1, iterations: 1, startTime: `${WARM_S + DUR_S}s`, exec: 'snapshot', tags: { phase: 'ctl' } },
    ...(MODE === 'open'
      ? { warm: open('0s', WARMUP, 'warm'), main: open(WARMUP, DURATION, 'main') }
      : {
          warm: { executor: 'constant-vus', vus: VUS, duration: WARMUP, exec: 'call', tags: { phase: 'warm' } },
          main: { executor: 'constant-vus', vus: VUS, duration: DURATION, startTime: WARMUP, exec: 'call', tags: { phase: 'main' } },
        }),
  },
  // 본구간만 따로 집계하려고 꼬리표 기준을 둔다(판정 기준이 아니다)
  thresholds: { 'http_req_duration{phase:main}': ['max>=0'], 'http_reqs{phase:main}': ['count>=0'], 'http_req_failed{phase:main}': ['rate>=0'], 'dropped_iterations{scenario:main}': ['count>=0'] },
};

export function reset() {
  http.post(`${ADMIN}/reset`);
}

export function snapshot() {
  http.post(`${ADMIN}/snapshot`);
}

export function call() {
  const r = http.post(BASE + req.path, req.body, { headers: req.headers });
  check(r, { status: (x) => x.status === req.status });
}

export function handleSummary(data) {
  const m = data.metrics;
  const pick = (name) => m[name] || { values: {} };
  // 장부 도구가 읽는 이름(http_req_duration 등)을 본구간 값으로 바꾼다. 전체 값은 *_all로 남긴다
  for (const name of ['http_req_duration', 'http_reqs', 'http_req_failed']) {
    m[`${name}_all`] = m[name];
    m[name] = pick(`${name}{phase:main}`);
  }
  m.dropped_iterations_all = m.dropped_iterations;
  m.dropped_iterations = m['dropped_iterations{scenario:main}'] || { values: { count: 0 } };
  const out = ledger(data);
  return { [`/out/${__ENV.NAME || 'vt41'}.k6.json`]: out['summary.json'], stdout: out.stdout };
}
