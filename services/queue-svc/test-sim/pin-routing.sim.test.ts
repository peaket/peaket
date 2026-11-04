// 실측(PC): node-redis 6.3 클러스터 클라이언트는 WAIT·INFO·CLIENT INFO 같은 키 없는 명령을 Redis 명령 팁(명령 정책)에 따라 모든 샤드나 아무 노드로 보내고 key를 무시한다.
// RB-05 복제 확인(ADR-0186)은 쓴 노드의 같은 연결로 INFO replication과 WAIT를 보내야 하므로 플랫폼 pin 옵션(CallOptions.pin)으로 key 슬롯의 주 노드에만 보낸다.
// ① 키를 주고도 pin 없이 보낸 CLUSTER MYID가 슬롯 주 노드가 아닌 노드에 닿는 키가 있고, pin을 주면 모든 키가 슬롯 주 노드(스크립트가 닿는 노드)에 닿는다.
// ② 다른 샤드에 이 연결로 쓴 뒤 그 샤드의 복제본이 멈췄을 때 pin 없는 WAIT는 모든 샤드의 최솟값(node-redis 명령 정책 all_shards·agg_min)이라 0이고, pin을 주면 그 키 샤드의 복제만 세 1이다.
// CI에서 돌지 않는다(pnpm --filter @peaket/queue-svc sim pin-routing). 결과는 콘솔·SIM_OUT/pin-routing.json과 ADR-0186 '측정'에 적는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHotRedis, type HotRedis, redisScript } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { newEvent } from '../test/support.js';
import { simCluster, type SimCluster } from './cluster.js';
import { SIM_OUT } from './record.js';

let c: SimCluster;
let redis: HotRedis;

beforeAll(async () => {
  c = await simCluster();
  redis = await createHotRedis({ clusterUrls: c.clusterUrls, nodeAddressMap: c.nodeAddressMap });
});

afterAll(async () => {
  await redis?.close().catch(() => undefined);
  c?.down();
});

const MYID = redisScript(`return redis.call('CLUSTER', 'MYID')`);

test('[실측] 키 없는 명령은 pin 없이는 key 슬롯 주 노드로 가지 않고, pin을 주면 그 주 노드로만 간다(ADR-0186)', async () => {
  // 슬롯 주 노드가 서로 다른 키를 고른다(CLUSTER MYID를 돌려주는 스크립트는 늘 key 슬롯의 주 노드에서 돈다)
  const picked: Array<{ key: string; master: string; owner: string }> = [];
  for (let i = 0; i < 200 && new Set(picked.map((p) => p.master)).size < 3; i++) {
    const key = keys.epoch(newEvent());
    const { master } = c.ownerOf(key);
    if (!picked.some((p) => p.master === master)) picked.push({ key, master, owner: String(await redis.evalScript(MYID, [key], [])) });
  }
  expect(picked).toHaveLength(3);
  const rows: Array<{ master: string; unpinned: string; pinned: string; owner: string }> = [];
  for (const p of picked) {
    const unpinned = String(await redis.command(['CLUSTER', 'MYID'], { key: p.key }));
    const pinned = new Set<string>();
    for (let i = 0; i < 6; i++) pinned.add(String(await redis.command(['CLUSTER', 'MYID'], { key: p.key, pin: true })));
    expect([...pinned]).toEqual([p.owner]);
    rows.push({ master: p.master, unpinned: unpinned.slice(0, 6), pinned: [...pinned][0]!.slice(0, 6), owner: p.owner.slice(0, 6) });
  }
  // pin 없이는 슬롯 주 노드가 아닌 노드가 답하는 키가 있다(주 노드 셋 가운데 한 곳으로만 가므로 적어도 둘은 어긋난다)
  expect(rows.filter((r) => r.unpinned !== r.owner).length).toBeGreaterThanOrEqual(1);
  mkdirSync(SIM_OUT, { recursive: true });
  writeFileSync(join(SIM_OUT, 'pin-routing.json'), JSON.stringify({ routing: rows }));
  console.log(JSON.stringify({ routing: rows }));
}, 180_000);

test('[실측] 다른 샤드에 쓴 뒤 그 복제본이 멈추면 pin 없는 WAIT는 모든 샤드의 최솟값이라 0이고, pin을 주면 그 키 샤드의 복제만 센다(ADR-0186)', async () => {
  const k1 = keys.epoch(newEvent());
  const a = c.ownerOf(k1);
  // k1과 다른 샤드에 있는 키(그 샤드의 복제본을 멈춘다)
  let other: { key: string; replica: string } | null = null;
  for (let i = 0; i < 200 && !other; i++) {
    const key = keys.epoch(newEvent());
    const o = c.ownerOf(key);
    if (o.master !== a.master && o.replica) other = { key, replica: o.replica };
  }
  expect(other).not.toBeNull();
  // WAIT는 이 연결이 쓴 것까지만 센다. 다른 샤드(B)의 복제본을 멈춘 채 B와 k1 샤드(A)에 이 연결로 쓴다: B의 쓰기는 복제되지 않고 A의 쓰기는 복제된다
  const mark = redisScript(`redis.call('HSET', KEYS[1], 'wait', '1') return 1`);
  c.pause(other!.replica);
  try {
    await redis.evalScript(mark, [other!.key], []);
    await redis.evalScript(mark, [k1], []);
    const t0 = Date.now();
    const unpinned = Number(await redis.command(['WAIT', '1', '400'], { key: k1, deadlineMs: 900 }));
    const unpinnedMs = Date.now() - t0;
    await redis.evalScript(mark, [k1], []);
    const t1 = Date.now();
    const pinned = Number(await redis.command(['WAIT', '1', '400'], { key: k1, deadlineMs: 900, pin: true }));
    const pinnedMs = Date.now() - t1;
    const out = JSON.stringify({ keyMaster: a.master, pausedReplica: other!.replica, unpinned, unpinnedMs, pinned, pinnedMs });
    console.log(out);
    mkdirSync(SIM_OUT, { recursive: true });
    writeFileSync(join(SIM_OUT, 'pin-wait.json'), out);
    expect(unpinned).toBe(0);
    expect(unpinnedMs).toBeGreaterThanOrEqual(350);
    expect(pinned).toBe(1);
    expect(pinnedMs).toBeLessThan(200);
  } finally {
    c.unpause(other!.replica);
  }
}, 180_000);
