// K1 대기열 시나리오의 v1 쪽(Q-T2, docs/verification.md §3.9 'v1 경로'). 실행: node loadtest/run.mjs v1 queue …(인자는 v0 queue와 같다)
// v0-queue.js와 같은 모델이다: 가상 대기자 USERS명이 ENTRY_RATE로 진입하고(route:preverify·entry, phase:prep), 그 뒤로는 대기자들이 만드는 조회 도착률만 만든다
// (§3.4, 서버와 같은 거리별 간격, 부르는 속도 모델은 ADMIT_PER_SECOND). v1은 대기 상태를 공개 대기 상태 파일(구역마다 하나)로 읽으며 nginx 캐시를 거친다(route:status).
// 입장 확정(route:admission)에는 그 사람의 대기표가 있어야 해서, 진입과 조회를 한 시나리오(flow)에 두고 VU마다 자기가 넣은 사람만 입장시킨다:
// 조회 한 번에서 읽은 serving이 자기 사람의 순번 이상이면 그 사람 하나를 입장 확정한다. 서버의 실제 입장 속도는 v1 입장 제어(초당 1,000명 상수, 동시 목표 5,000명)를 따른다.
// 구간 꼬리표는 시각으로 단다(진입 반복은 prep, 그 뒤 ENTRY_S + WARM_S까지 warm, 그 뒤 main). 로비 없이 오픈 뒤 진입이다(§3.9 'K1의 로비 없음').
// 환경 값: EVENT_ID USERS ENTRY_RATE ADMIT_PER_SECOND WARM_S MAIN_S PRE_VUS MAX_VUS(+ v1-common.js의 주소·신원)
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { pickPollUser, pollGroups, pollStages } from '../lib/model.mjs';
import { ROUTE_TARGETS } from '../lib/targets.mjs';
import { baseOptions } from './common.js';
import { admitV1, enterV1, envInt, envStr, markScenarios, stateServing, writeSummary } from './v1-common.js';

export { markEnd, markStart } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const Q = { users: envInt('USERS'), entryRate: envInt('ENTRY_RATE'), admitPerSecond: envInt('ADMIT_PER_SECOND') };
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 500);
const ENTRY_S = Math.ceil(Q.users / Q.entryRate);
/** 조회할 사람이 없던 반복(모두 불리고 5초가 지남). 요청을 보내지 않는다 */
const pollEmpty = new Counter('poll_empty');

const warm = pollStages({ ...Q, startS: ENTRY_S, durationS: WARM_S });
const main = pollStages({ ...Q, startS: ENTRY_S + WARM_S, durationS: MAIN_S });

export const options = baseOptions(
  {
    flow: {
      executor: 'ramping-arrival-rate',
      startRate: Q.entryRate,
      timeUnit: '1s',
      // 진입 구간 → (예열 첫 도착률로 건너뜀) 예열 → (본구간 첫 도착률로 건너뜀) 본구간
      stages: [{ target: Q.entryRate, duration: `${ENTRY_S}s` }, { target: warm.startRate, duration: '0s' }, ...warm.stages, { target: main.startRate, duration: '0s' }, ...main.stages],
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      exec: 'flow',
      tags: { phase: 'warm' },
    },
    ...markScenarios(ENTRY_S + WARM_S, ENTRY_S + WARM_S + MAIN_S),
  },
  ['preverify', 'entry', 'status', 'admission'],
);
options.thresholds['poll_empty{phase:main}'] = ['count>=0'];
options.thresholds['poll_empty{phase:warm}'] = ['count>=0'];
// K1 진입 점검: 진입은 진입 구간(phase:prep)에서만 나간다(v0-queue.js와 같다. 실행 도구가 checksFromSummary에 { entry: 'prep' }을 준다)
options.thresholds['http_reqs{phase:prep,route:entry}'] = ['count>=0'];
options.thresholds['http_req_duration{phase:prep,route:entry}'] = ['max>=0'];
options.thresholds['http_req_failed{phase:prep,route:entry}'] = ['rate>=0'];
for (const t of ROUTE_TARGETS.entry) options.thresholds[`over_target{phase:prep,route:entry,le:${t.le}}`] = ['count>=0'];

/** 이 VU가 넣고 아직 입장시키지 않은 사람(순번 차례) */
const mine = [];

export function flow() {
  const it = exec.scenario.iterationInTest;
  if (it < Q.users) {
    const entry = enterV1(EVENT_ID, it, { phase: 'prep', record: true });
    if (entry) mine.push({ i: it, entry });
    return;
  }
  const tS = (Date.now() - exec.scenario.startTime) / 1000;
  const phase = tS < ENTRY_S + WARM_S ? 'warm' : 'main';
  const i = pickPollUser(pollGroups(tS, Q), Math.random(), Math.random());
  if (i < 0) {
    pollEmpty.add(1, { phase });
    return;
  }
  // 모델의 사람 i는 순번 ≈ i + 1이라 그 구역 파일을 읽는다
  const { serving } = stateServing(EVENT_ID, Math.floor(i / 1000), { phase });
  const k = mine.findIndex((m) => m.entry.seq <= serving);
  if (k < 0) return;
  const m = mine[k];
  const body = admitV1(EVENT_ID, m.i, m.entry, { phase, record: true });
  // 아직 차례가 아니면(SOON·NOT_YET) 남겨 두고 다음 조회에서 다시 묻는다. 그 밖(입장·거절)은 뺀다
  if (body?.status !== 'SOON' && body?.status !== 'NOT_YET') mine.splice(k, 1);
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
