// F-08-9 릴레이 장애 주입 준비 시험(F089-1~4): V-T27·V-T28 ①②③·P-T1 추가 몫.
// 정본: docs/verification.md V-T27(657행)·V-T28(658행)·§2.5(83행), docs/features/payment.md P-T1(897행),
// 계획 docs/review/plans/F-08-9.md 6~7절. 단언 값은 정본에서 가져와 이 파일에 적는다(구현 상수를 가져오지 않는다).
// Docker·kind·k6를 쓰지 않는다. 실행: node --test loadtest/test/f089-relay-fault.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 새 모듈을 읽고 공개 이름이 있는지 먼저 본다. 기준 트리에서는 모듈이 없어 여기서 실패한다(계획 9절). */
async function relay() {
  let m;
  try {
    m = await import('../runner/relay-fault.mjs');
  } catch (e) {
    assert.fail(`runner/relay-fault.mjs를 읽지 못했다: ${e?.message ?? e}`);
  }
  for (const name of [
    'parseRelayFaultArgs', 'relayLoadPlan', 'relayConsumerPlan', 'faultPlan', 'validateFaultRecords', 'judgeRelayRun',
    'RELAY_EVIDENCE_SQL', 'buildToxiproxy', 'TOXIPROXY_RULES', 'reconcileSimLedger',
    'webhookDuplicatePlan', 'judgeWebhookDuplicates', 'parsePaymentFaultArgs', 'judgePaymentFaultRun',
    'missingRowIds', 'oldLeaderSendCount', 'summarizeSamples',
  ]) assert.equal(typeof m[name], 'function', `${name} 공개 함수가 없다`);
  for (const name of ['RELAY_RULES', 'RELAY_EVIDENCE_SQL', 'TOXIPROXY_RULES']) assert.equal(typeof m[name], 'object', `${name} 공개 상수가 없다`);
  return m;
}

/** V-T27: 30분, 설계 피크의 2배 [가정] = 12,600/s, 지연 p99 200ms, 묶음 p99 50ms, DB CPU 5%p, P-T5 3초. V-T28 ②는 30초. */
const MAIN_SECONDS = 1800;
const RATE = 12600;
const BROKER_STOP_SECONDS = 30;
const LAG_P99_SECONDS = 0.2;
const BATCH_P99_SECONDS = 0.05;
const DB_CPU_INCREASE_PCT_POINTS = 5;
const PAYMENT_P99_MS = 3000;
const PAYMENT_RATE = 300;
const DRAIN_SECONDS = 300;

const usage = (fn) =>
  assert.throws(fn, (e) => e?.name === 'UsageError', 'UsageError로 거부해야 한다');

/** 장애 기록(계획 6.3의 꼴): 계획의 atSecond·durationSeconds를 그대로 적는다 */
function goodFaults(plan) {
  return plan.map((f, i) => ({
    kind: f.kind,
    atSecond: f.atSecond,
    durationSeconds: f.durationSeconds,
    startedAt: `2026-11-27T10:0${i}:00+09:00`,
    endedAt: `2026-11-27T10:0${i}:${String(f.durationSeconds || 0).padStart(2, '0')}+09:00`,
    applied: true,
    evidence: `evidence-${f.kind}`,
  }));
}

/** 깨끗한 V-T27+V-T28 실행 하나(측정 경로는 DB 집계 건수만 넘긴다) */
function cleanRun(faultPlan) {
  const plan = faultPlan({ mainSeconds: MAIN_SECONDS });
  return {
    runId: 'run-1',
    mainSeconds: MAIN_SECONDS,
    rate: RATE,
    sentRows: 22_680_000,
    receivedRows: 22_680_000,
    missingRows: 0,
    orderViolations: 0,
    eventKeyMismatches: 0,
    oldLeaderSends: 0,
    maxKeyRepeats: 100,
    payment: { runId: 'run-1', mode: 'load', rate: 300, p99Ms: 2_500, p99BrokerRestartMs: 2_800, pullCount: 7 },
    lagSeconds: [0.01, 0.02, 0.03],
    batchSeconds: [0.001, 0.002, 0.003],
    faults: goodFaults(plan),
    leaderChangeMs: 5_000,
    relayCpuPctPoints: 1,
  };
}

const sim = (rows) => rows.map((r) => JSON.stringify({ kind: 'pg_charge', ...r })).join('\n');

test('F089-1 ① 릴레이 규칙·부하/소비자 계획·인자는 30분, 12600/s, DB COPY, 같은 실행 P-T5를 고정한다', async () => {
  const { RELAY_RULES, relayLoadPlan, relayConsumerPlan, parseRelayFaultArgs } = await relay();
  assert.equal(RELAY_RULES.mainSeconds, MAIN_SECONDS);
  assert.equal(RELAY_RULES.rateMultiplier, 2);
  assert.equal(RELAY_RULES.brokerStopSeconds, BROKER_STOP_SECONDS);
  assert.equal(RELAY_RULES.lagP99Seconds, LAG_P99_SECONDS);
  assert.equal(RELAY_RULES.batchP99Seconds, BATCH_P99_SECONDS);
  assert.equal(RELAY_RULES.dbCpuIncreasePctPoints, DB_CPU_INCREASE_PCT_POINTS);
  assert.equal(RELAY_RULES.paymentP99Ms, PAYMENT_P99_MS);
  assert.equal(RELAY_RULES.drainSeconds, DRAIN_SECONDS);

  const load = relayLoadPlan({ mainSeconds: MAIN_SECONDS, rate: RATE });
  assert.equal(load.rows, RATE * MAIN_SECONDS);
  assert.equal(load.writer, 'copy');
  assert.equal(load.sentTable, 'f089_sent');
  assert.equal(load.receivedTable, 'f089_received');
  assert.ok(load.hotKeyEvery > 0, '같은 좌석 키를 섞는 주기');
  assert.ok(load.batchRows > 0 && load.batchRows < load.rows);
  const consumer = relayConsumerPlan({ topic: 'trade.events', table: 'f089_received' });
  assert.equal(consumer.table, 'f089_received');
  assert.deepEqual(consumer.columns, ['id', 'key', 'seq', 'event_key', 'publisher', 'received_at']);
  assert.deepEqual(load.receivedColumns, consumer.columns, '부하 계획과 소비자 계약의 받은 행 칼럼');
  assert.ok(consumer.maxBatch > 0 && consumer.group);

  const a = parseRelayFaultArgs([
    '--main', String(MAIN_SECONDS), '--rate', String(RATE), '--relay', 'off',
    '--payment-rate', String(PAYMENT_RATE), '--payment-mode', 'load',
    '--out', '.cache/peaket-f09/relay', '--record', '--run-id', '2026-11-27-relay-f089',
    '--prom-url', 'http://127.0.0.1:9090',
  ]);
  assert.equal(a.mainSeconds, MAIN_SECONDS);
  assert.equal(a.rate, RATE);
  assert.equal(a.relay, 'off');
  assert.equal(a.paymentRate, PAYMENT_RATE);
  assert.equal(a.paymentMode, 'load');
  assert.equal(a.record, true);
  assert.equal(a.runId, '2026-11-27-relay-f089');
  const defaults = parseRelayFaultArgs(['--main', String(MAIN_SECONDS)]);
  assert.deepEqual([defaults.rate, defaults.paymentRate, defaults.paymentMode], [RATE, PAYMENT_RATE, 'load']);

  usage(() => parseRelayFaultArgs(['--main', '59', '--rate', '1']));
  usage(() => parseRelayFaultArgs(['--main', '3601', '--rate', '1']));
  usage(() => parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '0']));
  usage(() => parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '1', '--relay', 'wat']));
  usage(() => parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '1', '--payment-mode', 'const']));
  usage(() => parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '1', '--payment-rate', '0']));
  usage(() => parseRelayFaultArgs(['--main', String(MAIN_SECONDS), '--rate', '1', '--wat', 'x']));
});

test('F089-1 ② faultPlan은 ② 30초·③ 드레인 300초를 남기고 ①~③을 한 번씩 둔다', async () => {
  const { faultPlan } = await relay();
  const plan = faultPlan({ mainSeconds: MAIN_SECONDS });
  assert.deepEqual(plan.map((f) => f.kind), ['leader-stop', 'kafka-stop', 'db-cut']);
  for (const f of plan) {
    assert.ok(Number.isInteger(f.atSecond), `${f.kind}: atSecond`);
    assert.ok(f.atSecond >= 1 && f.atSecond < MAIN_SECONDS, `${f.kind}: atSecond ${f.atSecond}`);
    assert.ok(Number.isInteger(f.durationSeconds) && f.durationSeconds >= 0, `${f.kind}: durationSeconds`);
  }
  assert.equal(plan[1].durationSeconds, BROKER_STOP_SECONDS);
  assert.ok(plan[1].atSecond + BROKER_STOP_SECONDS <= MAIN_SECONDS - DRAIN_SECONDS, '② 뒤 드레인 창');
  assert.ok(plan[2].atSecond <= MAIN_SECONDS - DRAIN_SECONDS, '③ 뒤 드레인 창');
  assert.ok(plan[1].atSecond - plan[0].atSecond >= 60);
  assert.ok(plan[2].atSecond - plan[1].atSecond >= 60);
  assert.deepEqual(faultPlan({ mainSeconds: MAIN_SECONDS }), plan);
});

test('F089-2 ① 장애 기록은 종류 중복·적용 거짓·빈 증거·계획과 다른 시각/길이를 거부한다', async () => {
  const { faultPlan, validateFaultRecords } = await relay();
  const plan = faultPlan({ mainSeconds: MAIN_SECONDS });
  const good = goodFaults(plan);
  assert.deepEqual(validateFaultRecords(good, plan), { ok: true, problems: [] });

  assert.equal(validateFaultRecords(good.filter((x) => x.kind !== 'db-cut'), plan).ok, false);
  assert.equal(validateFaultRecords([...good, { ...good[0] }], plan).ok, false, '같은 종류 두 번');
  assert.equal(validateFaultRecords(good.map((x) => (x.kind === 'leader-stop' ? { ...x, applied: false } : x)), plan).ok, false);
  assert.equal(validateFaultRecords(good.map((x) => (x.kind === 'kafka-stop' ? { ...x, evidence: '' } : x)), plan).ok, false);
  assert.equal(validateFaultRecords(good.map((x) => (x.kind === 'kafka-stop' ? { ...x, durationSeconds: 1 } : x)), plan).ok, false, '② 30초 아님');
  assert.equal(validateFaultRecords(good.map((x) => (x.kind === 'db-cut' ? { ...x, atSecond: 1 } : x)), plan).ok, false, '계획과 다른 시각');
});

test('F089-2 ② judgeRelayRun은 DB 건수로 판정하고, 옛 리더·같은 키·P-T5가 빠지면 무효다', async () => {
  const { faultPlan, judgeRelayRun } = await relay();
  const base = cleanRun(faultPlan);
  assert.equal(judgeRelayRun(base).verdict, 'pass');
  assert.equal(judgeRelayRun(base).summary.paymentPulls, 7);
  assert.equal(judgeRelayRun(base).summary.paymentP99Ms, 2_500);

  assert.equal(judgeRelayRun({ ...base, missingRows: 1 }).verdict, 'fail');
  assert.equal(judgeRelayRun({ ...base, missingRows: 1 }).summary.missing, 1);
  assert.equal(judgeRelayRun({ ...base, orderViolations: 1 }).verdict, 'fail');
  assert.equal(judgeRelayRun({ ...base, eventKeyMismatches: 1 }).verdict, 'fail');
  assert.equal(judgeRelayRun({ ...base, oldLeaderSends: 1 }).verdict, 'fail');

  assert.equal(judgeRelayRun({ ...base, maxKeyRepeats: 1 }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, oldLeaderSends: undefined }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, rate: 100 }).verdict, 'invalid', 'V-T27 2배 [가정] 도착률이 아님');
  assert.equal(judgeRelayRun({ ...base, payment: { ...base.payment, runId: 'other-run' } }).verdict, 'invalid', '다른 실행 P-T5');
  assert.equal(judgeRelayRun({ ...base, payment: { ...base.payment, mode: 'const' } }).verdict, 'invalid', '상수 P-T5');
  assert.equal(judgeRelayRun({ ...base, payment: { ...base.payment, rate: 0 } }).verdict, 'invalid', '결제 부하 없음(rate 0)');
  assert.equal(judgeRelayRun({ ...base, payment: { ...base.payment, p99Ms: null } }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, payment: { ...base.payment, p99BrokerRestartMs: null } }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, payment: { ...base.payment, pullCount: undefined } }).verdict, 'invalid', '당기기 반영 수 없음');
  assert.equal(judgeRelayRun({ ...base, payment: { ...base.payment, pullCount: 0 } }).verdict, 'pass', '당기기 반영 0은 유효');
  assert.equal(judgeRelayRun({ ...base, payment: { ...base.payment, pullCount: -1 } }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, faults: [] }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, faults: base.faults.map((f) => (f.kind === 'db-cut' ? { ...f, applied: false } : f)) }).verdict, 'invalid', 'applied:false');
  assert.equal(judgeRelayRun({ ...base, lagSeconds: [] }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, mainSeconds: MAIN_SECONDS - 1 }).verdict, 'invalid');
  assert.equal(judgeRelayRun({ ...base, sentRows: 0 }).verdict, 'invalid');
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

test('F089-3 ② V-T27 문턱은 triggers로 남고, 빠진 행은 문턱과 상관없이 fail이다', async () => {
  const { faultPlan, judgeRelayRun } = await relay();
  const base = cleanRun(faultPlan);
  assert.deepEqual(judgeRelayRun(base).triggers, []);

  assert.ok(!judgeRelayRun({ ...base, lagSeconds: [LAG_P99_SECONDS] }).triggers.includes('relay-lag'));
  assert.ok(judgeRelayRun({ ...base, lagSeconds: [LAG_P99_SECONDS + 0.0001] }).triggers.includes('relay-lag'));
  assert.ok(!judgeRelayRun({ ...base, batchSeconds: [BATCH_P99_SECONDS] }).triggers.includes('batch'));
  assert.ok(judgeRelayRun({ ...base, batchSeconds: [BATCH_P99_SECONDS + 0.0001] }).triggers.includes('batch'));
  assert.ok(!judgeRelayRun({ ...base, relayCpuPctPoints: DB_CPU_INCREASE_PCT_POINTS }).triggers.includes('db-cpu'));
  assert.ok(judgeRelayRun({ ...base, relayCpuPctPoints: DB_CPU_INCREASE_PCT_POINTS + 0.1 }).triggers.includes('db-cpu'));
  assert.ok(!judgeRelayRun({ ...base, payment: { ...base.payment, p99Ms: PAYMENT_P99_MS } }).triggers.includes('payment-p99'));
  assert.ok(judgeRelayRun({ ...base, payment: { ...base.payment, p99Ms: PAYMENT_P99_MS + 1 } }).triggers.includes('payment-p99'));
  assert.ok(judgeRelayRun({ ...base, payment: { ...base.payment, p99BrokerRestartMs: PAYMENT_P99_MS + 1 } }).triggers.includes('payment-p99-broker'));

  assert.equal(judgeRelayRun({ ...base, lagSeconds: [0.5] }).verdict, 'pass');
  const missing = judgeRelayRun({ ...base, lagSeconds: [0.5], missingRows: 1 });
  assert.equal(missing.verdict, 'fail');
  assert.ok(missing.problems.length > 0);
});

test('F089-4 ① Toxiproxy는 판 고정·루프백 제어 API·인증을 쓰고 timeout을 만든다', async () => {
  const { TOXIPROXY_RULES, buildToxiproxy } = await relay();
  assert.equal(TOXIPROXY_RULES.image, 'ghcr.io/shopify/toxiproxy:2.13.0');
  assert.equal(TOXIPROXY_RULES.controlListen, '127.0.0.1:8474');
  assert.equal(TOXIPROXY_RULES.authTokenEnv, 'TOXIPROXY_AUTH_TOKEN');

  const plan = buildToxiproxy({
    name: 'sim', listen: '0.0.0.0:18080', upstream: 'pg-simulator.v1.svc:8080',
    toxics: [
      { type: 'latency', attributes: { latency: 500, jitter: 50 } },
      { type: 'reset_peer', attributes: { timeout: 0 } },
      { type: 'timeout', attributes: { timeout: 30000 } },
    ],
  });
  assert.equal(plan.toxics.length, 3);
  assert.equal(plan.toxics[2].type, 'timeout');

  assert.throws(() => buildToxiproxy({ name: 'x', listen: '0.0.0.0:1', upstream: 'u:1', toxics: [{ type: 'wat' }] }), RangeError);
  assert.throws(() => buildToxiproxy({ name: 'x', listen: '0.0.0.0:1', upstream: 'u:1', toxics: [{ type: 'latency', attributes: { latency: -1 } }] }), RangeError);
  assert.throws(() => buildToxiproxy({ name: 'x', listen: '0.0.0.0:1', upstream: '', toxics: [] }), RangeError);
});

test('F089-4 ② 시뮬레이터 원장은 실제 NDJSON을 읽고, 이중 원장만 있어도 실패하며, 웹훅 중복을 센다', async () => {
  const { reconcileSimLedger, webhookDuplicatePlan, judgeWebhookDuplicates } = await relay();
  const fail = reconcileSimLedger({
    simNdjson: sim([
      { payment_ref: 'p1', status: 'DONE' },
      { payment_ref: 'p2', status: 'PARTIAL_CANCELED' },
      { payment_ref: 'p3', status: 'CANCELED' },
      { payment_ref: 'p4', status: 'WAITING_FOR_DEPOSIT' },
    ]),
    payment: [{ payment_ref: 'p1' }, { payment_ref: 'p1' }],
  });
  assert.equal(fail.approved, 2);
  assert.equal(fail.recorded, 1);
  assert.deepEqual(fail.missing, ['p2']);
  assert.equal(fail.duplicatePayments, 1);
  assert.equal(fail.verdict, 'fail');

  const dupOnly = reconcileSimLedger({
    simNdjson: sim([{ payment_ref: 'p1', status: 'DONE' }]),
    payment: [{ payment_ref: 'p1' }, { payment_ref: 'p1' }],
  });
  assert.deepEqual(dupOnly.missing, []);
  assert.equal(dupOnly.duplicatePayments, 1);
  assert.equal(dupOnly.verdict, 'fail');

  assert.equal(reconcileSimLedger({ simNdjson: '', payment: [] }).verdict, 'invalid');
  assert.equal(reconcileSimLedger({
    simNdjson: sim([{ payment_ref: 'p1', status: 'DONE' }]), payment: [{ payment_ref: 'p1' }],
  }).verdict, 'pass');

  const wh = webhookDuplicatePlan({ webhookId: 'wh-1', duplicates: 2 });
  assert.equal(wh.sendCount, 2);
  assert.equal(wh.events.length, 2);
  assert.deepEqual(wh.events.map((e) => e.webhookId), ['wh-1', 'wh-1']);
  assert.equal(judgeWebhookDuplicates({ sent: 2, processed: 1 }).verdict, 'pass');
  assert.equal(judgeWebhookDuplicates({ sent: 2, processed: 2 }).verdict, 'fail');
  assert.equal(judgeWebhookDuplicates({ sent: 1, processed: 1 }).verdict, 'invalid');
});

test('F089-4 ③ 표본 헬퍼·DB 증거 SQL·P-T1 인자/판정이 빠짐·옛 리더·발생기 무효를 잡는다', async () => {
  const { missingRowIds, oldLeaderSendCount, RELAY_EVIDENCE_SQL, parsePaymentFaultArgs, judgePaymentFaultRun } = await relay();
  const pt1Args = parsePaymentFaultArgs([
    '--payments', '10000', '--rate', '100', '--generators', '2', '--webhook-duplicates', '2', '--invariants',
    '--out', '.cache/peaket-f09/pt1', '--record', '--run-id', '2026-11-27-pt1-f089',
    '--prom-url', 'http://127.0.0.1:9090',
  ]);
  assert.deepEqual([pt1Args.payments, pt1Args.rate, pt1Args.generators, pt1Args.webhookDuplicates], [10000, 100, 2, 2]);
  assert.equal(pt1Args.invariants, true);
  usage(() => parsePaymentFaultArgs(['--payments', '0']));
  usage(() => parsePaymentFaultArgs(['--payments', '10000', '--generators', '0']));
  usage(() => parsePaymentFaultArgs(['--payments', '10000', '--webhook-duplicates', '1']));
  const sent = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const received = [{ id: 'a' }, { id: 'c' }];
  assert.deepEqual(missingRowIds(sent, received), ['b']);
  assert.equal(oldLeaderSendCount([
    { id: 'a', publisher: 'old', atMs: 500 },
    { id: 'b', publisher: 'old', atMs: 2_000 },
    { id: 'c', publisher: 'new', atMs: 1_500 },
  ], 'old', 1_000), 1);

  for (const key of ['missing', 'order', 'eventKey', 'oldLeader', 'hotKeys', 'payment']) {
    assert.equal(typeof RELAY_EVIDENCE_SQL[key], 'string', `${key} SQL`);
  }
  assert.match(RELAY_EVIDENCE_SQL.missing, /left join|not exists/i);
  assert.match(RELAY_EVIDENCE_SQL.order, /lag\s*\(/i);
  assert.match(RELAY_EVIDENCE_SQL.eventKey, /count\s*\(\s*distinct/i);
  assert.match(RELAY_EVIDENCE_SQL.oldLeader, /publisher/i);
  assert.match(RELAY_EVIDENCE_SQL.hotKeys, /group by/i);
  assert.match(RELAY_EVIDENCE_SQL.payment, /percentile|p99/i);

  const clean = judgePaymentFaultRun({
    generator: { valid: true, dropped: 0 },
    simNdjson: sim([{ payment_ref: 'p1', status: 'DONE' }]),
    payment: [{ payment_ref: 'p1' }],
    webhook: { sent: 2, processed: 1 },
    invariants: { P1: 'PASS', P6: 'PASS', S3: 'SKIPPED' },
  });
  assert.equal(clean.verdict, 'pass');
  assert.equal(clean.summary.duplicateIssue, '미측정');
  assert.equal(judgePaymentFaultRun({
    generator: { valid: false, dropped: 2 }, simNdjson: sim([{ payment_ref: 'p1', status: 'DONE' }]),
    payment: [{ payment_ref: 'p1' }], webhook: { sent: 2, processed: 1 }, invariants: { P1: 'PASS', P6: 'PASS', S3: 'SKIPPED' },
  }).verdict, 'invalid');
  assert.equal(judgePaymentFaultRun({
    generator: { valid: true, dropped: 0 }, simNdjson: sim([{ payment_ref: 'p1', status: 'DONE' }]),
    payment: [], webhook: { sent: 2, processed: 1 }, invariants: { P1: 'PASS', P6: 'PASS', S3: 'SKIPPED' },
  }).verdict, 'fail');
  assert.equal(judgePaymentFaultRun({
    generator: { valid: true, dropped: 0 }, simNdjson: sim([{ payment_ref: 'p1', status: 'DONE' }]),
    payment: [{ payment_ref: 'p1' }], webhook: { sent: 2, processed: 2 }, invariants: { P1: 'PASS', P6: 'PASS', S3: 'SKIPPED' },
  }).verdict, 'fail');
});
