// 부하 발생기 보정(docs/verification.md §3.9 '발생기 보정', docs/perf-ledger.md §3 2번). 실행: node loadtest/run.mjs calibrate …
// 대상 대신 빈 응답 대역(nginx, TLS, 고정 JSON)에 대기 상태 조회와 같은 모양의 요청(쿠키·X-Forwarded-For를 단 HTTPS GET, 응답 JSON 읽기)을
// 정한 도착률로 보낸다(phase:warm → main, route:status). 판정은 실행 도구가 한다(loadtest/runner/results.mjs judgeCalibrationStep).
// 환경 값: RATE WARM_S MAIN_S PRE_VUS MAX_VUS EVENT_ID (+ common.js의 BASE RUN_TAG OUT_DIR USERS_FILE)
import { check } from 'k6';
import { openPhases } from '../lib/model.mjs';
import { baseOptions, call, envInt, envStr, jsonOf, markScenarios, user, userCount, writeSummary } from './common.js';

export { markEnd, markStart } from './common.js';

const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 500);
const EVENT_ID = envStr('EVENT_ID', '00000000-0000-4000-8000-000000000000');

const phases = openPhases({ exec: 'get', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: 0, preVUs: PRE_VUS, maxVUs: MAX_VUS });

export const options = baseOptions({ warm: phases.warm, main: phases.main, ...markScenarios(WARM_S, WARM_S + MAIN_S) }, ['status']);

export function setup() {
  if (userCount() < 1) throw new Error('토큰 파일이 비었다');
}

export function get() {
  const u = user(Math.floor(Math.random() * userCount()));
  const r = call('GET', `/v1/queues/${EVENT_ID}/entries/me`, { user: u, route: 'status', expected: [200] });
  check(r, { '빈 응답 200·JSON': (x) => x.status === 200 && jsonOf(x)?.status === 'WAITING' });
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
