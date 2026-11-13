// 스캔 큐 저장소 시험(BUILD_ORDER GAT-150, docs/frontend.md §3.8). IndexedDB가 없는 시험 환경은 메모리 어댑터로 계약을 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  IndexedDbScanQueue,
  MemoryScanQueue,
  openScanQueue,
  SCAN_QUEUE_DB_NAME,
  SCAN_QUEUE_INDEX,
  SCAN_QUEUE_STORE,
  SCAN_QUEUE_TX_OPTIONS,
  type ScanQueueRecord,
} from '../src/storage/scan-queue.ts';

const row = (id: string, nextAttemptAtMs: number, scannedAtMs = nextAttemptAtMs): ScanQueueRecord => ({
  id,
  eventId: '01900000-0000-7000-8000-000000000001',
  ticketId: `01900000-0000-7000-8000-${id.padStart(12, '0')}`,
  keyId: 'AAAAAAAAAAA',
  scannedAtMs,
  payload: JSON.stringify({ id }),
  attempts: 0,
  nextAttemptAtMs,
});

test('GAT-150 스캔 큐는 DB 이름·저장소·차례 인덱스를 정본과 맞춘다', () => {
  assert.equal(SCAN_QUEUE_DB_NAME, 'peaket-scanner-queue');
  assert.equal(SCAN_QUEUE_STORE, 'scanQueue');
  assert.equal(SCAN_QUEUE_INDEX, 'nextAttemptAtMs');
  assert.equal(typeof IndexedDbScanQueue.open, 'function');
});

test('GAT-150 쓰기 트랜잭션은 모두 strict이고 put은 complete를 기다린다', () => {
  assert.equal(SCAN_QUEUE_TX_OPTIONS.durability, 'strict');
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'storage', 'scan-queue.ts'), 'utf8');
  const readwrite = source.match(/this\.#db\.transaction\(SCAN_QUEUE_STORE, 'readwrite', ([^)]*)\)/g) ?? [];
  assert.equal(readwrite.length, 3);
  for (const call of readwrite) assert.match(call, /SCAN_QUEUE_TX_OPTIONS/);
  assert.doesNotMatch(source, /durability: 'relaxed'/);
  const put = source.slice(source.indexOf('async put('), source.indexOf('async due('));
  assert.match(put, /await transactionDone\(tx\)/);
});

test('GAT-150 put은 기록을 남기고 due는 보낼 때가 된 것만 차례대로 limit개 준다', async () => {
  const q = new MemoryScanQueue();
  await q.put(row('3', 300, 300));
  await q.put(row('1', 100, 100));
  await q.put(row('2', 200, 200));
  assert.equal(await q.count(), 3);
  assert.deepEqual((await q.due(150, 10)).map((r) => r.id), ['1']);
  assert.deepEqual((await q.due(300, 2)).map((r) => r.id), ['1', '2']);
  assert.deepEqual((await q.due(300, 10)).map((r) => r.id), ['1', '2', '3']);
});

test('GAT-150 ack는 지우고 fail은 attempts를 올려 다음 시각으로 미룬다', async () => {
  const q = new MemoryScanQueue();
  await q.put(row('1', 100));
  await q.fail('1', 900);
  assert.deepEqual((await q.due(800, 10)).map((r) => r.id), []);
  const [later] = await q.due(900, 10);
  assert.equal(later?.attempts, 1);
  await q.ack('1');
  assert.equal(await q.count(), 0);
  // 없는 기록의 ack·fail은 조용히 넘어간다(업로드 중복·다시 보내기)
  await q.ack('nope');
  await q.fail('nope', 1);
});

test('GAT-150 limit이 1 이상 정수가 아니면 거절한다', async () => {
  const q = new MemoryScanQueue();
  await assert.rejects(() => q.due(1, 0), RangeError);
  await assert.rejects(() => q.due(1, 1.5), RangeError);
});

test('GAT-150 IndexedDB가 없는 시험 환경은 메모리 큐로 떨어진다', async () => {
  const q = await openScanQueue();
  assert.equal(q instanceof MemoryScanQueue, true);
  await q.put(row('1', 0));
  assert.equal(await q.count(), 1);
});

test('GAT-150 브라우저에서 IndexedDB가 없으면 메모리로 숨기지 않고 거절한다', async () => {
  const g = globalThis as { window?: unknown; indexedDB?: unknown };
  const hadWindow = Object.hasOwn(g, 'window');
  const hadIndexedDB = Object.hasOwn(g, 'indexedDB');
  const prevWindow = g.window;
  const prevIndexedDB = g.indexedDB;
  try {
    g.window = {};
    delete g.indexedDB;
    await assert.rejects(() => openScanQueue(), /IndexedDB/);
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadIndexedDB) g.indexedDB = prevIndexedDB;
    else delete g.indexedDB;
  }
});

test('GAT-150 스캔 큐 DB를 열지 못하면 메모리로 숨기지 않고 오류를 낸다', async () => {
  const g = globalThis as { window?: unknown; indexedDB?: unknown };
  const hadWindow = Object.hasOwn(g, 'window');
  const hadIndexedDB = Object.hasOwn(g, 'indexedDB');
  const prevWindow = g.window;
  const prevIndexedDB = g.indexedDB;
  try {
    g.window = {};
    g.indexedDB = {
      open() {
        throw new Error('boom');
      },
    };
    await assert.rejects(() => openScanQueue(), /boom/);
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadIndexedDB) g.indexedDB = prevIndexedDB;
    else delete g.indexedDB;
  }
});
