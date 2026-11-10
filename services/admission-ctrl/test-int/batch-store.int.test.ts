// 묶음 게시를 실제 Valkey 8.1로 돈다: queue-svc 진입 Lua가 남긴 모양(닫힘 표시·참가자·회차 일정 사본)을 읽고,
// 사람별 결과 q:batch:{해시}·게시 표시·빠진 번호를 docs/data.md §3 모양으로 쓰는지 본다
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { drandRoundAfter } from '@peaket/shuffle';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LocalResultFiles } from '../src/modules/batch/adapters/local-result-files.js';
import { MemoryShuffleRecords } from '../src/modules/batch/adapters/memory-batch-store.js';
import { RedisBatchStore, RedisShuffleRecords, keys } from '../src/modules/batch/adapters/redis-batch-store.js';
import { TestRandomness } from '../src/modules/batch/adapters/test-randomness.js';
import { PublishBatchResults } from '../src/modules/batch/application/publish-batch-results.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** 비콘 대기 상한에 닿지 않는 라운드의 공시 기록(묶음 시험은 시드를 시험 값으로 받는다) */
function committedRecords(eventId: string, fixAtMs: number): MemoryShuffleRecords {
  const r = new MemoryShuffleRecords();
  r.setForTest(eventId, 1, { commit: '00'.repeat(32), round: drandRoundAfter(fixAtMs), sealed: 'x', atMs: 0 });
  return r;
}

test('[ASVS v5.0.0-16.5.2] 멈춤 표시: 비어 있을 때만 쓰고 처음 쓴 쪽만 참이며, 공시 기록이 없어도 쓰고, 모르는 값은 멈춘 것으로 읽는다', async () => {
  const E = `evt-stop-int-${Date.now()}`;
  const records = new RedisShuffleRecords(redis);
  const expireAt = Date.now() + 3_600_000;
  expect(await records.stop(E, 'lobby', 1_000, 'no_commit', expireAt)).toBe(true);
  expect(await records.stop(E, 'lobby', 2_000, 'beacon', expireAt)).toBe(false);
  expect(await cmd(keys.shuffle(E), ['HGET', keys.shuffle(E), 'stop:lobby'])).toBe('1000:no_commit');
  // 공시 기록 없이 멈춤만 써도 회차 키 수명이 걸린다
  expect(Number(await cmd(keys.shuffle(E), ['PEXPIRETIME', keys.shuffle(E)]))).toBe(expireAt);
  expect(await records.read(E, 'lobby')).toBeNull();
  await cmd(keys.shuffle(E), ['HSET', keys.shuffle(E), 'commit:lobby', '00'.repeat(32), 'round:lobby', '7', 'sealed:lobby', 'x', 'at:lobby', '0']);
  expect((await records.read(E, 'lobby'))?.stopped).toEqual({ reason: 'no_commit', atMs: 1_000 });
  await cmd(keys.shuffle(E), ['HSET', keys.shuffle(E), 'stop:lobby', 'garbage']);
  expect((await records.read(E, 'lobby'))?.stopped).toEqual({ reason: 'unknown', atMs: 0 });
});

test('Q-T6 로비 게시: lobby_members·batch_done의 lobby를 읽어 q:lobby·shuffle-results·pub:lobby를 쓰고, VERIFYING 번호는 빠진 번호다', async () => {
  const E = `evt-lobby-int-${Date.now()}`;
  const startsAt = Date.now() + 3 * 24 * 3600_000;
  const members = ['l1', 'l2', 'l3', 'l4'].map(hash);
  // 라운드 예정 시각 앞에 머클 루트를 공시하게, 지금 막 오픈한 회차로 둔다(ADR-0232 결정 5)
  const opensAt = Date.now() - 1_000;
  await cmd(keys.cfg(E), ['HSET', keys.cfg(E), 'opensAtMs', String(opensAt), 'startsAtMs', String(startsAt), 'lobbyShuffle', '1', 'openBatch', '0', 'rev', '1']);
  await cmd(keys.lobbyMembers(E), ['SADD', keys.lobbyMembers(E), ...members]);
  await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), 'lobby', '1:4:1']);
  await cmd(keys.verify(E), ['HSET', keys.verify(E), members[2]!, 'VERIFYING:1:NETWORK', members[3]!, 'ORPHAN:1']);
  await cmd(keys.shuffle(E), ['HSET', keys.shuffle(E), 'commit:lobby', '00'.repeat(32), 'round:lobby', String(drandRoundAfter(opensAt)), 'sealed:lobby', 'x', 'at:lobby', '0']);
  const dir = mkdtempSync(join(tmpdir(), 'shuffle-results-'));
  const clock = fakeClock({ now: Date.now() });
  const randomness = new TestRandomness(Buffer.alloc(32, 5));
  const publish = new PublishBatchResults(new RedisBatchStore(redis), new RedisShuffleRecords(redis), randomness, randomness, new LocalResultFiles(dir), clock);
  expect(await publish.run({ eventId: E, group: 'lobby' })).toMatchObject({ status: 'PUBLISHED', count: 4 });
  const seen = await Promise.all(members.map((m) => cmd(keys.lobbyResult(m), ['GET', keys.lobbyResult(m)])));
  expect(new Set(seen.map(String))).toEqual(new Set(['1:1', '2:1', '3:1', '4:1']));
  const seqOfVerifying = Number(String(seen[2]).split(':')[0]);
  expect(Number(await cmd(keys.removed(E), ['GETBIT', keys.removed(E), String(seqOfVerifying)]))).toBe(1);
  // 목록 고정 뒤 되돌리기가 남긴 자리(ORPHAN)도 빠진 번호다
  expect(Number(await cmd(keys.removed(E), ['GETBIT', keys.removed(E), String(seen[3]).split(':')[0]!]))).toBe(1);
  expect(readdirSync(join(dir, E, 'shuffle-results')).length).toBeGreaterThan(0);
  expect(await cmd(keys.batchDone(E), ['HGET', keys.batchDone(E), 'pub:lobby'])).not.toBeNull();
});

test('Q-T34 ① 실제 Valkey: 셔플 전에 통과한 로비 참가자(PASSED)는 게시 때 빠진 번호가 되지 않고 추가 검증 중·기각만 돌린다', async () => {
  const E = `evt-passed-int-${Date.now()}`;
  const startsAt = Date.now() + 3 * 24 * 3600_000;
  const members = ['v1', 'v2', 'v3', 'v4'].map(hash);
  const opensAt = Date.now() - 1_000;
  await cmd(keys.cfg(E), ['HSET', keys.cfg(E), 'opensAtMs', String(opensAt), 'startsAtMs', String(startsAt), 'lobbyShuffle', '1', 'openBatch', '0', 'rev', '1']);
  await cmd(keys.lobbyMembers(E), ['SADD', keys.lobbyMembers(E), ...members]);
  await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), 'lobby', '1:4:1']);
  await cmd(keys.verify(E), ['HSET', keys.verify(E), members[0]!, `PASSED:${Date.now() - 5_000}:NETWORK`, members[1]!, `VERIFYING:${Date.now() - 9_000}:NETWORK`, members[2]!, `BLOCKED:${Date.now()}:DEVICE_HISTORY`]);
  await cmd(keys.shuffle(E), ['HSET', keys.shuffle(E), 'commit:lobby', '00'.repeat(32), 'round:lobby', String(drandRoundAfter(opensAt)), 'sealed:lobby', 'x', 'at:lobby', '0']);
  const randomness = new TestRandomness(Buffer.alloc(32, 5));
  const publish = new PublishBatchResults(new RedisBatchStore(redis), new RedisShuffleRecords(redis), randomness, randomness, new LocalResultFiles(mkdtempSync(join(tmpdir(), 'shuffle-results-'))), fakeClock({ now: Date.now() }));
  expect(await publish.run({ eventId: E, group: 'lobby' })).toMatchObject({ status: 'PUBLISHED', count: 4 });
  const seqOf = async (m: string) => String(await cmd(keys.lobbyResult(m), ['GET', keys.lobbyResult(m)])).split(':')[0]!;
  const bit = async (m: string) => Number(await cmd(keys.removed(E), ['GETBIT', keys.removed(E), await seqOf(m)]));
  expect([await bit(members[0]!), await bit(members[1]!), await bit(members[2]!), await bit(members[3]!)]).toEqual([0, 1, 1, 0]);
  // 게시는 verify 칸을 바꾸지 않는다(통과 칸은 입장 확정이 읽는다)
  expect(String(await cmd(keys.verify(E), ['HGET', keys.verify(E), members[0]!]))).toMatch(/^PASSED:/);
});

test('Q-T68④ Q-T68⑦ 묶음 게시: 구간이 닫힌 뒤의 취소가 남긴 자리(ORPHAN)는 번호를 빠진 번호로 돌린다', async () => {
  const E = `evt-orphan-int-${Date.now()}`;
  const members = ['o1', 'o2', 'o3'].map(hash);
  const opensAt = Date.now() - 1_000;
  await cmd(keys.cfg(E), ['HSET', keys.cfg(E), 'opensAtMs', String(opensAt), 'startsAtMs', String(Date.now() + 3 * 86_400_000), 'lobbyShuffle', '0', 'openBatch', '1', 'rev', '1']);
  await cmd(keys.batchMembers(E, 1), ['SADD', keys.batchMembers(E, 1), ...members]);
  await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), '1', '11:3:1']);
  await cmd(keys.verify(E), ['HSET', keys.verify(E), members[1]!, 'ORPHAN:1']);
  await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), 'orphan:1', '1']);
  const randomness = new TestRandomness(Buffer.alloc(32, 5));
  const publish = new PublishBatchResults(new RedisBatchStore(redis), committedRecords(E, opensAt + 2_000), randomness, randomness, new LocalResultFiles(mkdtempSync(join(tmpdir(), 'batch-results-'))), fakeClock({ now: Date.now() }));
  expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED', count: 3 });
  const seq = String(await cmd(keys.batchResult(members[1]!), ['GET', keys.batchResult(members[1]!)])).split(':')[0]!;
  expect(Number(await cmd(keys.removed(E), ['GETBIT', keys.removed(E), seq]))).toBe(1);
  const other = String(await cmd(keys.batchResult(members[0]!), ['GET', keys.batchResult(members[0]!)])).split(':')[0]!;
  expect(Number(await cmd(keys.removed(E), ['GETBIT', keys.removed(E), other]))).toBe(0);
});

test('publishBatch_닫힘표시와참가자를읽어_사람별결과·결과파일·게시표시를쓰고_잃은자리는빠진번호다', async () => {
  const E = `evt-int-${Date.now()}`;
  const startsAt = Date.now() + 3 * 86_400_000;
  const members = Array.from({ length: 2_500 }, (_, i) => hash(`m-${i}`));
  const opensAt = Date.now() - 1_000;
  await cmd(keys.cfg(E), ['HSET', keys.cfg(E), 'opensAtMs', String(opensAt), 'startsAtMs', String(startsAt), 'lobbyShuffle', '0', 'openBatch', '1', 'rev', '1']);
  await cmd(keys.batchMembers(E, 1), ['SADD', keys.batchMembers(E, 1), ...members]);
  // 닫을 때 2,502명으로 셌는데 두 명의 SADD를 장애 전환으로 잃은 경우
  await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), '1', `101:${members.length + 2}:3`]);
  const dir = mkdtempSync(join(tmpdir(), 'batch-results-'));
  const clock = fakeClock({ now: Date.now() });
  const publish = new PublishBatchResults(new RedisBatchStore(redis), committedRecords(E, opensAt + 2_000), new TestRandomness(Buffer.alloc(32, 5)), new TestRandomness(Buffer.alloc(32, 5)), new LocalResultFiles(dir), clock);

  const r = await publish.run({ eventId: E });
  expect(r).toMatchObject({ status: 'PUBLISHED', count: members.length });
  const saleEnd = startsAt - 86_400_000;
  const seqs = new Set<number>();
  for (const h of members.slice(0, 50)) {
    const v = String(await cmd(keys.batchResult(h), ['GET', keys.batchResult(h)]));
    expect(v).toMatch(/^\d+:3$/);
    seqs.add(Number(v.split(':')[0]));
    expect(Number(await cmd(keys.batchResult(h), ['PEXPIRETIME', keys.batchResult(h)]))).toBe(saleEnd);
  }
  for (const s of seqs) expect(s >= 101 && s < 101 + members.length).toBe(true);
  expect(Number(await cmd(keys.batchDone(E), ['HGET', keys.batchDone(E), 'pub:1']))).toBe(clock.now());
  expect(Number(await cmd(keys.removed(E), ['GETBIT', keys.removed(E), String(101 + members.length)]))).toBe(1);
  expect(Number(await cmd(keys.removed(E), ['GETBIT', keys.removed(E), String(101 + members.length + 1)]))).toBe(1);
  expect(Number(await cmd(keys.removed(E), ['GETBIT', keys.removed(E), '101']))).toBe(0);

  const files = readdirSync(join(dir, E, 'batch-results'));
  expect(files.every((f) => /^[0-9a-f]{3}\.json$/.test(f))).toBe(true);
  const all = Object.assign({}, ...files.map((f) => JSON.parse(readFileSync(join(dir, E, 'batch-results', f), 'utf8')) as Record<string, number>));
  expect(Object.keys(all)).toHaveLength(members.length);
  expect(new Set(Object.values(all)).size).toBe(members.length);
  expect(await publish.run({ eventId: E })).toEqual({ status: 'ALREADY' });
  expect(String(await cmd(keys.batchDone(E), ['HGET', keys.batchDone(E), 'root:1']))).toBe(r.status === 'PUBLISHED' ? r.merkleRoot : '');

  // 결과 키 하나를 잃고 queue-svc가 다시 쓰기를 청했다: 같은 값으로 다시 쓰고 표시를 지운다
  const lost = keys.batchResult(members[7]!);
  const kept = String(await cmd(lost, ['GET', lost]));
  await cmd(lost, ['DEL', lost]);
  await cmd(keys.batchDone(E), ['HSETNX', keys.batchDone(E), 'repair:1', '123']);
  expect(await publish.run({ eventId: E })).toEqual({ status: 'REPAIRED', count: members.length });
  expect(String(await cmd(lost, ['GET', lost]))).toBe(kept);
  expect(await cmd(keys.batchDone(E), ['HGET', keys.batchDone(E), 'repair:1'])).toBeNull();
  expect(await publish.run({ eventId: E })).toEqual({ status: 'ALREADY' });
});

test('게시전복제확인은같은슬롯에한번쓰고WAIT로본다_최소복제본0이면바로되고_복제본이없는데1이면시간한도뒤에안된다', async () => {
  const E = `evt-wait-${Date.now()}`;
  await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), '1', '1:3:1']);
  expect(await new RedisBatchStore(redis, 0).confirmReplicated(E, 1, '1:3:1')).toBe(true);
  const started = Date.now();
  expect(await new RedisBatchStore(redis, 1).confirmReplicated(E, 1, '1:3:1')).toBe(false);
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  // 확인을 위해 쓴 값은 그 묶음의 표시 옆에 남는다(게시 표시와 헷갈리지 않는 이름)
  expect(await cmd(keys.batchDone(E), ['HEXISTS', keys.batchDone(E), 'wait:1'])).toBe(1);
});

test('복제확인은따로받은연결로쓰고기다린다_그연결이막혀도다른명령의연결은막히지않는다', async () => {
  const E = `evt-wait2-${Date.now()}`;
  const waitRedis = await createHotRedis({ url: valkey.url });
  try {
    const store = new RedisBatchStore(redis, 1, waitRedis);
    await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), '1', '1:3:1']);
    const waiting = store.confirmReplicated(E, 1, '1:3:1');
    // 확인 쓰기(HSET)의 응답 뒤에 WAIT가 나가므로 조금 기다린 뒤 잰다. 복제본이 없어 WAIT가 시간 한도까지 막는 동안에도 기본 연결은 바로 답한다
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    await cmd(keys.batchDone(E), ['HGET', keys.batchDone(E), 'x']);
    expect(Date.now() - started).toBeLessThan(100);
    expect(await waiting).toBe(false);
  } finally {
    await waitRedis.close();
  }
});

test('[ASVS v5.0.0-16.5.2] POL-005 Q-T6 실제 Valkey: 공시 라운드 뒤에 쓴 머클 루트는 저장소 시각으로 잡혀 게시를 멈춘다', async () => {
  const E = `evt-late-root-${Date.now()}`;
  const startsAt = Date.now() + 3 * 24 * 3600_000;
  const members = ['r1', 'r2'].map(hash);
  const opensAt = Date.now() - 20_000;
  await cmd(keys.cfg(E), ['HSET', keys.cfg(E), 'opensAtMs', String(opensAt), 'startsAtMs', String(startsAt), 'lobbyShuffle', '1', 'openBatch', '0', 'rev', '1']);
  await cmd(keys.lobbyMembers(E), ['SADD', keys.lobbyMembers(E), ...members]);
  await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), 'lobby', '1:2:1']);
  await cmd(keys.shuffle(E), ['HSET', keys.shuffle(E), 'commit:lobby', '00'.repeat(32), 'round:lobby', String(drandRoundAfter(opensAt)), 'sealed:lobby', 'x', 'at:lobby', '0']);
  const randomness = new TestRandomness(Buffer.alloc(32, 5));
  const publish = new PublishBatchResults(new RedisBatchStore(redis), new RedisShuffleRecords(redis), randomness, randomness, new LocalResultFiles(mkdtempSync(join(tmpdir(), 'late-root-'))), fakeClock({ now: Date.now() }));
  expect(await publish.run({ eventId: E, group: 'lobby' })).toEqual({ status: 'BEACON_STOPPED', reason: 'late_root', first: true });
  expect(String(await cmd(keys.shuffle(E), ['HGET', keys.shuffle(E), 'stop:lobby']))).toMatch(/:late_root$/);
  expect(await cmd(keys.batchDone(E), ['HGET', keys.batchDone(E), 'pub:lobby'])).toBeNull();
});

test('[ASVS v5.0.0-15.4.2] POL-005 머클루트·비콘·시드는 비어 있을 때만 쓰고, 게시 표시가 먼저 쓴 루트를 바꾸지 않는다', async () => {
  const E = `evt-once-${Date.now()}`;
  const store = new RedisBatchStore(redis);
  const records = new RedisShuffleRecords(redis);
  const expireAtMs = Date.now() + 60_000;
  const before = Date.now();
  const first = await store.markRoot(E, 'lobby', 'r1', expireAtMs);
  const second = await store.markRoot(E, 'lobby', 'r2', expireAtMs);
  // 공시 시각은 파드 시계가 아니라 저장소 시각이다
  expect(first.root).toBe('r1');
  expect(Math.abs(first.atMs - before)).toBeLessThan(5_000);
  expect(second).toEqual(first);
  expect(await store.earlyRootOf(E, 'lobby')).toEqual(first);
  await store.markPublished(E, 'lobby', 3_000, 'r3');
  expect((await store.published(E, 'lobby'))?.root).toBe('r1');
  await redis.command(['HSET', keys.shuffle(E), 'round:lobby', '7'], { key: keys.shuffle(E) });
  await records.recordBeacon(E, 'lobby', 'aa', 'bb', expireAtMs, 7);
  await records.recordBeacon(E, 'lobby', 'cc', 'dd', expireAtMs, 7);
  await records.reveal(E, 'lobby', 'ee', 4_000, expireAtMs);
  await records.reveal(E, 'lobby', 'ff', 5_000, expireAtMs);
  const k = keys.shuffle(E);
  const [beacon, sig, seed, seedAt] = (await redis.command(['HMGET', k, 'beacon:lobby', 'sig:lobby', 'seed:lobby', 'seedAt:lobby'], { key: k })) as string[];
  expect([beacon, sig, seed, seedAt]).toEqual(['aa', 'bb', 'ee', '4000']);
  await redis.command(['HSET', k, 'commit:lobby', '00', 'round:lobby', '3', 'sealed:lobby', 'x', 'at:lobby', '9'], { key: k });
  expect(await records.read(E, 'lobby')).toMatchObject({ seed: 'ee', seedAtMs: 4_000, beacon: 'aa', signature: 'bb' });
});

test('게시표시는비어있을때만쓴다_두번째게시가게시시각을늦춰분산창을다시닫지않는다', async () => {
  const E = `evt-pub-${Date.now()}`;
  const store = new RedisBatchStore(redis);
  await store.markPublished(E, 1, 1_000, 'aa');
  await store.markPublished(E, 1, 2_000, 'aa');
  expect(await cmd(keys.batchDone(E), ['HGET', keys.batchDone(E), 'pub:1'])).toBe('1000');
});
