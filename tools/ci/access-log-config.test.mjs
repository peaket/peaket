// F-01-8 법정 접속기록 갈래·access_log 표·권한·하루 사본·조사 사본 정적 계약 시험.
// 정본 값은 docs/observability.md §5·§7, docs/infra.md §6, docs/data.md §1, docs/api/asyncapi.yaml의
// InvestigationRequest.routeKind에서 읽는다. 시험은 저장소 밖 임시 사본에서 한 곳씩 깬다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'tools', 'ci', 'access-log-config.mjs');

/** 시험이 읽는 파일(계획 §5 '읽는 파일'). 임시 저장소에는 이것만 복사한다 */
const READS = [
  'deploy/platform/observability/collector/agent.yaml',
  'deploy/platform/observability/collector/access-log.yaml',
  'deploy/platform/observability/collector/local/access-log.yaml',
  'deploy/platform/observability/access-log/jobs.yaml',
  'deploy/platform/observability/alerts/access-log.yaml',
  'data/clickhouse/access-log/001_access_log.sql',
  'data/clickhouse/access-log/002_users.sql',
  'data/clickhouse/access-log/README.md',
  'services/identity-svc/src/modules/session/legal-access-log.ts',
  'services/analytics-ingest/src/worker.ts',
  'docs/observability.md',
  'docs/data.md',
  'docs/infra.md',
  'docs/api/asyncapi.yaml',
];

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-access-log-'));
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

function run(root) {
  const r = spawnSync(process.execPath, [CLI, '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function expectBlocked(mutate, needle) {
  const root = tempRepo();
  try {
    mutate(root);
    const r = run(root);
    assert.equal(r.code, 1, `위반인데 끝 코드가 ${r.code}다:\n${r.out}`);
    assert.match(r.out, /^막음: /m, '막음 줄이 없다');
    assert.ok(r.out.includes(needle), `막음 줄에 "${needle}"이 없다:\n${r.out}`);
    // 한 곳만 깬 사례는 막은 줄이 정확히 하나다(같은 위반을 두 번 찍지 않는다)
    assert.equal(r.out.split('\n').filter((l) => l.startsWith('막음: ')).length, 1, `막은 줄이 하나가 아니다:\n${r.out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('F-01-8 실제 저장소의 법정 갈래·표·권한·사본 설정은 계약을 지킨다', async () => {
  const { checkAccessLogConfig } = await import('./access-log-config.mjs');
  assert.deepEqual(checkAccessLogConfig(ROOT), []);
  const r = run(ROOT);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.includes('막음: '), false);
});

test('F-01-8 읽을 파일이 없거나 규칙 파일이 0개면 2이고 막음 줄을 내지 않는다', async () => {
  const { checkAccessLogConfig } = await import('./access-log-config.mjs');
  const root = tempRepo();
  try {
    rmSync(join(root, 'deploy/platform/observability/collector/access-log.yaml'));
    const r = run(root);
    assert.equal(r.code, 2, r.out);
    assert.equal(r.out.includes('막음: '), false);
    assert.throws(() => checkAccessLogConfig(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // 모르는 인자는 2
  const bad = spawnSync(process.execPath, [CLI, '--wat'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('V-T21 법정 갈래는 읽은 위치·처음부터 읽기·회전 파일·디스크 큐·끝없는 재시도를 지킨다', () => {
  expectBlocked((r) => set(r, 'deploy/platform/observability/collector/access-log.yaml', 'start_at: beginning\n    include_file_path: true\n    include_file_name: false\n    storage: file_storage/access-legal\n    compression: auto', 'start_at: end\n    include_file_path: true\n    include_file_name: false\n    storage: file_storage/access-legal\n    compression: auto'), 'envoy-legal');
  expectBlocked((r) => set(r, 'deploy/platform/observability/collector/access-log.yaml', 'storage: file_storage/access-legal\n    compression: auto', 'storage: file_storage/access-investigation\n    compression: auto'), 'storage');
  expectBlocked((r) => set(r, 'deploy/platform/observability/collector/access-log.yaml', 'compression: auto', 'compression: gzip'), 'compression');
  expectBlocked((r) => set(r, 'deploy/platform/observability/collector/access-log.yaml', 'block_on_overflow: true', 'block_on_overflow: false'), 'block_on_overflow');
  expectBlocked((r) => set(r, 'deploy/platform/observability/collector/access-log.yaml', 'max_elapsed_time: 0', 'max_elapsed_time: 300s'), 'max_elapsed_time');
  expectBlocked((r) => set(r, 'deploy/platform/observability/collector/access-log.yaml', 'logs_table_name: access_log', 'logs_table_name: access_log_copy'), 'access_log');
  // 법정 갈래에는 표본 처리기를 두지 않는다
  expectBlocked((r) => set(r, 'deploy/platform/observability/collector/access-log.yaml', 'processors: [memory_limiter, filter/legal-only, transform/strip-investigation, batch]', 'processors: [memory_limiter, filter/legal-only, probabilistic_sampler, transform/strip-investigation, batch]'), 'probabilistic_sampler');
});

test('V-T22 법정·조사 갈래는 file_storage를 따로 쓰고 identity 줄의 빈 seq를 경보로 센다', () => {
  expectBlocked((r) => set(r, 'deploy/platform/observability/collector/access-log.yaml', 'directory: /var/lib/otelcol/access-investigation', 'directory: /var/lib/otelcol/access-legal'), 'file_storage');
  expectBlocked((r) => set(r, 'deploy/platform/observability/alerts/access-log.yaml', 'access_log_seq_gaps_total', 'access_log_seq_gap'), 'access_log_seq_gaps_total');
  expectBlocked((r) => set(r, 'services/identity-svc/src/modules/session/legal-access-log.ts', 'seq', 'sequence'), 'seq');
});

test('V-T23 하루 사본은 03:30 앵커·04:00 내보내기·06:00 지연·Parquet·Object Lock·3개월+7일을 지킨다', () => {
  const jobs = 'deploy/platform/observability/access-log/jobs.yaml';
  expectBlocked((r) => set(r, jobs, 'schedule: "30 3 * * *"', 'schedule: "0 3 * * *"'), 'anchor');
  expectBlocked((r) => set(r, jobs, 'schedule: "0 4 * * *"', 'schedule: "0 5 * * *"'), 'copy');
  expectBlocked((r) => set(r, jobs, 'missingBy: "06:00"', 'missingBy: "07:00"'), '06:00');
  expectBlocked((r) => set(r, jobs, 'format: Parquet', 'format: CSV'), 'Parquet');
  expectBlocked((r) => set(r, jobs, 'objectLock: COMPLIANCE', 'objectLock: GOVERNANCE'), 'COMPLIANCE');
  expectBlocked((r) => set(r, jobs, 'retention: P3M7D', 'retention: P3M'), 'P3M7D');
  // 표: 일 파티션·복제 엔진·원문 IP 색인·TTL 3개월 이상
  const ddl = 'data/clickhouse/access-log/001_access_log.sql';
  expectBlocked((r) => set(r, ddl, 'ENGINE = ReplicatedMergeTree', 'ENGINE = MergeTree'), 'ReplicatedMergeTree');
  expectBlocked((r) => set(r, ddl, 'PARTITION BY toYYYYMMDD(ts)', 'PARTITION BY toYYYYMM(ts)'), 'toYYYYMMDD');
  expectBlocked((r) => set(r, ddl, 'INTERVAL 3 MONTH', 'INTERVAL 2 MONTH'), '3개월');
  expectBlocked((r) => set(r, ddl, 'TYPE bloom_filter', 'TYPE minmax'), 'bloom_filter');
  // 권한: 넣기만·관리 계정 줄만·수사 대응만, 사본 쓰기/읽기 역할 분리
  const users = 'data/clickhouse/access-log/002_users.sql';
  expectBlocked((r) => set(r, users, 'GRANT INSERT ON access_log.access_log TO al_ingest;', 'GRANT INSERT ON access_log.access_log TO al_ingest;\nGRANT SELECT ON access_log.access_log TO al_ingest;'), 'al_ingest');
  expectBlocked((r) => set(r, users, 'CREATE ROW POLICY IF NOT EXISTS admin_rows_only', 'CREATE ROW POLICY IF NOT EXISTS admin_rows_everyone'), 'admin_rows');
  expectBlocked((r) => set(r, users, 'GRANT SELECT ON access_log.access_log TO al_investigation;', ''), 'al_investigation');
});

test('V-T21·16.4.3 정본 값(0.1%·5분·15분)을 바꾸면 설정과 어긋나 막는다', () => {
  expectBlocked((r) => set(r, 'docs/observability.md', '모자란 비율이 0.1%를 넘으면', '모자란 비율이 0.2%를 넘으면'), 'shortfallThreshold');
  expectBlocked((r) => set(r, 'docs/observability.md', '대조 잡이 5분마다 15분 전의 5분 칸을 본다', '대조 잡이 10분마다 15분 전의 5분 칸을 본다'), 'window');
  expectBlocked((r) => set(r, 'docs/observability.md', '다음 날 03:30에는', '다음 날 03:00에는'), 'anchor');
  expectBlocked((r) => set(r, 'docs/infra.md', '매일 04:00 [가정]', '매일 05:00 [가정]'), 'copy');
  expectBlocked((r) => set(r, 'docs/infra.md', '3개월 + 7일 [가정]', '3개월 + 8일 [가정]'), 'retention');
  expectBlocked((r) => set(r, 'docs/observability.md', '06:00까지 없다', '07:00까지 없다'), 'missingBy');
});

test('Q-T61 ①~③ 조사 사본은 조사 경로만 Kafka로 보내고 조사 칸을 법정·일반 줄에서 지운다', () => {
  const cfg = 'deploy/platform/observability/collector/access-log.yaml';
  expectBlocked((r) => set(r, cfg, 'path: investigation.requests', 'path: investigation.copy'), 'investigation.requests');
  expectBlocked((r) => set(r, cfg, 'compression: zstd', 'compression: gzip'), 'zstd');
  expectBlocked((r) => set(r, cfg, 'block_on_overflow: false', 'block_on_overflow: true'), 'block_on_overflow');
  expectBlocked((r) => set(r, cfg, 'max_elapsed_time: 10m', 'max_elapsed_time: 1h'), '10m');
  // 조사 수신기는 법정과 다른 storage를 쓴다(읽은 위치를 따로 둔다)
  expectBlocked((r) => set(r, cfg, 'storage: file_storage/access-investigation', 'storage: file_storage/access-legal'), 'storage');
  // 상태 조회·결과 파일은 조사 줄이 아니다
  expectBlocked((r) => set(r, cfg, 'and not IsMatch(attributes["path"], "^/v1/queues/[^/]+/(status|files)(/|$)")', 'and true'), 'status');
  // asyncapi의 routeKind 목록을 하나라도 빠뜨리면 막는다
  expectBlocked((r) => set(r, cfg, 'set(attributes["routeKind"], "TRANSFER") where IsMatch(attributes["path"], "^/v1/tickets/[^/]+/transfers$")', ''), 'TRANSFER');
  // 법정·일반 사본에서 조사 칸을 지운다
  expectBlocked((r) => set(r, cfg, 'delete_key(attributes, "ja4")', 'delete_key(attributes, "ja4_missing")'), 'ja4');
  expectBlocked((r) => set(r, cfg, 'delete_key(attributes, "edge_bot_labels")', ''), 'edge_bot_labels');
  expectBlocked((r) => set(r, cfg, 'delete_key(attributes, "jny")', ''), 'jny');
  // 위조 끝단 머리 값은 게이트웨이가 지운다: 게이트웨이 401·403 줄도 법정 갈래에 남긴다
  expectBlocked((r) => set(r, cfg, 'status >= 400', 'status >= 500'), '401');
});

test('Q-T61 ④ 분석 적재는 investigation.requests를 읽지 않고 조사 칸을 시험으로 막는다', () => {
  expectBlocked(
    (r) => set(r, 'services/analytics-ingest/src/worker.ts', "export const TELEMETRY_TOPICS = ['telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts'] as const;", "export const TELEMETRY_TOPICS = ['telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts', 'investigation.requests'] as const;"),
    'investigation.requests',
  );
  expectBlocked((r) => set(r, 'services/analytics-ingest/src/worker.ts', "export const NEVER_TOPICS = ['investigation.requests', 'telemetry.behavior', 'telemetry.rum'] as const;", "export const NEVER_TOPICS = ['telemetry.behavior', 'telemetry.rum'] as const;"), 'NEVER_TOPICS');
});

test('16.3.1·16.3.2·16.3.3 identity 접속기록 줄은 결과·요소·실패 종류·seq를 싣고 비밀을 싣지 않는다', () => {
  const id = 'services/identity-svc/src/modules/session/legal-access-log.ts';
  expectBlocked((r) => set(r, id, "kind: 'legal-access'", "kind: 'access-log'"), 'legal-access');
  expectBlocked((r) => set(r, id, "'password'", "'password', 'token'"), 'token');
  expectBlocked((r) => set(r, id, "factors: [...input.factors]", 'factors: [],'), 'factors');
});
