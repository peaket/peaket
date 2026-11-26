// F-08-5(MSR-050) 6시간 장시간 시험 k6 시나리오.
//
// 정본: docs/verification.md §3.6·§3.5, 계획 docs/review/plans/F-08-5.md §6.1·§6.3.
// 열린 모델(constant-arrival-rate)로 정한 도착률을 6시간 유지한다. 구매·결제·Outbox는
// v1-common의 사전 검증→진입→차례→입장 확정→구매 세션 열기(스냅샷)를 거친 뒤 서명 요청을 보낸다.
// 준비가 실패하면 setup_failed·scenario_errors로 남기고 setup을 실패시켜 측정을 무효로 만든다.
import http from 'k6/http';
import ws from 'k6/ws';
import exec from 'k6/execution';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { userSeats } from '../lib/seats.mjs';
import { v1Headers, v1SeatIds } from '../lib/v1.mjs';
import {
  admitAndOpen,
  admitV1,
  CLIENT_KEY,
  CONSENT_VERSION,
  enterV1,
  envInt,
  envStr,
  HOLD_BASE,
  jsonOf,
  markScenarios,
  PURCHASE_BASE,
  QUEUE_BASE,
  RUN_TAG,
  STATE_BASE,
  stateServing,
  scenarioErrors,
  V1Session,
} from './v1-common.js';

const TARGET = envStr('TARGET');
const RATE = envInt('RATE');
const DURATION_S = envInt('DURATION_S', 21600);
const WARM_S = envInt('WARM_S', 1800);
const EVENT_ID = envStr('EVENT_ID');
const USERS = envInt('USERS', 5000);
const PREP_BATCH = envInt('PREP_BATCH', 100);
const PREP_TIMEOUT_S = envInt('PREP_TIMEOUT_S', 1800);
const GRID = { sections: envStr('SECTIONS').split(','), rows: envInt('ROWS'), perRow: envInt('PER_ROW') };
const HOLD_SIZE = envInt('HOLD_SIZE', 2);
const SEATS_PER_ORDER = envInt('SEATS_PER_ORDER', 2);
const CONNECTIONS = envInt('CONNECTIONS', 2500);
const HOLD_RATE = envInt('HOLD_RATE', 63);
const SIM_URL = envStr('SIM_URL', 'http://pg-simulator.v1.svc.cluster.local:8790');
const SIM_AUTH = `Basic ${encoding.b64encode(`${envStr('PG_SIMULATOR_SECRET_KEY')}:`)}`;
const TARGETS = ['queue-svc', 'purchase-svc', 'payment-svc', 'realtime-gw', 'outbox-relay'];
if (!TARGETS.includes(TARGET)) throw new Error(`TARGET은 ${TARGETS.join('|')} 가운데 하나다: ${TARGET}`);
if (!Number.isFinite(RATE) || RATE < 1) throw new Error('RATE는 1 이상이다');
if (!Number.isFinite(DURATION_S) || DURATION_S < 360 * 60) throw new Error('DURATION_S는 6시간(21600초) 이상이다');
if (!Number.isFinite(USERS) || USERS < 1 || USERS > 5000) throw new Error('USERS는 1~5,000이다(동시 입장 목표)');

const records = new Counter('soak_records_total');
const latency = new Trend('soak_request_duration_ms', true);
const setupFailed = new Counter('setup_failed');
const prepUsers = TARGET === 'realtime-gw' ? Math.min(CONNECTIONS, USERS) : TARGET === 'queue-svc' ? 0 : USERS;
const warmRate = Math.max(1, Math.floor(RATE / 2));

export const options = {
  setupTimeout: `${PREP_TIMEOUT_S}s`,
  // 본구간 경계는 markScenarios가 markStart/markEnd로 남긴다(실행 도구가 host·records 창을 자른다).
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
    ...markScenarios(WARM_S, WARM_S + DURATION_S),
  },
  thresholds: {
    dropped_iterations: ['count==0'],
    setup_failed: ['count==0'],
    http_req_failed: ['rate<0.01'],
  },
};

/** 사전 검증·진입·입장·스냅샷을 묶음으로 한다. 한 사람이라도 실패하면 setup_failed를 남긴다 */
function post(base, path, i, body, route) {
  return http.post(`${base}${path}`, JSON.stringify(body), {
    headers: v1Headers(RUN_TAG, i, { json: true }),
    tags: { phase: 'prep', route },
  });
}

export function setup() {
  if (TARGET === 'queue-svc') {
    const entries = new Array(USERS).fill(null);
    for (let from = 0; from < USERS; from += PREP_BATCH) {
      const ids = Array.from({ length: Math.min(PREP_BATCH, USERS - from) }, (_, k) => from + k);
      const pv = http.batch(ids.map((i) => post(QUEUE_BASE, `/v1/queues/${EVENT_ID}/pre-verifications`, i, {}, 'preverify')));
      const en = http.batch(ids.map((i, k) => post(QUEUE_BASE, `/v1/queues/${EVENT_ID}/entries`, i, { preverifyToken: jsonOf(pv[k])?.preverifyToken ?? '' }, 'entry')));
      en.forEach((r, k) => {
        if (r.status === 201) entries[ids[k]] = jsonOf(r);
      });
    }
    if (entries.filter(Boolean).length !== USERS) {
      setupFailed.add(1, { target: TARGET });
      scenarioErrors.add(1);
      throw new Error(`setup_failed: queue entry ${entries.filter(Boolean).length}/${USERS}`);
    }
    return { entries, tokens: null, openedAt: null };
  }

  const tokens = new Array(prepUsers).fill(null);
  const openedAt = new Array(prepUsers).fill(0);
  for (let from = 0; from < prepUsers; from += PREP_BATCH) {
    const ids = Array.from({ length: Math.min(PREP_BATCH, prepUsers - from) }, (_, k) => from + k);
    const pv = http.batch(ids.map((i) => post(QUEUE_BASE, `/v1/queues/${EVENT_ID}/pre-verifications`, i, {}, 'preverify')));
    const en = http.batch(ids.map((i, k) => post(QUEUE_BASE, `/v1/queues/${EVENT_ID}/entries`, i, { preverifyToken: jsonOf(pv[k])?.preverifyToken ?? '' }, 'entry')));
    const entries = en.map((r) => (r.status === 201 ? jsonOf(r) : undefined));
    if (entries.some((e) => !e)) {
      setupFailed.add(1, { target: TARGET });
      scenarioErrors.add(1);
      throw new Error(`setup_failed: queue entry 일부 실패(묶음 ${from})`);
    }
    const maxSeq = Math.max(...entries.map((e) => e.seq));
    const segment = Math.max(0, Math.floor((maxSeq - 1) / 1000));
    const until = Date.now() + 120_000;
    for (;;) {
      const s = jsonOf(http.get(`${STATE_BASE}/v1/queues/${EVENT_ID}/segment-states/${segment}.json`, { tags: { phase: 'prep', route: 'status' } }));
      if ((s?.serving ?? -1) >= maxSeq || Date.now() > until) break;
      sleep(0.5);
    }
    let left = ids.map((i, k) => ({ i, e: entries[k] }));
    for (let attempt = 0; attempt < 20 && left.length > 0; attempt += 1) {
      const ad = http.batch(left.map((x) => post(QUEUE_BASE, `/v1/queues/${EVENT_ID}/admission`, x.i, { queueTicket: x.e.queueTicket }, 'admission')));
      const next = [];
      left.forEach((x, k) => {
        const b = jsonOf(ad[k]);
        if (b?.status === 'ADMITTED' && typeof b.admissionToken === 'string') {
          tokens[x.i] = b.admissionToken;
          openedAt[x.i] = Date.now();
        } else next.push(x);
      });
      left = next;
      if (left.length) sleep(0.5);
    }
    const open = ids.filter((i) => tokens[i]);
    const sn = http.batch(open.map((i) => ['GET', `${PURCHASE_BASE}/v1/events/${EVENT_ID}/seatmap-snapshot`, null, {
      headers: { ...v1Headers(RUN_TAG, i), 'x-admission-token': tokens[i], 'x-client-ephemeral-key': CLIENT_KEY },
      tags: { phase: 'prep', route: 'snapshot' },
    }]));
    open.forEach((i, k) => {
      if (sn[k].status !== 200) tokens[i] = null;
    });
  }
  const ready = tokens.filter(Boolean).length;
  if (ready !== prepUsers) {
    setupFailed.add(1, { target: TARGET });
    scenarioErrors.add(1);
    throw new Error(`setup_failed: 구매 세션 ${ready}/${prepUsers}`);
  }
  return { entries: null, tokens, openedAt };
}

/** VU 안의 구매 세션. 35분이 지나면 새 입장·스냅샷으로 바꾼다(입장 토큰 45분 상한) */
const sessions = new Map();

function sessionFor(u, data) {
  const now = Date.now();
  let s = sessions.get(u);
  const at = s?.at ?? data.openedAt?.[u] ?? 0;
  if (!s || now - at > 35 * 60 * 1000) {
    const opened = admitAndOpen(EVENT_ID, u, { phase: 'prep', waitS: 120 });
    if (!opened) {
      setupFailed.add(1, { target: TARGET });
      return undefined;
    }
    s = { session: new V1Session(u, opened.admissionToken), at: now };
    sessions.set(u, s);
  }
  return s;
}

function record(target, route, started, status, ok) {
  records.add(1, { target, route });
  latency.add(Date.now() - started, { target, route });
  console.log(`record ${JSON.stringify({ kind: 'request', target, route, at: started, ms: Date.now() - started, status, ok, run: RUN_TAG })}`);
}

function holdAndRelease(u, data, order = false, retry = 0) {
  const s = sessionFor(u, data);
  if (!s) return;
  const seats = v1SeatIds(GRID, userSeats(GRID, u, order ? SEATS_PER_ORDER : HOLD_SIZE));
  const started = Date.now();
  const held = s.session.call('POST', `/v1/events/${EVENT_ID}/holds`, { seatIds: seats }, { route: 'hold', expected: [201, 409, 422], base: HOLD_BASE });
  if (held.status === 401) {
    sessions.delete(u);
    if (retry === 0) return holdAndRelease(u, data, order, 1);
    scenarioErrors.add(1);
    return;
  }
  let ok = check(held, { '홀드 201/409/422': (r) => [201, 409, 422].includes(r.status) });
  if (held.status === 422 && String(held.body).includes('invalid-seat')) scenarioErrors.add(1);
  record(TARGET, 'hold', started, held.status, ok);
  const holdId = held.status === 201 ? jsonOf(held)?.holdId : undefined;
  if (order && typeof holdId === 'string') {
    const ostarted = Date.now();
    const ordered = s.session.call('POST', '/v1/orders', {
      holdId,
      buyer: { name: 'Load Test', phone: '010-1234-5678' },
      consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT_VERSION },
    }, { route: 'order', expected: [201] });
    ok = check(ordered, { '주문 201': (r) => r.status === 201 });
    record(TARGET, 'order', ostarted, ordered.status, ok);
    return;
  }
  if (typeof holdId === 'string') {
    const rstarted = Date.now();
    const released = s.session.call('DELETE', `/v1/holds/${holdId}`, undefined, { route: 'release', expected: [204], base: HOLD_BASE });
    ok = check(released, { '해제 204': (r) => r.status === 204 });
    record(TARGET, 'release', rstarted, released.status, ok);
  }
}

function pay(u, data, retry = 0) {
  const s = sessionFor(u, data);
  if (!s) return;
  const seats = v1SeatIds(GRID, userSeats(GRID, u, SEATS_PER_ORDER));
  const held = s.session.call('POST', `/v1/events/${EVENT_ID}/holds`, { seatIds: seats }, { route: 'hold', expected: [201], base: HOLD_BASE });
  if (held.status === 401) {
    sessions.delete(u);
    if (retry === 0) return pay(u, data, 1);
    scenarioErrors.add(1);
    return;
  }
  const holdId = held.status === 201 ? jsonOf(held)?.holdId : undefined;
  record(TARGET, 'hold', Date.now(), held.status, typeof holdId === 'string');
  if (typeof holdId !== 'string') return;
  const ordered = s.session.call('POST', '/v1/orders', {
    holdId,
    buyer: { name: 'Load Test', phone: '010-1234-5678' },
    consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT_VERSION },
  }, { route: 'order', expected: [201] });
  const order = ordered.status === 201 ? jsonOf(ordered) : undefined;
  record(TARGET, 'order', Date.now(), ordered.status, typeof order?.orderId === 'string');
  if (typeof order?.orderId !== 'string') return;
  const startedRes = s.session.call('POST', `/v1/orders/${order.orderId}/payments`, {}, { route: 'pay_start', expected: [201] });
  const attempt = startedRes.status === 201 ? jsonOf(startedRes) : undefined;
  record(TARGET, 'pay_start', Date.now(), startedRes.status, typeof attempt?.attemptId === 'string');
  if (typeof attempt?.attemptId !== 'string') return;
  const auth = http.post(`${SIM_URL}/sim/authenticate`, JSON.stringify({
    orderId: attempt.checkout.orderId,
    amount: attempt.checkout.amount,
    orderName: attempt.checkout.orderName,
  }), { headers: { authorization: SIM_AUTH, 'content-type': 'application/json' }, tags: { route: 'sim_auth' } });
  const paymentKey = auth.status === 200 ? jsonOf(auth)?.paymentKey : undefined;
  record(TARGET, 'sim_auth', Date.now(), auth.status, typeof paymentKey === 'string');
  if (typeof paymentKey !== 'string') return;
  const accepted = s.session.call('POST', `/v1/orders/${order.orderId}/payment-acceptance`, {
    pg: attempt.pg,
    paymentKey,
    amount: order.amount,
    attemptId: attempt.attemptId,
  }, { route: 'payment', expected: [202] });
  record(TARGET, 'payment', Date.now(), accepted.status, accepted.status === 202);
}

function queueHit(data) {
  const u = exec.scenario.iterationInTest % USERS;
  let entry = data.entries?.[u];
  if (!entry) {
    entry = enterV1(EVENT_ID, u, { phase: 'main', record: false });
    if (!entry) return;
    data.entries[u] = entry;
  }
  const s = stateServing(EVENT_ID, entry.segment, { phase: 'main' });
  if (s.serving >= entry.seq) {
    const admitted = admitV1(EVENT_ID, u, entry, { phase: 'main', record: false });
    record(TARGET, 'admission', Date.now(), admitted?.status === 'ADMITTED' ? 200 : 0, admitted?.status === 'ADMITTED');
  } else {
    record(TARGET, 'status', Date.now(), 200, true);
  }
}

export function hit(data) {
  if (TARGET === 'queue-svc') return queueHit(data);
  const u = exec.scenario.iterationInTest % prepUsers;
  if (TARGET === 'purchase-svc') return holdAndRelease(u, data, false);
  if (TARGET === 'outbox-relay') return holdAndRelease(u, data, true);
  if (TARGET === 'payment-svc') return pay(u, data);
  // realtime-gw: 연결을 맺고 델타를 한 번 읽는다. 연결 수 유지는 측정 창의 별도 부하로 본다.
  const started = Date.now();
  let status = 0;
  ws.connect(`${envStr('WS_BASE', 'ws://realtime-gw.realtime-gw.svc.cluster.local:8080')}/v1/seats/stream?eventId=${EVENT_ID}&run=${RUN_TAG}`, { tags: { route: 'stream', target: TARGET } }, (socket) => {
    socket.on('open', () => {
      status = 101;
      socket.send(JSON.stringify({ type: 'subscribe', eventId: EVENT_ID }));
    });
    socket.on('message', () => {});
    socket.on('error', () => {});
    sleep(1);
    socket.close();
  });
  record(TARGET, 'stream', started, status, status === 101);
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
    setupFailed: data.metrics.setup_failed?.values?.count ?? 0,
  };
  return {
    'records.ndjson': `${JSON.stringify({ kind: 'summary', ...summary })}\n`,
    stdout: `${JSON.stringify(summary)}\n`,
  };
}
