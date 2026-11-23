// 진입 서버 비례 확인(MSR-020)의 진입 경로 시나리오(docs/verification.md §3.3·§3.5 1번, 계획 docs/review/plans/F-08-2.md 6.3). 실행: node loadtest/run.mjs v1 entry-steps …
// 단계 하나 = k6 실행 하나다(회차는 단계마다 새로 연다, 로비 없음).
// - 준비(phase:prep, 측정에서 뺌, 0초 ~ PREP_S초): 가상 사용자(VU)마다 TOKENS_PER_VU명을 사전 검증해 자기 VU 안에 토큰을 쌓는다(route:preverify).
//   준비 시나리오의 VU 수(PREP_VUS)는 진입 시나리오의 VU 수(ENTRY_VUS)와 구간 표시 VU를 더한 것보다 크게 둔다. k6는 시간이 겹치지 않는 시나리오끼리
//   같은 VU를 이어 쓰므로 진입 시나리오의 VU는 모두 준비에서 토큰을 쌓은 VU다.
// - 진입(phase:warm → main): 정한 도착률(constant-arrival-rate, §3.5 1번)로 진입(route:entry)만 보낸다. 반복마다 자기 VU의 토큰 하나를 쓴다(사람마다 진입 한 번,
//   같은 사람이 다시 들어오는 값싼 길을 재지 않는다). 토큰이 모자라면 보내지 않고 시나리오 오류로 센다(그 단계는 무효다).
// - 대기 상태 조회·입장 확정은 보내지 않는다.
// 환경 값: EVENT_ID RATE WARM_S MAIN_S PREP_S TOKENS_PER_VU PREP_VUS ENTRY_VUS(+ v1-common.js의 주소·신원)
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { openPhases } from '../lib/model.mjs';
import { baseOptions } from './common.js';
import { envInt, envStr, jsonOf, markScenarios, QUEUE_BASE, scenarioErrors, vcall, writeSummary } from './v1-common.js';

export { markEnd, markStart } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const PREP_S = envInt('PREP_S');
const TOKENS_PER_VU = envInt('TOKENS_PER_VU');
const PREP_VUS = envInt('PREP_VUS');
const ENTRY_VUS = envInt('ENTRY_VUS');
/** 준비가 끝나고 진입 예열을 시작하기까지 여유(초). 준비 시나리오는 gracefulStop 0초라 이 뒤에 겹치지 않는다 */
const GAP_S = 1;

/** VU마다 준비를 다 마친 시각(준비 시작부터 ms). 실행 도구가 최댓값으로 다음 단계의 준비 길이를 정한다(runner/entry-scale.mjs prepSeconds) */
const prepElapsed = new Trend('prep_elapsed_ms');
/** 사전 검증 실패 수(토큰을 쌓지 못한 사람) */
const preverifyFailed = new Counter('preverify_failed');
/** 진입할 토큰이 없어 보내지 못한 반복 수 */
const entryNoToken = new Counter('entry_no_token');

const entryStartS = PREP_S + GAP_S;
const phases = openPhases({ exec: 'entry', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: entryStartS, preVUs: ENTRY_VUS, maxVUs: ENTRY_VUS });

export const options = baseOptions(
  {
    prep: { executor: 'per-vu-iterations', vus: PREP_VUS, iterations: TOKENS_PER_VU, maxDuration: `${PREP_S}s`, gracefulStop: '0s', exec: 'prep', tags: { phase: 'prep' } },
    warm: phases.warm,
    main: phases.main,
    ...markScenarios(entryStartS + WARM_S, entryStartS + WARM_S + MAIN_S),
  },
  ['entry'],
);
options.thresholds['prep_elapsed_ms'] = ['max>=0'];
options.thresholds['preverify_failed'] = ['count>=0'];
options.thresholds['entry_no_token'] = ['count>=0'];
options.thresholds['http_reqs{phase:prep,route:preverify}'] = ['count>=0'];

/** 이 VU가 쌓은 사람(번호·사전 검증 토큰) */
const pool = [];
let made = 0;

export function prep() {
  // 사람 번호는 테스트 전체에서 겹치지 않는 VU 번호로 나눈다(발생기를 나눠도 겹치지 않는다)
  const i = (exec.vu.idInTest - 1) * TOKENS_PER_VU + made;
  made += 1;
  const r = vcall(QUEUE_BASE, 'POST', `/v1/queues/${EVENT_ID}/pre-verifications`, { i, route: 'preverify', body: '{}', expected: [201], phase: 'prep', noTarget: true });
  const token = r.status === 201 ? jsonOf(r)?.preverifyToken : undefined;
  if (check(r, { '사전 검증 201': () => typeof token === 'string' })) pool.push({ i, token });
  else preverifyFailed.add(1);
  if (made === TOKENS_PER_VU) prepElapsed.add(Date.now() - exec.scenario.startTime);
}

export function entry() {
  const t = pool.pop();
  if (!t) {
    entryNoToken.add(1);
    scenarioErrors.add(1);
    return;
  }
  const r = vcall(QUEUE_BASE, 'POST', `/v1/queues/${EVENT_ID}/entries`, { i: t.i, route: 'entry', body: JSON.stringify({ preverifyToken: t.token }), expected: [201] });
  check(r, { '진입 201': (x) => x.status === 201 });
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
