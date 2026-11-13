// S-T19·S-T20 측정(임시 하네스): 실제 Valkey 자동 배정 Lua에 HoldSeats 유스케이스로 1,000건을 동시에 보낸다.
// S-T19: 1순위 매진·연석 부족·중복 홀드 0. S-T20: 같은 조건의 순차 배정 순서가 두 번 같고, 충분한 좌석에서 굶주림 0.
// 결과는 .cache/bat090-auto-s19-s20.json에 남기고 docs/review/measurements/BAT-090-wave.md에 옮긴다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, test } from 'vitest';
import {
  HoldSeats,
  MemoryPurchaseSessions,
  MemorySeatMap,
  type MemorySeatDef,
  noSeatSignals,
  RecordingHoldAttempts,
  RedisSeatStore,
  type AutoCondition,
  autoFingerprint,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
const NOW = Date.now();
const RUN = process.env.PEAKET_MEASURE === '1';
const R_COUNT = 5_000;
const S_COUNT = 100;

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

function seats(prefix: string, count: number, from: number, sectionIndex: number, tierId: string): MemorySeatDef[] {
  return Array.from({ length: count }, (_, i) => ({
    seatId: `${prefix}${String(i + 1).padStart(4, '0')}`,
    index: from + i,
    sectionId: `SEC-${prefix}`,
    sectionIndex,
    seatOffset: i,
    tierId,
  }));
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1]! };
}

async function autoWorld(o: { rCount?: number; sCount?: number } = {}) {
  const clock = fakeClock({ now: NOW, monotonic: 0 });
  const store = new RedisSeatStore(redis);
  const map = new MemorySeatMap();
  const eventId = `ev-auto-${randomUUID()}`;
  const rCount = o.rCount ?? R_COUNT;
  const sCount = o.sCount ?? 0;
  const defs = [...seats('R', rCount, 0, 0, 'R'), ...seats('S', sCount, rCount, 1, 'S')];
  const seatCount = rCount + sCount;
  map.put({ eventId, layoutVersion: 'v1', seatCount, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, defs);
  await store.openSale({ eventId, seatCount, keepUntilMs: NOW + 2 * DAY });
  const sessions = new MemoryPurchaseSessions();
  const attempts = new RecordingHoldAttempts();
  const uc = new HoldSeats(store, map, sessions, attempts, clock, noSeatSignals, undefined, undefined, undefined, undefined, map);
  const open = (i: number) => sessions.open({ sessionId: `ps-${eventId}-${i}`, accountId: `acct-${eventId}-${i}`, eventId, journeyId: `jny-${eventId}-${i}`, loginSessionId: `ls-${eventId}-${i}`, key: Buffer.alloc(32) });
  const command = (i: number, auto: AutoCondition = { firstTierId: 'R', count: 2, wheelchair: false, allowSplit: false }) => ({
    eventId,
    accountId: `acct-${eventId}-${i}`,
    purchaseSessionId: `ps-${eventId}-${i}`,
    idempotencyKey: randomUUID(),
    body: { auto },
  });
  return { clock, store, map, eventId, sessions, attempts, uc, open, command, rCount, sCount };
}

test.skipIf(!RUN)('S19_S20_ 자동 배정 1,000건 동시·1순위 매진·연석 부족·순서 공정성(실제 Valkey)', { timeout: 180_000 }, async () => {
  // S-T19: 1,000건 동시, 5,000석(2,000석 필요)
  const w = await autoWorld();
  for (let i = 0; i < 1_000; i++) w.open(i);
  const lat: number[] = [];
  const results = await Promise.allSettled(
    Array.from({ length: 1_000 }, (_, i) => {
      const t = process.hrtime.bigint();
      return w.uc.execute(w.command(i)).then(
        (r) => {
          lat.push(Number(process.hrtime.bigint() - t) / 1e6);
          return r;
        },
        (e: unknown) => {
          lat.push(Number(process.hrtime.bigint() - t) / 1e6);
          throw e;
        },
      );
    }),
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ seatIds: string[]; assignResult?: string }>).value);
  const rejected = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
  const rejectCodes: Record<string, number> = {};
  for (const r of results) {
    if (r.status !== 'rejected') continue;
    const e = r.reason as { code?: string; message?: string };
    const k = e?.code ?? e?.message?.slice(0, 60) ?? String(r.reason);
    rejectCodes[k] = (rejectCodes[k] ?? 0) + 1;
  }
  const held = fulfilled.flatMap((r) => r.seatIds);
  const unique = new Set(held);
  const manual = rejected.filter((e) => e.includes('manual-selection-required')).length;
  const bits = Number(await redis.command(['BITCOUNT', seatKeys.bitmap(w.eventId)], { key: seatKeys.bitmap(w.eventId) }));

  // 같은 회차에 1,000건을 100씩 10묶음으로(로컬 단일 연결·100ms 마감에서 현실적인 동시성). 앞 1,000건 동시 실행이 남긴
  // 부분 홀드(마감 뒤 완료된 32석)와 섞이지 않게 새 회차에서 잰다.
  const w100 = await autoWorld();
  for (let i = 0; i < 1_000; i++) w100.open(i);
  const lat100: number[] = [];
  const fulfilled100: Array<{ seatIds: string[]; assignResult?: string }> = [];
  const reject100: Record<string, number> = {};
  for (let b = 0; b < 10; b++) {
    const batch = await Promise.allSettled(
      Array.from({ length: 100 }, (_, j) => {
        const i = b * 100 + j;
        const t = process.hrtime.bigint();
        return w100.uc.execute(w100.command(i)).then(
          (r) => {
            lat100.push(Number(process.hrtime.bigint() - t) / 1e6);
            return r;
          },
          (e: unknown) => {
            lat100.push(Number(process.hrtime.bigint() - t) / 1e6);
            throw e;
          },
        );
      }),
    );
    for (const r of batch) {
      if (r.status === 'fulfilled') fulfilled100.push(r.value);
      else {
        const e = r.reason as { code?: string; message?: string };
        const k = e?.code ?? e?.message?.slice(0, 60) ?? String(r.reason);
        reject100[k] = (reject100[k] ?? 0) + 1;
      }
    }
  }
  const held100 = fulfilled100.flatMap((r) => r.seatIds);
  const unique100 = new Set(held100);
  const bits100 = Number(await redis.command(['BITCOUNT', seatKeys.bitmap(w100.eventId)], { key: seatKeys.bitmap(w100.eventId) }));
  const autoCur100 = await w100.store.autoCursor(w100.eventId, autoFingerprint({ firstTierId: 'R', count: 2, wheelchair: false, allowSplit: false }));

  // S-T19: 1순위 매진 → 2순위 등급
  const sold = await autoWorld({ rCount: 100, sCount: 100 });
  for (let i = 0; i < 100; i++) await redis.command(['SETBIT', seatKeys.bitmap(sold.eventId), String(i), '1'], { key: seatKeys.bitmap(sold.eventId) });
  for (let i = 0; i < 50; i++) sold.open(i);
  const soldResults = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => sold.uc.execute(sold.command(i, { firstTierId: 'R', secondTierId: 'S', count: 2, wheelchair: false, allowSplit: false }))));
  const soldFulfilled = soldResults.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ seatIds: string[]; assignResult?: string }>).value);
  const soldSeats = soldFulfilled.flatMap((r) => r.seatIds);
  const soldUnique = new Set(soldSeats);

  // S-T19: 연석 부족(한 칸씩 띄움) → 분리 미허용 409, 허용 시 FIRST_SPLIT
  const split = await autoWorld({ rCount: 10 });
  for (const i of [0, 2, 4, 6, 8]) await redis.command(['SETBIT', seatKeys.bitmap(split.eventId), String(i), '1'], { key: seatKeys.bitmap(split.eventId) });
  split.open(0);
  split.open(1);
  const noSplit = await split.uc.execute(split.command(0)).then(() => 'OK', (e: unknown) => String(e));
  const withSplit = await split.uc.execute(split.command(1, { firstTierId: 'R', count: 2, wheelchair: false, allowSplit: true }));

  // S-T20: 같은 조건의 순차 배정 순서가 두 번 같다(각 10건, 100석)
  const sequence = async () => {
    const x = await autoWorld({ rCount: 100 });
    for (let i = 0; i < 10; i++) x.open(i);
    const out: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await x.uc.execute(x.command(i));
      out.push(...r.seatIds);
    }
    return out;
  };
  const seq1 = await sequence();
  const seq2 = await sequence();
  const identical = JSON.stringify(seq1) === JSON.stringify(seq2);

  const result = {
    measuredAt: new Date().toISOString(),
    condition: 'Valkey 8.1 로컬, HoldSeats.execute + RedisSeatStore.holdAuto, 1,000 동시(5,000석), 2순위 100석, 분리 10석, 순차 10건×2',
    s19: {
      requests: 1_000,
      fulfilled: fulfilled.length,
      rejected: rejected.length,
      manualSelectionRequired: manual,
      rejectCodes,
      firstFulfilled: fulfilled.slice(0, 3),
      heldSeats: held.length,
      uniqueHeldSeats: unique.size,
      duplicateHeldSeats: held.length - unique.size,
      bits,
      latencyMs: stats(lat),
      concurrent100: {
        requests: 1_000,
        fulfilled: fulfilled100.length,
        rejected: Object.values(reject100).reduce((a, b) => a + b, 0),
        rejectCodes: reject100,
        manualSelectionRequired: (reject100['MANUAL_SELECTION_REQUIRED'] ?? 0),
        heldSeats: held100.length,
        uniqueHeldSeats: unique100.size,
        duplicateHeldSeats: held100.length - unique100.size,
        bits: bits100,
        autoCur: autoCur100,
        latencyMs: stats(lat100),
      },
      soldOutSecondTier: { requests: 50, fulfilled: soldFulfilled.length, second: soldFulfilled.filter((r) => r.assignResult === 'SECOND').length, heldSeats: soldSeats.length, uniqueHeldSeats: soldUnique.size, duplicateHeldSeats: soldSeats.length - soldUnique.size },
      insufficientAdjacent: { noSplit, splitAssignResult: withSplit.assignResult, splitSeats: withSplit.seatIds },
    },
    s20: { sequentialRequests: 10, identical, sequence: seq1, starvation: manual },
  };
  mkdirSync('../../.cache', { recursive: true });
  writeFileSync('../../.cache/bat090-auto-s19-s20.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log('AUTO_RESULT', JSON.stringify(result));
});
