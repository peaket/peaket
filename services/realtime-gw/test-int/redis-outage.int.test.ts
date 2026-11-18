// realtime-gw 장애 주입: 붙은 채 좌석 Redis(Valkey 컨테이너)를 멈췄다가 다시 띄운다(BUILD_ORDER HOT-090, BAT-052, S-T42 ⑩).
// 정본: docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '좌석 Redis 구독'(다시 붙으면 원하는 채널을 모두 다시 구독, 끊긴 동안 WebSocket 연결은
// 닫지 않고 하트비트를 이어 보냄)·'지표와 로그'(realtime_gw_redis_up 0·1), §12 S-T42 ⑩. 끊긴 사례가 실제로 있었는지(redis_up 0을 봤는지)도 단언한다.
// docker restart는 쓰지 않고 docker stop·docker start로 한다(같은 호스트 포트로 다시 뜬다).
// 리뷰 반영(BAT-052 RF-T3, CON-02·COR-05·CON-12): 끊긴 동안 바뀐 원하는 상태를 다시 붙은 뒤 맞추는지(ADR-0297 결정 1, S-T42 ⑰).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from 'redis';
import { admissionToken, channelOf, connect, deltaText, entriesOf, isBatchInterval, isDelta, isHeartbeat, layoutDir, metricValue, type Running, serviceEnv, startService, streamPath, subscribeBytes, timeSyncBytes, until } from './support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let layout: ReturnType<typeof layoutDir>;
let svc: Running;

beforeAll(async () => {
  valkey = await startValkey();
  layout = layoutDir({ 'ev-1': 4 });
  svc = await startService(serviceEnv({ redisUrl: valkey.url, seatMapDir: layout.dir }));
}, 120_000);

afterAll(async () => {
  await svc?.close().catch(() => {});
  valkey?.stop();
  layout?.remove();
});

const withRedis = async <T>(fn: (r: { sendCommand(args: string[]): Promise<unknown> }) => Promise<T>): Promise<T> => {
  const r = createClient({ url: valkey.url });
  await r.connect();
  try {
    return await fn(r);
  } finally {
    await r.quit().catch(() => {});
  }
};
const shardSubs = (channel: string) => withRedis(async (r) => Number(((await r.sendCommand(['PUBSUB', 'SHARDNUMSUB', channel])) as unknown[])[1]));
const redisUp = async () => metricValue(await svc.metrics(), 'realtime_gw_redis_up');

describe('S-T42 ⑩ 좌석 Redis 장애 주입', () => {
  test(
    'S-T42 ⑩ 붙은 채 Valkey를 멈추면 redis_up이 0이 되고 연결은 열린 채 하트비트가 오며, 다시 띄우면 redis_up 1·다시 구독하고 그 뒤의 SPUBLISH가 묶음으로 온다',
    async () => {
      const ch = channelOf('ev-1', 2);
      const c = connect(svc.url(streamPath('ev-1')), { token: admissionToken() });
      let closedEarly: { code: number } | undefined;
      void c.closed.then((x) => (closedEarly = x));
      await c.opened;
      const openedAt = Date.now();
      await c.next(isBatchInterval);
      c.send(subscribeBytes([2]));
      await until(async () => (await shardSubs(ch)) === 1, '처음 구독');
      await withRedis((r) => r.sendCommand(['SPUBLISH', ch, deltaText({ epoch: 1, section: 2, version: 1, changedAtMs: Date.now(), seats: [[0, 1]] })]));
      await c.next(isDelta);
      expect(await redisUp()).toBe(1);

      valkey.pause();
      let sawDown = false;
      await until(async () => (sawDown = (await redisUp()) === 0), 'redis_up 0', 20_000, 100);
      expect(sawDown).toBe(true);

      // 끊긴 동안: TimeSync에 답하고, 맺은 뒤 15초가 지나면 주기 하트비트(echo 0)가 온다
      const downFrom = c.raw.length;
      c.send(timeSyncBytes(4_242));
      expect((await c.next(isHeartbeat, 3_000, downFrom)).echoClientTimeMs).toBe(4_242);
      type Beat = Extract<Parameters<typeof isHeartbeat>[0], { type: 'heartbeat' }>;
      const isPeriodic = (f: Parameters<typeof isHeartbeat>[0]): f is Beat => isHeartbeat(f) && f.echoClientTimeMs === 0;
      // 끊긴 뒤에 온 주기 하트비트(맺은 뒤 15초 또는 30초 박자)
      const periodic = await c.next(isPeriodic, Math.max(1_000, openedAt + 32_000 - Date.now()), downFrom);
      expect(periodic.echoClientTimeMs).toBe(0);
      expect(await redisUp()).toBe(0);
      expect(closedEarly).toBeUndefined();
      expect(c.ws.readyState).toBe(c.ws.OPEN);

      await valkey.resume();
      await until(async () => (await redisUp()) === 1, 'redis_up 1', 20_000, 100);
      // 다시 뜬 Valkey는 구독을 모른다: realtime-gw가 다시 구독해야 1이 된다
      await until(async () => (await shardSubs(ch)) === 1, '다시 구독', 20_000, 100);
      const W = Date.now();
      const before = c.raw.length;
      await withRedis((r) => r.sendCommand(['SPUBLISH', ch, deltaText({ epoch: 2, section: 2, version: 1, changedAtMs: W, seats: [[3, 2]] })]));
      const got = await c.next(isDelta, 3_000, before);
      expect(got.seatEpoch).toBe(2);
      expect(entriesOf(got)).toEqual([{ sectionIndex: 2, sectionVersion: 1, offsets: [3], states: [2] }]);
      expect(closedEarly).toBeUndefined();
      c.ws.terminate();
    },
    90_000,
  );

  test(
    'S-T42 ⑩ ⑰ Valkey가 멈춘 동안 한 연결은 새 구역을 구독하고 다른 연결은 구역을 빼면, 다시 띄운 뒤 PUBSUB SHARDNUMSUB가 원하는 상태와 같아지고 새 구역의 메시지가 묶음으로 오며 realtime_gw_subscribe_mismatch가 0으로 돌아온다',
    async () => {
      // 시험이 직접 SPUBLISH한 메시지만 쓴다(감독 지시: 환불 Lua의 changedAtMs에 기대지 않는다)
      const [ch0, ch1, ch3] = [channelOf('ev-1', 0), channelOf('ev-1', 1), channelOf('ev-1', 3)];
      const a = connect(svc.url(streamPath('ev-1')), { token: admissionToken() });
      const b = connect(svc.url(streamPath('ev-1')), { token: admissionToken({ accountId: 'acct-2' }) });
      await Promise.all([a.opened, b.opened]);
      await Promise.all([a.next(isBatchInterval), b.next(isBatchInterval)]);
      a.send(subscribeBytes([0]));
      b.send(subscribeBytes([1]));
      await until(async () => (await shardSubs(ch0)) === 1 && (await shardSubs(ch1)) === 1, '처음 구독');

      valkey.pause();
      await until(async () => (await redisUp()) === 0, 'redis_up 0', 20_000, 100);
      // 끊긴 동안: a는 구역 3을 더하고, b는 구역 1을 뺀다
      a.send(subscribeBytes([0, 3]));
      b.send(subscribeBytes([]));
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await redisUp()).toBe(0);

      await valkey.resume();
      await until(async () => (await redisUp()) === 1, 'redis_up 1', 20_000, 100);
      await until(async () => (await shardSubs(ch0)) === 1 && (await shardSubs(ch3)) === 1 && (await shardSubs(ch1)) === 0, '원하는 상태(0·3 구독, 1 해제)와 같음', 20_000, 200);
      const fromA = a.raw.length;
      const fromB = b.raw.length;
      await withRedis((r) => r.sendCommand(['SPUBLISH', ch3, deltaText({ epoch: 5, section: 3, version: 1, changedAtMs: Date.now(), seats: [[4, 1]] })]));
      await withRedis((r) => r.sendCommand(['SPUBLISH', ch1, deltaText({ epoch: 5, section: 1, version: 1, changedAtMs: Date.now(), seats: [[4, 1]] })]));
      expect(entriesOf(await a.next(isDelta, 3_000, fromA))).toEqual([{ sectionIndex: 3, sectionVersion: 1, offsets: [4], states: [1] }]);
      await new Promise((r) => setTimeout(r, 300));
      expect(b.frames().slice(fromB).filter(isDelta)).toEqual([]);
      await until(async () => metricValue(await svc.metrics(), 'realtime_gw_subscribe_mismatch') === 0, 'realtime_gw_subscribe_mismatch 0', 20_000, 200);
      expect([a.ws.readyState, b.ws.readyState]).toEqual([a.ws.OPEN, b.ws.OPEN]);
      a.ws.terminate();
      b.ws.terminate();
    },
    120_000,
  );
});
