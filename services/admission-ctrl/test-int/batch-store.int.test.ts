// 묶음 게시를 실제 Valkey 8.1로 돈다: queue-svc 진입 Lua가 남긴 모양(닫힘 표시·참가자·회차 일정 사본)을 읽고,
// 사람별 결과 q:batch:{해시}·게시 표시·빠진 번호를 docs/data.md §3 모양으로 쓰는지 본다
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LocalResultFiles } from '../src/modules/batch/adapters/local-result-files.js';
import { RedisBatchStore, keys } from '../src/modules/batch/adapters/redis-batch-store.js';
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

test('publishBatch_닫힘표시와참가자를읽어_사람별결과·결과파일·게시표시를쓰고_잃은자리는빠진번호다', async () => {
  const E = `evt-int-${Date.now()}`;
  const startsAt = Date.now() + 3 * 86_400_000;
  const members = Array.from({ length: 2_500 }, (_, i) => hash(`m-${i}`));
  await cmd(keys.cfg(E), ['HSET', keys.cfg(E), 'opensAtMs', String(Date.now() - 10_000), 'startsAtMs', String(startsAt), 'lobbyShuffle', '0', 'openBatch', '1', 'rev', '1']);
  await cmd(keys.batchMembers(E, 1), ['SADD', keys.batchMembers(E, 1), ...members]);
  // 닫을 때 2,502명으로 셌는데 두 명의 SADD를 장애 전환으로 잃은 경우
  await cmd(keys.batchDone(E), ['HSET', keys.batchDone(E), '1', `101:${members.length + 2}:3`]);
  const dir = mkdtempSync(join(tmpdir(), 'batch-results-'));
  const clock = fakeClock({ now: Date.now() });
  const publish = new PublishBatchResults(new RedisBatchStore(redis), new TestRandomness(Buffer.alloc(32, 5)), new TestRandomness(Buffer.alloc(32, 5)), new LocalResultFiles(dir), clock);

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

test('게시표시는비어있을때만쓴다_두번째게시가게시시각을늦춰분산창을다시닫지않는다', async () => {
  const E = `evt-pub-${Date.now()}`;
  const store = new RedisBatchStore(redis);
  await store.markPublished(E, 1, 1_000, 'aa');
  await store.markPublished(E, 1, 2_000, 'aa');
  expect(await cmd(keys.batchDone(E), ['HGET', keys.batchDone(E), 'pub:1'])).toBe('1000');
});
