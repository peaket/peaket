// F-08-9 릴레이 장애 주입·판정 도구(계획 docs/review/plans/F-08-9.md 6.1~6.6·7.1~7.2).
// 정본: docs/verification.md V-T27(657행)·V-T28(658행)·§2.5(83행), docs/features/payment.md P-T1(897행).
// 이 파일은 계산·계약만 둔다. 클러스터·DB·k6 실행은 run.mjs가 측정 창에서 맡는다.
// 수치를 새로 주장하지 않는다. 여기 값은 정본의 [가정] 값을 그대로 옮긴 측정 조건이다.

export class UsageError extends Error {
  name = 'UsageError';
}

const fail = (m) => {
  throw new UsageError(m);
};

/** V-T27·V-T28·NFR-006의 측정 조건(정본 값) */
export const RELAY_RULES = Object.freeze({
  mainSeconds: 1800,
  designPeakPerSecond: 6300,
  rateMultiplier: 2,
  brokerStopSeconds: 30,
  lagP99Seconds: 0.2,
  batchP99Seconds: 0.05,
  dbCpuIncreasePctPoints: 5,
  paymentP99Ms: 3000,
  drainSeconds: 300,
});

const DEFAULT_RATE = RELAY_RULES.designPeakPerSecond * RELAY_RULES.rateMultiplier;
const DEFAULT_PAYMENT_RATE = 300;
const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$/;
const PROM_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/;
const TX_COLUMNS = ['id', 'key', 'seq', 'event_key', 'created_at'];
const RECEIVED_COLUMNS = ['id', 'key', 'seq', 'event_key', 'publisher', 'received_at'];

const intArg = (name, raw, lo, hi) => {
  if (!/^\d+$/.test(String(raw))) fail(`${name}은 ${lo}~${hi} 정수다: ${raw}`);
  const n = Number(raw);
  if (n < lo || n > hi) fail(`${name}은 ${lo}~${hi} 정수다: ${raw}`);
  return n;
};

/** v1 relay-fault 인자. 계획 7.2의 공개 꼴 */
export function parseRelayFaultArgs(argv) {
  if (!Array.isArray(argv)) fail('인자 목록이 없다');
  const seen = new Map();
  const valueFlags = new Set(['--main', '--rate', '--relay', '--payment-rate', '--payment-mode', '--out', '--run-id', '--prom-url']);
  const boolFlags = new Set(['--record']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!valueFlags.has(flag) && !boolFlags.has(flag)) fail(`모르는 인자: ${flag}`);
    if (seen.has(flag)) fail(`${flag}를 두 번 줬다`);
    if (boolFlags.has(flag)) {
      seen.set(flag, true);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${flag}에 값이 없다`);
    seen.set(flag, v);
    i++;
  }
  const relay = seen.get('--relay') ?? 'on';
  if (relay !== 'on' && relay !== 'off') fail(`--relay는 on·off 가운데 하나다: ${relay}`);
  const paymentMode = seen.get('--payment-mode') ?? 'load';
  if (paymentMode !== 'load') fail(`--payment-mode는 load만 받는다: ${paymentMode}`);
  const record = seen.get('--record') === true;
  const runId = seen.get('--run-id');
  if (record && runId === undefined) fail('--record에는 --run-id가 꼭 있어야 한다');
  if (!record && runId !== undefined) fail('--run-id는 --record와 함께만 준다');
  if (runId !== undefined && !RUN_ID.test(runId)) fail(`--run-id 꼴이 틀렸다(YYYY-MM-DD-영소문자·숫자·-): ${runId}`);
  const promUrl = seen.get('--prom-url');
  if (promUrl !== undefined && !PROM_URL.test(promUrl)) fail(`--prom-url은 http://127.0.0.1:<포트>나 http://localhost:<포트>다: ${promUrl}`);
  return {
    mainSeconds: intArg('--main', seen.get('--main') ?? RELAY_RULES.mainSeconds, 60, 3600),
    rate: intArg('--rate', seen.get('--rate') ?? DEFAULT_RATE, 1, 1_000_000),
    relay,
    paymentRate: intArg('--payment-rate', seen.get('--payment-rate') ?? DEFAULT_PAYMENT_RATE, 1, 100_000),
    paymentMode,
    ...(seen.get('--out') !== undefined ? { out: seen.get('--out') } : {}),
    record,
    ...(runId !== undefined ? { runId } : {}),
    ...(promUrl !== undefined ? { promUrl } : {}),
  };
}

/**
 * V-T27 부하 계획: 30분×도착률만큼 보낸 행을 DB COPY로 넣는다. 메모리 배열을 만들지 않는다.
 * f089_sent에 보낸 행을 먼저 적고 Outbox에 넣으며, 소비자가 f089_received에 받은 행을 적는다.
 */
export function relayLoadPlan({ mainSeconds = RELAY_RULES.mainSeconds, rate = DEFAULT_RATE } = {}) {
  if (!Number.isInteger(mainSeconds) || mainSeconds < 60 || mainSeconds > 3600) throw new RangeError(`mainSeconds: ${mainSeconds}`);
  if (!Number.isInteger(rate) || rate <= 0) throw new RangeError(`rate: ${rate}`);
  const rows = rate * mainSeconds;
  const batchRows = 5_000;
  const hotKeyEvery = 10;
  return {
    rows,
    batchRows,
    batches: Math.ceil(rows / batchRows),
    writer: 'copy',
    sentTable: 'f089_sent',
    receivedTable: 'f089_received',
    hotKeyEvery,
    sentColumns: TX_COLUMNS,
    receivedColumns: RECEIVED_COLUMNS,
  };
}

/** f089_received를 채우는 소비자 계약 */
export function relayConsumerPlan({ topic, table = 'f089_received' } = {}) {
  if (typeof topic !== 'string' || topic.trim() === '') throw new RangeError('topic이 없다');
  if (table !== 'f089_received') throw new RangeError(`소비자 표는 f089_received여야 한다: ${table}`);
  return {
    group: 'peaket-f089-relay-consumer',
    topic,
    table: 'f089_received',
    columns: [...RECEIVED_COLUMNS],
    maxBatch: 1_000,
  };
}

/** V-T28 ①②③의 계획. ③은 끝나기 drainSeconds 전에 끝나 드레인 창을 남긴다 */
export function faultPlan({ mainSeconds = RELAY_RULES.mainSeconds } = {}) {
  if (!Number.isInteger(mainSeconds) || mainSeconds < 60 || mainSeconds > 3600) throw new RangeError(`mainSeconds: ${mainSeconds}`);
  const last = mainSeconds - RELAY_RULES.drainSeconds;
  if (last < 120) throw new RangeError(`mainSeconds가 너무 짧아 드레인 창을 둘 수 없다: ${mainSeconds}`);
  const first = Math.max(1, Math.floor(mainSeconds / 3));
  const second = Math.min(last - RELAY_RULES.brokerStopSeconds, Math.floor((mainSeconds * 2) / 3));
  if (second <= first || last <= second) throw new RangeError(`장애 시각을 벌릴 수 없다: ${mainSeconds}`);
  return [
    { kind: 'leader-stop', atSecond: first, durationSeconds: 0 },
    { kind: 'kafka-stop', atSecond: second, durationSeconds: RELAY_RULES.brokerStopSeconds },
    { kind: 'db-cut', atSecond: last, durationSeconds: 0 },
  ];
}

const iso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** 장애 기록이 계획과 같은지 본다. 적용·증거·시각·길이·종류 중복을 모두 요구한다 */
export function validateFaultRecords(records, plan) {
  const problems = [];
  if (!Array.isArray(records)) return { ok: false, problems: ['기록이 배열이 아니다'] };
  if (!Array.isArray(plan) || plan.length !== 3) return { ok: false, problems: ['계획이 ①②③ 세 줄이 아니다'] };
  const expectedKinds = new Set(plan.map((p) => p.kind));
  const byKind = new Map();
  for (const r of records) {
    if (!r || typeof r.kind !== 'string') {
      problems.push('종류가 없는 기록');
      continue;
    }
    if (!expectedKinds.has(r.kind)) problems.push(`계획에 없는 종류: ${r.kind}`);
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  for (const [kind, rows] of byKind) if (rows.length !== 1) problems.push(`${kind} 기록이 ${rows.length}개다(한 번이어야 한다)`);
  for (const expected of plan) {
    const rows = byKind.get(expected.kind) ?? [];
    if (rows.length === 0) {
      problems.push(`${expected.kind} 기록이 없다`);
      continue;
    }
    if (rows.length > 1) continue;
    const r = rows[0];
    if (r.applied !== true) problems.push(`${expected.kind}: applied가 참이 아니다`);
    if (typeof r.evidence !== 'string' || r.evidence.trim() === '') problems.push(`${expected.kind}: 증거가 비었다`);
    if (r.atSecond !== expected.atSecond) problems.push(`${expected.kind}: atSecond ${r.atSecond} != ${expected.atSecond}`);
    if (r.durationSeconds !== expected.durationSeconds) problems.push(`${expected.kind}: durationSeconds ${r.durationSeconds} != ${expected.durationSeconds}`);
    if (!iso(r.startedAt) || !iso(r.endedAt)) problems.push(`${expected.kind}: 시작·끝 시각이 ISO가 아니다`);
  }
  return { ok: problems.length === 0, problems };
}

/** 작은 표본 전용: 받은 기록에 없는 보낸 행 ID. 측정 경로는 RELAY_EVIDENCE_SQL을 쓴다 */
export function missingRowIds(sent, received) {
  const got = new Set((received ?? []).map((r) => r.id));
  return [...new Set((sent ?? []).map((r) => r.id).filter((id) => !got.has(id)))];
}

/** 작은 표본 전용: 재개 시각 뒤 옛 리더가 보낸 행 수. 측정 경로는 RELAY_EVIDENCE_SQL을 쓴다 */
export function oldLeaderSendCount(received, oldLeader, takeoverAt) {
  return (received ?? []).filter((r) => r.publisher === oldLeader && Number(r.atMs) > takeoverAt).length;
}

/** p50·p99·max(최근접 순위). 빈 표본은 null(0이 아니다) */
export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return { count: 0, p50: null, p99: null, max: null };
  const a = samples.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length === 0) return { count: 0, p50: null, p99: null, max: null };
  const at = (p) => a[Math.max(0, Math.ceil(p * a.length) - 1)];
  return { count: a.length, p50: at(0.5), p99: at(0.99), max: a[a.length - 1] };
}

/** 측정 경로의 DB 증거 SQL. 안티조인·스트리밍 집계만 쓴다(행 배열 금지) */
export const RELAY_EVIDENCE_SQL = Object.freeze({
  missing: `select count(*)::bigint as n
    from f089_sent s left join f089_received r on r.id = s.id
    where r.id is null`,
  order: `select count(*)::bigint as n from (
      select seq, lag(seq) over (partition by key order by received_at, id) as prev
      from f089_received
    ) t where prev is not null and seq < prev`,
  eventKey: `select count(*)::bigint as n from (
      select id from f089_received group by id having count(distinct event_key) > 1
    ) t`,
  oldLeader: `select count(*)::bigint as n
    from f089_received
    where publisher = $1 and received_at > $2`,
  hotKeys: `select max(c)::bigint as n from (
      select key, count(*) as c from f089_sent group by key
    ) t`,
  payment: `select percentile_cont(0.99) within group (order by p99_ms) as p99
    from f089_payment_p99 where window in ('main', 'broker-restart')`,
});

const nonNegInt = (v) => Number.isInteger(v) && v >= 0;
const finiteNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** V-T27·V-T28 판정. 입력은 DB 집계 건수다(행 배열을 받지 않는다) */
export function judgeRelayRun(o) {
  const problems = [];
  const invalid = (m) => problems.push(m);
  if (!o || typeof o !== 'object') return { verdict: 'invalid', problems: ['입력이 없다'], triggers: [], summary: {} };
  if (o.mainSeconds !== RELAY_RULES.mainSeconds) invalid(`본구간이 ${RELAY_RULES.mainSeconds}초가 아니다: ${o.mainSeconds}`);
  if (o.rate !== DEFAULT_RATE) invalid(`도착률이 ${DEFAULT_RATE}/s가 아니다: ${o.rate}`);
  if (!Number.isInteger(o.sentRows) || o.sentRows <= 0) invalid('보낸 행 수가 없다');
  if (!Number.isInteger(o.receivedRows) || o.receivedRows < 0) invalid('받은 행 수가 없다');
  for (const [key, value] of [['missingRows', o.missingRows], ['orderViolations', o.orderViolations], ['eventKeyMismatches', o.eventKeyMismatches], ['oldLeaderSends', o.oldLeaderSends]]) {
    if (!nonNegInt(value)) invalid(`${key}가 0 이상 정수가 아니다: ${value}`);
  }
  if (!Number.isInteger(o.maxKeyRepeats) || o.maxKeyRepeats <= 1) invalid(`maxKeyRepeats가 2 이상이 아니다: ${o.maxKeyRepeats}`);
  const p = o.payment;
  if (!p || typeof p !== 'object') invalid('P-T5 payment가 없다');
  else {
    if (typeof o.runId !== 'string' || p.runId !== o.runId) invalid('P-T5가 같은 실행 ID가 아니다');
    if (p.mode !== 'load') invalid(`P-T5 mode가 load가 아니다: ${p.mode}`);
    if (!Number.isInteger(p.rate) || p.rate <= 0) invalid(`P-T5 rate가 0보다 큰 정수가 아니다: ${p.rate}`);
    if (!nonNegInt(p.pullCount)) invalid(`P-T5 pullCount가 0 이상 정수가 아니다: ${p.pullCount}`);
    if (!finiteNonNeg(p.p99Ms)) invalid(`P-T5 p99가 없다: ${p.p99Ms}`);
    if (!finiteNonNeg(p.p99BrokerRestartMs)) invalid(`P-T5 브로커 구간 p99가 없다: ${p.p99BrokerRestartMs}`);
  }
  if (!Array.isArray(o.lagSeconds) || o.lagSeconds.length === 0 || !o.lagSeconds.every(finiteNonNeg)) invalid('릴레이 지연 표본이 없다');
  if (!Array.isArray(o.batchSeconds) || o.batchSeconds.length === 0 || !o.batchSeconds.every(finiteNonNeg)) invalid('묶음 표본이 없다');
  if (!Number.isFinite(o.leaderChangeMs) || o.leaderChangeMs <= 0) invalid('리더 변경 시간이 없다');
  if (!finiteNonNeg(o.relayCpuPctPoints)) invalid('DB CPU 증가분이 없다');
  const faults = validateFaultRecords(o.faults, planOf(o.mainSeconds));
  if (!faults.ok) invalid(`장애 기록: ${faults.problems.join('; ')}`);

  const lag = summarizeSamples(o.lagSeconds);
  const batch = summarizeSamples(o.batchSeconds);
  const summary = {
    sentRows: o.sentRows,
    receivedRows: o.receivedRows,
    missing: o.missingRows,
    order: o.orderViolations,
    eventKey: o.eventKeyMismatches,
    oldLeaderSends: o.oldLeaderSends,
    maxKeyRepeats: o.maxKeyRepeats,
    p50: lag.p50,
    p99: lag.p99,
    batchP99: batch.p99,
    paymentP99Ms: p?.p99Ms,
    paymentP99BrokerRestartMs: p?.p99BrokerRestartMs,
    paymentPulls: p?.pullCount,
    leaderChangeMs: o.leaderChangeMs,
  };
  if (problems.length > 0) return { verdict: 'invalid', problems, triggers: [], summary };

  const triggers = [];
  if (lag.p99 !== null && lag.p99 > RELAY_RULES.lagP99Seconds) triggers.push('relay-lag');
  if (batch.p99 !== null && batch.p99 > RELAY_RULES.batchP99Seconds) triggers.push('batch');
  if (o.relayCpuPctPoints > RELAY_RULES.dbCpuIncreasePctPoints) triggers.push('db-cpu');
  if (p.p99Ms > RELAY_RULES.paymentP99Ms) triggers.push('payment-p99');
  if (p.p99BrokerRestartMs > RELAY_RULES.paymentP99Ms) triggers.push('payment-p99-broker');

  const lost = o.missingRows > 0 || o.orderViolations > 0 || o.eventKeyMismatches > 0 || o.oldLeaderSends > 0;
  if (lost) {
    if (o.missingRows > 0) problems.push(`빠진 행 ${o.missingRows}건`);
    if (o.orderViolations > 0) problems.push(`순서 뒤집힘 ${o.orderViolations}건`);
    if (o.eventKeyMismatches > 0) problems.push(`eventKey 불일치 ${o.eventKeyMismatches}건`);
    if (o.oldLeaderSends > 0) problems.push(`옛 리더가 재개 뒤 보낸 행 ${o.oldLeaderSends}건`);
    return { verdict: 'fail', problems, triggers, summary };
  }
  return { verdict: 'pass', problems, triggers, summary };
}

const planOf = (mainSeconds) => {
  try {
    return faultPlan({ mainSeconds });
  } catch {
    return [];
  }
};

/** Toxiproxy 판 고정·제어 API·인증(정본 §2.5) */
export const TOXIPROXY_RULES = Object.freeze({
  image: 'ghcr.io/shopify/toxiproxy:2.13.0',
  controlListen: '127.0.0.1:8474',
  authTokenEnv: 'TOXIPROXY_AUTH_TOKEN',
});

const TOXIC_TYPES = new Set(['latency', 'reset_peer', 'timeout']);

/** Toxiproxy 프록시 계획(데이터 프록시). 제어 API 설정은 TOXIPROXY_RULES가 정한다 */
export function buildToxiproxy({ name, listen, upstream, toxics } = {}) {
  if (typeof name !== 'string' || name.trim() === '') throw new RangeError('Toxiproxy 이름이 없다');
  if (typeof listen !== 'string' || listen.trim() === '') throw new RangeError('listen이 없다');
  if (typeof upstream !== 'string' || upstream.trim() === '') throw new RangeError('upstream이 없다');
  if (!Array.isArray(toxics)) throw new RangeError('toxics가 배열이 아니다');
  const out = toxics.map((t) => {
    if (!t || !TOXIC_TYPES.has(t.type)) throw new RangeError(`모르는 toxic 종류: ${t?.type}`);
    const attributes = t.attributes ?? {};
    for (const [k, v] of Object.entries(attributes)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RangeError(`${t.type}.${k}가 0 이상 수가 아니다: ${v}`);
    }
    return { type: t.type, attributes };
  });
  return { name, listen, upstream, toxics: out };
}

const APPROVED_SIM = new Set(['DONE', 'PARTIAL_CANCELED']);
const refOf = (r) => r.payment_ref ?? r.paymentKey;

/** GET /sim/ledger의 NDJSON과 payment 원장을 결제 참조로 맞춘다 */
export function reconcileSimLedger({ simNdjson, payment } = {}) {
  const lines = typeof simNdjson === 'string' ? simNdjson.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const charges = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r?.kind === 'pg_charge') charges.push(r);
    } catch {
      // 깨진 줄은 승인으로 세지 않는다(원장 대조가 조용히 통과하지 않게)
    }
  }
  const approvedRefs = charges.filter((r) => APPROVED_SIM.has(r.status)).map(refOf).filter(Boolean);
  const approved = approvedRefs.length;
  if (approved === 0) return { approved: 0, recorded: 0, missing: [], duplicatePayments: 0, verdict: 'invalid' };
  const counts = new Map();
  for (const row of payment ?? []) {
    const ref = refOf(row);
    if (ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  const recorded = [...counts.keys()].length;
  const missing = [...new Set(approvedRefs)].filter((ref) => !counts.has(ref)).sort();
  const duplicatePayments = [...counts.values()].filter((n) => n > 1).length;
  if (missing.length > 0 || duplicatePayments > 0) return { approved, recorded, missing, duplicatePayments, verdict: 'fail' };
  return { approved, recorded, missing: [], duplicatePayments: 0, verdict: 'pass' };
}

/** 같은 webhook-id를 duplicates회 보내는 계획(수신 쪽 멱등을 시험한다) */
export function webhookDuplicatePlan({ webhookId, duplicates = 2 } = {}) {
  if (typeof webhookId !== 'string' || webhookId.trim() === '') throw new RangeError('webhookId가 없다');
  if (!Number.isInteger(duplicates) || duplicates < 2 || duplicates > 10) throw new RangeError(`duplicates는 2~10 정수다: ${duplicates}`);
  return {
    webhookId,
    sendCount: duplicates,
    events: Array.from({ length: duplicates }, (_, i) => ({ webhookId, index: i + 1 })),
  };
}

/** 웹훅 중복: 같은 webhook-id 두 번 보내고 한 번만 처리돼야 한다 */
export function judgeWebhookDuplicates({ sent, processed } = {}) {
  if (!Number.isInteger(sent) || sent < 2) return { verdict: 'invalid' };
  if (processed === 1) return { verdict: 'pass' };
  return { verdict: 'fail' };
}

/** P-T1 추가 몫: 발생기 유효·시뮬레이터 원장·웹훅 중복·불변식 */
export function judgePaymentFaultRun(o = {}) {
  const problems = [];
  const g = o.generator;
  if (!g || g.valid !== true || !Number.isInteger(g.dropped) || g.dropped !== 0) {
    return { verdict: 'invalid', problems: ['발생기가 유효하지 않다(dropped > 0 또는 valid=false)'], summary: {} };
  }
  const sim = reconcileSimLedger({ simNdjson: o.simNdjson, payment: o.payment });
  if (sim.verdict === 'invalid') return { verdict: 'invalid', problems: ['시뮬레이터 원장이 비었다'], summary: { ...sim } };
  if (sim.verdict === 'fail') problems.push(`원장 대조: missing ${sim.missing.length}, duplicatePayments ${sim.duplicatePayments}`);
  const wh = judgeWebhookDuplicates(o.webhook ?? {});
  if (wh.verdict === 'invalid') return { verdict: 'invalid', problems: ['웹훅 중복 발송이 2회 미만이다'], summary: { ...sim, webhook: wh.verdict } };
  if (wh.verdict === 'fail') problems.push('웹훅이 두 번 처리됐다');
  const inv = o.invariants ?? {};
  if (inv.P6 === 'FAIL' || inv.P1 === 'FAIL') problems.push('불변식 P1·P6 위반');
  const verdict = problems.length > 0 ? 'fail' : 'pass';
  return {
    verdict,
    problems,
    summary: {
      ...sim,
      webhook: wh.verdict,
      duplicateIssue: inv.S3 === 'SKIPPED' || inv.S3 === undefined ? '미측정' : '판정',
    },
  };
}

export { parsePaymentFaultArgs } from './payment-fault.mjs';
