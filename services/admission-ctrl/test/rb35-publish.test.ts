// 비상 셔플·더 기다리기·다시 공시 뒤의 게시(ADR-0239 결정 10~12·15, Q-T27). 게시 직전에 서명 묶음을 다시 검증한다.
import { createHash } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { combinedKey, drandRoundAfter, drandRoundTimeMs, EMERGENCY_BEACON, merkleRoot, shuffle, sortHashes } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { MemoryBatchStore, MemoryResultFiles, MemoryShuffleRecords } from '../src/modules/batch/adapters/memory-batch-store.js';
import { BEACON_WAIT_LIMIT_MS, PublishBatchResults } from '../src/modules/batch/application/publish-batch-results.js';
import type { ShuffleRecord } from '../src/modules/batch/domain/ports.js';
import { SignedMarkAuth } from '../src/modules/rb35/index.js';
import { emergencyMark, keysOf, operator, recommitMark } from './rb35-support.js';

const E = 'evt-rb35-pub';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const START = Date.parse('2026-11-10T11:00:00Z');
const SEED = Buffer.alloc(32, 3);
const COMMIT = '00'.repeat(32);
const members = ['a', 'b', 'c', 'd'].map(hash);
const a = operator('commander-a');
const b = operator('commander-b');
const OPENS = Date.parse('2026-11-03T03:00:00Z');
const FIX = OPENS + 2_000;
const R0 = drandRoundAfter(FIX);

function world(r: Partial<ShuffleRecord>, o: { beacon?: boolean; seedError?: () => boolean; auth?: boolean; storedOk?: boolean } = {}) {
  const round = r.round ?? R0;
  const clock = fakeClock({ now: drandRoundTimeMs(round) - 1_000 });
  const store = new MemoryBatchStore(clock);
  store.setForTest(E, { startsAtMs: START, opensAtMs: OPENS, members, closed: { first: 11, size: members.length, gen: 1 } });
  const records = new MemoryShuffleRecords();
  records.setForTest(E, 1, { commit: COMMIT, round, sealed: 's', atMs: 0, ...r });
  const beaconValue = Buffer.alloc(32, 9);
  const stored: unknown[][] = [];
  let relayCalls = 0;
  const beacons = {
    round: async () => ((relayCalls += 1), o.beacon === false ? null : { value: beaconValue, signature: 'aa'.repeat(48) }),
    verifyStored: (...args: unknown[]) => (stored.push(args), o.storedOk ?? true),
  };
  const seeds = {
    seed: async () => {
      if (o.seedError?.()) throw new Error('KMS down');
      return SEED;
    },
  };
  const files = new MemoryResultFiles();
  const publish = new PublishBatchResults(store, records, seeds, beacons, files, clock, o.auth === false ? undefined : new SignedMarkAuth(keysOf(a, b)));
  return { clock, store, records, publish, files, round, beaconValue, stored, relayCalls: () => relayCalls };
}

const sorted = sortHashes(members);
const root = merkleRoot(sorted.map((h) => Buffer.from(h, 'hex')));
const emergency = (o: Partial<Parameters<typeof emergencyMark>[0]> = {}) => emergencyMark({ eventId: E, group: 1, commit: COMMIT, round: R0, stop: 'beacon', ops: [a, b], ...o });
const FUTURE = drandRoundAfter(Date.parse('2026-11-03T03:10:00Z'));
const recommit = (round: number, atMs = drandRoundTimeMs(round) - 60_000, o: Partial<Parameters<typeof recommitMark>[0]> = {}) => recommitMark({ eventId: E, group: 1, commit: COMMIT, prev: R0, round, atMs, ops: [a, b], ...o });

describe('비상 셔플 뒤의 게시', () => {
  test('Q-T27 비콘을 기다리지 않고 비콘 자리에 고정값을 넣어 같은 규격으로 섞는다', async () => {
    const { publish, store, records } = world({ emergency: emergency() }, { beacon: false });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED', count: 4 });
    const order = shuffle(sorted, combinedKey(SEED, EMERGENCY_BEACON, root, E));
    expect(order.map((h) => store.resultOf(h)?.value)).toEqual(['11:1', '12:1', '13:1', '14:1']);
    expect((await records.read(E, 1))?.beacon).toBeUndefined();
  });

  test('Q-T27 비상 셔플 구간의 다시 쓰기도 같은 입력을 쓴다', async () => {
    const { publish, store } = world({ emergency: emergency() }, { beacon: false });
    await publish.run({ eventId: E });
    const before = sorted.map((h) => store.resultOf(h)?.value);
    store.repairForTest(E, 1, 99);
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'REPAIRED', count: 4 });
    expect(sorted.map((h) => store.resultOf(h)?.value)).toEqual(before);
  });

  test('Q-T27 비상 셔플이어도 공시한 머클 루트와 목록이 다르면 멈춘다(members_changed)', async () => {
    const { publish, store } = world({ emergency: emergency() }, { beacon: false });
    await store.markRoot(E, 1, 'ff'.repeat(32));
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'members_changed' });
  });

  test('Q-T27 비상 표시가 있어도 뒤에 선 멈춤은 게시를 막는다', async () => {
    const { publish, store } = world({ emergency: emergency(), stopped: { reason: 'members_changed', atMs: 5 } }, { beacon: false });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'members_changed', first: false });
    expect(store.publishedForTest(E)).toBeNull();
  });

  test('Q-T27 비상 셔플 표시는 라운드 검사를 건너뛴다', async () => {
    const stale = drandRoundAfter(Date.parse('2026-11-03T04:00:00Z'));
    const { publish } = world({ round: stale, emergency: emergency({ round: stale }) }, { beacon: false });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
  });

  test('Q-T27 서명이 만료된 뒤라도 저장된 묶음의 서명이 맞으면 게시한다(만료는 적용 때만 본다)', async () => {
    const { publish, clock } = world({ emergency: emergency() }, { beacon: false });
    clock.advance(30 * 86_400_000);
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
  });
});

describe('서명 없는 표시는 멈춘다(ADR-0239 결정 15)', () => {
  const stopped = { status: 'BEACON_STOPPED', reason: 'unauthorized', first: true };
  const noResults = (store: MemoryBatchStore) => expect(sorted.map((h) => store.resultOf(h))).toEqual(sorted.map(() => null));

  test.each([
    ['서명이 없는 값', () => ({ atMs: 5, stopReason: 'beacon' as const, reason: 'x', signed: {} })],
    ['commander 한 명', () => emergency({ ops: [a] })],
    ['같은 commander 둘', () => emergency({ ops: [a, a] })],
    ['다른 키로 서명', () => emergency({ ops: [a, operator('commander-b')] })],
    ['다른 회차의 묶음', () => emergency({ eventId: 'evt-other' })],
    ['다른 구간의 묶음', () => emergency({ group: 'lobby' })],
    ['다른 커밋의 묶음', () => emergency({ commit: 'b'.repeat(64) })],
    ['다른 라운드의 묶음', () => emergency({ round: R0 + 1 })],
    ['표시의 멈춘 이유가 묶음과 다름', () => ({ ...emergency(), stopReason: 'late_root' as const })],
    ['비콘 지연이 아닌 이유로 서명한 묶음(stale_round)', () => emergency({ stop: 'stale_round' })],
    ['비콘 지연이 아닌 이유로 서명한 묶음(late_commit)', () => emergency({ stop: 'late_commit' })],
    ['표시의 사유가 묶음과 다름', () => ({ ...emergency(), reason: '다른 사유' })],
  ])('Q-T27 %s의 비상 표시는 멈춘다', async (_n, mark) => {
    const { publish, store, files } = world({ emergency: mark() }, { beacon: true });
    expect(await publish.run({ eventId: E })).toEqual(stopped);
    noResults(store);
    expect(files.written(E).size).toBe(0);
  });

  test.each([
    ['서명이 없는 값', () => [{ atMs: 0, prev: R0, round: FUTURE, reason: 'x', signed: {} }]],
    ['commander 한 명', () => [recommit(FUTURE, undefined, { ops: [a] })]],
    ['다른 커밋의 묶음', () => [recommit(FUTURE, undefined, { commit: 'b'.repeat(64) })]],
    ['표시의 라운드가 묶음과 다름', () => [{ ...recommit(FUTURE), round: FUTURE + 1 }]],
    ['표시의 이전 라운드가 묶음과 다름', () => [{ ...recommit(FUTURE), prev: R0 + 1 }]],
    ['이력이 이어지지 않음', () => [recommit(FUTURE), recommit(FUTURE + 10, undefined, { prev: FUTURE + 5 })]],
  ])('Q-T27 %s의 다시 공시 표시는 멈춘다', async (_n, marks) => {
    const list = marks();
    const { publish, store } = world({ round: list.at(-1)!.round, recommits: list });
    expect(await publish.run({ eventId: E })).toEqual(stopped);
    noResults(store);
  });

  test('Q-T27 표시 칸의 모양이 틀리면(runbookInvalid) 없는 것으로 치지 않고 멈춘다', async () => {
    const { publish, store } = world({ runbookInvalid: true });
    expect(await publish.run({ eventId: E })).toEqual(stopped);
    noResults(store);
  });

  test('Q-T27 공개키 목록이 없는 환경에서는 표시가 있으면 멈춘다', async () => {
    const { publish } = world({ emergency: emergency() }, { auth: false });
    expect(await publish.run({ eventId: E })).toEqual(stopped);
  });

  test('Q-T27 표시가 없으면 공개키 목록이 없어도 평소대로 게시한다', async () => {
    const { publish } = world({}, { auth: false });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
  });

  test('Q-T27 게시한 구간의 다시 쓰기에 위조 표시가 끼어도 결과를 바꾸지 않는다', async () => {
    const { publish, store, records } = world({});
    await publish.run({ eventId: E });
    const before = sorted.map((h) => store.resultOf(h)?.value);
    const rec = (await records.read(E, 1))!;
    records.setForTest(E, 1, { ...rec, emergency: { atMs: 5, stopReason: 'beacon', reason: 'x', signed: {} } });
    store.repairForTest(E, 1, 99);
    expect(await publish.run({ eventId: E })).toEqual(stopped);
    expect(sorted.map((h) => store.resultOf(h)?.value)).toEqual(before);
  });
});

describe('더 기다리기 뒤의 게시', () => {
  const roundAt = drandRoundTimeMs(R0);

  test('Q-T27 waitUntil 전까지는 멈추지 않고 그 라운드를 기다린다', async () => {
    const until = roundAt + BEACON_WAIT_LIMIT_MS + 60_000;
    const { publish, clock } = world({ waitUntilMs: until }, { beacon: false });
    expect(await publish.run({ eventId: E })).toEqual({ status: 'WAITING_BEACON' });
    clock.advance(until - 1 - clock.now());
    expect(await publish.run({ eventId: E })).toEqual({ status: 'WAITING_BEACON' });
  });

  test('Q-T27 waitUntil이 지나면 다시 멈춘다', async () => {
    const until = roundAt + BEACON_WAIT_LIMIT_MS + 30_000;
    const { publish, clock } = world({ waitUntilMs: until }, { beacon: false });
    expect(await publish.run({ eventId: E })).toEqual({ status: 'WAITING_BEACON' });
    clock.advance(until - clock.now());
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'beacon', first: true });
  });

  test('Q-T27 waitUntil이 라운드 시각 + 60초보다 앞서면 60초가 이긴다', async () => {
    const { publish, clock } = world({ waitUntilMs: 1 }, { beacon: false });
    expect(await publish.run({ eventId: E })).toEqual({ status: 'WAITING_BEACON' });
    clock.advance(roundAt + BEACON_WAIT_LIMIT_MS - 1 - clock.now());
    expect(await publish.run({ eventId: E })).toEqual({ status: 'WAITING_BEACON' });
  });

  test('Q-T27 기다리는 사이에 값이 오면 그 라운드로 게시한다', async () => {
    const { publish, beaconValue, store } = world({ waitUntilMs: roundAt + 1_000_000 });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
    const order = shuffle(sorted, combinedKey(SEED, beaconValue, root, E));
    expect(order.map((h) => store.resultOf(h)?.value)).toEqual(['11:1', '12:1', '13:1', '14:1']);
  });
});

describe('기록한 비콘으로 이어서 게시한다(ADR-0239 결정 12)', () => {
  const BEACON_HEX = '09'.repeat(32);
  const SIG = 'aa'.repeat(48);
  const roundAt = drandRoundTimeMs(R0);
  const orderOf = () => shuffle(sorted, combinedKey(SEED, Buffer.from(BEACON_HEX, 'hex'), root, E));

  test('Q-T27 비콘을 기록했으면 중계를 다시 부르지 않고 그 값을 쓴다', async () => {
    const { publish, store, stored, relayCalls } = world({ beacon: BEACON_HEX, signature: SIG }, { beacon: false });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED', count: 4 });
    expect(relayCalls()).toBe(0);
    expect(stored).toEqual([[E, 1, R0, BEACON_HEX, SIG]]);
    expect(orderOf().map((h) => store.resultOf(h)?.value)).toEqual(['11:1', '12:1', '13:1', '14:1']);
  });

  test('Q-T27 비콘을 기록했으면 중계가 멈추고 상한이 지나도 beacon으로 멈추지 않는다', async () => {
    const { publish, clock } = world({ beacon: BEACON_HEX, signature: SIG }, { beacon: false, seedError: () => true });
    await expect(publish.run({ eventId: E })).rejects.toThrow('KMS down');
    clock.advance(roundAt + BEACON_WAIT_LIMIT_MS - clock.now());
    // 시드를 풀지 못해 멈출 수는 있어도 비콘 때문에 멈추지는 않는다
    expect(await publish.run({ eventId: E })).toEqual({ status: 'BEACON_STOPPED', reason: 'seed_unavailable', first: true });
  });

  test('Q-T27 기록한 서명이 맞지 않으면 쓰지 않고 unauthorized로 멈춘다', async () => {
    const { publish, store, relayCalls } = world({ beacon: BEACON_HEX, signature: SIG }, { storedOk: false });
    expect(await publish.run({ eventId: E })).toEqual({ status: 'BEACON_STOPPED', reason: 'unauthorized', first: true });
    expect(relayCalls()).toBe(0);
    expect(sorted.map((h) => store.resultOf(h))).toEqual(sorted.map(() => null));
  });

  test.each([
    ['서명 없이 비콘 값만', { beacon: BEACON_HEX }],
    ['비콘 값 없이 서명만', { signature: SIG }],
  ])('Q-T27 %s 있으면 unauthorized로 멈춘다', async (_n, r) => {
    const { publish } = world(r);
    expect(await publish.run({ eventId: E })).toEqual({ status: 'BEACON_STOPPED', reason: 'unauthorized', first: true });
  });

  test('Q-T27 게시한 구간의 다시 쓰기도 기록한 비콘을 쓰고 중계를 부르지 않는다', async () => {
    const { publish, store, relayCalls } = world({ beacon: BEACON_HEX, signature: SIG }, { beacon: false });
    await publish.run({ eventId: E });
    const before = sorted.map((h) => store.resultOf(h)?.value);
    store.repairForTest(E, 1, 99);
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'REPAIRED', count: 4 });
    expect(relayCalls()).toBe(0);
    expect(sorted.map((h) => store.resultOf(h)?.value)).toEqual(before);
  });

  test('Q-T27 게시한 구간의 기록한 서명이 맞지 않으면 다시 쓰지 않고 멈춘다', async () => {
    let ok = true;
    const { publish, store, records, clock } = world({ beacon: BEACON_HEX, signature: SIG }, { beacon: false });
    await publish.run({ eventId: E });
    const before = sorted.map((h) => store.resultOf(h)?.value);
    ok = false;
    store.repairForTest(E, 1, 99);
    const p = new PublishBatchResults(store, records, { seed: async () => SEED }, { round: async () => null, verifyStored: () => ok }, new MemoryResultFiles(), clock, new SignedMarkAuth(keysOf(a, b)));
    expect(await p.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'unauthorized' });
    expect(sorted.map((h) => store.resultOf(h)?.value)).toEqual(before);
  });
});

describe('시드를 풀지 못할 때의 상한(M3, ADR-0239 결정 2)', () => {
  const roundAt = drandRoundTimeMs(R0);

  test('Q-T27 비콘이 있어도 Decrypt가 실패하면 상한 전에는 다시 하고, 상한에 닿으면 멈추며 경보를 단다', async () => {
    const { publish, clock } = world({}, { seedError: () => true });
    await expect(publish.run({ eventId: E })).rejects.toThrow('KMS down');
    clock.advance(roundAt + BEACON_WAIT_LIMIT_MS - 1 - clock.now());
    await expect(publish.run({ eventId: E })).rejects.toThrow('KMS down');
    clock.advance(1);
    expect(await publish.run({ eventId: E })).toEqual({ status: 'BEACON_STOPPED', reason: 'seed_unavailable', first: true });
  });

  test('Q-T27 더 기다리기가 있으면 그때까지는 멈추지 않는다', async () => {
    const until = roundAt + BEACON_WAIT_LIMIT_MS + 30_000;
    const { publish, clock } = world({ waitUntilMs: until }, { seedError: () => true });
    await expect(publish.run({ eventId: E })).rejects.toThrow('KMS down');
    clock.advance(until - 1 - clock.now());
    await expect(publish.run({ eventId: E })).rejects.toThrow('KMS down');
    clock.advance(1);
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'seed_unavailable' });
  });

  test('Q-T27 비상 셔플은 허가한 때부터 상한을 잰다', async () => {
    const atMs = roundAt + BEACON_WAIT_LIMIT_MS + 5_000;
    const { publish, clock } = world({ emergency: { ...emergency(), atMs } }, { seedError: () => true, beacon: false });
    clock.advance(atMs + BEACON_WAIT_LIMIT_MS - 1 - clock.now());
    await expect(publish.run({ eventId: E })).rejects.toThrow('KMS down');
    clock.advance(1);
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'seed_unavailable' });
  });

  test('Q-T27 게시한 구간의 다시 쓰기는 멈추지 않고 다시 한다', async () => {
    let fail = false;
    const { publish, store, clock } = world({}, { seedError: () => fail });
    await publish.run({ eventId: E });
    store.repairForTest(E, 1, 99);
    fail = true;
    clock.advance(BEACON_WAIT_LIMIT_MS * 2);
    await expect(publish.run({ eventId: E })).rejects.toThrow('KMS down');
  });
});

describe('비콘 기록의 차례(M1, ADR-0239 결정 12)', () => {
  test('Q-T27 사람별 결과를 쓰기 전에 비콘을 기록한다', async () => {
    const { publish, store, records } = world({});
    const calls: string[] = [];
    const write = store.writeResults.bind(store);
    store.writeResults = async (...args: Parameters<typeof write>) => (calls.push('writeResults'), write(...args));
    const rec = records.recordBeacon.bind(records);
    records.recordBeacon = async (...args: Parameters<typeof rec>) => (calls.push('recordBeacon'), rec(...args));
    await publish.run({ eventId: E });
    expect(calls).toEqual(['recordBeacon', 'writeResults']);
  });

  test('Q-T27 비콘을 기록하지 못했으면(그 사이 라운드가 바뀜) 결과를 쓰지 않고 그만둔다', async () => {
    const { publish, store, records } = world({});
    records.recordBeacon = async () => false;
    expect(await publish.run({ eventId: E })).toEqual({ status: 'ABANDONED' });
    expect(sorted.map((h) => store.resultOf(h))).toEqual(sorted.map(() => null));
  });

  test('Q-T27 들고 있던 결과는 라운드가 바뀌면 쓰지 않고 다시 만든다', async () => {
    let fail = true;
    const { store, records, clock, round } = world({});
    const files = { write: async () => { if (fail) throw new Error('S3 down'); } };
    let seedCalls = 0;
    const p = new PublishBatchResults(store, records, { seed: async () => (seedCalls++, SEED) }, { round: async () => ({ value: Buffer.alloc(32, 9), signature: 'aa'.repeat(48) }), verifyStored: () => true }, files, clock, new SignedMarkAuth(keysOf(a, b)));
    await expect(p.run({ eventId: E })).rejects.toThrow('S3 down');
    expect(seedCalls).toBe(1);
    const rec = (await records.read(E, 1))!;
    const next = round + 500;
    records.setForTest(E, 1, { commit: rec.commit, sealed: rec.sealed, atMs: rec.atMs, round: next, recommits: [recommit(next, drandRoundTimeMs(next) - 60_000, { prev: round })] });
    fail = false;
    expect(await p.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
    expect(seedCalls).toBe(2);
    expect((await records.read(E, 1))?.round).toBe(next);
  });
});

describe('커밋 다시 공시 뒤의 게시', () => {
  test('Q-T27 다시 공시한 라운드면 stale_round로 멈추지 않는다', async () => {
    const { publish } = world({ round: FUTURE, recommits: [recommit(FUTURE)] });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
  });

  test('Q-T27 다시 공시가 라운드 3초 전보다 늦으면 인정하지 않는다', async () => {
    const { publish } = world({ round: FUTURE, recommits: [recommit(FUTURE, drandRoundTimeMs(FUTURE) - 2_999)] });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'stale_round' });
  });

  test('Q-T27 다시 공시 기록의 마지막 라운드와 공시 라운드가 다르면 stale_round다', async () => {
    const { publish } = world({ round: FUTURE, recommits: [recommit(FUTURE - 5)] });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'stale_round' });
  });

  test('Q-T27 일정의 라운드보다 앞선 라운드는 다시 공시 기록이 있어도 멈춘다', async () => {
    const before = drandRoundAfter(Date.parse('2026-11-03T02:00:00Z'));
    const { publish } = world({ round: before, recommits: [recommit(before, 0)] });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'stale_round' });
  });

  test('Q-T27 기록 없이 라운드가 일정과 다르면 지금처럼 멈춘다', async () => {
    const { publish } = world({ round: FUTURE });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'stale_round' });
  });

  test('Q-T27 늦은 커밋(late_commit)도 커밋 뒤의 라운드로 다시 공시했으면 게시한다', async () => {
    const atMs = drandRoundTimeMs(FUTURE) - 60_000;
    const { publish } = world({ round: FUTURE, atMs, recommits: [recommit(FUTURE)] });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
  });

  test('Q-T27 다시 공시한 라운드가 커밋보다 3초 뒤가 아니면 late_commit이다', async () => {
    const atMs = drandRoundTimeMs(FUTURE) - 2_000;
    const { publish } = world({ round: FUTURE, atMs, recommits: [recommit(FUTURE)] });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'late_commit' });
  });
});
