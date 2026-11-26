// MSR-020 진입 단계·F-08-4 정렬 비교의 사전 검증 토큰을 **측정 전에 한 번** 만들어 파일로 남기는 k6 스크립트
// (계획 docs/review/plans/F-08-2.md 6.3 리허설 고침, F-08-4 계획 §6.3).
// 왜 따로 도나: k6는 준비 시나리오와 진입 시나리오의 VU 상태(모듈 변수 pool)를 잇는다고 보장하지 않는다. 2026-11-24 리허설에서
// 진입 VU 일부가 토큰을 갖지 못해 entry_no_token이 992건 나왔다. 그래서 토큰은 이 스크립트가 만들어 out/prep.ndjson에 남기고,
// 진입 시나리오(v1-entry.js·v1-ordering.js)는 그 파일을 SharedArray로 읽어 반복 번호로 하나씩 쓴다.
// 실행: 발생기 파드 안에서 `k6 run ... loadtest/scenarios/v1-entry-tokens.js`(run.mjs가 측정 전에 한 번 부른다).
// 환경 값: EVENT_ID RATE WARM_S MAIN_S(진입 단계) 또는 EVENT_ID TOKENS_TOTAL TOKENS_RATE(정렬 비교)
//          (+ v1-common.js의 주소·신원). 토큰 번호 i는 두 경우 모두 0부터 센다.
import exec from 'k6/execution';
import { envInt, envStr, jsonOf, QUEUE_BASE, vcall } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const TOKENS_TOTAL = envInt('TOKENS_TOTAL', 0);
const TOKENS_START = envInt('TOKENS_START', 0);
const TOKENS_RATE = envInt('TOKENS_RATE', 1000);
const RATE = envInt('RATE', 0);
const WARM_S = envInt('WARM_S', 0);
const MAIN_S = envInt('MAIN_S', 0);

// 진입 시나리오가 쓰는 토큰 번호: warm은 0.., main은 WARM_SLOTS..에서 시작한다(v1-entry.js와 같은 셈).
// 실패가 섞여도 모자라지 않게 1.5배를 만들고, 두 구간의 여유(초)를 더한다.
const WARM_SLOTS = RATE * (WARM_S + 5);
const NEEDED = RATE * (MAIN_S + 1) + WARM_SLOTS + 2;
const USERS = RATE * (WARM_S + MAIN_S) + 2;
/** TOKENS_TOTAL을 주면 그 수만큼 만든다(F-08-4는 정확한 사람 수를 안다). 없으면 진입 단계 셈을 쓴다 */
const TOTAL = TOKENS_TOTAL > 0 ? TOKENS_TOTAL : Math.max(NEEDED, Math.ceil(USERS * 1.5));

export const options = {
  scenarios: {
    tokens: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, TOKENS_RATE),
      timeUnit: '1s',
      duration: `${Math.max(2, Math.ceil(TOTAL / Math.max(1, TOKENS_RATE)) + 1)}s`,
      preAllocatedVUs: Math.min(1000, Math.max(100, Math.ceil(TOKENS_RATE * 0.4))),
      maxVUs: Math.min(2000, Math.max(400, TOKENS_RATE)),
      exec: 'tokens',
    },
  },
  thresholds: {},
};

/** 사전 검증 하나. 한 줄 = {i: 사람 번호, token: 사전 검증 토큰}. */
export function tokens() {
  const it = exec.scenario.iterationInTest;
  if (it >= TOTAL) return;
  const i = TOKENS_START + it;
  const r = vcall(QUEUE_BASE, 'POST', `/v1/queues/${EVENT_ID}/pre-verifications`, {
    i,
    route: 'preverify',
    body: '{}',
    expected: [201],
    phase: 'prep',
    noTarget: true,
  });
  const token = r.status === 201 ? jsonOf(r)?.preverifyToken : undefined;
  if (typeof token === 'string') {
    console.log(JSON.stringify({ i, token }));
  }
}
