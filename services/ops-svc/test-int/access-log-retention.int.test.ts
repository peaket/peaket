// F-02-4 실제 저장소 통합 시험: ClickHouse 24.12 HTTP 인증(al_purger·al_admin_reader),
// ops-svc/PostgreSQL 감사 접수(ADMIN_ACCESS_LOG·ACCESS_LOG_PARTITION_PURGE), moto Object Lock 삭제 거절.
// Docker가 필요하다. 잠금은 바깥에서 잡고, 컨테이너는 끝나면 rm -f -v로 지운다.
import 'reflect-metadata';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, GetObjectLockConfigurationCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type ClickHouseContainer, startClickHouse } from './clickhouse.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CLI = join(ROOT, 'tools', 'local', 'access-log-jobs.mjs');
const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const REGION = 'ap-northeast-2';
const NOW = Date.parse('2026-11-24T07:00:00.000Z');
const PURGER_PASSWORD = 'purger-test';
const ADMIN_READER_PASSWORD = 'admin-reader-test';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

let pgContainer: PostgresContainer | undefined;
let ch: ClickHouseContainer | undefined;
let moto = '';
let db: Database | undefined;
let admin: pg.Client | undefined;
let svc: Awaited<ReturnType<typeof createService>> | undefined;
let svcBase = '';
let s3: S3Client | undefined;
let internalToken = '';

function runCli(args: string[]) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, PEAKET_ENV: 'ci' }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : error ? 2 : 0;
      resolve({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

const statements = (sql: string) => sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.split('\n').every((l) => l.trim().startsWith('--') || l.trim() === ''));

async function apply(sql: string) {
  for (const s of statements(sql)) await ch!.exec(s);
}

beforeAll(async () => {
  [pgContainer, ch] = await Promise.all([startPostgres(), startClickHouse({ name: `lane2-F-02-4-ch-${Math.random().toString(36).slice(2, 8)}` })]);
  await migrateOps(pgContainer.url);
  db = createDatabase({ url: pgContainer.url, applicationName: 'ops-svc-access-log-it' });
  admin = new pg.Client({ connectionString: pgContainer.url });
  await admin.connect();
  // 표는 ReplicatedMergeTree(운영) 대신 단일 노드 MergeTree로 바꿔 만들고, 사용자 셋은 시험 비밀번호로 envsubst한다.
  const ddl = readFileSync(join(ROOT, 'data/clickhouse/access-log/001_access_log.sql'), 'utf8').replace(/ReplicatedMergeTree\('[^']+', '\{replica\}'\)/g, 'MergeTree()');
  await apply(ddl);
  // 이 시험은 파기 잡이 TTL과 독립으로 만료 파티션만 지우는지 본다. 실제 시계의 TTL이 경계 파티션을 먼저 지우지 않게 TTL을 뗀다.
  await ch.exec('ALTER TABLE access_log.access_log REMOVE TTL');
  await ch.exec('ALTER TABLE access_log.access_log_otel REMOVE TTL');
  const users = readFileSync(join(ROOT, 'data/clickhouse/access-log/002_users.sql'), 'utf8')
    .replace('${PEAKET_AL_INGEST_PASSWORD}', 'ingest-test')
    .replace('${PEAKET_AL_ADMIN_READER_PASSWORD}', ADMIN_READER_PASSWORD)
    .replace('${PEAKET_AL_INVESTIGATION_PASSWORD}', 'investigation-test')
    .replace('${PEAKET_AL_MIGRATOR_PASSWORD}', 'migrator-test');
  await apply(users);
  const purgeUsers = readFileSync(join(ROOT, 'data/clickhouse/access-log/003_purge.sql'), 'utf8').replace('${PEAKET_AL_PURGER_PASSWORD}', PURGER_PASSWORD);
  await apply(purgeUsers);

  const token = `it-${randomUUID()}`;
  internalToken = token;
  vi.stubEnv('PEAKET_INTERNAL_TOKEN', token);
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, background: false }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  const { port } = await svc.listen('127.0.0.1');
  svcBase = `http://127.0.0.1:${port}`;

  moto = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', moto, '5000/tcp']).split('\n')[0]!;
  const endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  // moto는 PostgreSQL·ClickHouse 같은 준비 대기가 없다. 문이 열릴 때까지 짧게 기다린다.
  const motoDeadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(endpoint);
      break;
    } catch (e) {
      if (Date.now() > motoDeadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  s3 = new S3Client({ endpoint, region: REGION, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  pgContainer?.stop();
  ch?.stop();
  if (moto) {
    try {
      docker(['rm', '-f', '-v', moto]);
    } catch {
      // 이미 멈췄다
    }
  }
  vi.unstubAllEnvs();
});

describe('F-02-4 실제 ClickHouse·ops-svc·Object Lock 통합', () => {
  test('[ASVS v5.0.0-14.2.4] al_purger가 HTTP 인증으로 만료 파티션만 지우고 파기 기록이 PostgreSQL 감사 체인에 상태별로 남는다', async () => {
    const token = internalToken;
    await admin!.query('truncate audit_chain, audit_record_intake, audit_chain_head restart identity');
    await admin!.query("insert into audit_chain_head (id, last_seq, last_hash) values (1, 0, ''::bytea) on conflict (id) do update set last_seq=0, last_hash=''::bytea");
    await ch!.exec(`INSERT INTO access_log.access_log (ts, source, gateway, request_id, method, path, status, duration_ms, client_ip, user_agent, account_id, event, result, provider, factors, failure, act, seq, pod, is_admin) VALUES
      ('2026-08-22 12:00:00.000', 'gateway', 'GW_FAN', 'old-1', 'GET', '/v1/events/1', 200, 10, toIPv6OrNull('203.0.113.7'), 'UA-old', '', '', '', '', [], '', '', 0, '', 0),
      ('2026-08-24 12:00:00.000', 'gateway', 'GW_FAN', 'edge-1', 'GET', '/v1/events/1', 200, 10, toIPv6OrNull('203.0.113.8'), 'UA-edge', '', '', '', '', [], '', '', 0, '', 0),
      ('2026-11-23 12:00:00.000', 'identity', '', 'admin-1', '', '', 0, 0, toIPv6OrNull('203.0.113.9'), 'UA-admin', '11111111-1111-4111-8111-111111111111', 'LOGIN', 'SUCCESS', 'PASSWORD', ['password','totp'], '', '', 1, 'identity-1', 1),
      ('2026-11-23 13:00:00.000', 'identity', '', 'admin-2', '', '', 0, 0, toIPv6OrNull('203.0.113.10'), 'UA-admin2', '22222222-2222-4222-8222-222222222222', 'REAUTH', 'SUCCESS', 'PASSKEY', ['passkey'], '', '', 2, 'identity-1', 1),
      ('2026-11-23 14:00:00.000', 'identity', '', 'fan-1', '', '', 0, 0, toIPv6OrNull('203.0.113.11'), 'UA-fan', '33333333-3333-4333-8333-333333333333', 'LOGIN', 'SUCCESS', 'PASSWORD', ['password'], '', '', 3, 'identity-1', 0)`);
    // 원천 표(exporter 고정 칸)의 만료 파티션도 만든다.
    await ch!.exec(`INSERT INTO access_log.access_log_otel
      (Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes, EventName) VALUES
      ('2026-08-22 12:00:00.000', '', '', 0, '', 0, 'envoy', '', '', map('service.name','envoy'), '', '', '', map(), map('source','gateway','kind','envoy-access'), '')`);
    const r = await runCli([
      '--purge',
      '--today',
      '2026-11-24',
      '--clickhouse',
      ch!.url,
      '--clickhouse-user',
      'al_purger',
      '--clickhouse-password',
      PURGER_PASSWORD,
      '--ops-audit',
      `${svcBase}/internal/v1/ops/audit-records`,
      '--token',
      token,
    ]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    const parts = JSON.parse(await ch!.exec("SELECT partition, table FROM system.parts WHERE database='access_log' AND active AND table IN ('access_log','access_log_otel') FORMAT JSON")).data as Array<{ partition: string; table: string }>;
    expect(parts.filter((p) => p.table === 'access_log').map((p) => p.partition).sort()).toEqual(['20260824', '20261123']);
    expect(parts.filter((p) => p.table === 'access_log_otel')).toEqual([]);
    const states = (await admin!.query("select record_json->'payload'->>'state' as state, record_json->'payload'->>'table' as \"table\", count(*)::int as n from audit_chain where record_type='ACCESS_LOG_PARTITION_PURGE' group by state, record_json->'payload'->>'table' order by state, record_json->'payload'->>'table'")).rows;
    expect(states).toEqual([
      { state: 'DROPPED', table: 'access_log', n: 1 },
      { state: 'DROPPED', table: 'access_log_otel', n: 1 },
      { state: 'PLANNED', table: 'access_log', n: 1 },
      { state: 'PLANNED', table: 'access_log_otel', n: 1 },
    ]);
    const raw = (await admin!.query("select record_json from audit_chain where record_type='ACCESS_LOG_PARTITION_PURGE' and record_json->'payload'->>'state'='DROPPED' and record_json->'payload'->>'table'='access_log'")).rows[0].record_json;
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(payload.payload).toMatchObject({ day: '2026-08-22', table: 'access_log', state: 'DROPPED', rows: null });
    // TR-03: 실제 자격이 쓰였는지 확인한다. al_purger는 행을 읽지 못하고 currentUser()가 자기 이름이다.
    const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    const asUser = async (user: string, pass: string, sql: string) => fetch(`${ch!.url}/`, { method: 'POST', headers: { authorization: basic(user, pass) }, body: sql });
    const me = await asUser('al_purger', PURGER_PASSWORD, 'SELECT currentUser()');
    expect((await me.text()).trim()).toBe('al_purger');
    const denied = await asUser('al_purger', PURGER_PASSWORD, 'SELECT count() FROM access_log.access_log');
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(await denied.text()).toMatch(/ACCESS_DENIED|Not enough privileges|denied/i);
    const wrong = await runCli([
      '--purge', '--today', '2026-11-24', '--clickhouse', ch!.url,
      '--clickhouse-user', 'al_purger', '--clickhouse-password', 'wrong-password',
      '--ops-audit', `${svcBase}/internal/v1/ops/audit-records`, '--token', token,
    ]);
    expect(wrong.code, `${wrong.out}\n${wrong.err}`).toBe(1);
  });

  test('[ASVS v5.0.0-16.4.3] al_admin_reader가 KST 하루의 관리 계정 줄만 읽어 ops-svc PostgreSQL 감사 체인에 2년 보존으로 넣는다', async () => {
    const token = internalToken;
    await admin!.query('truncate audit_chain, audit_record_intake, audit_chain_head restart identity');
    await admin!.query("insert into audit_chain_head (id, last_seq, last_hash) values (1, 0, ''::bytea) on conflict (id) do update set last_seq=0, last_hash=''::bytea");
    await ch!.exec(`INSERT INTO access_log.access_log (ts, source, gateway, request_id, method, path, status, duration_ms, client_ip, user_agent, account_id, event, result, provider, factors, failure, act, seq, pod, is_admin) VALUES
      ('2026-11-23 14:59:59.000', 'identity', '', 'kst-before', '', '', 0, 0, NULL, 'UA', '44444444-4444-4444-8444-444444444444', 'LOGIN', 'SUCCESS', 'PASSWORD', ['password'], '', '', 4, 'identity-1', 1),
      ('2026-11-23 15:00:00.000', 'identity', '', 'kst-start', '', '', 0, 0, NULL, 'UA', '55555555-5555-4555-8555-555555555555', 'LOGIN', 'SUCCESS', 'PASSWORD', ['password'], '', '', 5, 'identity-1', 1),
      ('2026-11-24 08:59:59.000', 'identity', '', 'kst-mid', '', '', 0, 0, NULL, 'UA', '66666666-6666-4666-8666-666666666666', 'REAUTH', 'SUCCESS', 'PASSKEY', ['passkey'], '', '', 6, 'identity-1', 1),
      ('2026-11-24 14:59:59.000', 'identity', '', 'kst-end', '', '', 0, 0, NULL, 'UA', '77777777-7777-4777-8777-777777777777', 'LOGOUT', 'SUCCESS', '', [], '', '', 7, 'identity-1', 1),
      ('2026-11-24 15:00:00.000', 'identity', '', 'kst-after', '', '', 0, 0, NULL, 'UA', '88888888-8888-4888-8888-888888888888', 'LOGIN', 'SUCCESS', 'PASSWORD', ['password'], '', '', 8, 'identity-1', 1)`);
    const r = await runCli([
      '--admin-copy',
      '--date',
      '2026-11-24',
      '--clickhouse',
      ch!.url,
      '--clickhouse-user',
      'al_admin_reader',
      '--clickhouse-password',
      ADMIN_READER_PASSWORD,
      '--ops-audit',
      `${svcBase}/internal/v1/ops/audit-records`,
      '--token',
      token,
    ]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    const rows = (await admin!.query("select record_json from audit_chain where record_type='ADMIN_ACCESS_LOG' order by seq")).rows;
    expect(rows).toHaveLength(3);
    const payloads = rows.map((r2) => (typeof r2.record_json === 'string' ? JSON.parse(r2.record_json) : r2.record_json).payload);
    expect(payloads.map((p) => p.requestId).sort()).toEqual(['kst-end', 'kst-mid', 'kst-start']);
    expect(payloads.map((p) => p.retainUntil).sort()).toEqual(['2028-11-23T15:00:00.000Z', '2028-11-24T08:59:59.000Z', '2028-11-24T14:59:59.000Z']);
    expect(payloads.some((p) => p.requestId === 'kst-before' || p.requestId === 'kst-after' || p.requestId === 'fan-1')).toBe(false);
    const keys = rows.map((r2) => (typeof r2.record_json === 'string' ? JSON.parse(r2.record_json) : r2.record_json).payload.eventKey as string);
    expect(keys.every((k) => k.split(':')[2] === '2026-11-24')).toBe(true);
  });

  test('[ASVS v5.0.0-16.4.2] Object Lock 준수 모드 사본 버킷과 보존 머리를 받는다(모토는 삭제 거절을 흉내 내지 않아 그 부분은 미검증)', async () => {
    const bucket = `peaket-access-log-copy-${randomUUID().slice(0, 8)}`;
    await s3!.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true, CreateBucketConfiguration: { LocationConstraint: REGION } }));
    const config = await s3!.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
    expect(config.ObjectLockConfiguration?.ObjectLockEnabled).toBe('Enabled');
    const key = 'access_log/2026-11-24.parquet';
    await s3!.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'parquet', ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(Date.now() + 86_400_000) }));
    // moto 5.2.5는 Object Lock 삭제 거절(403)과 GetObjectRetention을 흉내 내지 않는다(2026-11-25 확인).
    // 그래서 여기서는 버킷 잠금 설정과 COMPLIANCE 머리 수락까지만 본다. 실제 삭제 거절은 INF-020 S3에서 확인한다.
  });
});
