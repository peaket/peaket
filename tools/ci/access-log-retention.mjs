#!/usr/bin/env node
// F-02-4 접속기록 보존 만료 파기 정적 계약·순수 계산.
// 정본: docs/data.md §1 '시스템 접속기록', docs/security/data-classification.md
// '법정 접속기록'·'관리자 시스템 접속기록'·'백업 보존 상한과 파기', docs/observability.md §7·§9.
// 값(3개월·2년·7일·40일·P3M7D)은 정본과 설정에서 읽는다. 실행기는 tools/local/access-log-jobs.mjs다.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FILES = {
  data: 'docs/data.md',
  classification: 'docs/security/data-classification.md',
  observability: 'docs/observability.md',
  asvs: 'docs/security/asvs/offline-gate.md',
  ddl: 'data/clickhouse/access-log/001_access_log.sql',
  users: 'data/clickhouse/access-log/002_users.sql',
  purgeUsers: 'data/clickhouse/access-log/003_purge.sql',
  jobs: 'deploy/platform/observability/access-log/jobs.yaml',
  retention: 'deploy/platform/observability/access-log/retention.yaml',
  alerts: 'deploy/platform/observability/alerts/access-log.yaml',
  runner: 'tools/local/access-log-jobs.mjs',
  intake: 'services/ops-svc/src/modules/audit/audit-intake.ts',
};

function readText(root, rel) {
  const file = join(root, rel);
  if (!existsSync(file)) throw new Error(`${rel}이 없다`);
  return readFileSync(file, 'utf8');
}
function parseYaml(text, rel) {
  try {
    return parse(text);
  } catch (e) {
    throw new Error(`${rel} YAML을 읽지 못했다: ${e instanceof Error ? e.message : e}`);
  }
}
function num(text, re, what) {
  const m = re.exec(text);
  if (!m) throw new Error(`${what}을 ${re}로 읽지 못했다`);
  return Number(m[1]);
}
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d, h = 0, min = 0, s = 0, ms = 0) => new Date(Date.UTC(y, m, d, h, min, s, ms)).toISOString();
const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

export function parseDay(dayIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayIso ?? ''))) throw new Error(`날짜 꼴이 YYYY-MM-DD가 아니다: ${dayIso}`);
  const [y, m, d] = dayIso.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m - 1)) throw new Error(`없는 날짜다: ${dayIso}`);
  return { y, m0: m - 1, d };
}

/** UTC 날짜에서 개월을 뺀 날짜. 월말·윤달은 그 달 마지막 날로 보정한다(ClickHouse addMonths와 같은 뜻). */
export function monthCutoff(dayIso, months) {
  const { y, m0, d } = parseDay(dayIso);
  if (!Number.isInteger(months) || months < 0) throw new Error(`개월이 0 이상의 정수다: ${months}`);
  const total = y * 12 + m0 - months;
  const ty = Math.floor(total / 12);
  const tm0 = ((total % 12) + 12) % 12;
  return `${ty}-${pad(tm0 + 1)}-${pad(Math.min(d, daysInMonth(ty, tm0)))}`;
}

/** 3개월이 지난 날짜 파티션. 같은 날짜(컷오프 당일)는 그날 늦은 줄이 아직 3개월이 안 됐을 수 있어 남긴다. */
export function expiredPartitionDays({ todayIso, partitionDays, retentionMonths }) {
  const cutoff = monthCutoff(todayIso, retentionMonths);
  return [...new Set((partitionDays ?? []).map((d) => String(d)))]
    .filter((d) => {
      parseDay(d);
      return d < cutoff;
    })
    .sort();
}

/** Object Lock 보존 끝(UTC ISO). 그 날짜 + 개월 + 덧붙인 날. */
export function retentionUntil(dayIso, months, extraDays) {
  const { y, m0, d } = parseDay(dayIso);
  const total = y * 12 + m0 + months;
  const ty = Math.floor(total / 12);
  const tm0 = ((total % 12) + 12) % 12;
  const t = new Date(Date.UTC(ty, tm0, Math.min(d, daysInMonth(ty, tm0)) + extraDays));
  return t.toISOString();
}

/** 관리 계정 접속기록의 보존 끝(UTC ISO). 접속 시각의 UTC 날짜 + 년. 2월 29일은 3월 1일로 보정한다. */
export function adminRetainUntil(accessTsIso, years) {
  const t = new Date(accessTsIso);
  if (Number.isNaN(t.getTime())) throw new Error(`시각을 읽지 못했다: ${accessTsIso}`);
  if (!Number.isInteger(years) || years < 0) throw new Error(`년이 0 이상의 정수다: ${years}`);
  const y = t.getUTCFullYear() + years;
  const m0 = t.getUTCMonth();
  const d = t.getUTCDate();
  if (m0 === 1 && d === 29 && daysInMonth(y, 1) === 28) {
    return iso(y, 2, 1, t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds());
  }
  return iso(y, m0, d, t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds());
}

/**
 * 파기 계획. 상한은 날짜가 아니라 `{day, table}` 파티션 단위다(같은 날 두 표는 둘).
 * `partitionDays`는 옛 호출 호환용이며 표를 알 수 없어 `access_log`로 본다.
 */
export function purgePlan({ todayIso, partitions, partitionDays, retentionMonths, maxDropPerRun = 40 }) {
  if (!Number.isInteger(maxDropPerRun) || maxDropPerRun < 1) throw new Error(`한 번에 지울 상한이 1 이상의 정수다: ${maxDropPerRun}`);
  const list = partitions ?? (partitionDays ?? []).map((day) => ({ day, table: 'access_log' }));
  const cutoff = monthCutoff(todayIso, retentionMonths);
  const seen = new Set();
  const expired = [];
  for (const p of list) {
    parseDay(p.day);
    if (!['access_log', 'access_log_otel'].includes(p.table)) throw new Error(`모르는 표다: ${p.table}`);
    if (p.day >= cutoff) continue;
    const key = `${p.day}|${p.table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    expired.push({ day: p.day, table: p.table });
  }
  expired.sort((a, b) => (a.day === b.day ? a.table.localeCompare(b.table) : a.day.localeCompare(b.day)));
  return {
    today: todayIso,
    cutoff,
    expired,
    drop: expired.slice(0, maxDropPerRun),
    overdue: expired.length,
    truncated: expired.length > maxDropPerRun,
  };
}

/**
 * 복원한 저장소에 다시 적용할 파기. 스냅샷 시각 뒤에 실행된 DROPPED 기록만 대상이고, PLANNED·FAILED는 넣지 않는다.
 * partitions는 `{day, table}` 목록이다(되살아난 표·날짜만 지운다). 문자열이면 두 표 모두로 본다.
 */
export function reapplyPlan({ snapshotAtIso, records, partitions, partitionDays }) {
  const snapshot = Date.parse(snapshotAtIso);
  if (Number.isNaN(snapshot)) throw new Error(`스냅샷 시각을 읽지 못했다: ${snapshotAtIso}`);
  const present = new Set();
  for (const p of partitions ?? partitionDays ?? []) {
    if (typeof p === 'string') {
      parseDay(p);
      present.add(`${p}|access_log`);
      present.add(`${p}|access_log_otel`);
    } else {
      parseDay(p.day);
      if (!['access_log', 'access_log_otel'].includes(p.table)) throw new Error(`모르는 표다: ${p.table}`);
      present.add(`${p.day}|${p.table}`);
    }
  }
  const drop = [];
  const skipped = [];
  const seen = new Set();
  for (const r of records ?? []) {
    // 저장된 파기 기록에는 state가 있다. 오래된 기록처럼 state가 없으면 지운 기록으로 본다.
    if (r?.state !== undefined && r.state !== 'DROPPED') continue;
    parseDay(r.day);
    if (!['access_log', 'access_log_otel'].includes(r.table)) throw new Error(`모르는 표다: ${r.table}`);
    const executed = Date.parse(r.executedAt);
    if (Number.isNaN(executed)) throw new Error(`파기 실행 시각을 읽지 못했다: ${r.executedAt}`);
    if (executed <= snapshot) {
      skipped.push({ day: r.day, reason: 'before-snapshot' });
      continue;
    }
    if (!present.has(`${r.day}|${r.table}`)) {
      skipped.push({ day: r.day, reason: 'not-restored' });
      continue;
    }
    const key = `${r.day}|${r.table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    drop.push({ day: r.day, table: r.table });
  }
  drop.sort((a, b) => (a.day === b.day ? a.table.localeCompare(b.table) : a.day.localeCompare(b.day)));
  return { drop, skipped };
}

export function canonFrom(root) {
  const data = readText(root, FILES.data);
  const classification = readText(root, FILES.classification);
  const observability = readText(root, FILES.observability);
  const asvs = readText(root, FILES.asvs);
  const jobsText = readText(root, FILES.jobs);
  const jobs = parseYaml(jobsText, FILES.jobs);
  const retentionText = readText(root, FILES.retention);
  const retention = parseYaml(retentionText, FILES.retention);
  const accessMonths = num(data, /최소 (\d+)개월 보존/, `${FILES.data} '시스템 접속기록'`);
  const classificationMonths = num(classification, /법정 최소 기간인 (\d+)개월간 보관/, `${FILES.classification} '법정 접속기록'`);
  const adminYears = num(classification, /최소 (\d+)년 이상 보존/, `${FILES.classification} '관리자 시스템 접속기록'`);
  const copyMonths = num(classification, /하루 사본은 그 날짜의 (\d+)개월 보존/, `${FILES.classification} '법정 접속기록' 하루 사본`);
  const copyDays = num(classification, /보존이 끝난 뒤 (\d+)일 \[가정\]/, `${FILES.classification} '법정 접속기록' 하루 사본`);
  const snapshotDays = num(classification, /\| ClickHouse \|[^\n]*?\| (\d+)일 \[가정\]\(ADR-0053 결정 10\)/, `${FILES.classification} ClickHouse 백업`);
  const reapplyDays = num(classification, /가장 긴 백업 상한\(35일\)보다 길게 (\d+)일 \[가정\]/, `${FILES.classification} 파기 기록 보존`);
  const observabilityMonths = num(observability, /(\d+)개월 \(통신비밀보호법/, `${FILES.observability} §9 '법정 시스템 접속기록'`);
  return {
    accessMonths,
    classificationMonths,
    observabilityMonths,
    adminYears,
    copyMonths,
    copyDays,
    snapshotDays,
    reapplyDays,
    jobs,
    retention,
    texts: { data, classification, observability, asvs, jobs: jobsText, retention: retentionText },
  };
}

export function checkAccessLogRetention(root) {
  const bad = [];
  const add = (rel, msg) => bad.push(`${rel}: ${msg}`);
  const canon = canonFrom(root);
  const { jobs, retention, texts } = canon;
  if (canon.accessMonths !== 3) add(FILES.data, `접속기록 보존이 3개월이 아니다(${canon.accessMonths})`);
  if (canon.classificationMonths !== canon.accessMonths) add(FILES.classification, `법정 접속기록 보존(${canon.classificationMonths}개월)이 data.md(${canon.accessMonths}개월)와 다르다`);
  if (canon.observabilityMonths !== canon.accessMonths) add(FILES.observability, `§9 접속기록 보존(${canon.observabilityMonths}개월)이 data.md(${canon.accessMonths}개월)와 다르다`);
  if (canon.copyMonths !== canon.accessMonths) add(FILES.classification, `하루 사본 보존(${canon.copyMonths}개월)이 접속기록 보존과 다르다`);
  if (canon.adminYears !== 2) add(FILES.classification, `관리 계정 접속기록 보존이 2년이 아니다(${canon.adminYears})`);
  if (canon.snapshotDays !== 7) add(FILES.classification, `ClickHouse 백업 보존이 7일이 아니다(${canon.snapshotDays})`);
  if (canon.reapplyDays !== 40) add(FILES.classification, `파기 기록 보존이 40일이 아니다(${canon.reapplyDays})`);

  // 표·TTL·파기 사용자
  const ddl = readText(root, FILES.ddl);
  for (const [table, ttlRe, partitionRe] of [
    ['access_log', /TTL toDateTime\(ts\) \+ INTERVAL (\d+) MONTH/, /PARTITION BY toYYYYMMDD\(ts\)/],
    ['access_log_otel', /TTL toDate\(Timestamp\) \+ INTERVAL (\d+) MONTH/, /PARTITION BY toDate\(Timestamp\)/],
  ]) {
    const ttl = ttlRe.exec(ddl);
    if (!ttl) add(FILES.ddl, `${table} TTL을 읽지 못했다(3개월 이상이어야 한다)`);
    else if (Number(ttl[1]) < canon.accessMonths) add(FILES.ddl, `${table} TTL ${ttl[1]}개월이 최소 ${canon.accessMonths}개월보다 짧다`);
    if (!partitionRe.test(ddl)) add(FILES.ddl, `${table}의 하루 파티션이 아니다`);
  }
  // al_purger의 넓은 ALTER 한계와 자격 분리를 정본에 적는다(ClickHouse 24.12에는 파티션만 좁히는 권한이 없다).
  if (!/\|\s*`al_purger`\s*\|/.test(texts.observability)) add(FILES.observability, '접속기록 사용자 표에 al_purger가 없다');
  if (!/ALTER TABLE/.test(texts.observability) || !/SELECT/.test(texts.observability)) add(FILES.observability, 'al_purger의 ALTER·SELECT 한계 설명이 없다');
  const users = readText(root, FILES.users);
  if (!/CREATE ROW POLICY IF NOT EXISTS admin_rows_only ON access_log\.access_log FOR SELECT USING is_admin = 1 TO al_admin_reader;/.test(users)) add(FILES.users, 'al_admin_reader 행 정책(admin_rows_only)이 없다');
  const purgeUsers = readText(root, FILES.purgeUsers);
  for (const table of ['access_log.access_log', 'access_log.access_log_otel']) {
    if (!new RegExp(`^GRANT ALTER ON ${table.replaceAll('.', '\\.')} TO al_purger;$`, 'm').test(purgeUsers)) add(FILES.purgeUsers, `al_purger의 ${table} ALTER 권한이 없다`);
  }
  if (!/^GRANT SELECT ON system\.parts TO al_purger;$/m.test(purgeUsers)) add(FILES.purgeUsers, 'al_purger의 system.parts SELECT 권한이 없다');
  if (/GRANT\s+SELECT[^\n]*ON\s+access_log\.access_log[^\n]*TO\s+al_purger/i.test(purgeUsers)) add(FILES.purgeUsers, 'al_purger가 접속기록 행을 읽을 수 있다(행 SELECT 금지)');
  const purgeGrants = purgeUsers.split('\n').filter((l) => /^\s*GRANT .* TO al_purger;/i.test(l));
  if (purgeGrants.length !== 3) add(FILES.purgeUsers, `al_purger 권한이 정확히 셋이 아니다(${purgeGrants.length}): ${purgeGrants.join(' / ')}`);

  // 작업 설정
  const r = retention ?? {};
  if (r.purge?.retentionMonths !== canon.accessMonths) add(FILES.retention, `purge.retentionMonths가 ${canon.accessMonths}이 아니다`);
  if (r.purge?.graceDays !== 0) add(FILES.retention, 'purge.graceDays가 0이 아니다');
  if (r.purge?.timeZone !== 'Asia/Seoul') add(FILES.retention, `purge.timeZone이 Asia/Seoul이 아니다(${r.purge?.timeZone})`);
  if (r.purge?.schedule !== '0 5 * * *') add(FILES.retention, `purge.schedule이 05:00 KST(0 5 * * *)가 아니다(${r.purge?.schedule})`);
  if (r.purge?.maxDropPerRun !== 40) add(FILES.retention, `purge.maxDropPerRun이 40이 아니다(${r.purge?.maxDropPerRun})`);
  if (r.purge?.auditRecordType !== 'ACCESS_LOG_PARTITION_PURGE') add(FILES.retention, 'purge.auditRecordType이 ACCESS_LOG_PARTITION_PURGE가 아니다');
  if (!Array.isArray(r.purge?.auditStates) || !['PLANNED', 'DROPPED', 'FAILED'].every((s) => r.purge.auditStates.includes(s))) add(FILES.retention, 'purge.auditStates에 PLANNED·DROPPED·FAILED가 없다');
  if (r.adminCopy?.retentionYears !== canon.adminYears) add(FILES.retention, `adminCopy.retentionYears가 ${canon.adminYears}이 아니다`);
  if (r.adminCopy?.recordType !== 'ADMIN_ACCESS_LOG') add(FILES.retention, 'adminCopy.recordType이 ADMIN_ACCESS_LOG가 아니다');
  if (r.adminCopy?.sourceFilter !== 'is_admin = 1') add(FILES.retention, 'adminCopy.sourceFilter가 is_admin = 1이 아니다');
  if (r.adminCopy?.timeZone !== 'Asia/Seoul') add(FILES.retention, `adminCopy.timeZone이 Asia/Seoul이 아니다(${r.adminCopy?.timeZone})`);
  if (r.adminCopy?.schedule !== '30 4 * * *') add(FILES.retention, `adminCopy.schedule이 04:30 KST(30 4 * * *)가 아니다(${r.adminCopy?.schedule})`);
  if (r.adminCopy?.lookbackDays !== 1) add(FILES.retention, `adminCopy.lookbackDays가 1이 아니다(${r.adminCopy?.lookbackDays})`);
  if (r.adminCopy?.sourceUser !== 'al_admin_reader') add(FILES.retention, `adminCopy.sourceUser가 al_admin_reader가 아니다(${r.adminCopy?.sourceUser})`);
  for (const [key, value] of [
    ['overdue', 'access_log_overdue_partitions'],
    ['lastSuccess', 'access_log_purge_last_success_timestamp'],
    ['adminCopyLastSuccess', 'access_log_admin_copy_last_success_timestamp'],
    ['adminCopyRows', 'access_log_admin_copy_rows_total'],
  ]) {
    if (r.metrics?.[key] !== value) add(FILES.retention, `metrics.${key}가 ${value}가 아니다(${r.metrics?.[key]})`);
  }
  if (r.backup?.snapshotRetentionDays !== canon.snapshotDays) add(FILES.retention, `backup.snapshotRetentionDays가 ${canon.snapshotDays}이 아니다`);
  if (r.backup?.reapplyWindowDays !== canon.reapplyDays) add(FILES.retention, `backup.reapplyWindowDays가 ${canon.reapplyDays}일이 아니다`);
  const lock = String(jobs?.copy?.objectLock ?? '');
  if (lock !== 'COMPLIANCE') add(FILES.jobs, `copy.objectLock이 COMPLIANCE가 아니다(${lock})`);
  const copyRet = /^P(\d+)M(\d+)D$/.exec(String(jobs?.copy?.retention ?? ''));
  if (!copyRet) add(FILES.jobs, `copy.retention이 P<개월>M<일>D 꼴이 아니다(${jobs?.copy?.retention})`);
  else if (Number(copyRet[1]) !== canon.copyMonths || Number(copyRet[2]) !== canon.copyDays) add(FILES.jobs, `copy.retention(${jobs?.copy?.retention})이 정본(P${canon.copyMonths}M${canon.copyDays}D, ${canon.copyMonths}개월+${canon.copyDays}일)과 다르다(설정 ${copyRet[1]}개월+${copyRet[2]}일)`);
  if (r.backup?.objectLockRetention !== jobs?.copy?.retention) add(FILES.retention, 'backup.objectLockRetention이 jobs.yaml의 copy.retention과 다르다');

  // 감사 접수 종류·경보·실행기
  const intake = readText(root, FILES.intake);
  if (!/ADMIN_ACCESS_LOG\s*:/.test(intake)) add(FILES.intake, 'ADMIN_ACCESS_LOG 접수 종류가 없다');
  if (!/ACCESS_LOG_PARTITION_PURGE\s*:/.test(intake)) add(FILES.intake, 'ACCESS_LOG_PARTITION_PURGE 접수 종류가 없다');
  const alerts = readText(root, FILES.alerts);
  for (const name of ['AccessLogPurgeOverdue', 'AccessLogPurgeFailed', 'AccessLogAdminCopyLate', 'AccessLogPurgeAuditFailed']) {
    if (!new RegExp(`alert: ${name}\\b`).test(alerts)) add(FILES.alerts, `${name} 경보가 없다`);
  }
  for (const metric of ['access_log_overdue_partitions', 'access_log_purge_last_success_timestamp', 'access_log_admin_copy_last_success_timestamp', 'access_log_admin_copy_rows_total']) {
    if (!alerts.includes(metric)) add(FILES.alerts, `${metric} 지표를 쓰는 경보가 없다`);
  }
  const runner = readText(root, FILES.runner);
  for (const key of ['purge', 'admin-copy', 'reapply']) {
    if (!new RegExp(`['"]?${key.replace('-', '\\-')}['"]?\\s*:`).test(runner)) add(FILES.runner, `--${key} 실행 경로가 없다`);
  }
  for (const id of ['v5.0.0-14.1.2', 'v5.0.0-14.2.4', 'v5.0.0-16.1.1', 'v5.0.0-16.4.2', 'v5.0.0-16.4.3']) {
    if (!texts.asvs.includes(id)) add(FILES.asvs, `ASVS ${id} 행이 없다`);
  }
  return bad;
}

export function formatViolations(list) {
  return list.map((v) => `막음: ${v}`).join('\n');
}

function main(argv) {
  let a;
  try {
    a = parseArgs({
      args: argv,
      options: {
        check: { type: 'boolean' },
        plan: { type: 'boolean' },
        root: { type: 'string' },
        today: { type: 'string' },
        partitions: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    console.error('쓰는 법: node tools/ci/access-log-retention.mjs --check [--root <저장소>] | --plan --today <YYYY-MM-DD> --partitions <csv>');
    return 2;
  }
  const o = a.values;
  if (o.help) {
    console.log('쓰는 법: node tools/ci/access-log-retention.mjs --check [--root <저장소>] | --plan --today <YYYY-MM-DD> --partitions <csv>');
    return 0;
  }
  const root = o.root ?? ROOT;
  try {
    if (o.plan) {
      if (!o.today || o.partitions === undefined) throw new Error('--plan에는 --today와 --partitions가 필요하다');
      const canon = canonFrom(root);
      const plan = purgePlan({ todayIso: o.today, partitionDays: o.partitions === '' ? [] : o.partitions.split(',').map((s) => s.trim()).filter(Boolean), retentionMonths: canon.accessMonths, maxDropPerRun: canon.retention.purge?.maxDropPerRun ?? 40 });
      console.log(JSON.stringify(plan));
      return 0;
    }
    const violations = checkAccessLogRetention(root);
    if (violations.length > 0) {
      console.error(formatViolations(violations));
      return 1;
    }
    console.log(`통과: F-02-4 접속기록 보존 만료 파기 설정(${FILES.retention})`);
    return 0;
  } catch (e) {
    console.error(String(e));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
