// K1(Q-T2의 v0 쪽) 대기열 시나리오(docs/verification.md §3.4·§3.9). 실행: node loadtest/run.mjs v0 queue …
// 1) 가상 대기자 USERS명이 ENTRY_RATE로 진입한다(phase:prep, route:entry, 시험 기록 queue_entry).
// 2) 사람 수만큼 연결을 만들지 않고 대기자들이 만드는 조회 도착률만 만든다: 시각 t의 묶음(서버와 같은 거리별 간격)으로
//    '묶음 인원 ÷ 주기'의 합을 10초 칸마다 다시 계산한 단계(ramping-arrival-rate, phase:warm → main).
//    조회 하나는 묶음 도착률에 비례한 확률로 고른 사람의 대기 상태를 묻고(route:status), CALLED면 입장 확정을 보낸다(route:admission, queue_admit).
// 환경 값: EVENT_ID USERS ENTRY_RATE ADMIT_PER_SECOND WARM_S MAIN_S PRE_VUS MAX_VUS (+ common.js의 BASE ORIGIN RUN_TAG OUT_DIR USERS_FILE)
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { pickPollUser, pollGroups, pollStages, rampingPhases } from '../lib/model.mjs';
import { ROUTE_TARGETS } from '../lib/targets.mjs';
import { admitQueue, baseOptions, call, enterQueue, envInt, envStr, jsonOf, markScenarios, user, userCount, writeSummary } from './common.js';

export { markEnd, markStart } from './common.js';

const EVENT_ID = envStr('EVENT_ID');
const Q = { users: envInt('USERS'), entryRate: envInt('ENTRY_RATE'), admitPerSecond: envInt('ADMIT_PER_SECOND') };
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 500);
/** 조회할 사람이 없던 반복(모두 불리고 5초가 지남). 요청을 보내지 않는다. 본구간 조회 수 + 이 수 = 계획한 반복 수 */
const pollEmpty = new Counter('poll_empty');
/** 진입이 끝나는 시각(초). 조회는 그 뒤부터 */
const ENTRY_S = Math.ceil(Q.users / Q.entryRate);

const polls = rampingPhases({
  exec: 'poll',
  startS: ENTRY_S,
  warmS: WARM_S,
  mainS: MAIN_S,
  warm: pollStages({ ...Q, startS: ENTRY_S, durationS: WARM_S }),
  main: pollStages({ ...Q, startS: ENTRY_S + WARM_S, durationS: MAIN_S }),
  preVUs: PRE_VUS,
  maxVUs: MAX_VUS,
});

export const options = baseOptions(
  {
    entry: {
      executor: 'constant-arrival-rate',
      rate: Q.entryRate,
      timeUnit: '1s',
      duration: `${ENTRY_S}s`,
      startTime: '0s',
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      exec: 'enter',
      tags: { phase: 'prep' },
    },
    warm: polls.warm,
    main: polls.main,
    ...markScenarios(ENTRY_S + WARM_S, ENTRY_S + WARM_S + MAIN_S),
  },
  ['entry', 'status', 'admission'],
);
options.thresholds['poll_empty{phase:main}'] = ['count>=0'];
options.thresholds['poll_empty{phase:warm}'] = ['count>=0'];
// K1 진입 점검(docs/verification.md §3.10 '경로 목표 점검'): 진입은 예열 앞의 진입 구간(phase:prep)에서만 나간다. k6는 기준을 건 하위 지표만
// 요약에 남기므로 그 구간의 요청 수·시간·실패·목표를 넘은 수에 기준을 건다(실행 도구가 checksFromSummary에 { entry: 'prep' }을 준다)
options.thresholds['http_reqs{phase:prep,route:entry}'] = ['count>=0'];
options.thresholds['http_req_duration{phase:prep,route:entry}'] = ['max>=0'];
options.thresholds['http_req_failed{phase:prep,route:entry}'] = ['rate>=0'];
for (const t of ROUTE_TARGETS.entry) options.thresholds[`over_target{phase:prep,route:entry,le:${t.le}}`] = ['count>=0'];

export function setup() {
  if (userCount() < Q.users) throw new Error(`토큰 파일의 가상 사용자(${userCount()})가 USERS보다 적다`);
}

/** 진입: 반복 번호 i가 곧 가상 사용자 i다(순번 ≈ i + 1) */
export function enter() {
  const i = exec.scenario.iterationInTest;
  if (i >= Q.users) return;
  enterQueue(EVENT_ID, user(i));
}

/** 조회: 모델 시각 t(진입 시작부터 초)의 묶음에서 한 사람을 고른다 */
export function poll() {
  const offsetS = exec.scenario.name === 'main' ? ENTRY_S + WARM_S : ENTRY_S;
  const tS = (Date.now() - exec.scenario.startTime) / 1000 + offsetS;
  const i = pickPollUser(pollGroups(tS, Q), Math.random(), Math.random());
  if (i < 0) {
    pollEmpty.add(1);
    return;
  }
  const u = user(i);
  const r = call('GET', `/v1/queues/${EVENT_ID}/entries/me`, { user: u, route: 'status', expected: [200] });
  check(r, { '대기 상태 200': (x) => x.status === 200 });
  if (r.status === 200 && jsonOf(r)?.status === 'CALLED') admitQueue(EVENT_ID, u);
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
