// K10(O-T1의 v0 한계) 검표 시나리오(docs/verification.md §3.10, docs/features/offline-gate.md §13). 실행: node loadtest/run.mjs v0 gate …
// v0 검표는 온라인 전용이라 스캐너가 찍을 때마다 서버에 코드를 보내 판정을 받는다(POST /v0/events/{eventId}/scans, route:scan).
// 스캐너 SCANNERS대(검표 스태프 계정, 실행 도구가 그 회차에 배정)가 합쳐 초당 RATE장을 찍는다(예열 → 본구간). 티켓은 한 장에 한 번씩 찍는다
// (본구간은 앞 번호부터, 예열은 뒤 번호부터). 본구간 도중 실행 도구가 입구를 끊었다가(입구 파드를 0개로) 되돌린다.
// 스캐너의 판정 대기 상한은 SCAN_TIMEOUT(기본 3s)이다. 본구간의 시도마다 검표 시도 줄(gate_scan)을 콘솔에 낸다(시험 기록이 아니다).
// 환경 값: EVENT_ID SCANNERS RATE WARM_S MAIN_S TICKETS CODES_FILE PRE_VUS MAX_VUS SCAN_TIMEOUT (+ common.js의 BASE ORIGIN RUN_TAG OUT_DIR USERS_FILE)
import exec from 'k6/execution';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { openPhases } from '../lib/model.mjs';
import { baseOptions, call, emit, envInt, envStr, jsonOf, markScenarios, scenarioErrors, user, userCount, writeSummary } from './common.js';

export { markEnd, markStart } from './common.js';

const EVENT_ID = envStr('EVENT_ID');
const SCANNERS = envInt('SCANNERS');
const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const TICKETS = envInt('TICKETS');
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 500);
const SCAN_TIMEOUT = envStr('SCAN_TIMEOUT', '3s');
const CODES_FILE = envStr('CODES_FILE', '/work/codes.json');
const RESULTS = ['ADMIT', 'ALREADY_ENTERED', 'INVALID', 'WRONG_EVENT'];

/** 티켓 코드(번호 → 코드). 실행 도구가 발권 공개 함수로 만든 합성 티켓이다 */
const codes = new SharedArray('codes', () => JSON.parse(open(CODES_FILE)));

const scans = openPhases({ exec: 'scan', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: 0, preVUs: PRE_VUS, maxVUs: MAX_VUS });

export const options = baseOptions({ warm: scans.warm, main: scans.main, ...markScenarios(WARM_S, WARM_S + MAIN_S) }, ['scan']);

export function setup() {
  if (userCount() < SCANNERS) throw new Error(`토큰 파일의 스캐너(${userCount()})가 SCANNERS보다 적다`);
  if (codes.length < TICKETS) throw new Error(`티켓 코드(${codes.length})가 TICKETS보다 적다`);
}

/** 검표 한 번: 본구간은 앞 번호부터, 예열은 뒤 번호부터 티켓을 쓴다(도착률 실행기는 구간마다 한 번 더 시작할 수 있다) */
export function scan() {
  const it = exec.scenario.iterationInTest;
  const main = exec.scenario.name === 'main';
  const t = main ? it : TICKETS - 1 - it;
  if (t < 0 || t >= TICKETS) {
    scenarioErrors.add(1);
    return;
  }
  const scanner = user(t % SCANNERS);
  const startedMs = Date.now();
  const r = call('POST', `/v0/events/${EVENT_ID}/scans`, { user: scanner, route: 'scan', body: { code: codes[t] }, expected: [200], timeout: SCAN_TIMEOUT });
  const endedMs = Math.max(Date.now(), startedMs);
  const result = r.status === 200 ? jsonOf(r)?.result : undefined;
  const ok = RESULTS.includes(result);
  check(r, { '검표 판정': () => ok });
  if (main) emit({ kind: 'gate_scan', startedMs, endedMs, ok, result: ok ? result : null });
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
