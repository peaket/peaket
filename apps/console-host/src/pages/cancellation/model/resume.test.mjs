// R-T45 ④ SCR-047 재개 조건 모델(F-07-15 I-06). 서버가 준 resume을 배지로 옮긴다.
// 기준 트리에는 resumeConditionOf·resumeBadgeOf가 없어 이 시험이 실행 중 TypeError로 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as live from './live.ts';

const resume = (over = {}) => ({
  circuitState: 'closed',
  calls: 20,
  failures: 0,
  failureRateBp: 0,
  windowSeconds: 300,
  state: 'ELIGIBLE',
  ...over,
});

test('R-T45 ④ 서버의 다섯 상태·배지·상세 해석을 함께 본다', () => {
  assert.equal(live.resumeConditionOf(resume())?.state, 'ELIGIBLE');
  assert.equal(live.resumeConditionOf(resume({ state: 'NO_SAMPLE', calls: 0, failureRateBp: null }))?.state, 'NO_SAMPLE');
  assert.equal(live.resumeConditionOf(resume({ state: 'FAILURE_RATE_HIGH', failureRateBp: 500 }))?.failureRateBp, 500);
  assert.equal(live.resumeConditionOf(resume({ state: 'CIRCUIT_OPEN', circuitState: 'open' }))?.circuitState, 'open');
  assert.equal(live.resumeConditionOf(resume({ state: 'CIRCUIT_UNAVAILABLE', circuitState: null }))?.state, 'CIRCUIT_UNAVAILABLE');
  assert.equal(live.resumeConditionOf(resume({ state: 'UNKNOWN' })), null);
  assert.equal(live.resumeConditionOf(resume({ calls: -1 })), null);
  assert.equal(live.resumeConditionOf(resume({ windowSeconds: 299 })), null);

  assert.deepEqual(live.resumeBadgeOf(resume()), { tone: 'ok', text: '재개 조건 충족' });
  assert.deepEqual(live.resumeBadgeOf(resume({ state: 'NO_SAMPLE', calls: 0, failureRateBp: null })), { tone: 'muted', text: '표본 없음(최근 5분 호출 0) · commander가 판단합니다' });
  assert.match(live.resumeBadgeOf(resume({ state: 'FAILURE_RATE_HIGH', failureRateBp: 700 })).text, /실패율 7\.0%/);
  assert.deepEqual(live.resumeBadgeOf(resume({ state: 'CIRCUIT_OPEN', circuitState: 'open' })), { tone: 'warn', text: '서킷이 열려 있습니다' });
  assert.deepEqual(live.resumeBadgeOf(resume({ state: 'CIRCUIT_UNAVAILABLE', circuitState: null })), { tone: 'muted', text: '서킷 상태를 읽지 못했습니다' });

  const view = live.detailView({
    requestId: 'req-1',
    status: 'PAUSED',
    progress: { total: 30, done: 1, failed: 0, perPg: [{ pg: 'TOSS', state: 'PAUSED', pauseReason: 'AUTO_FAILURE_RATE', done: 1, failed: 0, unknown: 0, resume: resume({ state: 'FAILURE_RATE_HIGH', failureRateBp: 1000 }), secret: '내부' }] },
  });
  assert.equal(view.progress.perPg[0].resume?.state, 'FAILURE_RATE_HIGH');
  assert.equal(view.progress.perPg[0].resume?.failureRateBp, 1000);
  assert.equal('secret' in (view.progress.perPg[0].resume ?? {}), false);
  const none = live.detailView({ requestId: 'req-1', status: 'PAUSED', progress: { total: 2, done: 1, failed: 0, perPg: [{ pg: 'TOSS', state: 'PAUSED', done: 1, failed: 0, unknown: 0 }] } });
  assert.equal(none.progress.perPg[0].resume, null);
  assert.equal(none.progress.total, 2);
});
