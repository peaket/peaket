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
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { openPhases } from '../lib/model.mjs';
import { faultFor, paymentEndTruncated, paymentOverTarget } from '../lib/targets.mjs';
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
/** 본구간 마지막 3초 안에 시작해 초과 집계에서 뺀 반복 수(BAT-033). 끝 상태와 비끝 상태를 나눠 old PENDING과 비교한다 */
const endTruncated = new Counter('payment_end_truncated');
const endTruncatedTerminal = new Counter('payment_end_truncated_terminal');
const endTruncatedPending = new Counter('payment_end_truncated_pending');
/** 결제 확정 시간(결제 접수 시작 → 끝 상태, ms) */
const confirmMs = new Trend('payment_confirm_ms', true);

const pays = openPhases({ exec: 'pay', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: 0, preVUs: PRE_VUS, maxVUs: MAX_VUS });

export const options = baseOptions(
  { warm: pays.warm, main: pays.main, ...markScenarios(WARM_S, WARM_S + MAIN_S) },
  ['hold', 'order', 'pay_start', 'sim_auth', 'sim_fault', 'payment', 'payment_status'],
);
options.thresholds['payment_confirm_ms{phase:main}'] = ['max>=0'];
options.thresholds['payment_end_truncated{phase:main}'] = ['count>=0'];
options.thresholds['payment_end_truncated_terminal{phase:main}'] = ['count>=0'];
options.thresholds['payment_end_truncated_pending{phase:main}'] = ['count>=0'];
// 접수 응답 코드 분포를 요약에 남긴다(태그가 붙은 계열은 임계값이 있어야 summary.json에 나온다). 429도 접수 경로 응답이 될 수 있어 함께 둔다
for (const code of ['0', '202', '400', '401', '404', '409', '422', '423', '429', '500', '503', '504']) options.thresholds[`payment_accept_status{phase:main,status:${code}}`] = ['count>=0'];
for (const s of [...TERMINAL, 'PENDING']) options.thresholds[`payment_outcomes{phase:main,status:${s}}`] = ['count>=0'];

export function setup() {
  if (RATE * (WARM_S + MAIN_S) + 2 > USERS) throw new Error('결제 시작 수의 상한(도착률 × 시간 + 2)이 가상 사용자 수보다 많다');
}

const sim = (path, body, route, expected) => http.post(`${SIM_URL}${path}`, JSON.stringify(body), { headers: { authorization: SIM_AUTH, 'content-type': 'application/json' }, tags: { route }, responseCallback: http.expectedStatuses(expected) });

export function pay() {
  // 반복 번호는 발생기를 나눠도(k6 실행 구간) 겹치지 않는다(줄무늬로 나뉜다). 사람마다 결제는 한 번이다.
  // k6의 iterationInTest는 시나리오별 번호다. 예열은 뒤에서, 본구간은 앞에서 세고, 계획한 반복 수를 넘는 꼬리는 버린다(BAT-035)
  const it = exec.scenario.iterationInTest;
  const i = paymentUserOf(exec.scenario.name, it, USERS, RATE, WARM_S, MAIN_S);
  if (i < 0 || i >= USERS) return;
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
  const startedMs = Date.now();
  // 본구간 종료 시각(k6가 주는 절대 시각). 마지막 3초 안에 시작한 반복은 끝에서 잘렸을 수 있어 초과 집계에서 뺀다(BAT-033)
  const mainEndMs = exec.scenario.name === 'main' ? exec.scenario.startTime + MAIN_S * 1000 : 0;
  const accepted = s.call('POST', `/v1/orders/${order.orderId}/payment-acceptance`, { pg: attempt.pg, paymentKey, amount: order.amount, attemptId: attempt.attemptId }, { route: 'payment', expected: [202], noTarget: true });
  acceptStatus.add(1, { phase, status: String(accepted.status) });
  if (!check(accepted, { '결제 접수 202': (x) => x.status === 202 })) {
    countOverTarget('payment', 0, { phase }, true);
    return;
  }

  // 결제 결과: 롱 폴링(최대 25초 [가정] 기다림)을 끝 상태까지, 네 번까지
  let status;
  for (let k = 0; k < 4; k++) {
    // 결과 조회는 서명하지 않는 경로다(신원 머리만)
    const r = vcall(PURCHASE_BASE, 'GET', `/v1/orders/${order.orderId}/payment-status`, { i, route: 'payment_status', expected: [200], timeout: '40s' });
    status = r.status === 200 ? jsonOf(r)?.status : undefined;
    if (TERMINAL.includes(status)) break;
  }
  const tookMs = Date.now() - startedMs;
  const terminal = TERMINAL.includes(status);
  confirmMs.add(tookMs, { phase });
  if (paymentEndTruncated({ startedMs, mainEndMs })) {
    endTruncated.add(1, { phase });
    if (terminal) endTruncatedTerminal.add(1, { phase });
    else endTruncatedPending.add(1, { phase });
  }
  // 끝 상태가 아닌 답은 시작 시각과 무관하게 초과로 센다(M6). 끝 상태라도 본구간 마지막 3초 안에 시작한 반복은
  // 본구간 종료와 함께 끝나지 못한 것이므로 초과에서 뺀다. 그 밖은 결제 확정 시간이 3초를 넘었는지로 센다.
  countOverTarget('payment', tookMs, { phase }, paymentOverTarget({ tookMs, terminal, startedMs, mainEndMs }));
  outcomes.add(1, { status: terminal ? status : 'PENDING' });
  check(null, { '결제 확정 CONFIRMED': () => status === 'CONFIRMED' });
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
