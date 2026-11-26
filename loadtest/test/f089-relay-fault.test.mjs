// F-08-9 릴레이 장애 주입 준비 시험(F089-1~4): V-T27·V-T28 ①②③·P-T1 추가 몫의 인자·계획·기록·판정·Toxiproxy·시뮬레이터 원장 대조.
// 정본: docs/verification.md V-T27(657행)·V-T28(658행), docs/features/payment.md P-T1(894행), 계획 docs/review/plans/F-08-9.md 6~7절.
// 단언 값은 정본에서 가져와 이 파일에 적는다(구현 상수를 가져오지 않는다). Docker·kind·k6를 쓰지 않는다.
// 실행: node --test loadtest/test/f089-relay-fault.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 새 모듈을 읽고 공개 이름이 있는지 먼저 본다. 기준 트리에서는 모듈이 없어 여기서 실패한다(계획 9절).
 * 구현이 생기면 같은 시험이 동작 단언까지 이어 간다.
 */
async function relay() {
  let m;
  try {
    m = await import('../runner/relay-fault.mjs');
  } catch (e) {
    assert.fail(`runner/relay-fault.mjs를 읽지 못했다: ${e?.message ?? e}`);
  }
  for (const name of [
    'parseRelayFaultArgs', 'faultPlan', 'validateFaultRecords', 'judgeRelayRun',
    'missingRows', 'orderViolations', 'eventKeyMismatches', 'summarizeSamples',
    'buildToxiproxy', 'reconcileSimLedger',
  ]) assert.equal(typeof m[name], 'function', `${name} 공개 함수가 없다`);
  return m;
}

/** V-T27 본구간 30분. V-T28 ②는 브로커를 30초 멈춘다. */
const MAIN_SECONDS = 1800;
const BROKER_STOP_SECONDS = 30;
/** V-T27 [가정] 문턱: 지연 p99 200ms, 묶음 p99 50ms, DB CPU 증가 5%p. */
const LAG_P99_SECONDS = 0.2;
const BATCH_P99_SECONDS = 0.05;
const DB_CPU_INCREASE_PCT_POINTS = 5;

const usage = (fn) =>
  assert.throws(fn, (e) => e?.name === 'UsageError', 'UsageError로 거부해야 한다');

/** 장애 기록 세 줄(계획 6.3의 꼴) */
function goodFaults(plan) {
  return plan.map((f, i) => ({
    kind: f.kind,
    startedAt: `2026-11-27T10:0${i}:00+09:00`,
    endedAt: `2026-11-27T10:0${i}:30+09:00`,
    applied: true,
    evidence: `evidence-${f.kind}`,
  }));
}

/** 깨끗한 V-T27+V-T28 실행 하나 */
function cleanRun(faultPlan) {
  const plan = faultPlan({ mainSeconds: MAIN_SECONDS });
  const sent = [
    { id: 'row-1', key: 'seat-1', seq: 1, eventKey: 'event-1' },
    { id: 'row-2', key: 'seat-1', seq: 2, eventKey: 'event-2' },
    { id: 'row-3', key: 'seat-2', seq: 1, eventKey: 'event-3' },
  ];
  const received = sent.map((r, i) => ({ ...r, publisher: 'relay-a', atMs: 1_000 + i * 10 }));
  return {
    mainSeconds: MAIN_SECONDS,
    rate: 100,
    sent,
    received,
    lagSeconds: [0.01, 0.02, 0.03],
    batchSeconds: [0.001, 0.002, 0.003],
    faults: goodFaults(plan),
    leaderChangeMs: 5_000,
    oldLeaderPublishedAfterResume: 0,
    relayCpuPctPoints: 1,
  };
}

test('F089-1 ① relay-fault 인자는 30분·도착률·기록을 읽고 범위 밖을 거부한다', async () => {
  const { parseRelayFaultArgs } = await relay();
  const a = parseRelayFaultArgs([
    '--main', String(MAIN_SECONDS),
    '--rate', '100',
    '--out', '.cache/peaket-f09/relay',
    '--record',
    '--run-id', '2026-11-27-relay-f089',
    '--prom-url', 'http://127.0.0.1:9090',
  ]);
  assert.equal(a.mainSeconds, MAIN_SECONDS);
  assert.equal(a.rate, 100);
  assert.equal(a.record, true);
  assert.equal(a.runId, '2026-11-27-relay-f089');
  assert.equal(a.promUrl, 'http://127.0.0.1:9090');
  assert.equal(a.relay, 'on');
  assert.equal(parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '1', '--relay', 'off']).relay, 'off');

  usage(() => parseRelayFaultArgs(['--main', '59', '--rate', '1']));
  usage(() => parseRelayFaultArgs(['--main', '3601', '--rate', '1']));
  usage(() => parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '0']));
  usage(() => parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '1', '--relay', 'wat']));
  usage(() => parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '1', '--wat', 'x']));
});

test('F089-1 ② faultPlan은 ①~③을 본구간 안에 60초 이상 떨어져 한 번씩 둔다', async () => {
  const { faultPlan } = await relay();
  const plan = faultPlan({ mainSeconds: MAIN_SECONDS });
  assert.deepEqual(plan.map((f) => f.kind), ['leader-stop', 'kafka-stop', 'db-cut']);
  for (const f of plan) {
    assert.ok(Number.isInteger(f.atSecond), `${f.kind}: atSecond가 정수다`);
    assert.ok(f.atSecond >= 1 && f.atSecond < MAIN_SECONDS, `${f.kind}: atSecond ${f.atSecond}`);
  }
  assert.equal(plan[1].durationSeconds, BROKER_STOP_SECONDS);
  assert.ok(plan[1].atSecond - plan[0].atSecond >= 60);
  assert.ok(plan[2].atSecond - plan[1].atSecond >= 60);
  // 같은 입력이면 같은 계획(측정 중에 계획이 흔들리지 않게)
  assert.deepEqual(faultPlan({ mainSeconds: MAIN_SECONDS }), plan);
});

test('F089-2 ① 장애 기록은 적용·증거가 없거나 종류가 빠지면 거부한다', async () => {
  const { faultPlan, validateFaultRecords } = await relay();
  const plan = faultPlan({ mainSeconds: MAIN_SECONDS });
  const good = goodFaults(plan);
  assert.deepEqual(validateFaultRecords(good, plan), { ok: true, problems: [] });

  const missing = good.filter((x) => x.kind !== 'db-cut');
  const missingResult = validateFaultRecords(missing, plan);
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.problems.some((p) => p.includes('db-cut')), JSON.stringify(missingResult.problems));

  const notApplied = good.map((x) => (x.kind === 'leader-stop' ? { ...x, applied: false } : x));
  assert.equal(validateFaultRecords(notApplied, plan).ok, false);

  const noEvidence = good.map((x) => (x.kind === 'kafka-stop' ? { ...x, evidence: '' } : x));
  assert.equal(validateFaultRecords(noEvidence, plan).ok, false);

  const unknown = [...good, { ...good[0], kind: 'wat' }];
  assert.equal(validateFaultRecords(unknown, plan).ok, false);
});

test('F089-2 ② judgeRelayRun은 빠짐·순서·eventKey·옛 리더를 실패로, 기록 없음·빈 표본을 무효로 낸다', async () => {
  const { faultPlan, judgeRelayRun } = await relay();
  const base = cleanRun(faultPlan);
  assert.equal(judgeRelayRun(base).verdict, 'pass');

  const missingOne = { ...base, received: base.received.slice(0, 2) };
  assert.equal(judgeRelayRun(missingOne).verdict, 'fail');
  assert.equal(judgeRelayRun(missingOne).summary.missing, 1);

  const outOfOrder = { ...base, received: [base.received[1], base.received[0], base.received[2]] };
  assert.equal(judgeRelayRun(outOfOrder).verdict, 'fail');
  assert.ok(judgeRelayRun(outOfOrder).summary.order >= 1);

  const differentKey = { ...base, received: [...base.received, { ...base.received[0], eventKey: 'event-other', atMs: 2_000 }] };
  assert.equal(judgeRelayRun(differentKey).verdict, 'fail');
  assert.ok(judgeRelayRun(differentKey).summary.eventKey >= 1);

  // 같은 행을 같은 eventKey로 다시 보낸 것은 실패가 아니다(V-T28의 '다시 보낸 사건은 eventKey가 같다')
  const retrySameKey = { ...base, received: [...base.received, { ...base.received[0], atMs: 2_000 }] };
  assert.equal(judgeRelayRun(retrySameKey).verdict, 'pass');

  assert.equal(judgeRelayRun({ ...base, oldLeaderPublishedAfterResume: 1 }).verdict, 'fail');
  assert.equal(judgeRelayRun({ ...base, faults: [] }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, lagSeconds: [] }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, batchSeconds: [] }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, mainSeconds: MAIN_SECONDS - 1 }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, sent: [], received: [] }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, leaderChangeMs: null }).verdict, 'invalid');
});

test('F089-3 ① summarizeSamples는 p50·p99·max를 내고 빈 표본은 null이다', async () => {
  const { summarizeSamples } = await relay();
  const s = summarizeSamples([0.01, 0.02, 0.03, 0.04]);
  assert.equal(s.count, 4);
  assert.ok(s.p50 >= 0.02 && s.p50 <= 0.03, `p50 ${s.p50}`);
  assert.ok(s.p99 >= 0.03 && s.p99 <= 0.04, `p99 ${s.p99}`);
  assert.equal(s.max, 0.04);

  assert.deepEqual(summarizeSamples([]), { count: 0, p50: null, p99: null, max: null });
});

test('F089-3 ② V-T27 문턱은 triggers로 남고 판정을 fail로 만들지 않는다', async () => {
  const { faultPlan, judgeRelayRun } = await relay();
  const base = cleanRun(faultPlan);
  assert.deepEqual(judgeRelayRun(base).triggers, []);

  // 경계 양쪽: 문턱과 같으면 트리거가 아니고, 넘으면 트리거다
  assert.ok(!judgeRelayRun({ ...base, lagSeconds: [LAG_P99_SECONDS] }).triggers.includes('relay-lag'));
  assert.ok(judgeRelayRun({ ...base, lagSeconds: [LAG_P99_SECONDS + 0.0001] }).triggers.includes('relay-lag'));
  assert.ok(!judgeRelayRun({ ...base, batchSeconds: [BATCH_P99_SECONDS] }).triggers.includes('batch'));
  assert.ok(judgeRelayRun({ ...base, batchSeconds: [BATCH_P99_SECONDS + 0.0001] }).triggers.includes('batch'));
  assert.ok(!judgeRelayRun({ ...base, relayCpuPctPoints: DB_CPU_INCREASE_PCT_POINTS }).triggers.includes('db-cpu'));
  assert.ok(judgeRelayRun({ ...base, relayCpuPctPoints: DB_CPU_INCREASE_PCT_POINTS + 0.1 }).triggers.includes('db-cpu'));

  // 트리거는 ADR-0116 결정 6으로 가는 표시일 뿐, 유실이 없으면 fail이 아니다
  assert.equal(judgeRelayRun({ ...base, lagSeconds: [0.5] }).verdict, 'pass');
  // 유실이 있으면 문턱과 상관없이 fail이다
  const missing = judgeRelayRun({ ...base, lagSeconds: [0.5], received: base.received.slice(0, 2) });
  assert.equal(missing.verdict, 'fail');
  assert.ok(missing.problems.length > 0);
});

test('F089-4 ① Toxiproxy 계획은 지연·끊김을 만들고 모르는 종류·음수·빈 upstream을 거부한다', async () => {
  const { buildToxiproxy } = await relay();
  const plan = buildToxiproxy({
    name: 'sim',
    listen: '0.0.0.0:18080',
    upstream: 'pg-simulator.v1.svc:8080',
    toxics: [
      { type: 'latency', attributes: { latency: 500, jitter: 50 } },
      { type: 'reset_peer', attributes: { timeout: 0 } },
    ],
  });
  assert.equal(plan.name, 'sim');
  assert.equal(plan.listen, '0.0.0.0:18080');
  assert.equal(plan.upstream, 'pg-simulator.v1.svc:8080');
  assert.equal(plan.toxics.length, 2);
  assert.equal(plan.toxics[0].type, 'latency');

  assert.throws(() => buildToxiproxy({
    name: 'x', listen: '0.0.0.0:1', upstream: 'u:1', toxics: [{ type: 'wat', attributes: {} }],
  }), RangeError);
  assert.throws(() => buildToxiproxy({
    name: 'x', listen: '0.0.0.0:1', upstream: 'u:1', toxics: [{ type: 'latency', attributes: { latency: -1 } }],
  }), RangeError);
  assert.throws(() => buildToxiproxy({
    name: 'x', listen: '0.0.0.0:1', upstream: '', toxics: [],
  }), RangeError);
});

test('F089-4 ② 시뮬레이터 원장 대조는 승인인데 원장에 없는 결제를 P6로 세고 빈 원장을 무효로 낸다', async () => {
  const { reconcileSimLedger } = await relay();
  const fail = reconcileSimLedger({
    sim: [
      { paymentKey: 'p1', status: 'APPROVED' },
      { paymentKey: 'p2', status: 'DECLINED' },
      { paymentKey: 'p3', status: 'APPROVED' },
    ],
    payment: [{ paymentKey: 'p1' }, { paymentKey: 'p1' }],
  });
  assert.equal(fail.approved, 2);
  assert.equal(fail.recorded, 1);
  assert.deepEqual(fail.missing, ['p3']);
  assert.equal(fail.duplicatePayments, 1);
  assert.equal(fail.verdict, 'fail');

  const invalid = reconcileSimLedger({ sim: [], payment: [] });
  assert.equal(invalid.verdict, 'invalid');
  assert.equal(invalid.approved, 0);

  const pass = reconcileSimLedger({
    sim: [{ paymentKey: 'p1', status: 'APPROVED' }],
    payment: [{ paymentKey: 'p1' }],
  });
  assert.equal(pass.verdict, 'pass');
  assert.deepEqual(pass.missing, []);
});

test('F089-4 ③ 유실·순서·eventKey 헬퍼는 받은 기록만으로 정확히 센다', async () => {
  const { missingRows, orderViolations, eventKeyMismatches } = await relay();
  const sent = [
    { id: 'a', key: 'k', seq: 1, eventKey: 'e1' },
    { id: 'b', key: 'k', seq: 2, eventKey: 'e2' },
    { id: 'c', key: 'k', seq: 3, eventKey: 'e3' },
  ];
  const received = [
    { ...sent[1], publisher: 'r1', atMs: 1 },
    { ...sent[0], publisher: 'r1', atMs: 2 },
    { ...sent[2], publisher: 'r1', atMs: 3 },
  ];
  assert.deepEqual(missingRows(sent, received), []);
  assert.equal(orderViolations(received), 1);
  assert.equal(eventKeyMismatches(received), 0);
  assert.equal(eventKeyMismatches([...received, { ...sent[0], eventKey: 'other', publisher: 'r2', atMs: 4 }]), 1);
});
