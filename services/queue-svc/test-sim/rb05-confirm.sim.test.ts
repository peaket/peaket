// 실측(PC): RB-05 복제 확인(ADR-0186)이 클러스터 모드(주 노드 셋·복제 셋)에서 회차 키의 주 노드로 가서 그 복제본을 기다리는지 본다.
// 통합 시험은 단일 노드 쌍(rb05-replica.int.test.ts)과 복제본 없는 클러스터 노드 하나(failover-cluster.int.test.ts)라, 클러스터 클라이언트가
// INFO replication과 WAIT를 그 샤드의 주 노드로 보내는 길은 여기서만 본다. 장애 전환은 세대 키에 옛 표지를 써서 흉내 낸다.
// CI에서 돌지 않는다(pnpm --filter @peaket/queue-svc sim rb05-confirm). 결과는 콘솔과 ADR-0186 '측정'에 적는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys, RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { newEvent } from '../test/support.js';
import { simCluster, type SimCluster } from './cluster.js';
import { SIM_OUT } from './record.js';

let c: SimCluster;
let redis: HotRedis;
/** WAIT 전용 연결(운영 조립 queue-svc main.ts와 같게) */
let waitRedis: HotRedis;

beforeAll(async () => {
  c = await simCluster();
  redis = await createHotRedis({ clusterUrls: c.clusterUrls, nodeAddressMap: c.nodeAddressMap });
  waitRedis = await createHotRedis({ clusterUrls: c.clusterUrls, nodeAddressMap: c.nodeAddressMap });
});

afterAll(async () => {
  await redis?.close().catch(() => undefined);
  await waitRedis?.close().catch(() => undefined);
  c?.down();
});

test('[실측] 클러스터에서 RB-05 확인은 회차 키의 주 노드로 가서 그 복제본이 받을 때까지 번호를 내지 않는다(ADR-0186)', async () => {
  const store = new RedisEntryStore(redis, waitRedis);
  const now = Date.now();
  const e = newEvent();
  const ek = keys.epoch(e);
  const input = { eventId: e, expireAtMs: now + 86_400_000, opensAtMs: now - 60_000, closeAtMs: now - 50_000, lobbyShuffle: false, openBatch: false };
  expect(await store.number(input)).toMatchObject({ kind: 'NUMBERED', seq: 1 });
  // 다른 노드가 쓴 표지(장애 전환 뒤): 같은 초의 견주기를 건너뛰지 않게 chk도 지난 값으로
  await redis.command(['HSET', ek, 'node', `${'f'.repeat(40)}:1`, 'chk', '0'], { key: ek });
  expect(await store.number(input)).toEqual({ kind: 'RECOVERING' });
  const rb = { eventId: e, expireAtMs: now + 86_400_000, skippedExpireAtMs: now + 86_400_000, skipBase: 10, opensAtMs: now - 60_000, lobbyShuffle: false, openBatch: false };
  expect(await store.rb05(rb)).toEqual({ kind: 'SKIPPED', start: 2, end: 11, gen: 2 });
  const { master, replica } = c.ownerOf(ek);
  expect(replica).not.toBeNull();
  c.pause(replica!);
  let waitedMs = 0;
  let sharedMs = 0;
  try {
    const t0 = Date.now();
    const confirming = store.confirmRb05({ eventId: e });
    await new Promise((r) => setTimeout(r, 100));
    // WAIT가 전용 연결을 막는 동안 공유 연결의 진입은 기다리지 않는다
    const t1 = Date.now();
    expect(await store.number(input)).toEqual({ kind: 'RECOVERING' });
    sharedMs = Date.now() - t1;
    expect(await confirming).toBe('WAITING');
    waitedMs = Date.now() - t0;
    expect(waitedMs).toBeGreaterThanOrEqual(400);
  } finally {
    c.unpause(replica!);
  }
  const t2 = Date.now();
  expect(await store.confirmRb05({ eventId: e })).toBe('CONFIRMED');
  const confirmMs = Date.now() - t2;
  expect(await store.number(input)).toMatchObject({ kind: 'NUMBERED', seq: 12, gen: 2 });
  // vitest는 통과한 시험의 콘솔 출력을 숨길 수 있어 결과는 실패 메시지가 아닌 파일로도 남긴다
  const out = JSON.stringify({ master, replica, waitedMs, sharedMs, confirmMs });
  console.log(out);
  mkdirSync(SIM_OUT, { recursive: true });
  writeFileSync(join(SIM_OUT, 'rb05-confirm.json'), out);
}, 300_000);
