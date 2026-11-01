// Outbox 릴레이의 반복·늘려 쉬기·지표(openspec 변경 add-idempotency-and-outbox 결정 9, ADR-0116 결정 3·5). DB는 통합 시험이 본다.
import { getEventListeners } from 'node:events';
import { Registry } from '@prometheus-io/client';
import { describe, expect, test } from 'vitest';
import { OUTBOX_RELAY_DEFAULTS, OutboxRelay, OutboxRelayMetrics, fakeClock, type Database } from '../src/index.js';
import { realSleep } from '../src/outbox-relay.js';

/** relayOnce를 각본대로 돌리는 릴레이(DB 없이 반복만 본다) */
class ScriptedRelay extends OutboxRelay {
  calls = 0;
  constructor(
    private readonly script: (number | Error)[],
    o: ConstructorParameters<typeof OutboxRelay>[0],
  ) {
    super(o);
  }
  override async relayOnce(): Promise<number> {
    const next = this.script[this.calls++];
    if (next === undefined) return 0;
    if (next instanceof Error) throw next;
    return next;
  }
}

function harness(script: (number | Error)[], o: { leader?: () => boolean; maxSleeps?: number } = {}) {
  const clock = fakeClock();
  const registry = new Registry();
  const metrics = new OutboxRelayMetrics(registry, 'purchase-svc');
  const sleeps: number[] = [];
  const stop = new AbortController();
  const relay = new ScriptedRelay(script, {
    database: {} as Database,
    publisher: { publish: async () => {} },
    leader: { isLeader: o.leader ?? (() => true) },
    clock,
    metrics,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms);
      if (sleeps.length >= (o.maxSleeps ?? 12)) stop.abort();
    },
  });
  return { relay, sleeps, stop, registry, clock };
}

const value = async (registry: Registry, name: string) => {
  const m = (await registry.getMetricsAsJSON()).find((x) => x.name === name) as { values: { value: number; labels: Record<string, string> }[] } | undefined;
  return m?.values.find((v) => v.labels.service === 'purchase-svc')?.value;
};

describe('반복(결정 9)', () => {
  test('FND080_기본값은_묶음500_주기100ms_늘려쉬기100ms에서5초_보내기상한10초다', () => {
    expect(OUTBOX_RELAY_DEFAULTS).toMatchObject({
      batchSize: 500,
      pollMs: 100,
      backoffMinMs: 100,
      backoffMaxMs: 5_000,
      publishTimeoutMs: 10_000,
      statementTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 30_000,
      measureEveryMs: 5_000,
    });
  });

  test('FND080_꽉찬묶음은쉬지않고이어가고_덜찬묶음뒤에는100ms쉰다', async () => {
    const h = harness([500, 500, 3, 0], { maxSleeps: 2 });
    await h.relay.runLoop(h.stop.signal);
    expect(h.relay.calls).toBe(4);
    expect(h.sleeps).toEqual([100, 100]);
  });

  test('ASVS_13_1_3_FND080_실패하면0_1초에서5초까지늘려쉬고_성공하면처음으로돌린다 [ASVS v5.0.0-13.1.3]', async () => {
    const e = new Error('브로커 없음');
    const h = harness([e, e, e, e, e, e, e, e, 1, e], { maxSleeps: 10 });
    await h.relay.runLoop(h.stop.signal);
    expect(h.sleeps).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000, 100, 100]);
    expect(await value(h.registry, 'outbox_relay_errors_total')).toBe(9);
  });

  test('FND080_리더가아니면_묶음을돌지않는다', async () => {
    const h = harness([500], { leader: () => false, maxSleeps: 3 });
    await h.relay.runLoop(h.stop.signal);
    expect(h.relay.calls).toBe(0);
    expect(h.sleeps).toEqual([100, 100, 100]);
  });

  test('FND080_보낸수와묶음시간을지표로낸다', async () => {
    const h = harness([500, 7], { maxSleeps: 1 });
    await h.relay.runLoop(h.stop.signal);
    expect(await value(h.registry, 'outbox_relay_published_total')).toBe(507);
    const batch = (await h.registry.getMetricsAsJSON()).find((x) => x.name === 'outbox_relay_batch_seconds') as { values: { metricName?: string; value: number }[] };
    expect(batch.values.find((v) => v.metricName === 'outbox_relay_batch_seconds_count')?.value).toBe(2);
  });
});

test('FND080_리뷰_잠이끝나면_오래사는멈춤신호에붙인리스너를뗀다', async () => {
  // 코드 리뷰 2026-11-01: 끝난 잠의 abort 리스너가 남아 100ms마다 하나씩 쌓였다(며칠이면 이벤트 루프가 느려진다)
  const stop = new AbortController();
  for (let i = 0; i < 30; i += 1) await realSleep(1, stop.signal);
  expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  const sleeping = realSleep(60_000, stop.signal);
  stop.abort();
  await sleeping;
});

describe('지표 이름(결정 9·8)', () => {
  test('FND080_릴레이와파티션지표를_service라벨로낸다', async () => {
    const registry = new Registry();
    const m = new OutboxRelayMetrics(registry, 'purchase-svc');
    m.isLeader.set({ service: 'purchase-svc' }, 1);
    m.lag.set({ service: 'purchase-svc' }, 0);
    m.partitionsAhead.set({ service: 'purchase-svc' }, 7);
    m.partitionsOverdue.set({ service: 'purchase-svc' }, 0);
    const names = (await registry.getMetricsAsJSON()).map((x) => x.name).sort();
    expect(names).toEqual([
      'outbox_partitions_ahead_days',
      'outbox_partitions_overdue',
      'outbox_relay_batch_seconds',
      'outbox_relay_errors_total',
      'outbox_relay_is_leader',
      'outbox_relay_lag_seconds',
      'outbox_relay_published_total',
    ]);
  });
});
