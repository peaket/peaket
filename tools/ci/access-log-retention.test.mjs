// F-02-4 접속기록 보존 만료 파기 정적 계약·순수 계산 시험.
// 정본 값은 docs/data.md §1 '시스템 접속기록', docs/security/data-classification.md
// '법정 접속기록'·'관리자 시스템 접속기록'·'백업 보존 상한과 파기', docs/observability.md §7·§9에서 읽고,
// 시험은 저장소 밖 임시 사본에서 한 곳씩 깬다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'tools', 'ci', 'access-log-retention.mjs');

/** 검사기가 읽는 파일(계획 §7). 임시 저장소에는 이것만 복사한다 */
const READS = [
  'data/clickhouse/access-log/001_access_log.sql',
  'data/clickhouse/access-log/002_users.sql',
  'data/clickhouse/access-log/003_purge.sql',
  'data/clickhouse/access-log/README.md',
  'deploy/platform/observability/access-log/jobs.yaml',
  'deploy/platform/observability/access-log/retention.yaml',
  'deploy/platform/observability/alerts/access-log.yaml',
  'tools/local/access-log-jobs.mjs',
  'services/ops-svc/src/modules/audit/audit-intake.ts',
  'docs/observability.md',
  'docs/security/data-classification.md',
  'docs/data.md',
  'docs/infra.md',
  'docs/features/offline-gate.md',
  'docs/security/asvs/offline-gate.md',
];

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-access-log-retention-'));
  for (const rel of READS) {
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(ROOT, rel), to);
  }
  return dir;
}

function set(root, rel, from, to) {
  const file = join(root, rel);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `${rel}에 바꿀 글이 없다: ${from}`);
  writeFileSync(file, text.replace(from, to));
}

/** 같은 글이 여럿일 때 n번째(1부터) 하나만 바꾼다. */
function replaceNth(root, rel, from, to, n) {
  const file = join(root, rel);
  const text = readFileSync(file, 'utf8');
  let seen = 0;
  const out = text.replaceAll(from, (m) => (++seen === n ? to : m));
  assert.ok(seen >= n, `${rel}에 ${n}번째 "${from}"이 없다`);
  writeFileSync(file, out);
}

function expectExit2(mutate) {
  const root = tempRepo();
  try {
    mutate(root);
    const r = run(root, ['--check']);
    assert.equal(r.code, 2, `읽기 실패인데 끝 코드가 ${r.code}다:\n${r.out}`);
    assert.equal(r.out.includes('막음: '), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root, extra = []) {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function expectBlocked(mutate, needle) {
  const root = tempRepo();
  try {
    mutate(root);
    const r = run(root, ['--check']);
    assert.equal(r.code, 1, `위반인데 끝 코드가 ${r.code}다:\n${r.out}`);
    assert.match(r.out, /^막음: /m, '막음 줄이 없다');
    assert.ok(r.out.includes(needle), `막음 줄에 "${needle}"이 없다:\n${r.out}`);
    assert.ok(r.out.split('\n').some((l) => l.startsWith('막음: ')), '막음 줄이 없다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('F-02-4 실제 저장소의 접속기록 보존·파기·관리 계정 복사 설정은 계약을 지킨다', async () => {
  const { checkAccessLogRetention } = await import('./access-log-retention.mjs');
  assert.deepEqual(checkAccessLogRetention(ROOT), []);
  const r = run(ROOT, ['--check']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.includes('막음: '), false);
});

test('F-02-4 검사기가 읽을 파일이 없거나 정본 행을 읽지 못하면 2이고 막음 줄을 내지 않는다', async () => {
  const { checkAccessLogRetention } = await import('./access-log-retention.mjs');
  const root = tempRepo();
  try {
    rmSync(join(root, 'deploy/platform/observability/access-log/retention.yaml'));
    const r = run(root, ['--check']);
    assert.equal(r.code, 2, r.out);
    assert.equal(r.out.includes('막음: '), false);
    assert.throws(() => checkAccessLogRetention(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // 모르는 인자는 2
  const bad = spawnSync(process.execPath, [CLI, '--unknown'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('[ASVS v5.0.0-14.1.2] 접속기록 보존 값이 정본과 설정·표에서 같고 하나만 바꾸면 막는다', async () => {
  // 정본 쪽 값이 바뀌면 설정이 따라오지 않은 것으로 보고 막는다(값을 코드에 복사하지 않는다).
  expectBlocked((root) => set(root, 'docs/data.md', '최소 3개월 보존', '최소 2개월 보존'), '3개월');
  expectBlocked((root) => set(root, 'docs/security/data-classification.md', '최소 2년 이상 보존', '최소 1년 이상 보존'), '2년');
  expectBlocked((root) => set(root, 'deploy/platform/observability/access-log/jobs.yaml', 'retention: P3M7D', 'retention: P3M6D'), 'P3M7D');
  expectBlocked((root) => set(root, 'docs/security/data-classification.md', '| 7일 [가정](ADR-0053 결정 10). 복원하면', '| 6일 [가정](ADR-0053 결정 10). 복원하면'), '7일');
  // 하루 사본의 7일(3개월 보존이 끝난 뒤)도 별도 값이다.
  expectBlocked((root) => set(root, 'docs/security/data-classification.md', '보존이 끝난 뒤 7일 [가정]', '보존이 끝난 뒤 8일 [가정]'), '7일');
});

test('[ASVS v5.0.0-14.1.2] 정본 행을 읽지 못하면 막지 않고 종료 2다', async () => {
  expectExit2((root) => {
    const file = join(root, 'docs/data.md');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('최소 3개월 보존'));
    writeFileSync(file, text.replace(/^.*최소 3개월 보존.*$/m, ''));
  });
});

test('[ASVS v5.0.0-16.1.1] 로그 목록·보존·지표·경보가 한 벌로 있고 하나를 빼거나 바꾸면 막는다', async () => {
  const rel = 'deploy/platform/observability/access-log/retention.yaml';
  expectBlocked((root) => set(root, rel, 'adminCopy:', 'adminCopyGone:'), 'adminCopy');
  expectBlocked((root) => set(root, rel, 'reapplyWindowDays: 40', 'reapplyWindowDays: 30'), '40일');
  expectBlocked((root) => set(root, rel, 'schedule: "0 5 * * *"', 'schedule: "0 9 * * *"'), '05:00');
  expectBlocked((root) => set(root, rel, 'maxDropPerRun: 40', 'maxDropPerRun: 400'), '40');
  expectBlocked((root) => set(root, rel, 'schedule: "30 4 * * *"', 'schedule: "0 4 * * *"'), '04:30');
  expectBlocked((root) => set(root, rel, 'lookbackDays: 1', 'lookbackDays: 2'), '1');
  expectBlocked((root) => set(root, rel, 'sourceUser: al_admin_reader', 'sourceUser: al_migrator'), 'al_admin_reader');
  expectBlocked((root) => set(root, rel, 'metrics:\n  overdue:', 'metricsGone:\n  overdue:'), 'metrics');
  expectBlocked((root) => set(root, rel, 'lastSuccess: access_log_purge_last_success_timestamp', 'lastSuccess: wrong_metric'), 'access_log_purge_last_success_timestamp');
  // timeZone은 purge와 adminCopy에 둘 있다. 첫째(purge)를 바꾼다.
  expectBlocked((root) => replaceNth(root, rel, 'timeZone: Asia/Seoul', 'timeZone: UTC', 1), 'Asia/Seoul');
  expectBlocked((root) => set(root, 'deploy/platform/observability/alerts/access-log.yaml', 'alert: AccessLogPurgeOverdue', 'alert: AccessLogPurgeOverdueGone'), 'AccessLogPurgeOverdue');
  expectBlocked((root) => set(root, 'deploy/platform/observability/alerts/access-log.yaml', 'alert: AccessLogAdminCopyLate', 'alert: AccessLogAdminCopyLateGone'), 'AccessLogAdminCopyLate');
  expectBlocked((root) => set(root, 'deploy/platform/observability/alerts/access-log.yaml', 'alert: AccessLogPurgeFailed', 'alert: AccessLogPurgeFailedGone'), 'AccessLogPurgeFailed');
  expectBlocked((root) => set(root, 'deploy/platform/observability/alerts/access-log.yaml', 'alert: AccessLogPurgeAuditFailed', 'alert: AccessLogPurgeAuditFailedGone'), 'AccessLogPurgeAuditFailed');
});

test('[ASVS v5.0.0-16.4.2] 파기 역할은 행을 읽지 못하고 다음 적용·Object Lock·행 정책이 빠지면 막는다', async () => {
  expectBlocked((root) => set(root, 'data/clickhouse/access-log/003_purge.sql', 'GRANT ALTER ON access_log.access_log TO al_purger;', ''), 'al_purger');
  expectBlocked(
    (root) => {
      const file = join(root, 'data/clickhouse/access-log/003_purge.sql');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\nGRANT SELECT ON access_log.access_log TO al_purger;\n`);
    },
    'al_purger',
  );
  expectBlocked((root) => set(root, 'deploy/platform/observability/access-log/jobs.yaml', 'objectLock: COMPLIANCE', 'objectLock: GOVERNANCE'), 'COMPLIANCE');
  expectBlocked(
    (root) => set(root, 'data/clickhouse/access-log/002_users.sql', 'CREATE ROW POLICY IF NOT EXISTS admin_rows_only ON access_log.access_log FOR SELECT USING is_admin = 1 TO al_admin_reader;', ''),
    'admin_rows_only',
  );
});

test('[ASVS v5.0.0-16.4.3] 전용 DB·감사 접수 종류·일반 사용자 권한 분리가 빠지면 막는다', async () => {
  expectBlocked((root) => set(root, 'services/ops-svc/src/modules/audit/audit-intake.ts', 'ADMIN_ACCESS_LOG:', 'ADMIN_ACCESS_LOG_GONE:'), 'ADMIN_ACCESS_LOG');
  expectBlocked((root) => set(root, 'services/ops-svc/src/modules/audit/audit-intake.ts', 'ACCESS_LOG_PARTITION_PURGE:', 'ACCESS_LOG_PARTITION_PURGE_GONE:'), 'ACCESS_LOG_PARTITION_PURGE');
  expectBlocked((root) => set(root, 'data/clickhouse/access-log/003_purge.sql', 'GRANT SELECT ON system.parts TO al_purger;', ''), 'system.parts');
});

test('[ASVS v5.0.0-14.2.4] 3개월 컷오프는 월말·윤달을 보정하고 같은 날짜는 남긴다', async () => {
  const { monthCutoff, expiredPartitionDays, purgePlan, retentionUntil, adminRetainUntil } = await import('./access-log-retention.mjs');
  assert.equal(monthCutoff('2026-05-31', 3), '2026-02-28');
  assert.equal(monthCutoff('2024-05-31', 3), '2024-02-29');
  assert.equal(monthCutoff('2026-11-24', 3), '2026-08-24');
  assert.equal(monthCutoff('2026-01-31', 1), '2025-12-31');
  assert.deepEqual(
    expiredPartitionDays({ todayIso: '2026-11-24', partitionDays: ['2026-08-25', '2026-08-24', '2026-08-23', '2026-08-22'], retentionMonths: 3 }),
    ['2026-08-22', '2026-08-23'],
  );
  // 같은 날짜(2026-08-24)는 남긴다: 그날 늦은 줄은 아직 3개월이 안 됐다.
  assert.deepEqual(expiredPartitionDays({ todayIso: '2026-11-24', partitionDays: ['2026-08-24'], retentionMonths: 3 }), []);
  const plan = purgePlan({ todayIso: '2026-11-24', partitionDays: ['2026-08-23', '2026-08-22', '2026-08-25'], retentionMonths: 3, maxDropPerRun: 1 });
  assert.deepEqual(plan.drop, ['2026-08-22']);
  assert.equal(plan.overdue, 2);
  assert.equal(plan.truncated, true);
  assert.equal(retentionUntil('2026-11-24', 3, 7), '2027-03-03T00:00:00.000Z');
  assert.equal(adminRetainUntil('2024-02-29T00:00:00.000Z', 2), '2026-03-01T00:00:00.000Z');
  assert.equal(adminRetainUntil('2024-02-29T00:00:00.000Z', 4), '2028-02-29T00:00:00.000Z');
  assert.equal(adminRetainUntil('2028-02-29T00:00:00.000Z', 2), '2030-03-01T00:00:00.000Z');
  assert.equal(adminRetainUntil('2026-11-24T23:59:59.000Z', 2), '2028-11-24T23:59:59.000Z');
});

test('[ASVS v5.0.0-14.2.4] 복원하면 스냅샷 뒤 파기 기록의 날짜만 다시 지운다', async () => {
  const { reapplyPlan } = await import('./access-log-retention.mjs');
  const records = [
    { day: '2026-11-23', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-23T20:00:00.000Z' },
    { day: '2026-11-24', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-24T20:00:00.000Z' },
    { day: '2026-11-25', table: 'access_log_otel', state: 'DROPPED', executedAt: '2026-11-25T20:00:00.000Z' },
    { day: '2026-11-25', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-25T20:00:00.000Z' },
  ];
  const plan = reapplyPlan({
    snapshotAtIso: '2026-11-24T00:00:00.000Z',
    records,
    partitions: [
      { day: '2026-11-23', table: 'access_log' },
      { day: '2026-11-24', table: 'access_log' },
      { day: '2026-11-25', table: 'access_log' },
    ],
  });
  assert.deepEqual(plan.drop, [
    { day: '2026-11-24', table: 'access_log' },
    { day: '2026-11-25', table: 'access_log' },
  ]);
  assert.deepEqual(plan.skipped, [
    { day: '2026-11-23', reason: 'before-snapshot' },
    { day: '2026-11-25', reason: 'not-restored' },
  ]);
});

test('access-log-retention 실행기는 --plan과 --check에서 정해진 끝 코드를 낸다', () => {
  const plan = run(ROOT, ['--plan', '--today', '2026-11-24', '--partitions', '2026-08-23,2026-08-24,2026-08-25']);
  assert.equal(plan.code, 0, plan.out);
  const parsed = JSON.parse(plan.out);
  assert.deepEqual(parsed.drop, ['2026-08-23']);
  assert.equal(parsed.cutoff, '2026-08-24');
  assert.equal(parsed.overdue, 1);
  const bad = run(ROOT, ['--plan', '--today', '2026-13-40', '--partitions', 'x']);
  assert.equal(bad.code, 2, bad.out);
});
