// 진입 서버 비례 확인(MSR-020)의 진입 경로 시나리오(docs/verification.md §3.3·§3.5 1번, 계획 docs/review/plans/F-08-2.md 6.3). 실행: node loadtest/run.mjs v1 entry-steps …
// 단계 하나 = k6 실행 하나다(회차는 단계마다 새로 연다, 로비 없음).
// - 사전 검증: 시나리오 밖(v1-entry-tokens.js)에서 실행 전에 한 번 만들어 `/work/out/prep.ndjson`에 둔다(2026-11-24 리허설 고침:
//   k6가 준비 시나리오와 진입 시나리오의 VU 상태를 잇는다고 보장하지 않아 진입 VU 일부가 토큰을 갖지 못했다).
// - 진입(phase:warm → main): 정한 도착률(constant-arrival-rate, §3.5 1번)로 진입(route:entry)만 보낸다. 반복마다 토큰 하나를 쓴다
//   (사람마다 진입 한 번, 같은 사람이 다시 들어오는 값싼 길을 재지 않는다). 토큰 번호는 시나리오의 반복 번호(iterationInTest)로 정한다.
//   토큰이 모자라면 보내지 않고 시나리오 오류로 센다(그 단계는 무효다).
// - 대기 상태 조회·입장 확정은 보내지 않는다.
// 환경 값: EVENT_ID RATE WARM_S MAIN_S ENTRY_VUS(+ v1-common.js의 주소·신원, 토큰 파일은 /work/out/prep.ndjson)
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { openPhases } from '../lib/model.mjs';
import { baseOptions } from './common.js';
import { envInt, envStr, markScenarios, QUEUE_BASE, scenarioErrors, vcall, writeSummary } from './v1-common.js';

export { markEnd, markStart } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
const ENTRY_VUS = envInt('ENTRY_VUS');
/** 토큰 파일 한 줄 = [사람 번호, 사전 검증 토큰]. 한 벌만 메모리에 두고 모든 VU가 나눠 읽는다 */
const TOKENS_FILE = envStr('TOKENS_FILE', '/work/out/prep.ndjson');
/** main 시나리오의 토큰 번호 시작. warm이 이보다 많이 돌면 겹치므로 5초 여유를 둔다(v1-entry-tokens.js와 같은 셈) */
const WARM_SLOTS = RATE * (WARM_S + 5);

const tokenRows = new SharedArray('entryTokens', () => {
  const rows = [];
  for (const line of open(TOKENS_FILE).split('\n')) {
    if (!line.startsWith('{')) continue;
    const row = JSON.parse(line);
    if (row && typeof row.token === 'string' && Number.isSafeInteger(row.i)) rows.push({ i: row.i, token: row.token });
  }
  return rows;
});

/** 진입할 토큰이 없어 보내지 못한 반복 수 */
const entryNoToken = new Counter('entry_no_token');

const phases = openPhases({ exec: 'entry', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: 0, preVUs: ENTRY_VUS, maxVUs: ENTRY_VUS });

export const options = baseOptions(
  {
    warm: phases.warm,
    main: phases.main,
    ...markScenarios(WARM_S, WARM_S + MAIN_S),
  },
  ['entry'],
);
options.thresholds['entry_no_token'] = ['count>=0'];

export function entry() {
  const index = (exec.scenario.name === 'main' ? WARM_SLOTS : 0) + exec.scenario.iterationInTest;
  const t = tokenRows[index];
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
