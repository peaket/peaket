// F-04-8 집계·검증(docs/review/plans/F-04-8.md §3·§7). 실행이 끝난 뒤 Kafka 오프셋·브론즈·rt 표를 읽어
// 누락률·정확성·신선도를 판정한다. run.mjs가 실행 끝에 부르고, 따로 `verify` 명령으로도 부를 수 있다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeAccuracy, judgeFreshness, judgeHotLag, judgeLoss, judgeRun, percentile } from './lib.mjs';
import { loadPlatform } from './modules.mjs';

export const GROUPS = Object.freeze({
  analytics: (env = 'ci') => `peaket.analytics-ingest.${env}`,
  rt: (env = 'ci') => `peaket.ops-rt.${env}`,
});

const BRONZE_TABLE = {
  seat: 'bronze.brz_seat_event',
  order: 'bronze.brz_order_event',
  payment: 'bronze.brz_payment_event',
  ticket: 'bronze.brz_ticket_event',
  hold: 'bronze.brz_hold_attempt',
  verdict: 'bronze.brz_trust_verdict',
  queue: 'bronze.brz_queue_entry',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 발생기 샤드 manifest를 하나로 합친다 */
export function mergeManifests(manifests) {
  const out = {
    runId: manifests[0]?.runId ?? 'unknown',
    mode: manifests[0]?.mode ?? 'normal',
    shards: manifests.length,
    total: 0,
    byRecord: {},
    sums: { orderAmount: 0, paymentAmount: 0 },
    results: { hold: {}, verdict: {} },
    producerFailures: 0,
    errors: [],
    shardStatus: [],
    partitions: manifests[0]?.partitions ?? 0,
    startedAt: manifests.map((m) => m.startedAt).filter(Boolean).sort()[0] ?? null,
    endedAt: manifests.map((m) => m.endedAt).filter(Boolean).sort().at(-1) ?? null,
  };
  for (const m of manifests) {
    out.total += num(m.sent);
    out.producerFailures += num(m.producerFailures);
    for (const [k, v] of Object.entries(m.byRecord ?? {})) out.byRecord[k] = (out.byRecord[k] ?? 0) + num(v);
    out.sums.orderAmount += num(m.sums?.orderAmount);
    out.sums.paymentAmount += num(m.sums?.paymentAmount);
    for (const [k, v] of Object.entries(m.results?.hold ?? {})) out.results.hold[k] = (out.results.hold[k] ?? 0) + num(v);
    for (const [k, v] of Object.entries(m.results?.verdict ?? {})) out.results.verdict[k] = (out.results.verdict[k] ?? 0) + num(v);
    out.errors.push(...(m.errors ?? []));
    out.shardStatus.push({ shard: m.shard, status: m.status, sent: num(m.sent), failures: num(m.producerFailures) });
  }
  out.producerOk = manifests.length > 0 && manifests.every((m) => m.status === 'done' && num(m.producerFailures) === 0);
  out.producerReasons = manifests.length === 0 ? ['발생기 manifest가 없다'] : manifests.filter((m) => m.status !== 'done' || num(m.producerFailures) > 0).map((m) => `샤드 ${m.shard}: ${m.status}, 실패 ${m.producerFailures ?? 0}`);
  return out;
}

/** 토픽·파티션의 낮은/높은 오프셋 */
export async function kafkaOffsets(admin, topics) {
  const out = {};
  for (const topic of topics) {
    const rows = await admin.fetchTopicOffsets(topic);
    out[topic] = Object.fromEntries(rows.map((r) => [Number(r.partition), { low: num(r.low), high: num(r.high) }]));
  }
  return out;
}

export function expectedOffsets(start, end) {
  let expected = 0;
  for (const [topic, parts] of Object.entries(end ?? {})) {
    for (const [partition, high] of Object.entries(parts ?? {})) {
      const low = num(start?.[topic]?.[partition]?.low ?? 0);
      const hi = num(high?.high);
      expected += Math.max(0, hi - low);
    }
  }
  return expected;
}

/** 소비자 그룹의 커밋 오프셋과 밀림. 그룹이 없으면 빈 결과(호출 쪽이 invalid로 다룬다) */
export async function groupLag(admin, groupId, end, start = {}) {
  let fetched;
  try {
    fetched = await admin.fetchOffsets({ groupId });
  } catch (err) {
    return { groupId, found: false, error: String(err?.message ?? err), total: null, max: null, hot: null, partitions: [] };
  }
  const committed = new Map();
  for (const t of fetched) for (const p of t.partitions) committed.set(`${t.topic}#${p.partition}`, num(p.offset));
  const partitions = [];
  let total = 0;
  let max = 0;
  for (const [topic, parts] of Object.entries(end)) {
    for (const [partition, high] of Object.entries(parts)) {
      const key = `${topic}#${partition}`;
      const low = start?.[topic]?.[partition]?.low ?? 0;
      const offset = committed.has(key) ? committed.get(key) : low;
      const lag = Math.max(0, high.high - offset);
      total += lag;
      max = Math.max(max, lag);
      if (lag > 0) partitions.push({ topic, partition: Number(partition), lag, committed: offset, high: high.high });
    }
  }
  return { groupId, found: true, total, max, partitions };
}

/** 브론즈 커버리지(고유 오프셋) */
export async function bronzeCoverage(ch) {
  const rows = await ch.rows(`SELECT topic, partition, uniqExact(offset) AS covered, countIf(outcome = 'REJECTED') AS rejected, countIf(outcome = 'SKIPPED') AS skipped FROM bronze.brz_offset GROUP BY topic, partition`);
  const byTopic = {};
  let covered = 0;
  let rejected = 0;
  let skipped = 0;
  for (const r of rows) {
    const topic = String(r.topic);
    const partition = Number(r.partition);
    byTopic[topic] ??= {};
    byTopic[topic][partition] = { covered: num(r.covered), rejected: num(r.rejected), skipped: num(r.skipped) };
    covered += num(r.covered);
    rejected += num(r.rejected);
    skipped += num(r.skipped);
  }
  return { covered, rejected, skipped, byTopic };
}

async function unionCounts(ch, spec, label) {
  const sql = Object.entries(spec)
    .map(([kind, table]) => `SELECT '${kind}' AS kind, uniqExact(event_key) AS c, count() AS raw FROM ${table}`)
    .join(' UNION ALL ');
  const rows = await ch.rows(sql);
  return Object.fromEntries(rows.map((r) => [String(r.kind), { c: num(r.c), raw: num(r.raw) }]));
}

async function dedupSum(ch, table, where) {
  const rows = await ch.rows(`SELECT sum(amount) AS s FROM (SELECT event_key, any(JSONExtractInt(payload, 'amount')) AS amount FROM ${table} WHERE ${where} GROUP BY event_key)`);
  return num(rows[0]?.s);
}

/** 브론즈·rt의 고유 eventKey 수와 금액 */
export async function readAccuracy(ch, manifest) {
  const bronzeCounts = await unionCounts(ch, BRONZE_TABLE, 'bronze');
  const bronze = Object.fromEntries(Object.keys(BRONZE_TABLE).map((k) => [k, bronzeCounts[k]?.c ?? 0]));
  bronze.rawRows = Object.fromEntries(Object.keys(BRONZE_TABLE).map((k) => [k, bronzeCounts[k]?.raw ?? 0]));
  bronze.orderAmount = await dedupSum(ch, 'bronze.brz_order_event', '1 = 1');
  bronze.paymentAmount = await dedupSum(ch, 'bronze.brz_payment_event', '1 = 1');

  const saleRows = await ch.rows(`SELECT source, type, uniqExact(event_key) AS c, count() AS raw FROM rt.sale_event GROUP BY source, type`);
  const sale = {};
  for (const r of saleRows) sale[`${r.source}/${r.type}`] = { c: num(r.c), raw: num(r.raw) };
  const holdRows = await ch.rows(`SELECT result, uniqExact(event_key) AS c, count() AS raw FROM rt.hold_attempt GROUP BY result`);
  const hold = Object.fromEntries(holdRows.map((r) => [String(r.result), { c: num(r.c), raw: num(r.raw) }]));
  const verdictRows = await ch.rows(`SELECT category, uniqExact(event_key) AS c, count() AS raw FROM rt.verdict GROUP BY category`);
  const verdict = Object.fromEntries(verdictRows.map((r) => [String(r.category), { c: num(r.c), raw: num(r.raw) }]));
  const paymentAmount = num((await ch.rows(`SELECT sum(amount) AS s FROM (SELECT event_key, any(amount) AS amount FROM rt.sale_event WHERE source = 'PAYMENT' AND type = 'APPROVED' GROUP BY event_key)`))[0]?.s);
  const orderAmount = num((await ch.rows(`SELECT sum(amount) AS s FROM (SELECT event_key, any(amount) AS amount FROM rt.sale_event WHERE source = 'ORDER' AND type = 'CONFIRMED' GROUP BY event_key)`))[0]?.s);

  const rt = {
    seatSold: sale['SEAT/SOLD']?.c ?? 0,
    orderConfirmed: sale['ORDER/CONFIRMED']?.c ?? 0,
    paymentApproved: sale['PAYMENT/APPROVED']?.c ?? 0,
    ticketIssued: sale['TICKET/ISSUED']?.c ?? 0,
    orderAmount,
    paymentAmount,
    holdHelped: hold.HELD?.c ?? 0,
    holdConflict: hold.CONFLICT?.c ?? 0,
    verdictPass: verdict.PASS?.c ?? 0,
  };
  rt.rawRows = { sale: Object.fromEntries(Object.entries(sale).map(([k, v]) => [k, v.raw])), hold: Object.fromEntries(Object.entries(hold).map(([k, v]) => [k, v.raw])), verdict: Object.fromEntries(Object.entries(verdict).map(([k, v]) => [k, v.raw])) };
  return { bronze, rt };
}

export function expectedAccuracy(manifest) {
  const b = manifest.byRecord ?? {};
  const h = manifest.results?.hold ?? {};
  const v = manifest.results?.verdict ?? {};
  return {
    bronze: {
      seat: num(b.seat),
      order: num(b.order),
      payment: num(b.payment),
      ticket: num(b.ticket),
      hold: num(b.hold),
      verdict: num(b.verdict),
      queue: num(b.queue),
      orderAmount: num(manifest.sums?.orderAmount),
      paymentAmount: num(manifest.sums?.paymentAmount),
    },
    rt: {
      seatSold: num(b.seat),
      orderConfirmed: num(b.order),
      paymentApproved: num(b.payment),
      ticketIssued: num(b.ticket),
      paymentAmount: num(manifest.sums?.paymentAmount),
      holdHelped: num(h.HELD),
      holdConflict: num(h.CONFLICT),
      verdictPass: num(v.PASS),
    },
  };
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/** 샘플에서 판정용 값만 고른다. 회복 구간은 정확성 판정에만 넣고 신선도에서는 뺀다(계획 §7.1) */
export function freshnessFromSamples(samples) {
  const use = (s) => s.phase === 'steady' || s.phase === 'drain';
  // C-T14·NFR-009의 '두 길 가운데 큰 값'을 쓴다. rtHeadMs가 없으면 누적 길만 쓴다(옛 산출물 호환).
  const head = (s) => (Number.isFinite(s.rtHeadMs) ? s.rtHeadMs : s.rtMs);
  const rt = samples.filter((s) => Number.isFinite(head(s)) && use(s)).map((s) => ({ at: s.at, ms: head(s) }));
  const bucket = samples.filter((s) => Number.isFinite(s.rtBucketMs) && use(s)).map((s) => s.rtBucketMs);
  const bronze = samples.filter((s) => Number.isFinite(s.bronzeMs) && use(s)).map((s) => s.bronzeMs);
  const query = samples.filter((s) => Number.isFinite(s.queryMs)).map((s) => s.queryMs);
  const hot = samples.filter((s) => Number.isFinite(s.hotLag) && use(s)).map((s) => s.hotLag);
  return { rt, bucket, bronze, query, hot };
}

/**
 * 실행 하나를 검증한다.
 * @param {{ch:any,admin:any,manifest:object,start:object,end:object,groups:object,samples:object[],mode?:string}} o
 */
export async function verifyRun(o) {
  const manifest = o.manifest;
  const expected = expectedOffsets(o.start, o.end);
  const coverage = await bronzeCoverage(o.ch);
  const loss = judgeLoss({ expected, covered: coverage.covered, rejected: coverage.rejected, producerFailures: manifest.producerFailures });
  const lag = {
    analytics: await groupLag(o.admin, o.groups.analytics, o.end),
    rt: await groupLag(o.admin, o.groups.rt, o.end),
  };
  const accuracyExpected = expectedAccuracy(manifest);
  const accuracyActual = await readAccuracy(o.ch, manifest);
  const accuracy = judgeAccuracy({ expected: accuracyExpected, actual: accuracyActual });
  const f = freshnessFromSamples(o.samples ?? []);
  const freshness = judgeFreshness(f.rt, { minSamples: o.minFreshnessSamples ?? 5 });
  const bronzeFreshness = judgeFreshness(f.bronze, { minSamples: o.minFreshnessSamples ?? 5 });
  const hot = o.mode === 'hot' && f.hot.length ? judgeHotLag(f.hot, { minSamples: o.minHotSamples ?? 5 }) : null;
  const queryP95 = percentile(f.query, 0.95);
  const hostCpu = percentile((o.samples ?? []).map((s) => s.hostCpu).filter((v) => Number.isFinite(v)), 0.95);
  const chCpu = percentile((o.samples ?? []).map((s) => s.chCpu).filter((v) => Number.isFinite(v)), 0.95);

  const judged = judgeRun({ freshness: { samples: f.rt, options: { minSamples: o.minFreshnessSamples ?? 5 } }, loss, accuracy, ...(hot ? { hot: { samples: f.hot, options: { minSamples: o.minHotSamples ?? 5 } } } : {}), mode: o.mode });
  const invalidReasons = [];
  if (!manifest.producerOk) invalidReasons.push(...manifest.producerReasons);
  if (!lag.analytics.found) invalidReasons.push(`분석 소비자 그룹을 찾지 못했다: ${lag.analytics.error ?? ''}`);
  if (!lag.rt.found) invalidReasons.push(`관제 소비자 그룹을 찾지 못했다: ${lag.rt.error ?? ''}`);
  if ((lag.analytics.total ?? 0) > 0) invalidReasons.push(`분석 소비자 밀림이 ${lag.analytics.total}건 남았다(따라잡기 실패)`);
  if ((lag.rt.total ?? 0) > 0) invalidReasons.push(`관제 소비자 밀림이 ${lag.rt.total}건 남았다(따라잡기 실패)`);
  const verdict = invalidReasons.length ? 'invalid' : judged.verdict;
  const reasons = [...new Set([...invalidReasons, ...judged.reasons])];
  const report = {
    runId: manifest.runId,
    mode: o.mode ?? manifest.mode,
    generatedAt: new Date().toISOString(),
    expectedOffsets: expected,
    coverage,
    lag,
    loss,
    accuracy: { pass: accuracy.pass, compared: accuracy.compared, reasons: accuracy.reasons, expected: accuracyExpected, actual: accuracyActual },
    freshness: { rt: freshness, bronze: bronzeFreshness, queryP95, samples: f.rt.length },
    hot,
    cpu: { hostP95: hostCpu, clickhouseP95: chCpu },
    manifest,
    verdict,
    pass: verdict === 'pass',
    reasons,
  };
  report.bench = {
    requests: manifest.total,
    dropped: manifest.producerFailures,
    p99_ms: freshness.p95 ?? 0,
    error_rate: loss.ratio ?? 0,
  };
  return report;
}

export function reportMarkdown(r) {
  const f = r.freshness.rt;
  const l = r.loss;
  const a = r.accuracy;
  const lines = [
    `# F-04-8 측정 결과 ${r.runId}`,
    '',
    `- 판정: **${r.verdict}**${r.reasons.length ? ` — ${r.reasons.slice(0, 6).join(' / ')}` : ''}`,
    `- 입력: ${r.manifest.total.toLocaleString()}건, 발생기 실패 ${r.manifest.producerFailures}건, 모드 ${r.mode}`,
    `- 신선도(관제): p95 ${f.p95 === null ? '—' : `${Math.round(f.p95)}ms`}, 샘플 ${f.count}개, 1분 창 ${f.fullWindows}개, 창 위반 ${f.windows.filter((w) => w.p95 !== null && w.p95 >= f.limitMs).length}개`,
    `- 신선도(브론즈, 참고): p95 ${r.freshness.bronze.p95 === null ? '—' : `${Math.round(r.freshness.bronze.p95)}ms`}`,
    `- 누락률: ${l.ratio === null ? '—' : `${(l.ratio * 100).toFixed(4)}%`} (전체 ${l.denominator.toLocaleString()}, 못 읽음 ${l.missing}, 거절 ${r.coverage.rejected})`,
    `- 정확성: ${a.pass ? '차이 0' : `차이 있음 — ${a.reasons.slice(0, 4).join(' / ')}`} (비교 ${a.compared}개)`,
    `- 소비자 밀림: 분석 ${r.lag.analytics.total ?? '—'}, 관제 ${r.lag.rt.total ?? '—'}`,
    `- 조회 p95: ${r.freshness.queryP95 === null ? '—' : `${Math.round(r.freshness.queryP95)}ms`}, ClickHouse CPU p95 ${r.cpu.clickhouseP95 === null ? '—' : `${r.cpu.clickhouseP95.toFixed(1)}%`}, 호스트 CPU p95 ${r.cpu.hostP95 === null ? '—' : `${r.cpu.hostP95.toFixed(1)}%`}`,
    r.hot ? `- 인기 회차 파티션 밀림 p95: ${r.hot.p95 === null ? '—' : `${Math.round(r.hot.p95)}ms`} (${r.hot.pass ? '통과' : '실패'})` : '',
    '',
    '| 브론즈 | 기대 | 실제 |',
    '| --- | --- | --- |',
    ...Object.keys(a.expected.bronze).map((k) => `| ${k} | ${a.expected.bronze[k]} | ${a.actual.bronze[k]} |`),
    '',
    '| 관제 rt | 기대 | 실제 |',
    '| --- | --- | --- |',
    ...Object.keys(a.expected.rt).map((k) => `| ${k} | ${a.expected.rt[k]} | ${a.actual.rt[k]} |`),
    '',
  ];
  return `${lines.filter((x) => x !== '').join('\n')}\n`;
}

export function writeReport(outDir, report) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'verify.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'report.md'), reportMarkdown(report), 'utf8');
  writeFileSync(join(outDir, 'bench.json'), `${JSON.stringify(report.bench, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a}에 값이 없다`); return v; };
    switch (a) {
      case '--run': o.run = val(); break;
      case '--manifest': o.manifest = val(); break;
      case '--out': o.out = val(); break;
      case '--clickhouse': o.clickhouse = val(); break;
      case '--brokers': o.brokers = val(); break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`모르는 인자: ${a}`);
    }
  }
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    process.stdout.write('사용: node loadtest/analytics/verify.mjs --run <run.json> --manifest <manifest.json 또는 샤드 폴더> --out <폴더>\n');
    return 0;
  }
  if (!o.run || !o.manifest || !o.out) throw new Error('--run, --manifest, --out이 필요하다');
  const run = JSON.parse(readFileSync(o.run, 'utf8'));
  const manifestPath = o.manifest.endsWith('.json') ? o.manifest : join(o.manifest, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`manifest가 없다: ${manifestPath}`);
  const manifest = mergeManifests([JSON.parse(readFileSync(manifestPath, 'utf8'))]);
  const samplesPath = join(o.out, 'freshness.jsonl');
  const samples = existsSync(samplesPath) ? readFileSync(samplesPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const { createKafkaAdmin } = await loadPlatform();
  const admin = createKafkaAdmin({ brokers: o.brokers ? o.brokers.split(',') : run.brokers, clientId: 'f048-verify' });
  await admin.connect();
  try {
    const topics = Object.keys(run.start ?? {});
    const end = await kafkaOffsets(admin, topics);
    const { clickhouseClient } = await import('./docker.mjs');
    const ch = clickhouseClient(o.clickhouse ?? run.clickhouse, run.chCredentials ?? {});
    const report = await verifyRun({ ch, admin, manifest, start: run.start ?? {}, end, groups: run.groups ?? { analytics: GROUPS.analytics(run.env), rt: GROUPS.rt(run.env) }, samples, mode: run.mode });
    writeReport(o.out, report);
    process.stdout.write(`${report.verdict}: ${o.out}\n`);
    return report.verdict === 'pass' ? 0 : report.verdict === 'invalid' ? 3 : 1;
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }).catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 2; });
}
