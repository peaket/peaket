// F-08-5(MSR-050) 6시간 장시간 시험 k6 시나리오.
//
// 정본: docs/verification.md §3.6·§3.5, 계획 docs/review/plans/F-08-5.md §6.1·§6.3.
// 열린 모델(constant-arrival-rate)로 정한 도착률을 6시간 유지한다. 대상별 요청 모양은
// TARGET으로 가르고, 결과는 콘솔의 `record ` 줄과 records.ndjson 요약으로 남긴다.
// 이 파일은 Docker·kind 없이 문법만 검사한다. 실제 측정은 측정 창 4a~4c에서 한다.
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const TARGET = __ENV.TARGET ?? '';
const RATE = Number(__ENV.RATE ?? 0);
const DURATION_S = Number(__ENV.DURATION_S ?? 21600);
const WARM_S = Number(__ENV.WARM_S ?? 1800);
const EVENT_ID = __ENV.EVENT_ID ?? '00000000-0000-4000-8000-000000000000';
const RUN = __ENV.RUN ?? 'f085';
const STATE_BASE = __ENV.STATE_BASE ?? 'http://queue-state-cache.v1.svc.cluster.local:8080';
const PURCHASE_BASE = __ENV.PURCHASE_BASE ?? 'http://purchase-svc.v1.svc.cluster.local:8080';
const WS_BASE = __ENV.WS_BASE ?? 'ws://realtime-gw.realtime-gw.svc.cluster.local:8080';
const HOLD_SIZE = Number(__ENV.HOLD_SIZE ?? 2);
const SEATS_PER_ORDER = Number(__ENV.SEATS_PER_ORDER ?? 2);
const CONNECTIONS = Number(__ENV.CONNECTIONS ?? 2500);
const HOLD_RATE = Number(__ENV.HOLD_RATE ?? 63);

const TARGETS = ['queue-svc', 'purchase-svc', 'payment-svc', 'realtime-gw', 'outbox-relay'];
if (!TARGETS.includes(TARGET)) throw new Error(`TARGET은 ${TARGETS.join('|')} 가운데 하나다: ${TARGET}`);
if (!Number.isFinite(RATE) || RATE < 1) throw new Error('RATE는 1 이상이다');
if (!Number.isFinite(DURATION_S) || DURATION_S < 360 * 60) throw new Error('DURATION_S는 6시간(21600초) 이상이다');

const records = new Counter('soak_records_total');
const latency = new Trend('soak_request_duration_ms', true);
const warmRate = Math.max(1, Math.floor(RATE / 2));

export const options = {
  scenarios: {
    warm: {
      executor: 'constant-arrival-rate',
      rate: warmRate,
      timeUnit: '1s',
      duration: `${WARM_S}s`,
      preAllocatedVUs: Math.max(10, Math.ceil(warmRate / 10)),
      maxVUs: Math.max(50, warmRate),
      exec: 'hit',
      tags: { phase: 'warm', target: TARGET },
    },
    main: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      startTime: `${WARM_S}s`,
      duration: `${DURATION_S}s`,
      preAllocatedVUs: Math.max(10, Math.ceil(RATE / 10)),
      maxVUs: Math.max(50, RATE),
      exec: 'hit',
      tags: { phase: 'main', target: TARGET },
    },
  },
  thresholds: {
    dropped_iterations: ['count==0'],
    http_req_failed: ['rate<0.01'],
  },
};

/** 구간 시작 표시(측정 담당이 시각을 맞춘다) */
export function markStart(label) {
  console.log(`record ${JSON.stringify({ kind: 'mark', mark: 'start', label, at: Date.now(), target: TARGET, run: RUN })}`);
}

/** 구간 끝 표시 */
export function markEnd(label) {
  console.log(`record ${JSON.stringify({ kind: 'mark', mark: 'end', label, at: Date.now(), target: TARGET, run: RUN })}`);
}

function headers() {
  return { headers: { 'content-type': 'application/json', 'x-peaket-run': RUN, 'x-peaket-target': TARGET } };
}

function request() {
  if (TARGET === 'queue-svc') {
    return http.get(`${STATE_BASE}/v1/queues/${EVENT_ID}/state`, { tags: { route: 'status', target: TARGET } });
  }
  if (TARGET === 'purchase-svc') {
    return http.post(`${PURCHASE_BASE}/v1/events/${EVENT_ID}/holds`, JSON.stringify({ holdSize: HOLD_SIZE }), {
      ...headers(),
      tags: { route: 'hold', target: TARGET },
    });
  }
  if (TARGET === 'payment-svc' || TARGET === 'outbox-relay') {
    return http.post(`${PURCHASE_BASE}/v1/orders`, JSON.stringify({ seatsPerOrder: SEATS_PER_ORDER }), {
      ...headers(),
      tags: { route: 'order', target: TARGET },
    });
  }
  // realtime-gw: 연결을 맺고 한 번 읽은 뒤 닫는다. 6시간 유지 연결 측정은 측정 창에서
  // CONNECTIONS·HOLD_RATE로 조절하고, 이 반복은 델타가 오는지 확인하는 표본이다.
  let status = 0;
  ws.connect(`${WS_BASE}/v1/seats/stream?eventId=${EVENT_ID}&run=${RUN}`, { tags: { route: 'stream', target: TARGET } }, (socket) => {
    socket.on('open', () => {
      status = 101;
      socket.send(JSON.stringify({ type: 'subscribe', eventId: EVENT_ID }));
    });
    socket.on('message', () => {});
    socket.on('error', () => {});
    sleep(1);
    socket.close();
  });
  return { status, timings: { duration: 0 } };
}

/** 한 번의 도착. 결과를 `record ` 줄로 남긴다 */
export function hit() {
  const started = Date.now();
  const res = request();
  const ms = Date.now() - started;
  records.add(1);
  latency.add(ms);
  const ok = check(res, { [`${TARGET} 응답`]: (r) => r.status >= 200 && r.status < 300 });
  console.log(`record ${JSON.stringify({ kind: 'request', target: TARGET, route: TARGET, at: started, ms, status: res.status, ok, run: RUN })}`);
}

export default function () {
  hit();
}

/** 요약과 records.ndjson(실행 도구가 콘솔 `record ` 줄을 모아 채운다) */
export function handleSummary(data) {
  const summary = {
    target: TARGET,
    rate: RATE,
    durationS: DURATION_S,
    warmS: WARM_S,
    connections: CONNECTIONS,
    holdRate: HOLD_RATE,
    records: data.metrics.soak_records_total?.values?.count ?? 0,
    dropped: data.metrics.dropped_iterations?.values?.count ?? 0,
  };
  return {
    'records.ndjson': `${JSON.stringify({ kind: 'summary', ...summary })}\n`,
    stdout: `${JSON.stringify(summary)}\n`,
  };
}
