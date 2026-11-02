// K2·K3(S-T1·S-T10의 v0 쪽) 좌석 홀드 시나리오(docs/verification.md §3.9). 실행: node loadtest/run.mjs v0 seat-hold …
// 준비 구간(phase:prep)에 가상 사용자를 진입·입장시키고, 홀드를 정한 도착률로 보낸다(phase:warm → main, route:hold).
// 좌석 고르기: spread(붙은 좌석 HOLD_SIZE석을 고르게 흩음) · hot(첫 HOT_COUNT석에 몰림, S-T1) · crossed(같은 두 좌석을 엇갈린 순서로, S-T10).
// 잡은 홀드는 RELEASE_MS 뒤 놓는다(route:release). 409(이미 잡힘)·422(1인 한도)는 업무상 기대한 거절이라 실패율에 넣지 않는다.
// 환경 값: EVENT_ID USERS RATE WARM_S MAIN_S MODE HOLD_SIZE HOT_COUNT PAIRS RELEASE_MS SECTIONS ROWS PER_ROW PREP_RATE PRE_VUS MAX_VUS
import { check, sleep } from 'k6';
import { openPhases } from '../lib/model.mjs';
import { pickHoldSeats } from '../lib/seats.mjs';
import { admitQueue, scenarioErrors, baseOptions, call, enterQueue, envInt, envStr, jsonOf, markScenarios, prepScenarios, user, userCount, writeSummary } from './common.js';
import exec from 'k6/execution';

export { markEnd, markStart } from './common.js';

const EVENT_ID = envStr('EVENT_ID');
const USERS = envInt('USERS');
const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const MODE = envStr('MODE', 'spread');
const HOLD_SIZE = envInt('HOLD_SIZE', 2);
const HOT_COUNT = envInt('HOT_COUNT', 1);
const PAIRS = envInt('PAIRS', 1);
const RELEASE_MS = envInt('RELEASE_MS', 0);
const GRID = { sections: envStr('SECTIONS').split(','), rows: envInt('ROWS'), perRow: envInt('PER_ROW') };
const PREP_RATE = envInt('PREP_RATE', Math.min(USERS, 200));
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 500);

const prep = prepScenarios(USERS, PREP_RATE);
const holds = openPhases({ exec: 'hold', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: prep.prepS, preVUs: PRE_VUS, maxVUs: MAX_VUS });

export const options = baseOptions(
  { ...prep.scenarios, warm: holds.warm, main: holds.main, ...markScenarios(prep.prepS + WARM_S, prep.prepS + WARM_S + MAIN_S) },
  ['hold', 'release'],
);

export function setup() {
  if (userCount() < USERS) throw new Error(`토큰 파일의 가상 사용자(${userCount()})가 USERS보다 적다`);
}

export function prepEntry() {
  const i = exec.scenario.iterationInTest;
  if (i < USERS) enterQueue(EVENT_ID, user(i), false);
}

export function prepAdmit() {
  const i = exec.scenario.iterationInTest;
  if (i >= USERS) return;
  // 입장 루프가 1초 칸마다 부르므로 차례가 아직이면 조금 뒤 다시 묻는다
  for (let k = 0; k < 20; k++) {
    if (admitQueue(EVENT_ID, user(i), false) === 'ADMITTED') return;
    sleep(0.5);
  }
  check(null, { '준비 입장': () => false });
  scenarioErrors.add(1);
}

export function hold() {
  const u = user(Math.floor(Math.random() * USERS));
  const seatIds = pickHoldSeats(GRID, { mode: MODE, size: HOLD_SIZE, hotCount: HOT_COUNT, pairs: PAIRS, u1: Math.random(), u2: Math.random() });
  const r = call('POST', `/v1/events/${EVENT_ID}/holds`, { user: u, route: 'hold', body: { seatIds }, expected: [201, 409, 422] });
  if (r.status === 422 && String(r.body).includes('invalid-seat')) scenarioErrors.add(1);
  if (r.status !== 201) return;
  const holdId = jsonOf(r)?.holdId;
  if (typeof holdId !== 'string') return;
  if (RELEASE_MS > 0) sleep(RELEASE_MS / 1000);
  call('DELETE', `/v1/holds/${holdId}`, { user: u, route: 'release', expected: [204] });
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
