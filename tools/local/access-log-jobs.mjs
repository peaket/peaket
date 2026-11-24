#!/usr/bin/env node
// F-01-8 법정 접속기록 로컬 작업 실행기(대조·일 앵커·하루 사본 내보내기/복원).
// 쓰는 법:
//   node tools/local/access-log-jobs.mjs --reconcile --ingress <n> --rows <n> [--seq 1,2,3]
//   node tools/local/access-log-jobs.mjs --reconcile --clickhouse <URL> --envoy <URL> [--envoy-query <PromQL>] [--seq ...]
//   node tools/local/access-log-jobs.mjs --anchor --date <YYYY-MM-DD> --source <n> --rows <n> --sha256 <hex> [--seq ...]
//   node tools/local/access-log-jobs.mjs --anchor --date <YYYY-MM-DD> --clickhouse <URL> [--envoy <URL>] [--bucket <URL>]
//   node tools/local/access-log-jobs.mjs --copy --date <YYYY-MM-DD> --clickhouse <URL> --bucket <URL>
//   node tools/local/access-log-jobs.mjs --restore --date <YYYY-MM-DD> --clickhouse <URL> --bucket <URL>
// 값(0.1%·5분·15분·3개월+7일)은 deploy/platform/observability/access-log/jobs.yaml에서 읽는다.
// 원천 0(확인 불가)은 종료 1이다. seq 중복은 at-least-once 재전송이라 경보로 세지 않고, 빈 번호만 센다(IR-12).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { dayAnchor, identityGaps, objectLockHeaders, retentionUntil, seqGaps, shortfallAlarm, shortfallRatio, windowOf } from '../ci/access-log-reconcile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const JOBS = join(ROOT, 'deploy', 'platform', 'observability', 'access-log', 'jobs.yaml');
const USAGE = '쓰는 법: node tools/local/access-log-jobs.mjs --reconcile|--anchor|--copy|--restore … (파일 머리 주석)';

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
    console.error(USAGE);
    return 2;
  } catch (e) {
    console.error(String(e));
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
