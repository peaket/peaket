#!/usr/bin/env node
// F-01-8·F-02-4 법정 접속기록 로컬 작업 실행기(대조·일 앵커·하루 사본·보존 만료 파기·관리 계정 복사·복원 다시 적용).
// 쓰는 법:
//   node tools/local/access-log-jobs.mjs --reconcile --ingress <n> --rows <n> [--seq 1,2,3]
//   node tools/local/access-log-jobs.mjs --reconcile --clickhouse <URL> --envoy <URL> [--envoy-query <PromQL>] [--seq ...]
//   node tools/local/access-log-jobs.mjs --anchor --date <YYYY-MM-DD> --source <n> --rows <n> --sha256 <hex> [--seq ...]
//   node tools/local/access-log-jobs.mjs --anchor --date <YYYY-MM-DD> --clickhouse <URL> [--envoy <URL>] [--bucket <URL>]
//   node tools/local/access-log-jobs.mjs --copy --date <YYYY-MM-DD> --clickhouse <URL> --bucket <URL>
//   node tools/local/access-log-jobs.mjs --restore --date <YYYY-MM-DD> --clickhouse <URL> --bucket <URL>
//   node tools/local/access-log-jobs.mjs --purge --clickhouse <URL> --ops-audit <URL> [--token <t>] [--today <YYYY-MM-DD>] [--max-drop <n>] [--metrics <파일>]
//   node tools/local/access-log-jobs.mjs --admin-copy --date <YYYY-MM-DD> --clickhouse <URL> --ops-audit <URL> [--token <t>]
//   node tools/local/access-log-jobs.mjs --reapply --snapshot-at <ISO> --purges <JSONL 파일> --clickhouse <URL> --ops-audit <URL> [--token <t>]
// 값(0.1%·5분·15분·3개월+7일·2년·7일·40일)은 jobs.yaml과 retention.yaml에서 읽는다.
// 원천 0(확인 불가)은 종료 1이다. seq 중복은 at-least-once 재전송이라 경보로 세지 않고, 빈 번호만 센다(IR-12).
// F-02-4: 파기 기록 접수에 실패하면 지우지 않는다(닫힘 실패). 지운 뒤 기록 실패는 다음 실행이 아니라 이 실행을 실패로 끝낸다.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { dayAnchor, identityGaps, objectLockHeaders, retentionUntil, seqGaps, shortfallAlarm, shortfallRatio, windowOf } from '../ci/access-log-reconcile.mjs';
import { adminRetainUntil, monthCutoff, parseDay, purgePlan, reapplyPlan } from '../ci/access-log-retention.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const JOBS = join(ROOT, 'deploy', 'platform', 'observability', 'access-log', 'jobs.yaml');
const RETENTION = join(ROOT, 'deploy', 'platform', 'observability', 'access-log', 'retention.yaml');
const USAGE = '쓰는 법: node tools/local/access-log-jobs.mjs --reconcile|--anchor|--copy|--restore|--purge|--admin-copy|--reapply … (파일 머리 주석)';
class OperationalError extends Error {}

const int = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what}가 0 이상의 정수다: ${v}`);
  return n;
};
const seqsOf = (v) => (v === undefined ? [] : v.split(',').map((x) => (x.trim() === '' ? null : int(x.trim(), 'seq'))));

function jobsConfig() {
  if (!existsSync(JOBS)) throw new Error(`${JOBS}이 없다`);
  const j = parse(readFileSync(JOBS, 'utf8'));
  const m = /^P(\d+)M(\d+)D$/.exec(String(j.copy?.retention ?? ''));
  if (!m) throw new Error(`copy.retention이 P<개월>M<일>D 꼴이 아니다: ${j.copy?.retention}`);
  return { threshold: j.reconcile?.shortfallThreshold, windowOffsetMinutes: j.reconcile?.windowOffsetMinutes, windowMinutes: j.reconcile?.windowMinutes, months: Number(m[1]), days: Number(m[2]), bucket: j.copy?.bucket };
}

function retentionConfig() {
  if (!existsSync(RETENTION)) throw new Error(`${RETENTION}이 없다`);
  const y = parse(readFileSync(RETENTION, 'utf8'));
  const months = Number(y?.purge?.retentionMonths);
  const years = Number(y?.adminCopy?.retentionYears);
  const snapshotDays = Number(y?.backup?.snapshotRetentionDays);
  const reapplyDays = Number(y?.backup?.reapplyWindowDays);
  const maxDrop = Number(y?.purge?.maxDropPerRun);
  if (![months, years, snapshotDays, reapplyDays, maxDrop].every((n) => Number.isInteger(n) && n > 0)) throw new Error(`${RETENTION}의 보존·상한 값이 1 이상의 정수가 아니다`);
  return { months, years, snapshotDays, reapplyDays, maxDrop, metrics: y?.metrics ?? {} };
}

/** 사건 키에서 늘 같은 UUID를 만든다(감사 체인의 recordId). */
function uuidOf(key) {
  const b = createHash('sha256').update(key).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function postAudit(base, token, record) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) },
    body: JSON.stringify(record),
  });
  if (!res.ok) throw new OperationalError(`감사 접수 실패: HTTP ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
}

const dayOfPartition = (partition) => {
  const p = String(partition);
  if (/^\d{8}$/.test(p)) return `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  throw new Error(`파티션 이름을 날짜로 읽지 못했다: ${p}`);
};
const chIso = (value) => {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = new Date(normalized);
  if (Number.isNaN(t.getTime())) throw new Error(`시각을 읽지 못했다: ${value}`);
  return t.toISOString();
};
const factorsOf = (v) => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean));

/** ClickHouse system.parts에서 지금 살아 있는 하루 파티션과 표를 읽는다. */
async function clickhousePartitions(base) {
  const sql = "SELECT partition, table FROM system.parts WHERE database = 'access_log' AND active AND table IN ('access_log', 'access_log_otel') ORDER BY table, partition FORMAT JSON";
  const j = await (await fetchOk(chQuery(base, sql))).json();
  const rows = (j?.data ?? []).map((r) => ({ day: dayOfPartition(r.partition), table: String(r.table) }));
  if (rows.length === 0) return [];
  return rows;
}

async function countRows(base, table, day) {
  try {
    const timeCol = table === 'access_log_otel' ? 'Timestamp' : 'ts';
    const sql = `SELECT count() AS n FROM access_log.${table} WHERE toYYYYMMDD(${timeCol}) = toYYYYMMDD(toDate('${day}')) FORMAT JSON`;
    const j = await (await fetchOk(chQuery(base, sql))).json();
    const n = Number(j?.data?.[0]?.n);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

async function dropPartition(base, table, day) {
  const partition = day.replaceAll('-', '');
  await fetchOk(chQuery(base, `ALTER TABLE access_log.${table} DROP PARTITION '${partition}'`));
}

async function purge(o, r) {
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  parseDay(today);
  const partitions = await clickhousePartitions(o.clickhouse);
  const plan = purgePlan({ todayIso: today, partitionDays: partitions.map((p) => p.day), retentionMonths: r.months, maxDropPerRun: Number(o['max-drop'] ?? r.maxDrop) });
  const targets = partitions.filter((p) => plan.drop.includes(p.day));
  const out = { kind: 'access-log-purge', today, cutoff: plan.cutoff, expired: plan.expired, overdue: plan.overdue, truncated: plan.truncated, dropped: [], failed: [], reconciled: [] };
  // 계획을 먼저 남긴다. 접수 실패면 아무것도 지우지 않는다(닫힘 실패).
  for (const t of targets) {
    const eventKey = `access-log-purge:v1:${t.day}:${t.table}:PLANNED`;
    await postAudit(o['ops-audit'], o.token, {
      eventKey,
      recordType: 'ACCESS_LOG_PARTITION_PURGE',
      recordId: uuidOf(eventKey),
      payload: { day: t.day, table: t.table, state: 'PLANNED', rows: null, reconciled: false, reason: null },
      occurredAt: new Date().toISOString(),
    });
  }
  for (const t of targets) {
    const rows = await countRows(o.clickhouse, t.table, t.day);
    try {
      await dropPartition(o.clickhouse, t.table, t.day);
      const eventKey = `access-log-purge:v1:${t.day}:${t.table}:DROPPED`;
      await postAudit(o['ops-audit'], o.token, {
        eventKey,
        recordType: 'ACCESS_LOG_PARTITION_PURGE',
        recordId: uuidOf(eventKey),
        payload: { day: t.day, table: t.table, state: 'DROPPED', rows, reconciled: false, reason: null },
        occurredAt: new Date().toISOString(),
      });
      out.dropped.push({ day: t.day, table: t.table, rows });
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      const eventKey = `access-log-purge:v1:${t.day}:${t.table}:FAILED`;
      try {
        await postAudit(o['ops-audit'], o.token, {
          eventKey,
          recordType: 'ACCESS_LOG_PARTITION_PURGE',
          recordId: uuidOf(eventKey),
          payload: { day: t.day, table: t.table, state: 'FAILED', rows, reconciled: false, reason },
          occurredAt: new Date().toISOString(),
        });
      } catch {
        // 실패 기록도 못 남기면 아래 종료 1로 알린다.
      }
      out.failed.push({ day: t.day, table: t.table, reason });
    }
  }
  const stillOverdue = partitions.filter((p) => plan.expired.includes(p.day) && !out.dropped.some((d) => d.day === p.day && d.table === p.table)).length;
  out.overdue = stillOverdue;
  if (o.metrics) {
    const m = r.metrics;
    writeFileSync(
      o.metrics,
      [
        `${m.overdue ?? 'access_log_overdue_partitions'} ${stillOverdue}`,
        `${m.lastSuccess ?? 'access_log_purge_last_success_timestamp'} ${out.failed.length === 0 ? Math.floor(Date.now() / 1000) : 0}`,
        `access_log_purge_audit_failures_total ${out.failed.length}`,
        '',
      ].join('\n'),
    );
  }
  console.log(JSON.stringify(out));
  return out.failed.length > 0 ? 1 : 0;
}

async function adminCopy(o, r) {
  const day = o.date;
  parseDay(day);
  const sql = `SELECT ts, source, request_id, event, result, provider, factors, failure, toString(client_ip) AS client_ip, user_agent, account_id, pod, seq, is_admin FROM access_log.access_log WHERE toYYYYMMDD(ts) = toYYYYMMDD(toDate('${day}')) AND is_admin = 1 ORDER BY ts, request_id FORMAT JSON`;
  const j = await (await fetchOk(chQuery(o.clickhouse, sql))).json();
  const rows = j?.data ?? [];
  const out = { kind: 'access-log-admin-copy', date: day, read: rows.length, copied: 0, duplicates: 0, failed: [] };
  for (const row of rows) {
    const accessTs = chIso(row.ts);
    const requestId = String(row.request_id ?? '');
    const seq = row.seq === null || row.seq === undefined ? null : Number(row.seq);
    const source = String(row.source ?? '');
    const keyTail = requestId || `${accessTs}:${String(row.pod ?? '')}:${seq ?? ''}`;
    const eventKey = `access-log-admin:v1:${day}:${source}:${keyTail}`;
    const payload = {
      source,
      accessTs,
      requestId,
      event: String(row.event ?? ''),
      result: String(row.result ?? ''),
      provider: String(row.provider ?? ''),
      factors: factorsOf(row.factors),
      failure: String(row.failure ?? ''),
      clientIp: row.client_ip === null || row.client_ip === undefined || String(row.client_ip) === '' ? null : String(row.client_ip),
      userAgent: String(row.user_agent ?? '').slice(0, 512),
      adminAccountId: row.account_id === null || row.account_id === undefined || String(row.account_id) === '' ? null : String(row.account_id),
      pod: String(row.pod ?? '').slice(0, 128),
      seq,
      retainUntil: adminRetainUntil(accessTs, r.years),
    };
    try {
      const res = await postAudit(o['ops-audit'], o.token, { eventKey, recordType: 'ADMIN_ACCESS_LOG', recordId: uuidOf(eventKey), payload, occurredAt: accessTs });
      if (res?.accepted === true) out.copied += 1;
      else out.duplicates += 1;
    } catch (e) {
      out.failed.push({ eventKey, reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) });
    }
  }
  if (o.metrics) {
    const rowsMetric = r.metrics.adminCopyRows ?? 'access_log_admin_copy_rows_total';
    writeFileSync(
      o.metrics,
      [
        `${r.metrics.adminCopyLastSuccess ?? 'access_log_admin_copy_last_success_timestamp'} ${out.failed.length === 0 ? Math.floor(Date.now() / 1000) : 0}`,
        `${rowsMetric}{result="copied"} ${out.copied}`,
        `${rowsMetric}{result="failed"} ${out.failed.length}`,
        '',
      ].join('\n'),
    );
  }
  console.log(JSON.stringify(out));
  return out.failed.length > 0 ? 1 : 0;
}

async function reapply(o, r) {
  if (!o['snapshot-at'] || !o.purges) throw new Error('--reapply에는 --snapshot-at과 --purges가 필요하다');
  const text = readFileSync(o.purges, 'utf8');
  const records = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  const partitions = await clickhousePartitions(o.clickhouse);
  const plan = reapplyPlan({ snapshotAtIso: o['snapshot-at'], records, partitionDays: partitions.map((p) => p.day) });
  const out = { kind: 'access-log-reapply', snapshotAt: o['snapshot-at'], reapplied: [], skipped: plan.skipped };
  for (const t of plan.drop) {
    const eventKey = `access-log-purge:v1:${t.day}:${t.table}:REAPPLIED:${o['snapshot-at']}`;
    await postAudit(o['ops-audit'], o.token, {
      eventKey,
      recordType: 'ACCESS_LOG_PARTITION_PURGE',
      recordId: uuidOf(eventKey),
      payload: { day: t.day, table: t.table, state: 'PLANNED', rows: null, reconciled: false, reason: 'reapply' },
      occurredAt: new Date().toISOString(),
    });
    await dropPartition(o.clickhouse, t.table, t.day);
    await postAudit(o['ops-audit'], o.token, {
      eventKey: `${eventKey}:DROPPED`,
      recordType: 'ACCESS_LOG_PARTITION_PURGE',
      recordId: uuidOf(`${eventKey}:DROPPED`),
      payload: { day: t.day, table: t.table, state: 'DROPPED', rows: null, reconciled: false, reason: 'reapply' },
      occurredAt: new Date().toISOString(),
    });
    out.reapplied.push(t);
  }
  console.log(JSON.stringify(out));
  return 0;
}

async function fetchOk(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return res;
}
const chQuery = (base, sql) => `${base.replace(/\/$/, '')}/?query=${encodeURIComponent(sql)}`;

/** ClickHouse HTTP에서 게이트웨이 원천 행 수와 identity 파드별 행·seq를 나눠 읽는다(IR-22). */
async function clickhouseRows(base, where) {
  const gatewayRes = await fetchOk(chQuery(base, `SELECT count() AS n FROM access_log.access_log WHERE ${where} AND source='gateway' FORMAT JSON`));
  const gateway = await gatewayRes.json();
  const identityRes = await fetchOk(chQuery(base, `SELECT pod, count() AS n, groupArray(seq) AS seqs FROM access_log.access_log WHERE ${where} AND source='identity' GROUP BY pod ORDER BY pod FORMAT JSON`));
  const identityJson = await identityRes.json();
  const identity = (identityJson?.data ?? []).map((r) => ({ pod: String(r.pod ?? ''), rows: Number(r.n ?? 0), seqs: Array.isArray(r.seqs) ? r.seqs.map((x) => (x === null ? null : Number(x))) : [] }));
  return { rows: Number(gateway?.data?.[0]?.n ?? 0), identity };
}

/** Prometheus HTTP에서 원천 요청 수(또는 하루 합계)를 읽는다. 결과가 없으면 null(확인 불가). */
async function promNumber(base, query) {
  const res = await fetchOk(`${base.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(query)}`);
  const j = await res.json();
  const v = j?.data?.result?.[0]?.value?.[1];
  return v === undefined ? null : Number(v);
}

async function copyDay(o, j) {
  const day = o.date;
  const where = `toYYYYMMDD(ts)=toYYYYMMDD(toDate('${day}'))`;
  const rows = Number((await (await fetchOk(chQuery(o.clickhouse, `SELECT count() FROM access_log.access_log WHERE ${where}`))).text()).trim());
  const parquet = Buffer.from(await (await fetchOk(chQuery(o.clickhouse, `SELECT * FROM access_log.access_log WHERE ${where} FORMAT Parquet`))).arrayBuffer());
  const sha256 = createHash('sha256').update(parquet).digest('hex');
  const until = retentionUntil(day, j.months, j.days);
  const key = `access_log/${day}.parquet`;
  const anchor = { date: day, rows, fileRows: rows, fileSha256: sha256, retentionUntil: until, objectLock: 'COMPLIANCE' };
  await fetchOk(`${o.bucket.replace(/\/$/, '')}/${key}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...objectLockHeaders({ mode: 'COMPLIANCE', retainUntil: until }) }, body: parquet });
  await fetchOk(`${o.bucket.replace(/\/$/, '')}/access_log/${day}.anchor.json`, { method: 'PUT', headers: { 'content-type': 'application/json', ...objectLockHeaders({ mode: 'COMPLIANCE', retainUntil: until }) }, body: JSON.stringify(anchor) });
  return anchor;
}

async function restoreDay(o) {
  const key = `access_log/${o.date}.parquet`;
  const parquet = Buffer.from(await (await fetchOk(`${o.bucket.replace(/\/$/, '')}/${key}`)).arrayBuffer());
  const anchor = JSON.parse(await (await fetchOk(`${o.bucket.replace(/\/$/, '')}/access_log/${o.date}.anchor.json`)).text());
  const sha256 = createHash('sha256').update(parquet).digest('hex');
  if (sha256 !== anchor.fileSha256) throw new Error(`파일 SHA-256이 앵커와 다르다(복원하지 않는다): ${sha256} != ${anchor.fileSha256}`);
  const rows = Number((await (await fetchOk(chQuery(o.clickhouse, `SELECT count() FROM access_log.access_log WHERE toYYYYMMDD(ts)=toYYYYMMDD(toDate('${o.date}'))`))).text()).trim());
  if (rows !== 0) throw new Error(`그 날짜 파티션에 이미 ${rows}행이 있다(지운 뒤 복원한다)`);
  await fetchOk(chQuery(o.clickhouse, 'INSERT INTO access_log.access_log FORMAT Parquet'), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: parquet });
  const after = Number((await (await fetchOk(chQuery(o.clickhouse, `SELECT count() FROM access_log.access_log WHERE toYYYYMMDD(ts)=toYYYYMMDD(toDate('${o.date}'))`))).text()).trim());
  if (after !== anchor.rows) throw new Error(`복원한 행 수가 앵커와 다르다: ${after} != ${anchor.rows}`);
  return { date: o.date, rows: after, sha256 };
}

async function reconcile(o, j) {
  let ingress = o.ingress === undefined ? undefined : int(o.ingress, 'ingress');
  let rows = o.rows === undefined ? undefined : int(o.rows, 'rows');
  let seqs = seqsOf(o.seq);
  let identity = [];
  let window;
  if (o.clickhouse || o.envoy) {
    window = windowOf(Date.now(), { offsetMinutes: j.windowOffsetMinutes, sizeMinutes: j.windowMinutes });
    if (o.clickhouse) {
      const r = await clickhouseRows(o.clickhouse, `ts >= fromUnixTimestamp64Milli(${window.startMs}) and ts < fromUnixTimestamp64Milli(${window.endMs})`);
      rows = r.rows;
      identity = identityGaps(r.identity);
      if (o.seq === undefined && r.identity.length === 0) seqs = [];
    }
    if (o.envoy) ingress = await promNumber(o.envoy, o['envoy-query'] ?? 'sum(increase(envoy_http_downstream_rq_total[5m]))');
  }
  if (ingress === undefined || rows === undefined) throw new Error('--reconcile에는 (--ingress·--rows) 또는 (--clickhouse·--envoy)가 필요하다');
  // Prometheus 응답이 비면 확인 불가(종료 1)다. null을 shortfallRatio에 넘기지 않는다(IR-19).
  const ratio = ingress === null || ingress === undefined ? null : shortfallRatio(ingress, rows);
  const alarm = ratio === null ? null : shortfallAlarm(ratio, j.threshold);
  const gaps = seqGaps(seqs);
  const identityMissing = identity.flatMap((p) => p.missing.map((n) => ({ pod: p.pod, n })));
  return { kind: 'access-log-reconcile', window, ingress, rows, shortfall: ratio, threshold: j.threshold, verifiable: ratio !== null, alarm, seqMissing: gaps.missing, seqDuplicates: gaps.duplicates, identityMissing, identity };
}

async function anchor(o, j) {
  let source = o.source === undefined ? undefined : int(o.source, 'source');
  let rows = o.rows === undefined ? undefined : int(o.rows, 'rows');
  let seqs = seqsOf(o.seq);
  let sha256 = o.sha256;
  let fileRows = o.fileRows === undefined ? undefined : int(o.fileRows, 'fileRows');
  let identity = [];
  if (o.clickhouse) {
    const where = `toYYYYMMDD(ts)=toYYYYMMDD(toDate('${o.date}'))`;
    const r = await clickhouseRows(o.clickhouse, where);
    rows = r.rows;
    identity = identityGaps(r.identity);
    if (o.seq === undefined && r.identity.length === 0) seqs = [];
  }
  if (o.envoy) source = await promNumber(o.envoy, o['envoy-query'] ?? 'sum(increase(envoy_http_downstream_rq_total[1d]))');
  if (o.bucket && sha256 === undefined) {
    const a = JSON.parse(await (await fetchOk(`${o.bucket.replace(/\/$/, '')}/access_log/${o.date}.anchor.json`)).text());
    sha256 = a.fileSha256;
    fileRows = a.fileRows;
  }
  if (!o.date || rows === undefined || !sha256) throw new Error('--anchor에는 --date·--source(또는 --envoy)·--rows(또는 --clickhouse)·--sha256(또는 --bucket)이 필요하다');
  const identityMissing = identity.flatMap((p) => p.missing.map((n) => ({ pod: p.pod, n })));
  if (source === null || source === undefined) {
    return { kind: 'access-log-anchor', date: o.date, sourceTotal: null, ingestedTotal: rows, shortfall: null, seqMissing: seqs.length ? seqGaps(seqs).missing : [], seqDuplicates: [], fileSha256: sha256, fileRows: fileRows ?? rows, matches: false, verifiable: false, retentionUntil: retentionUntil(o.date, j.months, j.days), identity, identityMissing };
  }
  const r = dayAnchor({ date: o.date, sourceTotal: source, ingestedTotal: rows, seqs, fileSha256: sha256, fileRows: fileRows ?? rows });
  // 파드 하나의 빈 seq도 일 앵커 불일치다(--reconcile과 같은 기준, IR-22)
  return { kind: 'access-log-anchor', ...r, matches: r.matches && identityMissing.length === 0, verifiable: true, retentionUntil: retentionUntil(o.date, j.months, j.days), identity, identityMissing };
}

async function main(argv) {
  let a;
  try {
    a = parseArgs({
      args: argv,
      options: {
        reconcile: { type: 'boolean' },
        anchor: { type: 'boolean' },
        copy: { type: 'boolean' },
        restore: { type: 'boolean' },
        purge: { type: 'boolean' },
        'admin-copy': { type: 'boolean' },
        reapply: { type: 'boolean' },
        'ops-audit': { type: 'string' },
        token: { type: 'string' },
        today: { type: 'string' },
        'max-drop': { type: 'string' },
        'snapshot-at': { type: 'string' },
        purges: { type: 'string' },
        metrics: { type: 'string' },
        ingress: { type: 'string' },
        rows: { type: 'string' },
        fileRows: { type: 'string' },
        source: { type: 'string' },
        date: { type: 'string' },
        sha256: { type: 'string' },
        seq: { type: 'string' },
        clickhouse: { type: 'string' },
        envoy: { type: 'string' },
        'envoy-query': { type: 'string' },
        bucket: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    console.error(USAGE);
    return 2;
  }
  const o = a.values;
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const j = jobsConfig();
    if (o.reconcile) {
      const r = await reconcile(o, j);
      console.log(JSON.stringify(r));
      // 확인 불가(원천 0)와 빈 번호는 실패다. 중복은 정상 재전송이라 실패로 세지 않는다.
      return r.verifiable === false || r.alarm === true || r.seqMissing.length > 0 || r.identityMissing.length > 0 ? 1 : 0;
    }
    if (o.anchor) {
      const r = await anchor(o, j);
      console.log(JSON.stringify(r));
      // 일 앵커도 파드 하나의 빈 seq를 실패로 센다(--reconcile과 같은 기준, IR-22)
      return r.matches && r.identityMissing.length === 0 ? 0 : 1;
    }
    if (o.copy || o.restore) {
      if (!o.date || !o.clickhouse || !o.bucket) throw new Error('--copy/--restore에는 --date·--clickhouse·--bucket이 필요하다');
      const r = o.copy ? await copyDay(o, j) : await restoreDay(o);
      console.log(JSON.stringify({ kind: o.copy ? 'access-log-copy' : 'access-log-restore', ...r }));
      return 0;
    }
    if (o.purge || o['admin-copy'] || o.reapply) {
      if (!o.clickhouse || !o['ops-audit']) throw new Error('--purge/--admin-copy/--reapply에는 --clickhouse와 --ops-audit이 필요하다');
      const r = retentionConfig();
      if (o.purge) return await purge(o, r);
      if (o['admin-copy']) {
        if (!o.date) throw new Error('--admin-copy에는 --date가 필요하다');
        return await adminCopy(o, r);
      }
      return await reapply(o, r);
    }
    console.error(USAGE);
    return 2;
  } catch (e) {
    console.error(String(e));
    return e instanceof OperationalError ? 1 : 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
