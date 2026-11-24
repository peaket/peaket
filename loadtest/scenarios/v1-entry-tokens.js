// MSR-020 진입 단계의 사전 검증 토큰을 **측정 전에 한 번** 만들어 파일로 남기는 k6 스크립트(계획 docs/review/plans/F-08-2.md 6.3 리허설 고침).
// 왜 따로 도나: k6는 준비 시나리오와 진입 시나리오의 VU 상태(모듈 변수 pool)를 잇는다고 보장하지 않는다. 2026-11-24 리허설에서
// 진입 VU 일부가 토큰을 갖지 못해 entry_no_token이 992건 나왔다. 그래서 토큰은 이 스크립트가 만들어 out/prep.ndjson에 남기고,
// 진입 시나리오(v1-entry.js)는 그 파일을 SharedArray로 읽어 시나리오 반복 번호로 하나씩 쓴다.
// 실행: 발생기 파드 안에서 `k6 run ... loadtest/scenarios/v1-entry-tokens.js`(run.mjs가 측정 전에 한 번 부른다).
// 환경 값: EVENT_ID RATE WARM_S MAIN_S(+ v1-common.js의 주소·신원). 사람 수는 RATE × (WARM_S + MAIN_S) + 2다.
import { envInt, envStr, jsonOf, QUEUE_BASE, vcall } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');

// 진입 시나리오가 쓰는 토큰 번호: warm은 0.., main은 WARM_SLOTS..에서 시작한다(v1-entry.js와 같은 셈).
// 실패가 섞여도 모자라지 않게 1.5배를 만들고, 두 구간의 여유(초)를 더한다.
const WARM_SLOTS = RATE * (WARM_S + 5);
const NEEDED = RATE * (MAIN_S + 1) + WARM_SLOTS + 2;
const USERS = RATE * (WARM_S + MAIN_S) + 2;
const TOTAL = Math.max(NEEDED, Math.ceil(USERS * 1.5));

export const options = {
  vus: 1,
  iterations: 1,
  discardResponseBodies: false,
  thresholds: {},
};

export default function () {
  const started = Date.now();
  let made = 0;
  let failed = 0;
  for (let i = 0; i < TOTAL; i += 1) {
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
      // 한 줄 = {i: 사람 번호, token: 사전 검증 토큰}. 진입 시나리오가 이 줄만 골라 읽는다.
      console.log(JSON.stringify({ i, token }));
      made += 1;
    } else {
      failed += 1;
    }
  }
  console.log(JSON.stringify({ kind: 'prep', requested: TOTAL, made, failed, elapsed_ms: Date.now() - started }));
}
