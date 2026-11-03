// 새 맥락 리뷰가 찾은 결함의 재현 시험(docs/architecture.md §8.6의 3): 대기열 Redis가 응답하지 않을 때와 입장 루프 시동.
// - Redis 시간 초과 기본값(docs/architecture.md §5 시간 초과 표 Redis 행): 핫패스는 연결이 끊긴 동안 명령을 쌓지 않고,
//   명령 시간 초과가 소켓에 쓰기 전까지만 들어 응답 없이 사라진 노드에는 호출 쪽 마감 100ms를 함께 건다(ADR-0176 결정 2)
// - 입장 루프(docs/features/queue-admission.md §13 동작 4): 복제본마다 정한 간격으로 돌고, 1초 칸마다 한 번만 부른다
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock, type PlatformService } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createQueueAdmin } from '../src/modules/queue/index.js';
import { createV0Redis, type V0Redis } from '../src/redis.js';
import { fanHeaders } from './queue-harness.js';
import { pauseValkey, startValkey, unpauseValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let redis: V0Redis;
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createV0Redis(valkey.url);
});

afterAll(async () => {
  await redis?.close().catch(() => {});
  valkey?.stop();
});

/** 정한 시간 안에 끝나지 않으면 '끝나지 않음'으로 끝낸다(시험이 매달리지 않게) */
async function within<T>(ms: number, p: Promise<T>): Promise<{ done: true; value: T; ms: number } | { done: false; ms: number }> {
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<'guard'>((r) => (timer = setTimeout(() => r('guard'), ms)));
  try {
    const v = await Promise.race([p.then((value) => ({ value })), guard]);
    const took = performance.now() - t0;
    return v === 'guard' ? { done: false, ms: took } : { done: true, value: v.value, ms: took };
  } finally {
    clearTimeout(timer);
  }
}

test('FR007_QT2_대기열Redis가응답하지않으면_대기상태요청은마감안에500으로끝나고_돌아오면다시답한다', async () => {
  const clock = fakeClock();
  const svc: PlatformService = await createService({
    name: 'v0-monolith',
    module: AppModule.register({ queue: { redis, tickIntervalMs: false } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
  });
  try {
    const admin = createQueueAdmin(redis);
    await admin.open('fail-1', { admitPerSecond: 1 });
    const entered = await svc.http.inject({ method: 'POST', url: '/v1/queues/fail-1/entries', headers: fanHeaders('p1') });
    expect(entered.statusCode).toBe(201);

    pauseValkey(valkey);
    try {
      const r = await within(3_000, svc.http.inject({ method: 'GET', url: '/v1/queues/fail-1/entries/me', headers: fanHeaders('p1') }));
      expect(r.done, `대기 상태 요청이 3초 안에 끝나지 않았다(${Math.round(r.ms)}ms)`).toBe(true);
      if (r.done) {
        expect(r.value.statusCode).toBe(500);
        expect(r.ms).toBeLessThan(1_000);
      }
      const t = await within(3_000, admin.tick(clock.now()).then(() => 'ok', () => 'rejected'));
      expect(t.done, `입장 루프가 3초 안에 끝나지 않았다(${Math.round(t.ms)}ms)`).toBe(true);
      if (t.done) expect(t.value).toBe('rejected');
    } finally {
      unpauseValkey(valkey);
    }

    // 돌아오면 같은 연결로 다시 답한다
    let back = 0;
    for (let i = 0; i < 50 && back !== 200; i += 1) {
      back = (await svc.http.inject({ method: 'GET', url: '/v1/queues/fail-1/entries/me', headers: fanHeaders('p1') })).statusCode;
      if (back !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    expect(back).toBe(200);
  } finally {
    await svc.close();
  }
});

test('POL008_입장루프시동은정한간격으로돌아_1초칸마다정한수만큼부르고_서비스를닫으면멈춘다', async () => {
  // 실제 시계: 입장 루프가 스스로 돈다(간격 50ms). 1초 칸마다 한 번만 부르므로 부른 칸의 초가 서로 다르다
  const svc: PlatformService = await createService({
    name: 'v0-monolith',
    module: AppModule.register({ queue: { redis, tickIntervalMs: 50 } }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: quiet(),
  });
  const admin = createQueueAdmin(redis);
  await admin.open('ticker-1', { admitPerSecond: 1 });
  for (const pid of ['t1', 't2', 't3']) {
    expect((await svc.http.inject({ method: 'POST', url: '/v1/queues/ticker-1/entries', headers: fanHeaders(pid) })).statusCode).toBe(201);
  }
  const end = Date.now() + 4_000;
  let log = await admin.servingLog('ticker-1');
  while (Date.now() < end && !log.some((e) => e.serving >= 2)) {
    await new Promise((r) => setTimeout(r, 50));
    log = await admin.servingLog('ticker-1');
  }
  await svc.close();
  const called = log.filter((e) => e.called > 0);
  expect(called.length).toBeGreaterThanOrEqual(2);
  expect(called.every((e) => e.called === 1)).toBe(true);
  const seconds = log.map((e) => Math.floor(e.atMs / 1000));
  expect(new Set(seconds).size).toBe(seconds.length);

  // 닫은 뒤에는 더 부르지 않는다
  const before = (await admin.servingLog('ticker-1')).length;
  await new Promise((r) => setTimeout(r, 1_300));
  expect((await admin.servingLog('ticker-1')).length).toBe(before);
}, 15_000);

// ───────── 두 번째 새 맥락 리뷰 결함의 재현 시험 ─────────

const settle = <T>(p: Promise<T>) => p.then(() => 'resolved' as const, () => 'rejected' as const);

test('FR007_대기열Redis가연결만받고답하지않으면_시작은마감안에실패한다', async () => {
  // queue-admission §13 '연결과 시간 초과': 시작할 때 정한 시간 안에 붙지 못하면 시작하지 않는다(조용히 매달리지 않는다)
  pauseValkey(valkey);
  try {
    const r = await within(15_000, settle(createV0Redis(valkey.url)));
    expect(r.done, `시작이 15초 안에 끝나지 않았다(${Math.round(r.ms)}ms)`).toBe(true);
    if (r.done) {
      expect(r.value).toBe('rejected');
      expect(r.ms).toBeLessThan(8_000);
    }
  } finally {
    unpauseValkey(valkey);
  }
}, 30_000);

test('FR007_대기열Redis가멈춘채연결을닫아도_닫기는곧끝난다', async () => {
  const own = await createV0Redis(valkey.url);
  pauseValkey(valkey);
  try {
    // 마감을 넘겨 버린 명령이 응답 대기 목록에 남는다
    await within(150, settle(own.sendCommand(['INCR', 'close-probe'])));
    const r = await within(5_000, settle(own.close()));
    expect(r.done, `닫기가 5초 안에 끝나지 않았다(${Math.round(r.ms)}ms)`).toBe(true);
    if (r.done) expect(r.ms).toBeLessThan(2_000);
  } finally {
    unpauseValkey(valkey);
  }
}, 30_000);

test('FR007_마감이지난뒤에온스크립트없음답으로는_EVAL을새로보내지않는다', async () => {
  // §13 '연결과 시간 초과': 마감을 넘긴 명령은 결과를 모르므로 다시 보내지 않는다
  const sent: string[] = [];
  const slowNoScript = {
    async sendCommand(args: string[]) {
      sent.push(args[0]!);
      if (args[0] === 'EVALSHA') {
        await new Promise((r) => setTimeout(r, 150)); // 마감 100ms 뒤에
        throw new Error('NOSCRIPT No matching script.');
      }
      return redis.sendCommand(args);
    },
  };
  const admin = createQueueAdmin(slowNoScript);
  await expect(admin.open('late-eval', { admitPerSecond: 1 })).rejects.toThrow();
  await new Promise((r) => setTimeout(r, 300));
  expect(sent).not.toContain('EVAL');
});

test('POL008_입장루프가한회차에서실패하면_그회차ID와원인을기록한다', async () => {
  const lines: string[] = [];
  const capture = new Writable({
    write: (c, _e, cb) => {
      lines.push(String(c));
      cb();
    },
  });
  const admin = createQueueAdmin(redis);
  await admin.open('log-bad', { admitPerSecond: 1 });
  await redis.sendCommand(['SET', 'q0:{event:log-bad}:waiting', 'broken']);
  const svc = await createService({
    name: 'v0-monolith',
    module: AppModule.register({ queue: { redis, tickIntervalMs: 50 } }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: capture,
  });
  try {
    const end = Date.now() + 3_000;
    const hit = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.eventId === 'log-bad' && typeof l.err === 'object');
    while (Date.now() < end && !hit()) await new Promise((r) => setTimeout(r, 50));
    const line = hit();
    expect(line, `회차 ID가 든 실패 기록이 없다: ${lines.join('').slice(0, 500)}`).toBeDefined();
    expect(JSON.stringify(line!.err)).toMatch(/WRONGTYPE/);
  } finally {
    await svc.close();
    await redis.sendCommand(['DEL', 'q0:{event:log-bad}:waiting']);
    await redis.sendCommand(['SREM', 'q0:events', 'log-bad']);
  }
});
