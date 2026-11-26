// F-05-9 K10 판정 함수 시험(계획 docs/review/plans/F-05-9.md §5·§13).
// 이 시험은 실제 300건·10분을 재지 않는다. 판정 함수가 정본의 기준을 맞게 가르는지만 본다.
// 실제 측정은 측정 창 3에서 하고, 그 결과를 docs/review/ledger-notes.md에 '측정'으로 적는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  K10,
  judgeLane,
  judgeTransition,
  lanePlan,
  laneRunValidity,
  meetsRatio,
  median,
  percentile,
  stoppedTimeMs,
  throughputPerMinute,
  transitionPlan,
  transitionWindowIndexes,
} from './k10-lib.mjs';

/** O-T40 합성 실행. 기본은 모두 통과하는 값이다. */
function runOf({ count = 330, switchAt = 150, latency = 100, transitionLatency = 120, result = 'PASS', warmup = 10 } = {}) {
  const scans = Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    const phase = index < switchAt ? 'online' : index <= K10.transitionScans ? 'offline' : 'recovery';
    const inWindow = (index >= 120 && index <= 180) || index > K10.transitionScans;
    const ms = inWindow ? transitionLatency : latency;
    return {
      index,
      phase,
      presentedAtMs: index * 2_000,
      decodedAtMs: index * 2_000 + 10,
      verdictAtMs: index * 2_000 + ms,
      result,
    };
  });
  return {
    scans,
    expectedScans: count,
    warmup,
    transitionWindows: transitionWindowIndexes({ switchAt, total: K10.transitionScans, recovery: count - K10.transitionScans }),
    queueAfter: 0,
    expectedUploadedIds: scans.map((s) => `id-${s.index}`),
    uploadedIds: scans.map((s) => `id-${s.index}`),
  };
}

/** O-T41 합성 실행. */
function laneRun({ condition, run, perMinute, valid = true, nonPass = 0, missing = 0 }) {
  return { condition, run, perMinute, valid, nonPass, missing };
}

test('O-T40 판정은 330건이 모두 PASS이고 평소 p95·전환 최대가 150ms 안이며 큐가 0이면 통과한다', () => {
  const verdict = judgeTransition(runOf());
  assert.equal(verdict.pass, true, verdict.reasons.join(' / '));
  assert.equal(verdict.metrics.normalP95Ms, 100);
  assert.equal(verdict.metrics.transitionMaxMs, 120);
  assert.equal(verdict.metrics.stoppedMs, 0);
});

test('O-T40 판정은 전환 앞뒤 최대가 150ms를 넘으면 실패한다', () => {
  const verdict = judgeTransition(runOf({ transitionLatency: 150.1 }));
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /전환 앞뒤 최대 150\.1ms > 150ms/);
});

test('O-T40 판정은 전환 최대가 정확히 150ms면 통과한다', () => {
  const verdict = judgeTransition(runOf({ transitionLatency: 150 }));
  assert.equal(verdict.pass, true, verdict.reasons.join(' / '));
});

test('O-T40 판정은 평소 p95가 150ms를 넘으면 실패한다', () => {
  const verdict = judgeTransition(runOf({ latency: 151 }));
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /평소 p95 151\.0ms > 150ms/);
});

test('O-T40 판정은 오류·비정상 판정을 실패로 센다', () => {
  const rejected = runOf();
  rejected.scans[50].result = 'REJECT';
  const verdict = judgeTransition(rejected);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /오류·비정상 판정 1건/);
});

test('O-T40 판정은 결과 없는 판정을 실패로 센다', () => {
  const missing = runOf();
  missing.scans[60].verdictAtMs = 0;
  const verdict = judgeTransition(missing);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /결과 없음 1건/);
});

test('O-T40 판정은 3초를 넘긴 멈춘 시간을 실패로 센다', () => {
  const stopped = runOf();
  stopped.scans[70].verdictAtMs = stopped.scans[70].presentedAtMs + 3_500;
  const verdict = judgeTransition(stopped);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /멈춘 시간 500ms > 0/);
});

test('O-T40 판정은 남은 스캔 큐를 실패로 센다', () => {
  const queued = runOf();
  queued.queueAfter = 1;
  const verdict = judgeTransition(queued);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /스캔 큐 1건이 남았다/);
});

test('O-T40 판정은 빠진 업로드와 같은 기록 두 번 올리기를 실패로 센다', () => {
  const upload = runOf();
  upload.uploadedIds = upload.uploadedIds.slice(0, -1);
  const r1 = judgeTransition(upload);
  assert.equal(r1.pass, false);
  assert.match(r1.reasons.join(' / '), /올리지 못한 기록 1건/);
  assert.match(r1.reasons.join(' / '), /올린 기록 329\/330건/);

  const duplicate = runOf();
  duplicate.uploadedIds = [...duplicate.uploadedIds, duplicate.uploadedIds[0]];
  const r2 = judgeTransition(duplicate);
  assert.equal(r2.pass, false);
  assert.match(r2.reasons.join(' / '), /같은 기록을 두 번 올렸다\(1건\)/);
});

test('O-T41 판정은 오프라인 중앙값이 온라인의 90% 이상일 때 통과한다', () => {
  const verdict = judgeLane({
    onlineRuns: [laneRun({ condition: 'online', run: 1, perMinute: 30 }), laneRun({ condition: 'online', run: 2, perMinute: 31 }), laneRun({ condition: 'online', run: 3, perMinute: 29 })],
    offlineRuns: [laneRun({ condition: 'offline', run: 1, perMinute: 27 }), laneRun({ condition: 'offline', run: 2, perMinute: 27.5 }), laneRun({ condition: 'offline', run: 3, perMinute: 26.5 })],
  });
  assert.equal(verdict.pass, true, verdict.reasons.join(' / '));
  assert.equal(verdict.metrics.onlineMedian, 30);
  assert.equal(verdict.metrics.offlineMedian, 27);
  assert.equal(verdict.metrics.ratioPercent, 90);
});

test('O-T41 판정은 90% 아래를 실패로 하고 90.0% 경계를 통과로 센다', () => {
  assert.equal(meetsRatio(27, 30, 90), true, '27/30 = 90.0%');
  assert.equal(meetsRatio(26.9, 30, 90), false, '26.9/30 = 89.7%');

  const fail = judgeLane({
    onlineRuns: [laneRun({ condition: 'online', run: 1, perMinute: 30 }), laneRun({ condition: 'online', run: 2, perMinute: 30 }), laneRun({ condition: 'online', run: 3, perMinute: 30 })],
    offlineRuns: [laneRun({ condition: 'offline', run: 1, perMinute: 26.9 }), laneRun({ condition: 'offline', run: 2, perMinute: 26.9 }), laneRun({ condition: 'offline', run: 3, perMinute: 26.9 })],
  });
  assert.equal(fail.pass, false);
  assert.match(fail.reasons.join(' / '), /89\.7% < 90%/);
});

test('O-T41 판정은 유효한 실행이 3회씩 없으면 실패한다', () => {
  const verdict = judgeLane({
    onlineRuns: [laneRun({ condition: 'online', run: 1, perMinute: 30 }), laneRun({ condition: 'online', run: 2, perMinute: 30, valid: false }), laneRun({ condition: 'online', run: 3, perMinute: 30 })],
    offlineRuns: [laneRun({ condition: 'offline', run: 1, perMinute: 27 }), laneRun({ condition: 'offline', run: 2, perMinute: 27 }), laneRun({ condition: 'offline', run: 3, perMinute: 27 })],
  });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /유효한 온라인 실행 2\/3/);
});

test('O-T41 한 실행의 유효성은 창·사람 수·결과·네트워크·새로고침·호스트 포화를 본다', () => {
  const base = { windowMs: K10.laneWindowMs, verdicts: 300, nonPass: 0, missing: 0, tickets: Array.from({ length: 20 }, (_, i) => `t-${i}`), network: 'offline', expectedNetwork: 'offline', pageReloaded: false, hostCpuPercent: 40 };
  assert.equal(laneRunValidity(base).valid, true, laneRunValidity(base).reasons.join(' / '));

  const short = laneRunValidity({ ...base, windowMs: K10.laneWindowMs - 6_000 });
  assert.equal(short.valid, false);
  assert.match(short.reasons.join(' / '), /창/);

  const few = laneRunValidity({ ...base, tickets: base.tickets.slice(0, 19) });
  assert.equal(few.valid, false);
  assert.match(few.reasons.join(' / '), /사람 19\/20/);

  const wrongNet = laneRunValidity({ ...base, network: 'online' });
  assert.equal(wrongNet.valid, false);
  assert.match(wrongNet.reasons.join(' / '), /네트워크/);

  const reloaded = laneRunValidity({ ...base, pageReloaded: true });
  assert.equal(reloaded.valid, false);
  assert.match(reloaded.reasons.join(' / '), /새로고침/);

  const hot = laneRunValidity({ ...base, hostCpuPercent: 81 });
  assert.equal(hot.valid, false);
  assert.match(hot.reasons.join(' / '), /호스트 CPU 81%/);
});

test('K10 전환 일정은 149건 온라인·151건 오프라인·30건 복구다', () => {
  const plan = transitionPlan();
  assert.equal(plan.length, 330);
  assert.equal(plan.filter((s) => s.phase === 'online').length, 149);
  assert.equal(plan.filter((s) => s.phase === 'offline').length, 151);
  assert.equal(plan.filter((s) => s.phase === 'recovery').length, 30);
  assert.equal(plan[148].phase, 'online', '149번째는 온라인');
  assert.equal(plan[149].phase, 'offline', '150번째는 오프라인');
  assert.equal(plan[299].phase, 'offline', '300번째는 오프라인');
  assert.equal(plan[300].phase, 'recovery', '301번째는 복구');
});

test('K10 전환 창은 120~180번째와 301~330번째다', () => {
  assert.deepEqual(transitionWindowIndexes(), [[120, 180], [301, 330]]);
});

test('K10 레인 일정은 사람 20명과 10분 창을 만든다', () => {
  const plan = lanePlan();
  assert.equal(plan.people.length, 20);
  assert.equal(plan.windowMs, 600_000);
  assert.deepEqual(plan.people.slice(0, 3), [0, 1, 2]);
});

test('K10 백분위는 가까운 차례로 고르고 중앙값은 짝수에서 가운데 둘의 평균이다', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(values, 0.95), 95);
  assert.equal(percentile(values, 0.5), 50);
  assert.equal(percentile([], 0.95), undefined);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(throughputPerMinute(300, 600_000), 30);
  assert.equal(throughputPerMinute(300, 0), undefined);
});

test('K10 멈춘 시간은 3초를 넘긴 대기만 센다', () => {
  assert.equal(stoppedTimeMs([{ presentedAtMs: 0, verdictAtMs: 3_000 }]), 0);
  assert.equal(stoppedTimeMs([{ presentedAtMs: 0, verdictAtMs: 3_500 }]), 500);
  assert.equal(stoppedTimeMs([{ presentedAtMs: 0, verdictAtMs: 0 }], { scanTimeoutMs: 10_000 }), 7_000);
});
