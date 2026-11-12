// K7 결제 시나리오의 v1 쪽(P-T1, docs/verification.md §3.9 'v1 경로'·§3.10 'v1 합본의 K7 ② 조건'). 실행: node loadtest/run.mjs v1 payment …(인자는 v0 payment와 같다)
// 결제 하나를 정한 도착률로 시작한다(phase:warm → main). 가상 사용자 하나가 결제 하나이고 번호는 v0와 같다(본구간은 앞에서부터, 예열은 뒤에서부터).
// v1은 동시 입장 목표가 5,000명이라 가상 사용자를 준비 구간에 모두 입장시키지 않는다(§3.9 '준비 구간의 입장'): 반복마다 사전 검증·진입·차례·입장 확정·구매 세션 열기를
// 먼저 하고(꼬리표 phase:prep, 본구간 판정에서 뺀다) 결제로 간다. 결제를 마친 구매 세션이 끝나면 입장 자리가 비어 다음 사람이 들어온다.
// 결제: 자기 몫 좌석 홀드(route:hold) → 주문(route:order) → 결제 시도 시작(route:pay_start) → 시뮬레이터 시험 인증(route:sim_auth) →
// (장애 배정이면 시뮬레이터 장애, route:sim_fault) → 결제 접수(route:payment, 202) → 결제 결과 기다림(route:payment_status, 롱 폴링) → 끝 상태까지.
// 결제 확정 시간(NFR-006 '결제를 요청한 때부터')은 결제 접수 요청 시작부터 끝 상태를 받을 때까지이고(지표 payment_confirm_ms), route:payment의 목표 점검도
// 그 시간으로 센다. 끝 상태가 아닌 빠른 답(기다림 표가 꽉 참·멈춤 등)으로 끝나면 목표를 넘은 것으로 센다(코드 리뷰 M6). 구매 요청은 서명한다(lib/purchase-auth.mjs).
// 장애 배정은 lib/targets.mjs faultFor(소수 한 자리 비율, 1,000명마다 그 비율 × 10명)이다.
// 환경 값: EVENT_ID USERS RATE WARM_S MAIN_S SEATS_PER_ORDER SECTIONS ROWS PER_ROW SIM_URL PRE_VUS MAX_VUS FAULT_DROP_PCT FAULT_DELAY_PCT FAULT_DELAY_MS ADMIT_WAIT_S, 시험 키 PG_SIMULATOR_SECRET_KEY(파드 Secret)
import http from 'k6/http';
import exec from 'k6/execution';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { openPhases } from '../lib/model.mjs';
import { faultFor, paymentDrainFinished, paymentDrainNewStart, paymentDrainUnfinished, paymentOverTarget, paymentPendingBefore3s, paymentStatusPollNext, PAYMENT_STATUS_POLL_MAX_MS } from '../lib/targets.mjs';
import { userSeats } from '../lib/seats.mjs';
import { PAYMENT_TERMINAL, paymentUserOf, v1SeatIds } from '../lib/v1.mjs';
import { baseOptions } from './common.js';
import { admitAndOpen, CONSENT_VERSION, countOverTarget, envInt, envStr, HOLD_BASE, jsonOf, markScenarios, PURCHASE_BASE, scenarioErrors, V1Session, vcall, writeSummary } from './v1-common.js';

export { markEnd, markStart } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const USERS = envInt('USERS');
const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const SEATS_PER_ORDER = envInt('SEATS_PER_ORDER', 2);
const GRID = { sections: envStr('SECTIONS').split(','), rows: envInt('ROWS'), perRow: envInt('PER_ROW') };
const SIM_URL = envStr('SIM_URL', 'http://pg-simulator.v1.svc.cluster.local:8790');
const SIM_AUTH = `Basic ${encoding.b64encode(`${envStr('PG_SIMULATOR_SECRET_KEY')}:`)}`;
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 500);
/** 장애 비율(소수 한 자리까지, 실행 도구가 검사해 넘긴다) */
const pct = (name) => {
  const raw = __ENV[name] ?? '0';
  if (!/^\d+(\.\d)?$/.test(raw)) throw new Error(`환경 값 ${name}은 소수 한 자리까지의 수다`);
  return Number(raw);
};
const FAULT_DROP_PCT = pct('FAULT_DROP_PCT');
const FAULT_DELAY_PCT = pct('FAULT_DELAY_PCT');
const FAULT_DELAY_MS = envInt('FAULT_DELAY_MS', 16000);
const ADMIT_WAIT_S = envInt('ADMIT_WAIT_S', 120);
/** 결제 결과 끝 상태(lib/v1.mjs PAYMENT_TERMINAL: 결과 모름 UNKNOWN은 거쳐 가는 상태라 끝 상태까지 더 묻는다, 재확인 리뷰 3) */
const TERMINAL = PAYMENT_TERMINAL;
/** 결제 하나의 마지막 상태(꼬리표 status) */
const outcomes = new Counter('payment_outcomes');
/** 결제 접수 응답 상태 코드(202·4xx·5xx·0). 실패의 코드 분포를 다음 측정에 남긴다(BAT-033) */
const acceptStatus = new Counter('payment_accept_status');
/** 드레인 중 끝난 결제 수와 그중 끝 상태/비끝 상태(BAT-511) */
const drainFinished = new Counter('payment_drain_finished');
const drainFinishedTerminal = new Counter('payment_drain_finished_terminal');
const drainFinishedPending = new Counter('payment_drain_finished_pending');
/** 드레인 20초가 지나도 끝나지 않은 결제 수(시작 - 끝) */
const drainUnfinished = new Counter('payment_drain_unfinished');
/** 드레인 중 새 결제가 시작되지 않았는지 세는 시작·끝 수(끝나지 않은 수 = 시작 - 끝) */
const paymentStarted = new Counter('payment_started');
const paymentFinished = new Counter('payment_finished');
/** 결제 확정 시간(결제 접수 시작 → 끝 상태, ms) */
const confirmMs = new Trend('payment_confirm_ms', true);
/** 결제 하나의 상태 조회 수와 호출 하나의 시간(조기 종료·느린 호출 진단, BAT-511) */
const statusCalls = new Trend('payment_status_calls', true);
const statusCallMs = new Trend('payment_status_call_ms', true);
/** PENDING으로 끝난 결제의 마지막 상태·호출 시간·3초 전 포기 여부(BAT-511) */
const pendingLastStatus = new Counter('payment_pending_last_status');
const pendingBefore3s = new Counter('payment_pending_before_3s');
const pendingAfter3s = new Counter('payment_pending_after_3s');
const pendingMs = new Trend('payment_pending_ms', true);
const pendingLastCallMs = new Trend('payment_pending_last_call_ms', true);

const pays = openPhases({ exec: 'pay', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: 0, preVUs: PRE_VUS, maxVUs: MAX_VUS });
// 본구간 뒤 20초 드레인: 새 반복을 시작하지 않고 진행 중인 결제를 끝까지 기다린다(BAT-511)
const main = { ...pays.main, gracefulStop: '20s' };

export const options = baseOptions(
  { warm: pays.warm, main, ...markScenarios(WARM_S, WARM_S + MAIN_S) },
  ['hold', 'order', 'pay_start', 'sim_auth', 'sim_fault', 'payment', 'payment_status'],
);
options.thresholds['payment_confirm_ms{phase:main}'] = ['max>=0'];
for (const name of ['payment_drain_finished', 'payment_drain_finished_terminal', 'payment_drain_finished_pending', 'payment_drain_unfinished', 'payment_started', 'payment_finished', 'payment_pending_before_3s', 'payment_pending_after_3s']) {
  options.thresholds[`${name}{phase:main}`] = ['count>=0'];
}
for (const name of ['payment_status_calls', 'payment_status_call_ms', 'payment_pending_ms', 'payment_pending_last_call_ms']) options.thresholds[`${name}{phase:main}`] = ['max>=0'];
// PENDING의 마지막 상태 분포(빠른 비끝 답의 정체를 남긴다)
for (const s of ['ACCEPTED', 'RESERVED', 'APPROVED', 'UNKNOWN', 'undefined']) options.thresholds[`payment_pending_last_status{phase:main,status:${s}}`] = ['count>=0'];
// 접수 응답 코드 분포를 요약에 남긴다(태그가 붙은 계열은 임계값이 있어야 summary.json에 나온다). 429도 접수 경로 응답이 될 수 있어 함께 둔다
for (const code of ['0', '202', '400', '401', '404', '409', '422', '423', '429', '500', '503', '504']) options.thresholds[`payment_accept_status{phase:main,status:${code}}`] = ['count>=0'];
for (const s of [...TERMINAL, 'PENDING']) options.thresholds[`payment_outcomes{phase:main,status:${s}}`] = ['count>=0'];

export function setup() {
  if (RATE * (WARM_S + MAIN_S) + 2 > USERS) throw new Error('결제 시작 수의 상한(도착률 × 시간 + 2)이 가상 사용자 수보다 많다');
  // 드레인·조기 종료 카운터는 0건이어도 요약에 남긴다(시작·끝 수는 payment_started/payment_finished에서 계산)
  for (const c of [drainFinished, drainFinishedTerminal, drainFinishedPending, drainUnfinished, paymentStarted, paymentFinished, pendingBefore3s, pendingAfter3s]) c.add(0, { phase: 'main' });
}

const sim = (path, body, route, expected) => http.post(`${SIM_URL}${path}`, JSON.stringify(body), { headers: { authorization: SIM_AUTH, 'content-type': 'application/json' }, tags: { route }, responseCallback: http.expectedStatuses(expected) });

export function pay() {
  // 반복 번호는 발생기를 나눠도(k6 실행 구간) 겹치지 않는다(줄무늬로 나뉜다). 사람마다 결제는 한 번이다.
  // k6의 iterationInTest는 시나리오별 번호다. 예열은 뒤에서, 본구간은 앞에서 세고, 계획한 반복 수를 넘는 꼬리는 버린다(BAT-035)
  const it = exec.scenario.iterationInTest;
  const i = paymentUserOf(exec.scenario.name, it, USERS, RATE, WARM_S, MAIN_S);
  if (i < 0 || i >= USERS) return;
  // 본구간 끝 뒤에는 새 결제를 시작하지 않는다. k6 gracefulStop이 새 반복을 막고, 이 가드가 경계의 반복을 막는다(BAT-511)
  const mainEndMs = exec.scenario.name === 'main' ? exec.scenario.startTime + MAIN_S * 1000 : 0;
  if (paymentDrainNewStart({ startedMs: Date.now(), mainEndMs })) return;
  const opened = admitAndOpen(EVENT_ID, i, { phase: 'prep', waitS: ADMIT_WAIT_S, record: false });
  if (!opened) return;
  const s = new V1Session(i, opened.admissionToken);

  const held = s.call('POST', `/v1/events/${EVENT_ID}/holds`, { seatIds: v1SeatIds(GRID, userSeats(GRID, i, SEATS_PER_ORDER)) }, { route: 'hold', expected: [201], base: HOLD_BASE });
  const holdId = held.status === 201 ? jsonOf(held)?.holdId : undefined;
  if (!check(held, { '홀드 201': () => typeof holdId === 'string' })) return;

  const ordered = s.call('POST', '/v1/orders', { holdId, buyer: { name: 'Load Test', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT_VERSION } }, { route: 'order', expected: [201] });
  const order = ordered.status === 201 ? jsonOf(ordered) : undefined;
  if (!check(ordered, { '주문 201': () => typeof order?.orderId === 'string' })) return;

  const started = s.call('POST', `/v1/orders/${order.orderId}/payments`, {}, { route: 'pay_start', expected: [201] });
  const attempt = started.status === 201 ? jsonOf(started) : undefined;
  if (!check(started, { '결제 시도 시작 201': () => typeof attempt?.attemptId === 'string' && typeof attempt?.checkout?.orderId === 'string' })) return;

  const auth = sim('/sim/authenticate', { orderId: attempt.checkout.orderId, amount: attempt.checkout.amount, orderName: attempt.checkout.orderName }, 'sim_auth', 200);
  const paymentKey = auth.status === 200 ? jsonOf(auth)?.paymentKey : undefined;
  if (!check(auth, { '결제창 인증 200': () => typeof paymentKey === 'string' })) return;

  // 장애는 이 주문의 승인 호출에만, 한 번만 건다(시뮬레이터가 주문 ID로 고른다). 결제 접수 전에 건다(접수 뒤 실행기가 승인을 부른다)
  const fault = faultFor(i, FAULT_DROP_PCT, FAULT_DELAY_PCT);
  if (fault !== null) {
    const body = fault === 'drop' ? { op: 'confirm', orderId: order.orderId, times: 1, kind: 'drop', applied: true } : { op: 'confirm', orderId: order.orderId, times: 1, kind: 'delay', ms: FAULT_DELAY_MS };
    if (sim('/sim/faults', body, 'sim_fault', 204).status !== 204) scenarioErrors.add(1);
  }

  const phase = exec.scenario.name === 'main' ? 'main' : 'warm';
  // 접수도 본구간 끝 뒤에는 시작하지 않는다(앞 단계가 드레인 경계를 넘긴 반복)
  const startedMs = Date.now();
  if (paymentDrainNewStart({ startedMs, mainEndMs })) return;
  const accepted = s.call('POST', `/v1/orders/${order.orderId}/payment-acceptance`, { pg: attempt.pg, paymentKey, amount: order.amount, attemptId: attempt.attemptId }, { route: 'payment', expected: [202], noTarget: true });
  acceptStatus.add(1, { phase, status: String(accepted.status) });
  if (!check(accepted, { '결제 접수 202': (x) => x.status === 202 })) {
    countOverTarget('payment', 0, { phase }, true);
    return;
  }
  paymentStarted.add(1, { phase });

  // 결제 결과: 끝 상태까지 롱 폴링. 빠른 비끝 답이면 짧게 쉬었다 다시 묻고, 접수 시작 후 최소 3초까지 묻는다.
  // 3초가 지나도 비끝이면 그때 위반으로 세고 멈춘다. 전체 상한은 20초 드레인과 맞춘다(BAT-511).
  let status;
  let calls = 0;
  let lastCallMs = 0;
  for (;;) {
    const before = paymentStatusPollNext({ startedMs, nowMs: Date.now(), calls, terminal: TERMINAL.includes(status) });
    if (!before.poll) break;
    const remainingMs = Math.max(1_000, PAYMENT_STATUS_POLL_MAX_MS - (Date.now() - startedMs));
    const callStartedMs = Date.now();
    // 결과 조회는 서명하지 않는 경로다(신원 머리만)
    const r = vcall(PURCHASE_BASE, 'GET', `/v1/orders/${order.orderId}/payment-status`, { i, route: 'payment_status', expected: [200], timeout: `${remainingMs}ms` });
    calls += 1;
    lastCallMs = Date.now() - callStartedMs;
    statusCallMs.add(lastCallMs, { phase });
    status = r.status === 200 ? jsonOf(r)?.status : undefined;
    if (TERMINAL.includes(status)) break;
    const after = paymentStatusPollNext({ startedMs, nowMs: Date.now(), calls, terminal: false });
    if (!after.poll) break;
    if (after.sleepMs > 0) sleep(after.sleepMs / 1000);
  }
  statusCalls.add(calls, { phase });
  const finishedMs = Date.now();
  const tookMs = finishedMs - startedMs;
  const terminal = TERMINAL.includes(status);
  confirmMs.add(tookMs, { phase });
  paymentFinished.add(1, { phase });
  if (!terminal) {
    // PENDING의 정체를 남긴다: 마지막 상태·전체 시간·마지막 호출 시간·3초 전 포기 여부
    pendingLastStatus.add(1, { phase, status: String(status ?? 'undefined') });
    pendingMs.add(tookMs, { phase });
    pendingLastCallMs.add(lastCallMs, { phase });
    if (paymentPendingBefore3s({ tookMs, terminal })) pendingBefore3s.add(1, { phase });
    else pendingAfter3s.add(1, { phase });
  }
  if (paymentDrainFinished({ startedMs, finishedMs, mainEndMs })) {
    drainFinished.add(1, { phase });
    if (terminal) drainFinishedTerminal.add(1, { phase });
    else drainFinishedPending.add(1, { phase });
  }
  // 드레인 중 끝난 결제도 실제 시간으로 판정한다. 끝 상태가 아니면 위반이고, 끝 상태면 3초 초과가 위반이다(BAT-511).
  countOverTarget('payment', tookMs, { phase }, paymentOverTarget({ tookMs, terminal }));
  outcomes.add(1, { status: terminal ? status : 'PENDING' });
  check(null, { '결제 확정 CONFIRMED': () => status === 'CONFIRMED' });
}

export function handleSummary(data) {
  // 드레인 20초가 지나도 끝나지 않은 결제는 위반으로 센다(시작 - 끝). k6 gracefulStop이 강제로 멈춘 반복은
  // payment_finished를 부르지 못하므로 이 차이가 곧 미완 수다(BAT-511).
  const started = data.metrics['payment_started{phase:main}']?.values?.count ?? 0;
  const finished = data.metrics['payment_finished{phase:main}']?.values?.count ?? 0;
  const unfinished = paymentDrainUnfinished({ started, finished });
  const drain = data.metrics['payment_drain_unfinished{phase:main}'];
  if (drain) {
    drain.values.count = unfinished;
    drain.values.rate = 0;
  }
  const over = data.metrics['over_target{phase:main,route:payment,le:3000}'];
  if (over) over.values.count += unfinished;
  const pending = data.metrics['payment_outcomes{phase:main,status:PENDING}'];
  if (pending) pending.values.count += unfinished;
  return writeSummary(data, MAIN_S);
}
