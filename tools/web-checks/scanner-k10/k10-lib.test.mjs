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

/** O-T40 합성 실행. 기본은 모두 통과하는 값이다. 예열은 scans 밖이므로 warmup을 두지 않는다. */
function runOf({ count = 330, switchAt = 150, latency = 100, transitionLatency = 120, result = 'PASS', firstOnlineLatency, intervalStats, networkEvidence } = {}) {
  const scans = Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    const phase = index < switchAt ? 'online' : index <= K10.transitionScans ? 'offline' : 'recovery';
    const inWindow = (index >= 120 && index <= 180) || index > K10.transitionScans;
    const slowFirst = firstOnlineLatency !== undefined && index <= 10 && phase === 'online';
    const ms = slowFirst ? firstOnlineLatency : inWindow ? transitionLatency : latency;
    return {
      index,
      ticketId: `ticket-${index}`,
      phase,
      presentedAtMs: index * 2_000,
      decodedAtMs: index * 2_000 + 10,
      verdictAtMs: index * 2_000 + ms,
      result,
    };
  });
  const offlineScans = scans.filter((s) => s.phase === 'offline').length;
  return {
    scans,
    expectedScans: count,
    transitionAtScan: switchAt,
    reconnectAtScan: K10.transitionScans + 1,
    transitionWindows: transitionWindowIndexes({ switchAt, total: K10.transitionScans, recovery: count - K10.transitionScans }),
    queueAfter: 0,
    expectedUploadedIds: scans.map((s) => `id-${s.index}`),
    uploadedIds: scans.map((s) => `id-${s.index}`),
    pageReloaded: false,
    unknownPaths: 0,
    intervalStats: intervalStats ?? { targetMs: K10.intervalMs, toleranceMs: K10.intervalToleranceMs, maxMs: K10.intervalMaxMs, intervals: [], medianMs: 2_000, maxIntervalMs: 2_010, overruns: 0 },
    networkEvidence: networkEvidence ?? {
      observed: 'offline',
      before: 'online',
      afterOffline: 'offline',
      beforeReconnect: 'offline',
      afterReconnect: 'online',
      apiReachableBefore: true,
      apiReachableOffline: false,
      apiReachableAfter: true,
      offlineScans,
      offlineScansWithOnlineTrue: 0,
      queueBeforeReconnect: offlineScans,
    },
  };
}

/** O-T41 합성 실행. */
function laneRun({ condition, run, perMinute = 30, valid = true, nonPass = 0, missing = 0 }) {
  return { condition, run, perMinute, valid, nonPass, missing };
}

/** O-T41 유효성 기본값. 모두 유효한 온라인 실행이다. */
function laneValidityOf(over = {}) {
  return {
    windowMs: K10.laneWindowMs,
    verdicts: 300,
    perMinute: 30,
    nonPass: 0,
    missing: 0,
    tickets: Array.from({ length: 300 }, (_, i) => `t-${i}`),
    roles: Array.from({ length: 20 }, (_, i) => i),
    duplicateTickets: 0,
    unknownPaths: 0,
    network: 'online',
    expectedNetwork: 'online',
    pageReloaded: false,
    hostCpuPercent: 40,
    networkEvidence: {
      apiReachableAtStart: true,
      onlineSamples: 300,
      offlineSamples: 0,
      queueDrainCount: 0,
    },
    ...over,
  };
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

test('O-T40 판정은 QR 간격 중앙값·최대·초과를 2초 기준으로 본다', () => {
  const slow = runOf({ intervalStats: { targetMs: 2_000, toleranceMs: 150, maxMs: 2_500, medianMs: 1_000, maxIntervalMs: 1_000, overruns: 0 } });
  const r1 = judgeTransition(slow);
  assert.equal(r1.pass, false);
  assert.match(r1.reasons.join(' / '), /간격 중앙값 1000ms가 2000±150ms 밖이다/);

  const overrun = runOf({ intervalStats: { targetMs: 2_000, toleranceMs: 150, maxMs: 2_500, medianMs: 2_000, maxIntervalMs: 2_160, overruns: 1 } });
  const r2 = judgeTransition(overrun);
  assert.equal(r2.pass, false);
  assert.match(r2.reasons.join(' / '), /넘긴 간격 1건/);

  const stalled = runOf({ intervalStats: { targetMs: 2_000, toleranceMs: 150, maxMs: 2_500, medianMs: 2_000, maxIntervalMs: 2_600, overruns: 0 } });
  const r3 = judgeTransition(stalled);
  assert.equal(r3.pass, false);
  assert.match(r3.reasons.join(' / '), /최대 간격 2600ms > 2500ms/);
});

test('O-T40 판정은 간격 표본이 없으면 실패한다', () => {
  const noTimes = runOf();
  noTimes.intervalStats = null;
  for (const s of noTimes.scans) s.presentedAtMs = 0;
  const verdict = judgeTransition(noTimes);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /QR 간격 통계가 없다/);
});

test('O-T40 판정은 실제 오프라인 단절 증거가 없으면 실패한다', () => {
  const noEvidence = runOf();
  noEvidence.networkEvidence = null;
  const r1 = judgeTransition(noEvidence);
  assert.equal(r1.pass, false);
  assert.match(r1.reasons.join(' / '), /실제 오프라인 단절 증거가 없다/);

  const base = runOf().networkEvidence;
  const onlineClaim = runOf({ networkEvidence: { ...base, observed: 'online' } });
  const r2 = judgeTransition(onlineClaim);
  assert.equal(r2.pass, false);
  assert.match(r2.reasons.join(' / '), /실제 오프라인 단절 증거가 없다/);

  const leakedOnline = runOf({ networkEvidence: { ...base, offlineScansWithOnlineTrue: 1 } });
  const r3 = judgeTransition(leakedOnline);
  assert.equal(r3.pass, false);
  assert.match(r3.reasons.join(' / '), /navigator\.onLine이 true인 판정 1건/);

  const noQueue = runOf({ networkEvidence: { ...base, queueBeforeReconnect: 0 } });
  const r4 = judgeTransition(noQueue);
  assert.equal(r4.pass, false);
  assert.match(r4.reasons.join(' / '), /스캔 큐 0건: 끊긴 동안 쌓이지 않았다/);

  const reachable = runOf({ networkEvidence: { ...base, apiReachableOffline: true } });
  const r5 = judgeTransition(reachable);
  assert.equal(r5.pass, false);
  assert.match(r5.reasons.join(' / '), /끊긴 동안 가짜 API에 닿았다/);
});

test('O-T40 판정은 오프라인 판정 수·앞뒤 온라인 상태·큐 적재량을 요구한다', () => {
  const base = runOf().networkEvidence;
  const short = runOf({ networkEvidence: { ...base, offlineScans: 150 } });
  const r1 = judgeTransition(short);
  assert.equal(r1.pass, false);
  assert.match(r1.reasons.join(' / '), /오프라인 판정 150\/151건/);

  const badBefore = runOf({ networkEvidence: { ...base, before: 'offline' } });
  const r2 = judgeTransition(badBefore);
  assert.equal(r2.pass, false);
  assert.match(r2.reasons.join(' / '), /앞뒤 온라인 상태가 계획과 다르다/);

  const lowQueue = runOf({ networkEvidence: { ...base, queueBeforeReconnect: 150 } });
  const r3 = judgeTransition(lowQueue);
  assert.equal(r3.pass, false);
  assert.match(r3.reasons.join(' / '), /큐 150건 < 오프라인 판정 151건/);
});

test('O-T40 판정은 페이지 새로고침·티켓 겹침·예상 밖 경로·전환 시각을 실패로 센다', () => {
  const reloaded = runOf();
  reloaded.pageReloaded = true;
  const r1 = judgeTransition(reloaded);
  assert.equal(r1.pass, false);
  assert.match(r1.reasons.join(' / '), /페이지를 새로고침/);

  const overlap = runOf();
  overlap.scans[1].ticketId = overlap.scans[0].ticketId;
  const r2 = judgeTransition(overlap);
  assert.equal(r2.pass, false);
  assert.match(r2.reasons.join(' / '), /티켓 ID가 겹친다\(1건\)/);

  const stray = runOf();
  stray.unknownPaths = 2;
  const r3 = judgeTransition(stray);
  assert.equal(r3.pass, false);
  assert.match(r3.reasons.join(' / '), /예상 밖 API 경로 2건/);

  const late = runOf();
  late.transitionAtScan = 151;
  const r4 = judgeTransition(late);
  assert.equal(r4.pass, false);
  assert.match(r4.reasons.join(' / '), /전환 시각 151번째 ≠ 150번째/);

  const earlyReconnect = runOf();
  earlyReconnect.reconnectAtScan = 302;
  const r5 = judgeTransition(earlyReconnect);
  assert.equal(r5.pass, false);
  assert.match(r5.reasons.join(' / '), /복구 시각 302번째 ≠ 301번째/);
});

test('O-T40 판정은 측정된 첫 10건의 느린 판정을 예열로 빼지 않는다', () => {
  const verdict = judgeTransition(runOf({ firstOnlineLatency: 500 }));
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /평소 p95 500\.0ms > 150ms/);
});

test('O-T40 판정은 올린 기록 수가 예상과 다르면 실패한다', () => {
  const run = runOf();
  run.expectedUploadCount = 330;
  run.uploadedCount = 329;
  const verdict = judgeTransition(run);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /올린 기록 329\/330건/);
});

test('O-T40 판정은 빈 표본·빠진 표본·무효 실행을 통과로 새지 않게 한다', () => {
  const empty = { ...runOf(), scans: [], expectedScans: 330 };
  const r1 = judgeTransition(empty);
  assert.equal(r1.pass, false);
  assert.match(r1.reasons.join(' / '), /판정 0\/330건/);

  const short = runOf();
  short.scans.pop();
  const r2 = judgeTransition(short);
  assert.equal(r2.pass, false);
  assert.match(r2.reasons.join(' / '), /판정 329\/330건/);

  const invalid = runOf();
  invalid.valid = false;
  invalid.invalidReasons = ['계획과 다른 실행'];
  const r3 = judgeTransition(invalid);
  assert.equal(r3.pass, false);
  assert.match(r3.reasons.join(' / '), /무효 실행: 계획과 다른 실행/);
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
  const base = laneValidityOf();
  assert.equal(laneRunValidity(base).valid, true, laneRunValidity(base).reasons.join(' / '));

  const short = laneRunValidity(laneValidityOf({ windowMs: K10.laneWindowMs - 6_000 }));
  assert.equal(short.valid, false);
  assert.match(short.reasons.join(' / '), /창/);

  const few = laneRunValidity(laneValidityOf({ roles: undefined, tickets: base.tickets.slice(0, 19) }));
  assert.equal(few.valid, false);
  assert.match(few.reasons.join(' / '), /사람 19\/20/);

  const wrongNet = laneRunValidity(laneValidityOf({ network: 'offline' }));
  assert.equal(wrongNet.valid, false);
  assert.match(wrongNet.reasons.join(' / '), /네트워크/);

  const reloaded = laneRunValidity(laneValidityOf({ pageReloaded: true }));
  assert.equal(reloaded.valid, false);
  assert.match(reloaded.reasons.join(' / '), /새로고침/);

  const hot = laneRunValidity(laneValidityOf({ hostCpuPercent: 81 }));
  assert.equal(hot.valid, false);
  assert.match(hot.reasons.join(' / '), /호스트 CPU 81%/);
});

test('O-T41 유효성은 0건·분당 값 없음·PASS 아님·결과 없음·예상 밖 경로·티켓 중복을 실패로 센다', () => {
  const zero = laneRunValidity(laneValidityOf({ verdicts: 0, perMinute: undefined }));
  assert.equal(zero.valid, false);
  assert.match(zero.reasons.join(' / '), /판정이 0건이다/);
  assert.match(zero.reasons.join(' / '), /분당 통과 인원이 없다/);

  const nonPass = laneRunValidity(laneValidityOf({ nonPass: 1 }));
  assert.equal(nonPass.valid, false);
  assert.match(nonPass.reasons.join(' / '), /PASS가 아닌 판정 1건/);

  const missing = laneRunValidity(laneValidityOf({ missing: 1 }));
  assert.equal(missing.valid, false);
  assert.match(missing.reasons.join(' / '), /결과 없음 1건/);

  const stray = laneRunValidity(laneValidityOf({ unknownPaths: 2 }));
  assert.equal(stray.valid, false);
  assert.match(stray.reasons.join(' / '), /예상 밖 API 경로 2건/);

  const duplicate = laneRunValidity(laneValidityOf({ duplicateTickets: 1 }));
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.reasons.join(' / '), /같은 티켓을 두 번 판정했다\(1건\)/);
});

test('O-T41 유효성은 오프라인 증거(관측 오프라인·API 도달 불가·큐 적재)를 요구한다', () => {
  const offline = laneValidityOf({
    network: 'offline',
    expectedNetwork: 'offline',
    networkEvidence: { apiReachableAtStart: false, onlineSamples: 0, offlineSamples: 300, queueDrainCount: 300 },
  });
  assert.equal(laneRunValidity(offline).valid, true, laneRunValidity(offline).reasons.join(' / '));

  const noOffline = laneRunValidity({ ...offline, networkEvidence: { ...offline.networkEvidence, offlineSamples: 0 } });
  assert.equal(noOffline.valid, false);
  assert.match(noOffline.reasons.join(' / '), /오프라인 표본이 없다/);

  const reachable = laneRunValidity({ ...offline, networkEvidence: { ...offline.networkEvidence, apiReachableAtStart: true } });
  assert.equal(reachable.valid, false);
  assert.match(reachable.reasons.join(' / '), /끊긴 채 시작하지 않았다/);

  const emptyQueue = laneRunValidity({ ...offline, networkEvidence: { ...offline.networkEvidence, queueDrainCount: 0 } });
  assert.equal(emptyQueue.valid, false);
  assert.match(emptyQueue.reasons.join(' / '), /다시 연결하기 전 큐 0건 < 판정 300건/);
});

test('O-T41 판정은 빈 실행 묶음과 분당 값 없는 실행을 실패로 센다', () => {
  const empty = judgeLane({});
  assert.equal(empty.pass, false);
  assert.match(empty.reasons.join(' / '), /유효한 온라인 실행 0\/3/);

  const offlineNoValue = [1, 2, 3].map((run) => {
    const r = laneRun({ condition: 'offline', run, perMinute: 27 });
    r.perMinute = undefined;
    return r;
  });
  const verdict = judgeLane({
    onlineRuns: [1, 2, 3].map((run) => laneRun({ condition: 'online', run, perMinute: 30 })),
    offlineRuns: offlineNoValue,
  });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /오프라인 분당 통과 인원 중앙값이 없다/);
});

test('O-T41 판정은 nonPass·missing 실행을 실패로 센다', () => {
  const onlineRuns = [1, 2, 3].map((run) => laneRun({ condition: 'online', run, perMinute: 30 }));
  const offlineRuns = [1, 2, 3].map((run) => laneRun({ condition: 'offline', run, perMinute: 27 }));
  offlineRuns[0].nonPass = 1;
  offlineRuns[1].missing = 1;
  const verdict = judgeLane({ onlineRuns, offlineRuns });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' / '), /PASS가 아닌 판정 1건/);
  assert.match(verdict.reasons.join(' / '), /결과 없음 1건/);
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
