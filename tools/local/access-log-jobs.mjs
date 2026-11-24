#!/usr/bin/env node
// F-01-8 법정 접속기록 로컬 작업 실행기(대조·일 앵커·하루 사본 내보내기/복원).
// 쓰는 법:
//   node tools/local/access-log-jobs.mjs --reconcile --ingress <n> --rows <n> [--seq 1,2,3]
//   node tools/local/access-log-jobs.mjs --anchor --date <YYYY-MM-DD> --source <n> --rows <n> --sha256 <hex> [--seq ...]
//   node tools/local/access-log-jobs.mjs --copy --date <YYYY-MM-DD> --clickhouse <URL> --bucket <URL>
//   node tools/local/access-log-jobs.mjs --restore --date <YYYY-MM-DD> --clickhouse <URL> --bucket <URL>
// 값(0.1%·5분·15분·3개월+7일)은 deploy/platform/observability/access-log/jobs.yaml에서 읽는다.
// Docker·ClickHouse·moto가 필요한 --copy/--restore는 로컬 시험 몫이다. 나머지는 순수 계산이다.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { dayAnchor, objectLockHeaders, retentionUntil, seqGaps, shortfallAlarm, shortfallRatio } from '../ci/access-log-reconcile.mjs';

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
  return { threshold: j.reconcile?.shortfallThreshold, months: Number(m[1]), days: Number(m[2]), bucket: j.copy?.bucket };
}

async function fetchOk(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

const chQuery = (base, sql) => `${base.replace(/\/$/, '')}/?query=${encodeURIComponent(sql)}`;

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

function main(argv) {
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
      if (o.ingress === undefined || o.rows === undefined) throw new Error('--reconcile에는 --ingress·--rows가 필요하다');
      const ratio = shortfallRatio(int(o.ingress, 'ingress'), int(o.rows, 'rows'));
      const alarm = ratio === null ? null : shortfallAlarm(ratio, j.threshold);
      const gaps = seqGaps(seqsOf(o.seq));
      console.log(JSON.stringify({ kind: 'access-log-reconcile', ingress: Number(o.ingress), rows: Number(o.rows), shortfall: ratio, threshold: j.threshold, alarm, seqMissing: gaps.missing, seqDuplicates: gaps.duplicates }));
      return alarm === true || gaps.missing.length > 0 || gaps.duplicates.length > 0 ? 1 : 0;
    }
    if (o.anchor) {
      if (!o.date || o.source === undefined || o.rows === undefined || !o.sha256) throw new Error('--anchor에는 --date·--source·--rows·--sha256이 필요하다');
      const fileRows = o.fileRows === undefined ? Number(o.rows) : int(o.fileRows, 'fileRows');
      const r = dayAnchor({ date: o.date, sourceTotal: int(o.source, 'source'), ingestedTotal: int(o.rows, 'rows'), seqs: seqsOf(o.seq), fileSha256: o.sha256, fileRows });
      console.log(JSON.stringify({ kind: 'access-log-anchor', ...r, retentionUntil: retentionUntil(o.date, j.months, j.days) }));
      return r.matches ? 0 : 1;
    }
    if (o.copy || o.restore) {
      if (!o.date || !o.clickhouse || !o.bucket) throw new Error('--copy/--restore에는 --date·--clickhouse·--bucket이 필요하다');
      const run = o.copy ? copyDay(o, j) : restoreDay(o);
      return run.then((r) => {
        console.log(JSON.stringify({ kind: o.copy ? 'access-log-copy' : 'access-log-restore', ...r }));
        return 0;
      }).catch((e) => {
        console.error(String(e));
        return 2;
      });
    }
    console.error(USAGE);
    return 2;
  } catch (e) {
    console.error(String(e));
    return 2;
  }
}

const p = main(process.argv.slice(2));
if (typeof p === 'number') process.exitCode = p;
else process.exitCode = await p;
