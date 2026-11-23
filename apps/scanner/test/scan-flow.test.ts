// F-05-4 판정 → 기기 일련번호 → 스캔 큐 → 입장 상태의 차례 시험(계획 docs/review/plans/F-05-4.md §4 scan-flow.ts·§6 '쓰는 차례·되돌림').
// 정본: docs/features/offline-gate.md §6.4 '스캐너 앱 판정 첫 구현'(쓰는 차례, 큐 실패면 다시 찍기, 같은 QR 3초)·§6.5(기록 칸, scannerSessionId = 토큰 sid,
// knownSeq·versionVector·clockOffsetMs), openapi ScanEvent. 큐·저장소는 진짜 메모리 어댑터(MemoryScanQueue·MemoryPackageStore)를 쓰고,
// 큐 쓰기를 붙잡거나 실패시킬 때만 ScanQueue 포트를 구현한 시험 큐를 쓴다(장애 주입).
// 새 모듈은 동적 불러오기로 읽는다: 모듈이 없으면 각 시험이 '함수가 있다'는 단언에서 떨어진다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScannerChangesResponse } from '../src/api/client.ts';
import type { PackageStore } from '../src/storage/package-store.ts';
import type { EntryState, PackageState, Placement } from '../src/storage/package-state.ts';
import { MemoryScanQueue, type ScanQueue, type ScanQueueRecord } from '../src/storage/scan-queue.ts';
import { deferred, DEVICE, EVENT, OTHER_DEVICE, pageOf, QR_MS, QR_SEC, qrText, SESSION, stateOf, ticketOf, vectorOf, walletKey } from './scanner-fixture.ts';

type Outcome = Record<string, unknown> & { result: string };
type FlowModule = {
  uuidV7(nowMs: number, random?: (n: number) => Uint8Array): string;
  scannerSessionIdOf(token: string): string | undefined;
  scanEventOf(i: { id: string; outcome: Outcome; state: PackageState; deviceSeq: number; scannerSessionId: string; nowMs: number; clockOffsetMs: number }): Record<string, unknown>;
  runScan(d: {
    raw: string;
    state: PackageState;
    store: PackageStore;
    queue: ScanQueue;
    nowMs: number;
    clockOffsetMs: number;
    scannerSessionId: string;
    id?: () => string;
  }): Promise<{ outcome: Outcome; state: PackageState; recorded: boolean; persisted: boolean }>;
  createSameQrFilter(windowMs?: number): (raw: string, nowMs: number) => boolean;
};
type StoreModule = { MemoryPackageStore: new () => PackageStore };
type StateModule = { applyChangePage(state: PackageState, page: ScannerChangesResponse, deviceId: string): PackageState };
const FLOW = '../src/judge/scan-flow.ts';
const STORE = '../src/storage/package-store.ts';
const STATE = '../src/storage/package-state.ts';
const flowLoaded = (await import(FLOW).catch(() => ({}))) as Partial<FlowModule>;
const storeLoaded = (await import(STORE).catch(() => ({}))) as Partial<StoreModule>;
const stateLoaded = (await import(STATE).catch(() => ({}))) as Partial<StateModule>;
function flow(): FlowModule {
  for (const name of ['uuidV7', 'scannerSessionIdOf', 'scanEventOf', 'runScan', 'createSameQrFilter'] as const) assert.equal(typeof flowLoaded[name], 'function', `${FLOW}의 ${name}가 없다`);
  return flowLoaded as FlowModule;
}
async function newStore(state?: PackageState): Promise<PackageStore> {
  assert.equal(typeof storeLoaded.MemoryPackageStore, 'function', `${STORE}의 MemoryPackageStore가 없다`);
  const s = new storeLoaded.MemoryPackageStore!();
  if (state) await s.save(state);
  return s;
}
function applyChangePage(state: PackageState, page: ScannerChangesResponse, deviceId: string): PackageState {
  assert.equal(typeof stateLoaded.applyChangePage, 'function', `${STATE}의 applyChangePage가 없다`);
  return stateLoaded.applyChangePage!(state, page, deviceId);
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T = '0190f3a1-7c2e-7a00-8b2a-6c1d5e730001';
const key = await walletKey();
const raw = await qrText(key, { ticketId: T, timestampSec: QR_SEC });
const iso = (ms: number) => new Date(ms).toISOString();
const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
const payloads = async (q: ScanQueue) => (await q.due(Number.MAX_SAFE_INTEGER, 1000)).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
let idn = 0;
const ids = () => `0190f3a1-7c2e-7f00-8000-${String(++idn).padStart(12, '0')}`;

function baseState(over: { placement?: Placement; reentryAllowed?: boolean; entries?: [string, EntryState][]; lastSeq?: number; vectorSeq?: number; status?: string } = {}): PackageState {
  return stateOf({
    tickets: [ticketOf(T, key, over.status ? { status: over.status } : {})],
    ...(over.placement ? { placement: over.placement } : {}),
    ...(over.reentryAllowed !== undefined ? { reentryAllowed: over.reentryAllowed } : {}),
    ...(over.entries ? { entries: over.entries } : {}),
    lastSeq: over.lastSeq ?? 40,
    versionVector: vectorOf({ seq: over.vectorSeq ?? over.lastSeq ?? 40 }),
  });
}

/** put을 손으로 풀 때까지 붙잡는 큐(쓰기 차례를 보려고) */
class HeldQueue implements ScanQueue {
  readonly inner = new MemoryScanQueue();
  readonly entered = deferred<ScanQueueRecord>();
  readonly release = deferred();
  async put(r: ScanQueueRecord): Promise<void> {
    this.entered.resolve(r);
    await this.release.promise;
    await this.inner.put(r);
  }
  due(nowMs: number, limit: number) {
    return this.inner.due(nowMs, limit);
  }
  ack(id: string) {
    return this.inner.ack(id);
  }
  fail(id: string, next: number) {
    return this.inner.fail(id, next);
  }
  count() {
    return this.inner.count();
  }
}

/** 첫 put만 실패시키는 큐(strict 쓰기 실패 주입) */
class FailOnceQueue implements ScanQueue {
  readonly inner = new MemoryScanQueue();
  readonly attempted: ScanQueueRecord[] = [];
  #failed = false;
  async put(r: ScanQueueRecord): Promise<void> {
    this.attempted.push(r);
    if (!this.#failed) {
      this.#failed = true;
      throw new Error('시험이 넣은 IndexedDB 쓰기 실패');
    }
    await this.inner.put(r);
  }
  due(nowMs: number, limit: number) {
    return this.inner.due(nowMs, limit);
  }
  ack(id: string) {
    return this.inner.ack(id);
  }
  fail(id: string, next: number) {
    return this.inner.fail(id, next);
  }
  count() {
    return this.inner.count();
  }
}

test('GAT-140 uuidV7은 시각 48비트와 판 7·변형 비트를 싣는다(주입한 난수로 정확한 값)', () => {
  const { uuidV7 } = flow();
  const t = 0x0190f3a17c2e;
  assert.equal(uuidV7(t, (n) => new Uint8Array(n)), '0190f3a1-7c2e-7000-8000-000000000000');
  assert.equal(uuidV7(t, (n) => new Uint8Array(n).fill(0xff)), '0190f3a1-7c2e-7fff-bfff-ffffffffffff');
  assert.match(uuidV7(QR_MS), UUID_V7);
  assert.equal(uuidV7(QR_MS).slice(0, 13).replace('-', ''), QR_MS.toString(16).padStart(12, '0'));
});

test('GAT-140 scannerSessionIdOf는 토큰 내용의 sid를 읽고(서명은 보지 않는다), 없거나 깨지면 undefined다', () => {
  const { scannerSessionIdOf } = flow();
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(scannerSessionIdOf(`${part({ alg: 'ES256' })}.${part({ sub: 'acc', sid: SESSION })}.c2ln`), SESSION);
  assert.equal(scannerSessionIdOf(`${part({ alg: 'ES256' })}.${part({ sub: 'acc' })}.c2ln`), undefined);
  assert.equal(scannerSessionIdOf('not-a-jwt'), undefined);
  assert.equal(scannerSessionIdOf(`${part({ alg: 'ES256' })}.%%%.c2ln`), undefined);
  assert.equal(scannerSessionIdOf(`${part({ alg: 'ES256' })}.${part({ sid: 42 })}.c2ln`), undefined);
});

test('GAT-140 통과는 큐 기록(openapi ScanEvent 칸, method QR)을 쓴 뒤 이 기기 입장 상태(LOCAL, 보정 시각)를 바꾸고 저장소에도 남긴다(knownSeq는 lastSeq, versionVector는 저장 벡터 그대로)', async () => {
  // 마지막 반영 번호(40)와 저장 벡터의 seq(47)를 다르게 골라 두 칸을 따로 본다(RV-05)
  const state = baseState({ lastSeq: 40, vectorSeq: 47 });
  const store = await newStore(state);
  const queue = new MemoryScanQueue();
  const now = QR_MS + 2_000;
  const r = await flow().runScan({ raw, state, store, queue, nowMs: now, clockOffsetMs: 400, scannerSessionId: SESSION, id: () => 'id-pass-1' });
  assert.equal(r.recorded, true);
  assert.equal(r.persisted, true);
  assert.equal(r.outcome.result, 'PASS');
  const rows = await queue.due(Number.MAX_SAFE_INTEGER, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 'id-pass-1');
  assert.equal(rows[0]!.attempts, 0);
  assert.deepEqual(JSON.parse(rows[0]!.payload), {
    id: 'id-pass-1',
    eventId: EVENT,
    ticketId: T,
    scannerSessionId: SESSION,
    direction: 'IN',
    method: 'QR',
    result: 'PASS',
    gateZone: '동문',
    keyId: key.keyId,
    qrTimestamp: iso(QR_MS),
    scannedAtDevice: iso(now + 400),
    clockOffsetMs: 400,
    knownSeq: 40,
    deviceSeq: 1,
    versionVector: vectorOf({ seq: 47 }),
  });
  const entry = { lastDirection: 'IN', lastAtMs: now + 400, gateZone: '동문', source: 'LOCAL' };
  assert.deepEqual(r.state.entries.get(T), entry);
  assert.deepEqual((await store.load())!.entries.get(T), entry);
  assert.equal((await store.meta()).deviceSeq, 1);
  assert.equal(state.entries.has(T), false, '넘긴 상태는 그대로다');
});

test('GAT-140 큐 put이 끝나기 전에는 입장 상태가 바뀌지 않고, 끝난 뒤에야 통과가 돌아온다', async () => {
  const state = baseState();
  const store = await newStore(state);
  const queue = new HeldQueue();
  let settled = false;
  const pending = flow()
    .runScan({ raw, state, store, queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids })
    .then((r) => {
      settled = true;
      return r;
    });
  const record = await queue.entered.promise;
  assert.equal(JSON.parse(record.payload).deviceSeq, 1, 'deviceSeq를 먼저 올린 뒤 큐에 쓴다');
  assert.equal((await store.meta()).deviceSeq, 1);
  assert.equal(settled, false, '큐 쓰기가 끝나기 전에 판정이 돌아오지 않는다');
  assert.equal((await store.load())!.entries.has(T), false, '큐 쓰기 전에는 저장된 입장 상태가 그대로다');
  queue.release.resolve();
  const r = await pending;
  assert.equal(r.outcome.result, 'PASS');
  assert.equal((await store.load())!.entries.get(T)!.source, 'LOCAL');
});

test('GAT-140 큐 쓰기가 실패하면 다시 찍기(RETRY)·기록 안 됨·입장 상태 그대로이고, 다음 판정의 deviceSeq는 실패한 번호보다 크다', async () => {
  const state = baseState();
  const store = await newStore(state);
  const queue = new FailOnceQueue();
  const first = await flow().runScan({ raw, state, store, queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.deepEqual(first.outcome, { result: 'RETRY' });
  assert.equal(first.recorded, false);
  assert.deepEqual(first.state, state);
  assert.equal((await store.load())!.entries.has(T), false);
  assert.equal(await queue.count(), 0);
  const failedSeq = JSON.parse(queue.attempted[0]!.payload).deviceSeq as number;
  const second = await flow().runScan({ raw, state: first.state, store, queue, nowMs: QR_MS + 5_000, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.equal(second.outcome.result, 'PASS');
  assert.equal(second.recorded, true);
  const [p] = await payloads(queue);
  assert.ok((p!.deviceSeq as number) > failedSeq, `다음 deviceSeq ${p!.deviceSeq} > 실패 ${failedSeq}`);
});

test('GAT-140 판정이 다시 찍기(RETRY)면 큐에 쓰지 않고 입장 상태도 그대로다', async () => {
  const state = baseState({ status: 'SOMETHING_NEW' });
  const store = await newStore(state);
  const queue = new MemoryScanQueue();
  const r = await flow().runScan({ raw, state, store, queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.deepEqual(r.outcome, { result: 'RETRY' });
  assert.equal(r.recorded, false);
  assert.equal(await queue.count(), 0);
  assert.deepEqual(r.state, state);
});

test('O-T9 확인 필요(NO_EXIT_RECORD)는 기록하되 입장 상태를 바꾸지 않는다', async () => {
  const prior: EntryState = { lastDirection: 'IN', lastAtMs: QR_MS - 60_000, gateZone: '동문', source: 'CHANGES' };
  const state = baseState({ reentryAllowed: true, entries: [[T, prior]] });
  const store = await newStore(state);
  const queue = new MemoryScanQueue();
  const r = await flow().runScan({ raw, state, store, queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.equal(r.outcome.result, 'CHECK');
  assert.equal(r.recorded, true);
  const [p] = await payloads(queue);
  assert.deepEqual([p!.result, p!.reason, p!.direction], ['CHECK', 'NO_EXIT_RECORD', 'IN']);
  assert.deepEqual(r.state.entries.get(T), prior);
});

test('O-T5 기기 시계 +60,000ms에 오차 −60,000ms면 통과(보정 시각 = QR 시각)이고, 오차 0이면 QR_EXPIRED 거부가 clockOffsetMs 0으로 큐에 남는다', async () => {
  const state = baseState();
  const okQueue = new MemoryScanQueue();
  const ok = await flow().runScan({ raw, state, store: await newStore(state), queue: okQueue, nowMs: QR_MS + 60_000, clockOffsetMs: -60_000, scannerSessionId: SESSION, id: ids });
  assert.equal(ok.outcome.result, 'PASS');
  const [okP] = await payloads(okQueue);
  assert.deepEqual([okP!.clockOffsetMs, okP!.scannedAtDevice], [-60_000, iso(QR_MS)]);

  const badQueue = new MemoryScanQueue();
  const bad = await flow().runScan({ raw, state, store: await newStore(state), queue: badQueue, nowMs: QR_MS + 60_000, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.equal(bad.recorded, true);
  const [p] = await payloads(badQueue);
  assert.deepEqual(
    { result: p!.result, reason: p!.reason, clockOffsetMs: p!.clockOffsetMs, scannedAtDevice: p!.scannedAtDevice, qrTimestamp: p!.qrTimestamp, ticketId: p!.ticketId },
    { result: 'REJECT', reason: 'QR_EXPIRED', clockOffsetMs: 0, scannedAtDevice: iso(QR_MS + 60_000), qrTimestamp: iso(QR_MS), ticketId: T },
  );
  assert.equal(bad.state.entries.has(T), false);
});

/** 기기 저장소 장애 주입: MemoryPackageStore를 감싸 nextDeviceSeq·save를 정한 만큼 실패시킨다(PackageStore 포트 그대로) */
class FaultyStore implements PackageStore {
  readonly inner: PackageStore;
  failSeq = 0;
  failSave = 0;
  saves = 0;
  constructor(inner: PackageStore) {
    this.inner = inner;
  }
  load() {
    return this.inner.load();
  }
  async save(s: PackageState) {
    this.saves++;
    if (this.failSave > 0) {
      this.failSave--;
      throw new Error('시험이 넣은 기기 저장소 저장 실패');
    }
    return this.inner.save(s);
  }
  async nextDeviceSeq() {
    if (this.failSeq > 0) {
      this.failSeq--;
      throw new Error('시험이 넣은 deviceSeq 저장 실패');
    }
    return this.inner.nextDeviceSeq();
  }
  meta() {
    return this.inner.meta();
  }
  setMeta(p: Parameters<PackageStore['setMeta']>[0]) {
    return this.inner.setMeta(p);
  }
  clear() {
    return this.inner.clear();
  }
}

test('GAT-140 1단계 거부(풀리지 않는 글·지원하지 않는 형식 버전)는 판정 화면만 보이고 큐에 쓰지 않는다', async () => {
  const state = baseState();
  const store = await newStore(state);
  const queue = new MemoryScanQueue();
  const v2 = await qrText(key, { ticketId: T, timestampSec: QR_SEC, version: 2 });
  for (const [input, reason] of [
    ['not#base45', 'INVALID_QR'],
    [v2, 'UNSUPPORTED_VERSION'],
  ] as const) {
    const r = await flow().runScan({ raw: input, state, store, queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
    assert.deepEqual([r.outcome.result, r.outcome.reason, r.recorded], ['REJECT', reason, false], reason);
    assert.deepEqual(r.state, state, reason);
  }
  assert.equal(await queue.count(), 0);
  // 2단계 이후 거부는 기록한다(예외는 1단계뿐)
  const unknown = await flow().runScan({ raw: await qrText(key, { ticketId: '0190f3a1-7c2e-7a00-8b2a-6c1d5e73ffff', timestampSec: QR_SEC }), state, store, queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.deepEqual([unknown.outcome.reason, unknown.recorded], ['UNKNOWN_TICKET', true]);
  assert.equal(await queue.count(), 1);
});

test('GAT-140 기기 저장소 장애: deviceSeq를 올리지 못하면 다시 찍기(RETRY)·큐 0건·입장 상태 그대로다', async () => {
  const state = baseState();
  const store = new FaultyStore(await newStore(state));
  store.failSeq = 1;
  const queue = new MemoryScanQueue();
  const r = await flow().runScan({ raw, state, store, queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.deepEqual(r.outcome, { result: 'RETRY' });
  assert.equal(r.recorded, false);
  assert.equal(await queue.count(), 0);
  assert.deepEqual(r.state, state);
  assert.equal((await store.load())!.entries.has(T), false);
});

test('GAT-140 기기 저장소 장애: 큐 쓰기 뒤 저장이 실패하면 통과·기록 참·persisted 거짓이고, 돌려준 상태의 입장 상태가 다음 저장에 함께 들어간다', async () => {
  const T2 = '0190f3a1-7c2e-7a00-8b2a-6c1d5e730002';
  const state = stateOf({ tickets: [ticketOf(T, key), ticketOf(T2, key)], lastSeq: 40, versionVector: vectorOf({ seq: 40 }) });
  const store = new FaultyStore(await newStore(state));
  store.failSave = 1;
  const queue = new MemoryScanQueue();
  let first: Awaited<ReturnType<FlowModule['runScan']>> | undefined;
  await assert.doesNotReject(async () => {
    first = await flow().runScan({ raw, state, store, queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  }, 'runScan은 던지지 않는다');
  assert.deepEqual([first!.outcome.result, first!.recorded, first!.persisted], ['PASS', true, false]);
  assert.ok(store.saves >= 1, '저장을 실제로 시도했다(장애가 닿았다)');
  assert.equal(await queue.count(), 1);
  assert.equal(first!.state.entries.get(T)!.source, 'LOCAL', '돌려준 상태에는 입장 상태가 있다');
  assert.equal((await store.load())!.entries.has(T), false, '저장소에는 아직 없다');
  const second = await flow().runScan({ raw: await qrText(key, { ticketId: T2, timestampSec: QR_SEC }), state: first!.state, store, queue, nowMs: QR_MS + 1_000, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.deepEqual([second.outcome.result, second.persisted], ['PASS', true]);
  const saved = await store.load();
  assert.deepEqual([saved!.entries.get(T)?.lastDirection, saved!.entries.get(T2)?.lastDirection], ['IN', 'IN']);
});

test('GAT-140 scanEventOf의 구역은 기기 배치 구역이고 거부 사유를 싣는다(다른 게이트 티켓)', () => {
  const state = baseState({ placement: { gateZone: '동문', mode: 'IN', version: 2 }, lastSeq: 55 });
  const body = flow().scanEventOf({
    id: 'id-wz',
    outcome: { result: 'REJECT', reason: 'WRONG_ZONE', direction: 'IN', ticketId: T, keyId: key.keyId, qrTimestampMs: QR_MS, ticketGateZone: '서문' },
    state,
    deviceSeq: 9,
    scannerSessionId: SESSION,
    nowMs: QR_MS + 1_000,
    clockOffsetMs: -250,
  });
  assert.deepEqual(plain(body), {
    id: 'id-wz',
    eventId: EVENT,
    ticketId: T,
    scannerSessionId: SESSION,
    direction: 'IN',
    method: 'QR',
    result: 'REJECT',
    reason: 'WRONG_ZONE',
    gateZone: '동문',
    keyId: key.keyId,
    qrTimestamp: iso(QR_MS),
    scannedAtDevice: iso(QR_MS + 750),
    clockOffsetMs: -250,
    knownSeq: 55,
    deviceSeq: 9,
    versionVector: vectorOf({ seq: 55 }),
  });
});

test('GAT-140 id를 주지 않으면 기록 ID는 UUIDv7이다', async () => {
  const state = baseState();
  const queue = new MemoryScanQueue();
  await flow().runScan({ raw, state, store: await newStore(state), queue, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION });
  const [row] = await queue.due(Number.MAX_SAFE_INTEGER, 10);
  assert.match(row!.id, UUID_V7);
  assert.equal(JSON.parse(row!.payload).id, row!.id);
});

test('GAT-140 같은 QR 글자는 판정 뒤 2,999ms에는 버리고 3,000ms에는 다시 판정한다(다른 글자는 바로 판정)', () => {
  const { createSameQrFilter } = flow();
  const drop = createSameQrFilter();
  assert.equal(drop('QR-A', 10_000), false);
  assert.equal(drop('QR-A', 12_999), true);
  assert.equal(drop('QR-B', 12_999), false);
  assert.equal(drop('QR-A', 13_000), false);
  assert.equal(drop('QR-A', 15_999), true, '다시 판정한 때부터 3초');
  const short = createSameQrFilter(500);
  assert.equal(short('QR-A', 0), false);
  assert.equal(short('QR-A', 499), true);
  assert.equal(short('QR-A', 500), false);
});

test('O-T24 기기 X(퇴장 모드)가 통과(OUT)시킨 기록을 SCAN_STATE로 반영한 기기 Y(입장 모드)는 같은 티켓을 통과(IN)시킨다', async () => {
  const inBefore: EntryState = { lastDirection: 'IN', lastAtMs: QR_MS - 600_000, gateZone: '동문', source: 'CHANGES' };
  const stateX = baseState({ reentryAllowed: true, placement: { gateZone: '동문', mode: 'OUT', version: 3 }, entries: [[T, inBefore]] });
  const qx = new MemoryScanQueue();
  const x = await flow().runScan({ raw, state: stateX, store: await newStore(stateX), queue: qx, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.equal(x.outcome.result, 'PASS');
  const [px] = await payloads(qx);
  assert.equal(px!.direction, 'OUT');
  assert.deepEqual(x.state.entries.get(T), { lastDirection: 'OUT', lastAtMs: QR_MS, gateZone: '동문', source: 'LOCAL' });

  const stateY = baseState({ reentryAllowed: true, entries: [[T, inBefore]] });
  const yAfter = applyChangePage(stateY, pageOf([{ seq: 41, kind: 'SCAN_STATE', payload: { v: 1, ticketId: T, direction: px!.direction, scannedAtDevice: px!.scannedAtDevice, gateZone: px!.gateZone, deviceId: OTHER_DEVICE } }]), DEVICE);
  const raw2 = await qrText(key, { ticketId: T, timestampSec: QR_SEC + 20 });
  const qy = new MemoryScanQueue();
  const y = await flow().runScan({ raw: raw2, state: yAfter, store: await newStore(yAfter), queue: qy, nowMs: QR_MS + 20_000, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids });
  assert.deepEqual([y.outcome.result, y.outcome.direction], ['PASS', 'IN']);
});

test('GAT-160 두 기기가 같은 티켓을 오프라인으로 통과시키면 기록마다 그 기기의 knownSeq·deviceSeq·버전 벡터가 실린다 [ASVS v5.0.0-2.3.4]', async () => {
  const stateA = baseState({ lastSeq: 40 });
  const stateB = baseState({ lastSeq: 37 });
  const storeA = await newStore(stateA);
  const storeB = await newStore(stateB);
  await storeB.nextDeviceSeq();
  await storeB.nextDeviceSeq();
  const qa = new MemoryScanQueue();
  const qb = new MemoryScanQueue();
  const [a, b] = await Promise.all([
    flow().runScan({ raw, state: stateA, store: storeA, queue: qa, nowMs: QR_MS, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids }),
    flow().runScan({ raw, state: stateB, store: storeB, queue: qb, nowMs: QR_MS + 1_000, clockOffsetMs: 0, scannerSessionId: SESSION, id: ids }),
  ]);
  assert.deepEqual([a.outcome.result, b.outcome.result], ['PASS', 'PASS'], '오프라인 두 기기는 서로를 모른다');
  const [pa] = await payloads(qa);
  const [pb] = await payloads(qb);
  assert.deepEqual([pa!.knownSeq, pa!.deviceSeq, pa!.versionVector], [40, 1, vectorOf({ seq: 40 })]);
  assert.deepEqual([pb!.knownSeq, pb!.deviceSeq, pb!.versionVector], [37, 3, vectorOf({ seq: 37 })]);
  assert.notEqual(pa!.id, pb!.id);
});
