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
async function fakeClickHouse({ partitions = [], adminRows = [], failDrop = null, missingDrop = null, failQuery = null, countRows = 0, filterAdmin = false } = {}) {
  const queries = [];
  const auths = [];
  const h = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await bodyOf(req);
    const q = url.searchParams.get('query') ?? raw;
    queries.push(q);
    auths.push(req.headers.authorization ?? '');
    if (failQuery) {
      res.writeHead(failQuery);
      res.end(`query failed ${failQuery}`);
      return;
    }
    if (q.includes('system.parts') || q.includes('system.partitions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: partitions.map((p) => (typeof p === 'string' ? { partition: p.replaceAll('-', ''), table: 'access_log' } : p)) }));
      return;
    }
    if (q.includes('is_admin')) {
      let rows = filterAdmin ? adminRows.filter((r) => Number(r.is_admin) === 1) : adminRows;
      // KST 하루 경계 질의를 흉내 낸다(UTC 표의 [전날 15:00, 그날 15:00)).
      const from = /ts >= toDateTime64\('([^']+)'/.exec(q)?.[1];
      const to = /ts < toDateTime64\('([^']+)'/.exec(q)?.[1];
      if (from && to) {
        const f = Date.parse(`${from.replace(' ', 'T')}Z`);
        const t = Date.parse(`${to.replace(' ', 'T')}Z`);
        rows = rows.filter((r) => {
          const at = Date.parse(r.ts);
          return at >= f && at < t;
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: rows }));
      return;
    }
    if (q.includes('DROP PARTITION')) {
      if (missingDrop && q.includes(missingDrop)) {
        res.writeHead(500);
        res.end(`Partition ${missingDrop} doesn't exist`);
        return;
      }
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
  return { ...h, queries, auths };
}

async function fakeAudit({ fail = false, failAfter = null } = {}) {
  const posts = [];
  const h = await listen(async (req, res) => {
    const body = await bodyOf(req);
    if (fail || (failAfter !== null && posts.length >= failAfter)) {
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

test('[ASVS v5.0.0-14.2.4] 파기 실행기는 만료 파티션만 지우고 계획·결과를 상태별로 남긴다', async () => {
  const ch = await fakeClickHouse({
    partitions: [
      { partition: '20260822', table: 'access_log' },
      { partition: '20260823', table: 'access_log' },
      { partition: '20260824', table: 'access_log' },
    ],
    countRows: 7,
  });
  const audit = await fakeAudit();
  const dir = mkdtempSync(join(tmpdir(), 'peaket-purge-metrics-'));
  const metrics = join(dir, 'metrics.txt');
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch.base, '--ops-audit', audit.base, '--metrics', metrics]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const drops = ch.queries.filter((q) => q.includes('DROP PARTITION'));
    assert.equal(drops.length, 2, drops.join('\n'));
    assert.ok(drops.every((q) => q.includes('access_log.access_log')));
    assert.ok(drops.every((q) => q.includes('20260822') || q.includes('20260823')));
    assert.ok(drops.every((q) => !q.includes('20260824')));
    const states = audit.posts.map((p) => `${p.recordType}:${p.payload?.state}:${p.payload?.day}`).sort();
    assert.deepEqual(states, [
      'ACCESS_LOG_PARTITION_PURGE:DROPPED:2026-08-22',
      'ACCESS_LOG_PARTITION_PURGE:DROPPED:2026-08-23',
      'ACCESS_LOG_PARTITION_PURGE:PLANNED:2026-08-22',
      'ACCESS_LOG_PARTITION_PURGE:PLANNED:2026-08-23',
    ]);
    // al_purger는 행 SELECT 권한이 없어 행 수를 셀 수 없다. DROPPED의 rows는 null이다.
    assert.equal(audit.posts.filter((p) => p.payload.state === 'DROPPED').every((p) => p.payload.rows === null), true);
    const out = JSON.parse(r.out.trim().split('\n').at(-1));
    assert.equal(out.kind, 'access-log-purge');
    assert.equal(out.dropped.length, 2);
    assert.equal(out.overdue, 0);
    assert.equal(readFileSync(metrics, 'utf8').includes('access_log_overdue_partitions 0'), true);
    assert.equal(readFileSync(metrics, 'utf8').includes('access_log_purge_last_success_timestamp '), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    ch.server.close();
    audit.server.close();
  }
});

test('[ASVS v5.0.0-14.2.4] 파기는 원천 표 access_log_otel과 계약 표 access_log를 모두 지운다', async () => {
  const ch = await fakeClickHouse({
    partitions: [
      { partition: '20260822', table: 'access_log' },
      { partition: '20260822', table: 'access_log_otel' },
    ],
  });
  const audit = await fakeAudit();
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch.base, '--ops-audit', audit.base]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const drops = ch.queries.filter((q) => q.includes('DROP PARTITION'));
    assert.equal(drops.length, 2, drops.join('\n'));
    assert.ok(drops.some((q) => q.includes('access_log.access_log_otel')));
    assert.ok(drops.some((q) => q.includes('access_log.access_log ')));
    assert.equal(new Set(audit.posts.map((p) => `${p.payload.table}:${p.payload.state}`)).size, 4);
  } finally {
    ch.server.close();
    audit.server.close();
  }
});

test('[ASVS v5.0.0-14.2.4] --max-drop 상한과 파티션 0개(할 일 없음)를 지킨다', async () => {
  const ch1 = await fakeClickHouse({ partitions: ['2026-08-22', '2026-08-23', '2026-08-25'] });
  const audit1 = await fakeAudit();
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch1.base, '--ops-audit', audit1.base, '--max-drop', '1']);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.equal(ch1.queries.filter((q) => q.includes('DROP PARTITION')).length, 1);
    const out = JSON.parse(r.out.trim().split('\n').at(-1));
    assert.equal(out.overdue, 1);
    assert.equal(out.truncated, true);
  } finally {
    ch1.server.close();
    audit1.server.close();
  }
  const ch2 = await fakeClickHouse({ partitions: [] });
  const audit2 = await fakeAudit();
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch2.base, '--ops-audit', audit2.base]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.equal(ch2.queries.filter((q) => q.includes('DROP PARTITION')).length, 0);
    assert.equal(JSON.parse(r.out.trim().split('\n').at(-1)).dropped.length, 0);
  } finally {
    ch2.server.close();
    audit2.server.close();
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
  // (다) 이미 없는 파티션은 DROPPED + reconciled: true이고 종료 0이다.
  const ch3 = await fakeClickHouse({ partitions: ['2026-08-22'], missingDrop: '20260822' });
  const audit3 = await fakeAudit();
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch3.base, '--ops-audit', audit3.base]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const done = audit3.posts.find((p) => p.payload?.state === 'DROPPED' && p.payload?.day === '2026-08-22');
    assert.equal(done?.payload?.reconciled, true, JSON.stringify(audit3.posts));
  } finally {
    ch3.server.close();
    audit3.server.close();
  }
  // (라) ClickHouse 401(자격 실패)은 종료 1이다.
  const ch4 = await fakeClickHouse({ failQuery: 401 });
  const audit4 = await fakeAudit();
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch4.base, '--ops-audit', audit4.base]);
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
  } finally {
    ch4.server.close();
    audit4.server.close();
  }
  // (마) DROP은 성공했는데 DROPPED 감사 접수가 실패하면 종료 1이다.
  const ch5 = await fakeClickHouse({ partitions: ['2026-08-22'] });
  const audit5 = await fakeAudit({ failAfter: 1 });
  try {
    const r = await runCli(['--purge', '--today', '2026-11-24', '--clickhouse', ch5.base, '--ops-audit', audit5.base]);
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    assert.equal(ch5.queries.filter((q) => q.includes('DROP PARTITION')).length, 1);
  } finally {
    ch5.server.close();
    audit5.server.close();
  }
});

test('[ASVS v5.0.0-16.4.3] 관리 계정 줄만 KST 하루로 복사하고 2년 보존 끝을 싣는다', async () => {
  const ch = await fakeClickHouse({
    filterAdmin: true,
    adminRows: [
      { ts: '2026-11-22T14:59:59.000Z', source: 'identity', request_id: 'before', event: 'LOGIN', result: 'SUCCESS', provider: 'PASSWORD', factors: ['password'], failure: '', client_ip: '203.0.113.6', user_agent: 'UA-0', account_id: '00000000-0000-4000-8000-000000000000', pod: 'identity-1', seq: 1, is_admin: 1 },
      { ts: '2026-11-22T15:00:00.000Z', source: 'identity', request_id: 'r-1', event: 'LOGIN', result: 'SUCCESS', provider: 'PASSWORD', factors: ['password', 'totp'], failure: '', client_ip: '203.0.113.7', user_agent: 'UA-1', account_id: '11111111-1111-4111-8111-111111111111', pod: 'identity-1', seq: 2, is_admin: 1 },
      { ts: '2026-11-23T08:59:59.000Z', source: 'gateway', request_id: 'r-2', event: '', result: '', provider: '', factors: [], failure: '', client_ip: '203.0.113.8', user_agent: 'UA-2', account_id: '22222222-2222-4222-8222-222222222222', pod: '', seq: 0, is_admin: 1 },
      { ts: '2026-11-23T15:00:00.000Z', source: 'identity', request_id: 'after', event: 'LOGIN', result: 'SUCCESS', provider: 'PASSWORD', factors: ['password'], failure: '', client_ip: '203.0.113.9', user_agent: 'UA-3', account_id: '33333333-3333-4333-8333-333333333333', pod: 'identity-1', seq: 3, is_admin: 1 },
    ],
  });
  const audit = await fakeAudit();
  try {
    const r = await runCli(['--admin-copy', '--date', '2026-11-23', '--clickhouse', ch.base, '--clickhouse-user', 'al_admin_reader', '--clickhouse-password', 'secret', '--ops-audit', audit.base]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const query = ch.queries.find((q) => q.includes('is_admin = 1'));
    assert.ok(query, 'is_admin = 1 질의가 없다');
    // KST 2026-11-23 00:00~24:00 = UTC 2026-11-22 15:00~2026-11-23 15:00
    assert.ok(query.includes("toDateTime64('2026-11-22 15:00:00'"), query);
    assert.ok(query.includes("toDateTime64('2026-11-23 15:00:00'"), query);
    assert.equal(query.includes("toYYYYMMDD(ts) = toYYYYMMDD(toDate('2026-11-23'))"), false, 'UTC 날짜로 읽고 있다');
    assert.equal(audit.posts.length, 2, JSON.stringify(audit.posts));
    for (const p of audit.posts) {
      assert.equal(p.recordType, 'ADMIN_ACCESS_LOG');
      assert.equal(p.occurredAt, p.payload.accessTs);
      assert.equal(p.payload.retainUntil.slice(0, 4), '2028');
      assert.equal(p.eventKey.split(':')[2], '2026-11-23', `eventKey day가 KST 날짜가 아니다: ${p.eventKey}`);
      assert.deepEqual(Object.keys(p.payload).sort(), ['accessTs', 'adminAccountId', 'clientIp', 'event', 'factors', 'failure', 'pod', 'provider', 'requestId', 'result', 'retainUntil', 'seq', 'source', 'userAgent'].sort());
      for (const forbidden of ['password', 'token', 'cookie', 'body', 'email', 'phone', 'accountEmail']) assert.equal(forbidden in p.payload, false, forbidden);
    }
    assert.equal(audit.posts.some((p) => p.payload.requestId === 'before' || p.payload.requestId === 'after'), false);
    assert.ok(ch.auths.some((a) => a.startsWith('Basic ')), 'ClickHouse 기본 인증을 보내지 않는다');
    assert.equal(JSON.parse(r.out.trim().split('\n').at(-1)).copied, 2);
  } finally {
    ch.server.close();
    audit.server.close();
  }
});

test('[ASVS v5.0.0-14.2.4] 같은 관리 계정 복사를 두 번 해도 eventKey가 같다', async () => {
  const rows = [{ ts: '2026-11-23T12:00:00.000Z', source: 'identity', request_id: 'same', event: 'LOGIN', result: 'SUCCESS', provider: 'PASSWORD', factors: ['password'], failure: '', client_ip: null, user_agent: 'UA', account_id: null, pod: 'identity-1', seq: 1, is_admin: 1 }];
  const ch = await fakeClickHouse({ adminRows: rows, filterAdmin: true });
  const audit = await fakeAudit();
  try {
    const args = ['--admin-copy', '--date', '2026-11-23', '--clickhouse', ch.base, '--ops-audit', audit.base];
    assert.equal((await runCli(args)).code, 0);
    assert.equal((await runCli(args)).code, 0);
    assert.equal(audit.posts.length, 2);
    assert.equal(audit.posts[0].eventKey, audit.posts[1].eventKey);
    assert.equal(audit.posts[0].recordId, audit.posts[1].recordId);
  } finally {
    ch.server.close();
    audit.server.close();
  }
});

test('[ASVS v5.0.0-14.2.4] 복원하면 스냅샷 뒤 파기 기록의 날짜·표가 모두 맞을 때만 다시 지운다', async () => {
  const ch = await fakeClickHouse({
    partitions: [
      { partition: '20261123', table: 'access_log' },
      { partition: '20261124', table: 'access_log' },
      { partition: '20261125', table: 'access_log' },
    ],
  });
  const audit = await fakeAudit();
  const dir = mkdtempSync(join(tmpdir(), 'peaket-purge-records-'));
  const purges = join(dir, 'purges.jsonl');
  writeFileSync(
    purges,
    [
      { day: '2026-11-23', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-23T20:00:00.000Z' },
      { day: '2026-11-24', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-24T20:00:00.000Z' },
      { day: '2026-11-25', table: 'access_log_otel', state: 'DROPPED', executedAt: '2026-11-25T20:00:00.000Z' },
      { day: '2026-11-25', table: 'access_log', state: 'DROPPED', executedAt: '2026-11-25T20:00:00.000Z' },
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
    assert.ok(drops.some((q) => q.includes('access_log.access_log ') && q.includes('20261124')));
    assert.ok(drops.some((q) => q.includes('access_log.access_log ') && q.includes('20261125')));
    assert.ok(drops.every((q) => !q.includes('access_log_otel') && !q.includes('20261123')));
    assert.equal(audit.posts.filter((p) => p.recordType === 'ACCESS_LOG_PARTITION_PURGE').length >= 4, true, JSON.stringify(audit.posts));
    assert.equal(JSON.parse(r.out.trim().split('\n').at(-1)).reapplied.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    ch.server.close();
    audit.server.close();
  }
});

test('[ASVS v5.0.0-14.2.4] 다시 적용의 입력 오류는 2, DROP 부분 실패는 1이다', async () => {
  const ch = await fakeClickHouse({ partitions: ['2026-11-24'] });
  const audit = await fakeAudit();
  try {
    const missing = await runCli(['--reapply', '--snapshot-at', '2026-11-24T00:00:00.000Z', '--purges', join(tmpdir(), 'no-such-purges.jsonl'), '--clickhouse', ch.base, '--ops-audit', audit.base]);
    assert.equal(missing.code, 2, `${missing.out}\n${missing.err}`);
    const dir = mkdtempSync(join(tmpdir(), 'peaket-purge-bad-'));
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, '{not json');
    try {
      const broken = await runCli(['--reapply', '--snapshot-at', '2026-11-24T00:00:00.000Z', '--purges', bad, '--clickhouse', ch.base, '--ops-audit', audit.base]);
      assert.equal(broken.code, 2, `${broken.out}\n${broken.err}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    ch.server.close();
    audit.server.close();
  }
  const ch2 = await fakeClickHouse({ partitions: ['2026-11-24', '2026-11-25'], failDrop: '20261124' });
  const audit2 = await fakeAudit();
  const dir2 = mkdtempSync(join(tmpdir(), 'peaket-purge-partial-'));
  const purges2 = join(dir2, 'purges.jsonl');
  writeFileSync(purges2, ['2026-11-24', '2026-11-25'].map((d) => JSON.stringify({ day: d, table: 'access_log', state: 'DROPPED', executedAt: `${d}T20:00:00.000Z` })).join('\n'));
  try {
    const r = await runCli(['--reapply', '--snapshot-at', '2026-11-23T00:00:00.000Z', '--purges', purges2, '--clickhouse', ch2.base, '--ops-audit', audit2.base]);
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    assert.ok(audit2.posts.some((p) => p.payload?.state === 'FAILED'), JSON.stringify(audit2.posts));
  } finally {
    rmSync(dir2, { recursive: true, force: true });
    ch2.server.close();
    audit2.server.close();
  }
});
