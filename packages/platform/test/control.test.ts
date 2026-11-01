// 제어 상태 시작 작업·방송형 소비·다시 맞춤과 준비 표시(openspec 변경 add-maintenance-control-and-consumers 결정 7~10,
// ADR-0103 결정 2·3·4, ADR-0143 결정 2, D-T29). Kafka 대신 방송형 읽기 포트의 대역을 쓴다. 실제 Kafka는 kafka.int.test.ts.
import { afterEach, describe, expect, test } from 'vitest';
import {
  CONTROL_SYNC_DEFAULTS,
  CONTROL_TOPICS,
  startControlSync,
  type BroadcastRecord,
  type BroadcastSource,
  type ControlEntry,
} from '../src/index.js';
import { jsonControlCodec } from '../src/testing.js';
import { sample, start, type Started } from './fixture.js';

const MIN = 60_000;

/** 파티션 하나짜리 토픽 대역. up이 거짓이면 Kafka에 닿지 않는 것처럼 실패한다 */
class FakeBroker implements BroadcastSource {
  up = true;
  calls = 0;
  readonly topics = new Map<string, BroadcastRecord[]>();
  readonly asked: { topic: string; at: number }[] = [];
  #wake: (() => void)[] = [];

  append(topic: string, key: string, value: unknown, timestamp: number) {
    const list = this.topics.get(topic) ?? [];
    list.push({ topic, partition: 0, offset: BigInt(list.length), key, value: value === null ? null : Buffer.from(JSON.stringify(value)), headers: {}, timestamp });
    this.topics.set(topic, list);
    for (const w of this.#wake.splice(0)) w();
  }

  async watermarks(topic: string) {
    this.calls += 1;
    if (!this.up) throw new Error('Kafka에 닿지 않는다');
    return new Map([[0, { low: 0n, high: BigInt(this.topics.get(topic)?.length ?? 0) }]]);
  }

  async offsetsAt(topic: string, at: number) {
    this.calls += 1;
    if (!this.up) throw new Error('Kafka에 닿지 않는다');
    this.asked.push({ topic, at });
    const list = this.topics.get(topic) ?? [];
    const i = list.findIndex((r) => r.timestamp >= at);
    return new Map([[0, BigInt(i < 0 ? list.length : i)]]);
  }

  async read(topic: string, from: Map<number, bigint>, onRecord: (r: BroadcastRecord) => Promise<void> | void, signal: AbortSignal) {
    this.calls += 1;
    if (!this.up) throw new Error('Kafka에 닿지 않는다');
    let next = Number(from.get(0) ?? 0n);
    while (!signal.aborted) {
      const list = this.topics.get(topic) ?? [];
      while (next < list.length) await onRecord(list[next++]!);
      await new Promise<void>((r) => {
        this.#wake.push(r);
        signal.addEventListener('abort', () => r(), { once: true });
      });
    }
  }
}

const fast = { degradeAfterMs: 80, retryMs: 10, reconcileMs: 20, measureMs: 20 };
const until = async (cond: () => boolean | Promise<boolean>, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('기다린 조건이 오지 않았다');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

async function boot(o: { broker?: FakeBroker; control?: () => Promise<ControlEntry[]>; options?: Partial<typeof fast> } = {}) {
  const s: Started = await start();
  const broker = o.broker ?? new FakeBroker();
  const sync = startControlSync(s.svc, {
    source: broker,
    codec: jsonControlCodec,
    controlState: o.control ? { read: o.control } : undefined,
    ...fast,
    ...o.options,
  });
  stops.push(async () => {
    await sync.stop();
    await s.svc.close();
  });
  const ready = async () => s.svc.management.inject({ method: 'GET', url: '/ready' });
  return { s, broker, sync, ready };
}

const setting = (kind: string, _target: string, value: unknown, occurredAt: number, expiresAt: number | null = null) => ({
  commandId: `c-${occurredAt}`,
  key: kind,
  scope: 'PLATFORM',
  value,
  expiresAt,
  actor: '00000000-0000-4000-8000-000000000000',
  occurredAt,
  eventKey: `00000000-0000-4000-8000-${String(occurredAt).padStart(12, '0').slice(-12)}`,
});

describe('D-T29 시작 작업과 준비 표시', () => {
  test('D_T29_세작업이끝나기전에는_ready가503이고남은작업을알리며_끝나면200이다', async () => {
    expect(CONTROL_SYNC_DEFAULTS).toMatchObject({ degradeAfterMs: 30_000, reconcileMs: 2_000, sessionsRewindMs: 15 * MIN });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const broker = new FakeBroker();
    const { ready } = await boot({ broker, control: async () => (await gate, [{ key: 'PLATFORM:SALE_PAUSE', version: 1, value: false }]) });
    const before = await ready();
    expect(before.statusCode).toBe(503);
    expect(JSON.parse(before.payload)).toMatchObject({ status: 'starting' });
    expect((JSON.parse(before.payload) as { pending: string[] }).pending).toContain('control-state');
    release();
    await until(async () => (await ready()).statusCode === 200);
  });

  test('D_T29_제어상태를읽지못하면_Kafka가멀쩡해도계속준비상태가아니다', async () => {
    const { ready } = await boot({
      control: async () => {
        throw new Error('sale_control 읽기 실패');
      },
    });
    await new Promise((r) => setTimeout(r, fast.degradeAfterMs * 3));
    const r = await ready();
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toEqual({ status: 'starting', pending: ['control-state'] });
  });

  test('D_T29_Kafka에닿지않은채뜨면_정한시간뒤준비상태가되고_control_sync_lagging이1이며_돌아와따라잡으면0이다 [ASVS v5.0.0-16.5.2]', async () => {
    const broker = new FakeBroker();
    broker.up = false;
    const { s, ready } = await boot({ broker });
    expect((await ready()).statusCode).toBe(503);
    await until(async () => (await ready()).statusCode === 200);
    const m = await s.metrics();
    expect(sample(m, 'control_sync_lagging', { service: 'demo-svc', kind: 'settings' })).toBe(1);
    expect(sample(m, 'control_sync_lagging', { service: 'demo-svc', kind: 'sessions' })).toBe(1);
    broker.up = true;
    await until(async () => sample(await s.metrics(), 'control_sync_lagging', { service: 'demo-svc', kind: 'sessions' }) === 0);
    expect(sample(await s.metrics(), 'control_sync_lagging', { service: 'demo-svc', kind: 'settings' })).toBe(0);
  });

  test('D_T29_D_T19_ready는의존성을부르지않는다', async () => {
    let reads = 0;
    const broker = new FakeBroker();
    const { ready } = await boot({ broker, control: async () => (reads++, []), options: { reconcileMs: 60_000, measureMs: 60_000 } });
    await until(async () => (await ready()).statusCode === 200);
    const calls = broker.calls;
    const r0 = reads;
    for (let i = 0; i < 20; i += 1) expect((await ready()).statusCode).toBe(200);
    expect(broker.calls).toBe(calls);
    expect(reads).toBe(r0);
  });
});

describe('ADR0103 설정·종료 세션·다시 맞춤', () => {
  test('C_T51_설정은키마다큰판만남기고_지우는표시는지우며_적용판을지표로낸다', async () => {
    const broker = new FakeBroker();
    const now = Date.parse('2026-11-01T00:00:00Z');
    const key = 'PLATFORM:FEATURE_FLAG:reviews';
    // 8일 전에 끈 플래그(압축 토픽에 남아 있다), 그 뒤 옛 판이 늦게 다시 왔다
    broker.append(CONTROL_TOPICS.settings, key, setting('FEATURE_FLAG', 'reviews', { enabled: false }, now - 8 * 24 * 60 * MIN), now - 8 * 24 * 60 * MIN);
    broker.append(CONTROL_TOPICS.settings, key, setting('FEATURE_FLAG', 'reviews', { enabled: true }, now - 9 * 24 * 60 * MIN), now);
    broker.append(CONTROL_TOPICS.settings, 'PLATFORM:FEATURE_FLAG:old', setting('FEATURE_FLAG', 'old', { enabled: true }, now - MIN), now - MIN);
    broker.append(CONTROL_TOPICS.settings, 'PLATFORM:FEATURE_FLAG:old', null, now);
    const { s, sync, ready } = await boot({ broker });
    await until(async () => (await ready()).statusCode === 200);
    expect(sync.settings.get(key)?.value).toEqual({ enabled: false });
    expect(sync.settings.get('PLATFORM:FEATURE_FLAG:old')).toBeUndefined();
    expect(sample(await s.metrics(), 'control_settings_applied_version', { service: 'demo-svc', key })).toBe(now - 8 * 24 * 60 * MIN);
  });

  test('C_T51_만료가지난설정은무시하고_이서비스로그수준은바로적용했다가_만료되면기본으로돌린다', async () => {
    const broker = new FakeBroker();
    const { s, sync, ready } = await boot({ broker });
    await until(async () => (await ready()).statusCode === 200);
    const now = s.clock.now();
    expect(s.svc.logger.level).toBe('info');
    broker.append(CONTROL_TOPICS.settings, 'PLATFORM:LOG_LEVEL:demo-svc', setting('LOG_LEVEL', 'demo-svc', { level: 'DEBUG' }, now, now + 30 * MIN), now);
    broker.append(CONTROL_TOPICS.settings, 'PLATFORM:LOG_LEVEL:other-svc', setting('LOG_LEVEL', 'other-svc', { level: 'TRACE' }, now, now + 30 * MIN), now);
    await until(() => s.svc.logger.level === 'debug');
    s.clock.advance(30 * MIN);
    await until(() => s.svc.logger.level === 'info');
    expect(sync.settings.get('PLATFORM:LOG_LEVEL:demo-svc')).toBeUndefined();
    // 이미 만료된 채 들어온 값은 적용하지 않는다
    broker.append(CONTROL_TOPICS.settings, 'PLATFORM:LOG_LEVEL:demo-svc', setting('LOG_LEVEL', 'demo-svc', { level: 'TRACE' }, now + 1, now), now);
    await new Promise((r) => setTimeout(r, fast.reconcileMs * 3));
    expect(s.svc.logger.level).toBe('info');
  });

  test('I_T48_종료세션은_지금빼기15분부터읽어_종료세션목록에넣는다', async () => {
    const broker = new FakeBroker();
    const s0 = Date.parse('2026-11-01T00:00:00.000Z');
    broker.append(CONTROL_TOPICS.sessionsTerminated, 'acc-1', { accountId: 'acc-1', sessionId: 's-old', reason: 'LOGOUT', terminatedAt: s0 - 20 * MIN }, s0 - 20 * MIN);
    broker.append(CONTROL_TOPICS.sessionsTerminated, 'acc-1', { accountId: 'acc-1', sessionId: 's-1', reason: 'LOGOUT', terminatedAt: s0 - MIN }, s0 - MIN);
    const { s, ready } = await boot({ broker });
    await until(async () => (await ready()).statusCode === 200);
    expect(broker.asked).toEqual([{ topic: CONTROL_TOPICS.sessionsTerminated, at: s0 - 15 * MIN }]);
    expect(s.svc.auth.isTerminated('s-1')).toBe(true);
    expect(s.svc.auth.isTerminated('s-old')).toBe(false);
    // 준비 뒤에 온 사건도 계속 읽는다
    broker.append(CONTROL_TOPICS.sessionsTerminated, 'acc-2', { accountId: 'acc-2', sessionId: 's-2', reason: 'DELETE', terminatedAt: s0 }, s0);
    await until(() => s.svc.auth.isTerminated('s-2'));
  });

  test('ADR0103_제어상태는정한주기마다다시읽어_판번호가큰쪽을남기고_바뀐것을알린다', async () => {
    let stored: ControlEntry[] = [{ key: 'PLATFORM:SALE_PAUSE', version: 3, value: false }];
    const { sync, ready } = await boot({ control: async () => stored });
    await until(async () => (await ready()).statusCode === 200);
    const seen: [string, unknown][] = [];
    sync.control!.onChange((k, e) => seen.push([k, e.value]));
    // 제어 gRPC로 먼저 판 5를 받았다. 저장소가 아직 판 3이면 내리지 않는다
    expect(sync.control!.apply({ key: 'PLATFORM:SALE_PAUSE', version: 5, value: true })).toBe(true);
    await new Promise((r) => setTimeout(r, fast.reconcileMs * 3));
    expect(sync.control!.get('PLATFORM:SALE_PAUSE')).toMatchObject({ version: 5, value: true });
    stored = [{ key: 'PLATFORM:SALE_PAUSE', version: 7, value: false }];
    await until(() => sync.control!.get('PLATFORM:SALE_PAUSE')?.version === 7);
    expect(seen).toEqual([
      ['PLATFORM:SALE_PAUSE', true],
      ['PLATFORM:SALE_PAUSE', false],
    ]);
    expect(sync.control!.apply({ key: 'PLATFORM:SALE_PAUSE', version: 7, value: true })).toBe(false);
  });
});
