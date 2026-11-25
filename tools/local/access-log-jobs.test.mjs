// F-02-4 접속기록 보존 만료 파기·관리 계정 복사·복원 뒤 다시 적용 실행기 시험.
// Docker 없이 가짜 ClickHouse HTTP 서버와 가짜 ops 감사 접수 서버로 바깥 경계를 본다.
// 정본 값(3개월·2년·7일·40일)은 docs/data.md와 docs/security/data-classification.md에서 읽는다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'tools', 'local', 'access-log-jobs.mjs');

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function bodyOf(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 가짜 ClickHouse: system.parts 목록, ALTER DROP 기록, 관리 계정 줄 응답을 한 곳에서 처리한다. */
async function fakeClickHouse({ partitions = [], adminRows = [], failDrop = null, countRows = 0 } = {}) {
  const queries = [];
  const h = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await bodyOf(req);
    const q = url.searchParams.get('query') ?? raw;
    queries.push(q);
    if (q.includes('system.parts') || q.includes('system.partitions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: partitions.map((p) => (typeof p === 'string' ? { partition: p.replaceAll('-', ''), table: 'access_log' } : p)) }));
      return;
    }
    if (q.includes('is_admin')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: adminRows }));
      return;
    }
    if (q.includes('DROP PARTITION')) {
      if (failDrop && q.includes(failDrop)) {
        res.writeHead(500);
        res.end('drop failed');
        return;
      }
      res.writeHead(200);
      res.end('');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(String(countRows));
  });
  return { ...h, queries };
}

async function fakeAudit({ fail = false } = {}) {
  const posts = [];
  const h = await listen(async (req, res) => {
    const body = await bodyOf(req);
    if (fail) {
      res.writeHead(500);
      res.end('audit down');
      return;
    }
    posts.push(JSON.parse(body));
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, seq: posts.length }));
  });
  return { ...h, posts };
}

test('[ASVS v5.0.0-14.2.4] 파기 실행기는 만료 파티션만 지우고 계획·결과를 남긴다', async () => {
  const ch = await fakeClickHouse({
    partitions: [
      { partition: '20260822', table: 'access_log' },
      { partition: '20260823', table: 'access_log' },
      { partition: '20260824', table: 'access_log' },
    ],
    countRows: 7,
  });
  const audit = await fakeAudit();
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch.base, '--ops-audit', audit.base]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const drops = ch.queries.filter((q) => q.includes('DROP PARTITION'));
    assert.equal(drops.length, 2, drops.join('\n'));
    assert.ok(drops.every((q) => q.includes('20260822') || q.includes('20260823')));
    assert.ok(drops.every((q) => !q.includes('20260824')));
    const states = audit.posts.map((p) => `${p.recordType}:${p.payload?.state}:${p.payload?.day}`).sort();
    assert.deepEqual(states, [
      'ACCESS_LOG_PARTITION_PURGE:DROPPED:2026-08-22',
      'ACCESS_LOG_PARTITION_PURGE:DROPPED:2026-08-23',
      'ACCESS_LOG_PARTITION_PURGE:PLANNED:2026-08-22',
      'ACCESS_LOG_PARTITION_PURGE:PLANNED:2026-08-23',
    ]);
    const out = JSON.parse(r.out.trim().split('\n').at(-1));
    assert.equal(out.kind, 'access-log-purge');
    assert.equal(out.dropped.length, 2);
    assert.equal(out.overdue, 0);
  } finally {
    ch.server.close();
    audit.server.close();
  }
});

test('[ASVS v5.0.0-16.4.2] 파기 기록을 받지 못하거나 지우기가 실패하면 지우지 않고 실패로 끝난다', async () => {
  // (가) 감사 접수가 500이면 DROP을 보내지 않는다(닫힘 실패).
  const ch1 = await fakeClickHouse({ partitions: ['2026-08-22'] });
  const audit1 = await fakeAudit({ fail: true });
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch1.base, '--ops-audit', audit1.base]);
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    assert.equal(ch1.queries.filter((q) => q.includes('DROP PARTITION')).length, 0);
  } finally {
    ch1.server.close();
    audit1.server.close();
  }
  // (나) DROP이 실패하면 FAILED 기록을 남기고 종료 1이다.
  const ch2 = await fakeClickHouse({ partitions: ['2026-08-22', '2026-08-23'], failDrop: '20260822' });
  const audit2 = await fakeAudit();
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch2.base, '--ops-audit', audit2.base]);
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    assert.ok(audit2.posts.some((p) => p.payload?.state === 'FAILED' && p.payload?.day === '2026-08-22'), JSON.stringify(audit2.posts));
    assert.ok(audit2.posts.some((p) => p.payload?.state === 'DROPPED' && p.payload?.day === '2026-08-23'), JSON.stringify(audit2.posts));
  } finally {
    ch2.server.close();
    audit2.server.close();
  }
});

test('[ASVS v5.0.0-16.4.3] 관리 계정 줄만 복사하고 2년 보존 끝을 싣는다', async () => {
  const ch = await fakeClickHouse({
    adminRows: [
      { ts: '2026-11-23T12:00:00.000Z', source: 'identity', request_id: 'r-1', event: 'LOGIN', result: 'SUCCESS', provider: 'PASSWORD', factors: ['password', 'totp'], failure: '', client_ip: '203.0.113.7', user_agent: 'UA-1', account_id: '11111111-1111-4111-8111-111111111111', pod: 'identity-1', seq: 1, is_admin: 1 },
      { ts: '2026-11-23T13:00:00.000Z', source: 'gateway', request_id: 'r-2', event: '', result: '', provider: '', factors: [], failure: '', client_ip: '203.0.113.8', user_agent: 'UA-2', account_id: '22222222-2222-4222-8222-222222222222', pod: '', seq: 0, is_admin: 1 },
    ],
  });
  const audit = await fakeAudit();
  try {
    const r = await runCli(['--admin-copy', '--date', '2026-11-23', '--clickhouse', ch.base, '--ops-audit', audit.base]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.ok(ch.queries.some((q) => q.includes('is_admin')), '관리 계정 줄만 고르는 질의가 없다');
    assert.equal(audit.posts.length, 2, JSON.stringify(audit.posts));
    for (const p of audit.posts) {
      assert.equal(p.recordType, 'ADMIN_ACCESS_LOG');
      assert.equal(p.occurredAt, p.payload.accessTs);
      assert.equal(p.payload.retainUntil.slice(0, 4), '2028');
      assert.equal('password' in p.payload, false);
      assert.equal('token' in p.payload, false);
      assert.equal('cookie' in p.payload, false);
      assert.equal('body' in p.payload, false);
    }
    assert.notEqual(audit.posts[0].eventKey, audit.posts[1].eventKey);
    const out = JSON.parse(r.out.trim().split('\n').at(-1));
    assert.equal(out.kind, 'access-log-admin-copy');
    assert.equal(out.copied, 2);
  } finally {
    ch.server.close();
    audit.server.close();
  }
});

test('[ASVS v5.0.0-14.2.4] 복원하면 스냅샷 뒤 파기 기록의 날짜만 다시 지운다', async () => {
  const ch = await fakeClickHouse({ partitions: ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'] });
  const audit = await fakeAudit();
  const dir = mkdtempSync(join(tmpdir(), 'peaket-purge-records-'));
  const purges = join(dir, 'purges.jsonl');
  writeFileSync(
    purges,
    [
      { day: '2026-11-23', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-23T20:00:00.000Z' },
      { day: '2026-11-24', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-24T20:00:00.000Z' },
      { day: '2026-11-25', table: 'access_log_otel', state: 'DROPPED', executedAt: '2026-11-25T20:00:00.000Z' },
      { day: '2026-11-22', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-22T20:00:00.000Z' },
      { day: '2026-11-26', table: 'access_log', state: 'PLANNED', executedAt: '2026-11-26T20:00:00.000Z' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );
  try {
    const r = await runCli(['--reapply', '--snapshot-at', '2026-11-24T00:00:00.000Z', '--purges', purges, '--clickhouse', ch.base, '--ops-audit', audit.base]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const drops = ch.queries.filter((q) => q.includes('DROP PARTITION'));
    assert.equal(drops.length, 2, drops.join('\n'));
    assert.ok(drops.some((q) => q.includes('20261124')));
    assert.ok(drops.some((q) => q.includes('20261125')));
    assert.ok(drops.every((q) => !q.includes('20261123')));
    assert.equal(JSON.parse(r.out.trim().split('\n').at(-1)).reapplied.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    ch.server.close();
    audit.server.close();
  }
});
