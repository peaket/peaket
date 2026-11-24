// v1 실행의 DB·Valkey 통계 시험(F088-5·F088-6): loadtest/runner/probes.mjs walBytesDelta·parseRedisInfoMemory와 run.mjs --db-stats·--redis-stats 인자.
// 계획 docs/review/plans/F-08-8.md 2절 3 (가)·7.1~7.3. 표본은 fixtures/f08/redis-info-memory.txt(Valkey 8.1 INFO memory 꼴)다.
// 클러스터·Docker를 건드리지 않는다. run.mjs를 띄우는 시험은 인자 오류만 준다.
// 실행: node --test loadtest/test/f088-stats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../runner/args.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUN = join(here, '..', 'run.mjs');
const probes = () => import('../runner/probes.mjs');
const INFO = readFileSync(join(here, 'fixtures', 'f08', 'redis-info-memory.txt'), 'utf8');

// 가정한 꼴(계획 7.2가 인자 모양을 정하지 않았다): walBytesDelta는 pg_stat_wal 한 줄({ wal_bytes })을 전·후로 받는다.
// node-postgres는 numeric을 글자로 돌려주므로 글자와 수를 모두 받는다.
test('F088-5 ① walBytesDelta: pg_stat_wal의 wal_bytes 전후 차이를 정확히 낸다(글자·수 모두)', async () => {
  const { walBytesDelta } = await probes();
  assert.equal(walBytesDelta({ wal_bytes: '16777216' }, { wal_bytes: '50331648' }), 33554432);
  assert.equal(walBytesDelta({ wal_bytes: 1024 }, { wal_bytes: 1024 }), 0);
  // 2^53 가까이 쌓인 값도 차이는 정확하다
  assert.equal(walBytesDelta({ wal_bytes: '9007199254000000' }, { wal_bytes: '9007199254740000' }), 740000);
});

test('F088-5 ② walBytesDelta: 칸이 없거나 숫자가 아니면 null이다(0이 아니다)', async () => {
  const { walBytesDelta } = await probes();
  assert.strictEqual(walBytesDelta({}, { wal_bytes: '100' }), null);
  assert.strictEqual(walBytesDelta({ wal_bytes: '100' }, {}), null);
  assert.strictEqual(walBytesDelta({ wal_bytes: 'abc' }, { wal_bytes: '100' }), null);
  assert.strictEqual(walBytesDelta({ wal_bytes: '100' }, { wal_bytes: null }), null);
});

test('F088-5 ③ walBytesDelta: 전후가 뒤바뀌면(뒤가 작으면) 오류다', async () => {
  const { walBytesDelta } = await probes();
  assert.throws(() => walBytesDelta({ wal_bytes: '50331648' }, { wal_bytes: '16777216' }), RangeError);
});

test('F088-5 ④ parseRedisInfoMemory: used_memory·used_memory_peak·maxmemory를 정확히 읽는다(이름이 앞부분만 같은 _human·_peak_perc 칸을 섞지 않는다, maxmemory 0은 0이다)', async () => {
  const { parseRedisInfoMemory } = await probes();
  const want = { usedMemory: 2318208, usedMemoryPeak: 3523712, maxmemory: 0 };
  const pick = (r) => ({ usedMemory: r.usedMemory, usedMemoryPeak: r.usedMemoryPeak, maxmemory: r.maxmemory });
  assert.deepEqual(pick(parseRedisInfoMemory(INFO)), want);
  // Valkey가 실제로 보내는 줄 끝(CRLF)
  assert.deepEqual(pick(parseRedisInfoMemory(INFO.replace(/\r?\n/g, '\r\n'))), want);
});

test('F088-5 ⑤ parseRedisInfoMemory: 칸이 없거나 숫자가 아니면 그 칸은 null이다(0이 아니다)', async () => {
  const { parseRedisInfoMemory } = await probes();
  const noPeak = INFO.split('\n').filter((l) => !/^used_memory_peak:/.test(l)).join('\n');
  const r1 = parseRedisInfoMemory(noPeak);
  assert.strictEqual(r1.usedMemoryPeak, null);
  assert.equal(r1.usedMemory, 2318208);
  const r2 = parseRedisInfoMemory(INFO.replace('used_memory:2318208', 'used_memory:abc'));
  assert.strictEqual(r2.usedMemory, null);
  const r3 = parseRedisInfoMemory('');
  assert.deepEqual([r3.usedMemory, r3.usedMemoryPeak, r3.maxmemory], [null, null, null]);
});

const QUEUE = ['--users', '1000', '--entry-rate', '1000', '--admit-per-second', '28'];
const SEAT = ['--users', '1000', '--rate', '2000', '--mode', 'hot', '--keep'];
const PAY = ['--users', '9002', '--rate', '100'];

test('F088-6 ① v1 queue·seat-hold·payment는 --db-stats·--redis-stats를 받는다', () => {
  for (const [s, rest] of [['queue', QUEUE], ['seat-hold', SEAT], ['payment', PAY]]) {
    const a = parseArgs(['v1', s, ...rest, '--db-stats', '--redis-stats']);
    assert.equal(a.dbStats, true, `${s} dbStats`);
    assert.equal(a.redisStats, true, `${s} redisStats`);
    const b = parseArgs(['v1', s, ...rest]);
    assert.equal(b.dbStats, false, `${s} 기본 dbStats`);
    assert.equal(b.redisStats, false, `${s} 기본 redisStats`);
  }
});

test('F088-6 ② v0는 --redis-stats를 받지 않는다(UsageError, run.mjs 종료 코드 2)', () => {
  for (const [s, rest] of [['queue', QUEUE], ['seat-hold', ['--users', '1000', '--rate', '200']], ['payment', PAY]]) {
    assert.throws(() => parseArgs(['v0', s, ...rest, '--redis-stats']), (e) => e.name === 'UsageError' && /--redis-stats/.test(e.message), s);
  }
  const dir = mkdtempSync(join(tmpdir(), 'f088-cli-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)));
    env.KUBECONFIG = join(dir, 'none');
    const r = spawnSync(process.execPath, [RUN, 'v0', 'queue', ...QUEUE, '--redis-stats'], { encoding: 'utf8', env, timeout: 60_000, windowsHide: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--redis-stats/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
