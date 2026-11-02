// K7 결제 시나리오(docs/verification.md §3.9, docs/features/payment.md §13). 실행: node loadtest/run.mjs v0 payment …
// 준비 구간(phase:prep)에 가상 사용자를 진입·입장시키고, 결제 하나를 정한 도착률로 시작한다(phase:warm → main).
// 가상 사용자마다 자기 몫의 좌석(SEATS_PER_ORDER석, 겹치지 않음)을 홀드 → 주문 → 시뮬레이터 시험 인증 → 결제 확정 → 주문 보기로 잇는다.
// 결제창 인증은 결제창 대신 시뮬레이터의 시험용 인증(POST /sim/authenticate, 시험 키 기본 인증)으로 한다(payment §13 'v0에 없는 것').
// 환경 값: EVENT_ID USERS RATE WARM_S MAIN_S SEATS_PER_ORDER SECTIONS ROWS PER_ROW SIM_URL PREP_RATE PRE_VUS MAX_VUS, 시험 키 PG_SIMULATOR_SECRET_KEY(파드 Secret)
import http from 'k6/http';
import exec from 'k6/execution';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';
import { openPhases } from '../lib/model.mjs';
import { userSeats } from '../lib/seats.mjs';
import { admitQueue, scenarioErrors, baseOptions, call, enterQueue, envInt, envStr, jsonOf, markScenarios, prepScenarios, user, userCount, writeSummary } from './common.js';

export { markEnd, markStart } from './common.js';

const EVENT_ID = envStr('EVENT_ID');
const USERS = envInt('USERS');
const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const SEATS_PER_ORDER = envInt('SEATS_PER_ORDER', 2);
const GRID = { sections: envStr('SECTIONS').split(','), rows: envInt('ROWS'), perRow: envInt('PER_ROW') };
const SIM_URL = envStr('SIM_URL', 'http://pg-simulator.v0.svc.cluster.local:8790');
const SIM_AUTH = `Basic ${encoding.b64encode(`${envStr('PG_SIMULATOR_SECRET_KEY')}:`)}`;
const PREP_RATE = envInt('PREP_RATE', Math.min(USERS, 200));
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 500);

const prep = prepScenarios(USERS, PREP_RATE);
const pays = openPhases({ exec: 'pay', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: prep.prepS, preVUs: PRE_VUS, maxVUs: MAX_VUS });

export const options = baseOptions(
  { ...prep.scenarios, warm: pays.warm, main: pays.main, ...markScenarios(prep.prepS + WARM_S, prep.prepS + WARM_S + MAIN_S) },
  ['hold', 'order', 'sim_auth', 'payment', 'order_view'],
);

export function setup() {
  if (userCount() < USERS) throw new Error(`토큰 파일의 가상 사용자(${userCount()})가 USERS보다 적다`);
  if (RATE * (WARM_S + MAIN_S) + 2 > USERS) throw new Error('결제 시작 수의 상한(도착률 × 시간 + 2)이 가상 사용자 수보다 많다');
}

export function prepEntry() {
  const i = exec.scenario.iterationInTest;
  if (i < USERS) enterQueue(EVENT_ID, user(i), false);
}

export function prepAdmit() {
  const i = exec.scenario.iterationInTest;
  if (i >= USERS) return;
  for (let k = 0; k < 20; k++) {
    if (admitQueue(EVENT_ID, user(i), false) === 'ADMITTED') return;
    sleep(0.5);
  }
  check(null, { '준비 입장': () => false });
  scenarioErrors.add(1);
}

/**
 * 결제 하나. 가상 사용자는 본구간이 앞에서부터(0, 1, …), 예열이 뒤에서부터(USERS−1, USERS−2, …) 쓴다.
 * 도착률 실행기는 구간마다 반복을 '도착률 × 시간 + 1'번까지 시작할 수 있어(2026-11-03 리허설) 번호를 이어 붙이면 겹친다
 */
export function pay() {
  const it = exec.scenario.iterationInTest;
  const i = exec.scenario.name === 'main' ? it : USERS - 1 - it;
  if (i < 0 || i >= USERS) return;
  const u = user(i);
  const seatIds = userSeats(GRID, i, SEATS_PER_ORDER);
  const held = call('POST', `/v1/events/${EVENT_ID}/holds`, { user: u, route: 'hold', body: { seatIds }, expected: [201] });
  const holdId = held.status === 201 ? jsonOf(held)?.holdId : undefined;
  if (!check(held, { '홀드 201': () => typeof holdId === 'string' })) return;

  const ordered = call('POST', '/v0/orders', { user: u, route: 'order', body: { holdId }, expected: [201] });
  const order = ordered.status === 201 ? jsonOf(ordered) : undefined;
  if (!check(ordered, { '주문 201': () => typeof order?.orderId === 'string' })) return;

  const auth = http.post(`${SIM_URL}/sim/authenticate`, JSON.stringify({ orderId: order.orderId, amount: order.amount, orderName: order.orderName }), {
    headers: { authorization: SIM_AUTH, 'content-type': 'application/json' },
    tags: { route: 'sim_auth' },
    responseCallback: http.expectedStatuses(200),
  });
  const paymentKey = auth.status === 200 ? jsonOf(auth)?.paymentKey : undefined;
  if (!check(auth, { '결제창 인증 200': () => typeof paymentKey === 'string' })) return;

  const paid = call('POST', `/v0/orders/${order.orderId}/payment`, { user: u, route: 'payment', body: { paymentKey, amount: order.amount }, expected: [200] });
  if (!check(paid, { '결제 확정 200': (x) => x.status === 200 })) return;

  const viewed = call('GET', `/v0/orders/${order.orderId}`, { user: u, route: 'order_view', expected: [200] });
  check(viewed, { '주문 확정 CONFIRMED': (x) => x.status === 200 && jsonOf(x)?.status === 'CONFIRMED' });
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
