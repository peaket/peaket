// 온세일 구간의 정상 로그 줄 표본 신호 LOG_SAMPLING을 ops-svc가 내는지 본다(F-02-5 OPS-300, docs/features/control-tower.md §14 C-T75 ①③④,
// ADR-0334 결정 1·3, POL-028, docs/api/asyncapi.yaml SettingChanged·LogSamplingValue, BAT-215가 넘긴 생산 몫).
// - 계획(docs/review/plans/F-02-5.md 8.2)의 이름 그대로: domain/log-sampling.ts의
//   logSamplingEndOf·logSamplingSettingOf·LOG_SAMPLING_ONE_IN, 포트 OnsaleScheduleSource·SettingsPublisher, 응용 PublishOnsaleLogSampling.runOnce.
// - 실제 응용·도메인·메모리 저장소(MemoryCommandStore가 SettingsPublisher를 구현, Outbox 메시지는 settingOutboxMessage를 지난 것)를 돌리고,
//   바꾸는 것은 core-svc 일정 읽기 포트(다른 서비스 호출, 허용 목록) 하나다. 짝 가짜는 포트를 implements하고 [fromMs, untilMs] 안의 오픈만 준다.
// - C-T75 ④는 두 복제가 낸 Outbox 메시지 둘을 플랫폼의 실제 소비(startControlSync + 운영 해독기 controlEventCodec)에 넣어 한 번만 적용되는지 본다.
//   Kafka 대신 방송형 읽기 포트(BroadcastSource)를 implements한 메모리 대역을 쓴다(진짜 짝은 packages/platform test-int/control-sync.int.test.ts).
// - 정본 값: 윈도우 [오픈 − 10분, 오픈 + 60분)(POL-028), 대형·중형만(규모 없는 회차는 소형), 걸친 윈도우 끝 가운데 가장 늦은 것이 expiresAt,
//   끝이 바뀔 때만 다시 낸다, 범위 PLATFORM·메시지 키 PLATFORM:LOG_SAMPLING:*·oneIn 100, 행위자 SYSTEM, commandId·eventKey는 expiresAt에서 정한다,
//   core를 읽지 못하면 내지 않는다(ADR-0334 결정 1·3, docs/observability.md §7 '온세일 구간에 100').
import 'reflect-metadata';
import { SettingChanged } from '@peaket/contracts/asyncapi';
import { CONTROL_TOPICS, controlEventCodec, createService, fakeClock, startControlSync, type BroadcastRecord, type BroadcastSource, type ControlSync } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  LOG_SAMPLING_ONE_IN,
  MemoryCommandStore,
  PublishOnsaleLogSampling,
  SYSTEM_ACTOR_REF,
  logSamplingEndOf,
  logSamplingSettingOf,
  settingEventKey,
  type CommandExecutor,
  type OnsaleOpen,
  type OnsaleScheduleSource,
} from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from './support.js';

const MIN = 60_000;
/** 대형 회차 A의 오픈 시각 T(KST 20:00) */
const T = Date.parse('2026-12-05T11:00:00.000Z');
const A = '1a000000-0000-4000-8000-00000000000a';
const B = '1b000000-0000-4000-8000-00000000000b';
const C = '1c000000-0000-4000-8000-00000000000c';
const D = '1d000000-0000-4000-8000-00000000000d';
/** 정본(C-T75): 대형 A는 T, 중형 B는 T+30분, 소형 C는 따로(A·B 구간과 겹치지 않게 T+3시간), 규모 없는 D는 T+4시간 */
const OPENS: readonly OnsaleOpen[] = [
  { eventId: A, opensAtMs: T, scale: 'LARGE' },
  { eventId: B, opensAtMs: T + 30 * MIN, scale: 'MEDIUM' },
  { eventId: C, opensAtMs: T + 180 * MIN, scale: 'SMALL' },
  { eventId: D, opensAtMs: T + 240 * MIN, scale: null },
];
/** 온세일 비율(C-T75 ①, docs/observability.md §7) */
const ONSALE_ONE_IN = 100;
const MESSAGE_KEY = 'PLATFORM:LOG_SAMPLING:*';
const iso = (ms: number) => new Date(ms).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** core-svc 회차 일정 읽기 짝 가짜(OnsaleScheduleSource 포트). 물은 구간 [fromMs, untilMs] 안의 오픈만 준다. fail이면 읽기 실패로 던진다 */
class FakeSchedule implements OnsaleScheduleSource {
  fail = false;
  readonly asked: Array<{ fromMs: number; untilMs: number }> = [];
  constructor(private readonly opens: readonly OnsaleOpen[]) {}
  async opensBetween(fromMs: number, untilMs: number): Promise<readonly OnsaleOpen[]> {
    this.asked.push({ fromMs, untilMs });
    if (this.fail) throw Object.assign(new Error('core-svc 503'), { status: 503 });
    return this.opens.filter((o) => o.opensAtMs >= fromMs && o.opensAtMs <= untilMs);
  }
}

function setup(opens: readonly OnsaleOpen[] = OPENS) {
  const clock = fakeClock({ now: T - 30 * MIN });
  const store = new MemoryCommandStore(new MemoryAuditChain());
  const schedule = new FakeSchedule(opens);
  const replica = () => new PublishOnsaleLogSampling({ schedule, publisher: store, clock });
  return { clock, store, schedule, replica, job: replica() };
}

/** 시계를 at으로 옮겨 한 바퀴 돈다 */
async function roundAt(s: ReturnType<typeof setup>, job: PublishOnsaleLogSampling, at: number) {
  s.clock.advance(at - s.clock.now());
  return job.runOnce();
}

const sampling = (s: ReturnType<typeof setup>) => s.store.outboxSettings().filter((o) => o.setting.kind === 'LOG_SAMPLING');
const payloadOf = (m: { payload: Uint8Array }) => JSON.parse(Buffer.from(m.payload).toString('utf8')) as Record<string, unknown>;

describe('C-T75 ① 대형·중형 오픈 T−10분에 LOG_SAMPLING을 한 번 낸다', () => {
  test('C-T75 ① T−10분 직전(−1ms)에는 사건이 없고, T−10분 정각에 PLATFORM·oneIn 100·expiresAt T+60분 사건이 하나 나온다', async () => {
    const s = setup();
    expect(await roundAt(s, s.job, T - 10 * MIN - 1)).toEqual({ status: 'OUTSIDE' });
    expect(sampling(s)).toEqual([]);

    expect(await roundAt(s, s.job, T - 10 * MIN)).toEqual({ status: 'PUBLISHED', expiresAtMs: T + 60 * MIN });
    const rows = sampling(s);
    expect(rows).toHaveLength(1);
    const { setting, message } = rows[0]!;
    expect(setting).toMatchObject({ kind: 'LOG_SAMPLING', scope: 'PLATFORM', target: '*', value: { oneIn: ONSALE_ONE_IN }, expiresAtMs: T + 60 * MIN, actorRef: SYSTEM_ACTOR_REF });
    expect(message.topic).toBe('control.settings');
    expect(message.topic).toBe(CONTROL_TOPICS.settings);
    expect(message.key).toBe(MESSAGE_KEY);
    const body = payloadOf(message);
    expect(SettingChanged.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ key: 'LOG_SAMPLING', scope: 'PLATFORM', value: { oneIn: ONSALE_ONE_IN }, expiresAt: iso(T + 60 * MIN), actor: SYSTEM_ACTOR_REF });
    expect(body.commandId).toMatch(UUID);
    expect(body.eventKey).toBe(settingEventKey(String(body.commandId), 'LOG_SAMPLING', 'PLATFORM'));
  });

  test('C-T75 ① 끝이 그대로면 다음 바퀴(1분 뒤·T 정각·T+19분)는 UNCHANGED이고 사건은 하나뿐이다', async () => {
    const s = setup();
    await roundAt(s, s.job, T - 10 * MIN);
    for (const at of [T - 9 * MIN, T, T + 19 * MIN]) expect(await roundAt(s, s.job, at), iso(at)).toEqual({ status: 'UNCHANGED', expiresAtMs: T + 60 * MIN });
    expect(sampling(s)).toHaveLength(1);
  });

  test('C-T75 ① 소형 C의 구간과 규모 없는 D(소형으로 본다)의 구간에는 사건이 나오지 않는다', async () => {
    const s = setup();
    for (const at of [T + 170 * MIN, T + 180 * MIN, T + 230 * MIN, T + 240 * MIN, T + 299 * MIN]) {
      expect(await roundAt(s, s.job, at), iso(at)).toEqual({ status: 'OUTSIDE' });
    }
    expect(sampling(s)).toEqual([]);
  });

  test('C-T75 ① 오픈 뒤에 처음 돈 복제(재시작)도 구간 안이면 지난 오픈의 윈도우를 보고 같은 끝(T+60분)을 낸다', async () => {
    // A만 있는 일정: 과거 오픈도 읽어야 T+59분 59.999초까지 구간 안이다
    const s = setup([{ eventId: A, opensAtMs: T, scale: 'LARGE' }]);
    expect(await roundAt(s, s.job, T + 60 * MIN - 1)).toEqual({ status: 'PUBLISHED', expiresAtMs: T + 60 * MIN });
    expect(await roundAt(s, s.job, T + 60 * MIN)).toEqual({ status: 'OUTSIDE' });
    expect(sampling(s)).toHaveLength(1);
  });
});

describe('C-T75 ③(생산 쪽) 겹친 윈도우가 끝을 늦추면 한 번 더 낸다', () => {
  test('C-T75 ③ T+20분 직전은 그대로, T+20분 정각에 expiresAt T+90분 사건이 한 번 더, T+60분에도 새 사건 없음, T+90분부터 사건 없음', async () => {
    const s = setup();
    await roundAt(s, s.job, T - 10 * MIN);
    expect(await roundAt(s, s.job, T + 20 * MIN - 1)).toEqual({ status: 'UNCHANGED', expiresAtMs: T + 60 * MIN });
    expect(await roundAt(s, s.job, T + 20 * MIN)).toEqual({ status: 'PUBLISHED', expiresAtMs: T + 90 * MIN });
    expect(await roundAt(s, s.job, T + 60 * MIN)).toEqual({ status: 'UNCHANGED', expiresAtMs: T + 90 * MIN });
    expect(await roundAt(s, s.job, T + 90 * MIN - 1)).toEqual({ status: 'UNCHANGED', expiresAtMs: T + 90 * MIN });
    expect(await roundAt(s, s.job, T + 90 * MIN)).toEqual({ status: 'OUTSIDE' });
    const rows = sampling(s);
    expect(rows.map((r) => r.setting.expiresAtMs)).toEqual([T + 60 * MIN, T + 90 * MIN]);
    expect(rows.map((r) => r.setting.occurredAtMs)).toEqual([T - 10 * MIN, T + 20 * MIN]);
    // 끝이 다르면 다른 사건이다(commandId·eventKey가 다르다)
    const [first, second] = rows.map((r) => payloadOf(r.message));
    expect(second!.commandId).not.toBe(first!.commandId);
    expect(second!.eventKey).not.toBe(first!.eventKey);
    expect(second!.expiresAt).toBe(iso(T + 90 * MIN));
  });
});

/** 파티션 하나짜리 방송형 토픽의 메모리 대역(BroadcastSource 포트 implements). Outbox 메시지 바이트를 그대로 넣는다 */
class MemoryBroadcast implements BroadcastSource {
  readonly topics = new Map<string, BroadcastRecord[]>();
  #wake: (() => void)[] = [];

  append(topic: string, key: string, value: Buffer, timestamp: number): void {
    const list = this.topics.get(topic) ?? [];
    list.push({ topic, partition: 0, offset: BigInt(list.length), key, value, headers: {}, timestamp });
    this.topics.set(topic, list);
    for (const w of this.#wake.splice(0)) w();
  }

  async watermarks(topic: string) {
    return new Map([[0, { low: 0n, high: BigInt(this.topics.get(topic)?.length ?? 0) }]]);
  }

  async offsetsAt(topic: string, at: number) {
    const list = this.topics.get(topic) ?? [];
    const i = list.findIndex((r) => r.timestamp >= at);
    return new Map([[0, BigInt(i < 0 ? list.length : i)]]);
  }

  async read(topic: string, from: Map<number, bigint>, onRecord: (r: BroadcastRecord) => Promise<void> | void, signal: AbortSignal) {
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

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('C-T75 ④ ops-svc 복제 둘이 같은 구간을 함께 본다', () => {
  test('C-T75 ④ 복제 둘이 같은 끝을 3초 차이로 내도 commandId·eventKey·메시지 키가 같고, 서비스 파드는 둘을 받아 한 번만 적용한다', async () => {
    const s = setup();
    const one = s.replica();
    const two = s.replica();
    expect(await roundAt(s, one, T - 10 * MIN)).toEqual({ status: 'PUBLISHED', expiresAtMs: T + 60 * MIN });
    expect(await roundAt(s, two, T - 10 * MIN + 3_000)).toEqual({ status: 'PUBLISHED', expiresAtMs: T + 60 * MIN });
    const rows = sampling(s);
    expect(rows).toHaveLength(2);
    const [b1, b2] = rows.map((r) => payloadOf(r.message));
    expect(b2!.commandId).toBe(b1!.commandId);
    expect(b2!.eventKey).toBe(b1!.eventKey);
    expect(rows[1]!.message.key).toBe(rows[0]!.message.key);
    expect(b2!.expiresAt).toBe(b1!.expiresAt);

    // 서비스 파드(플랫폼 실제 소비). 시작 설정 값은 기본 10·온세일 100과 다른 7
    const clock = fakeClock({ now: T - 10 * MIN + 5_000 });
    const executor: CommandExecutor = { execute: async () => ({ status: 'ACKED', ackedAtMs: clock.now() }) };
    const svc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, executor, auditChain: new MemoryAuditChain() }),
      env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '7' },
      clock,
      logDestination: quiet(),
      adminAuthz: new FakeIdentity(),
    });
    closers.push(() => svc.close());
    expect(svc.logs.sampleOneIn).toBe(7);
    const applied = vi.spyOn(svc.logs, 'setSampleOneIn');
    const broker = new MemoryBroadcast();
    for (const r of rows) broker.append(CONTROL_TOPICS.settings, r.message.key, Buffer.from(r.message.payload), r.setting.occurredAtMs);
    // 두 사건 뒤에 다른 설정 하나를 두어, 그것이 처리되면 앞의 둘도 처리된 것으로 본다(파티션 하나 안의 차례)
    const after = 'PLATFORM:FEATURE_FLAG:reviews';
    const sentinel = {
      commandId: '2f000000-0000-4000-8000-000000000001',
      key: 'FEATURE_FLAG',
      scope: 'PLATFORM',
      value: { enabled: true },
      actor: SYSTEM_ACTOR_REF,
      occurredAt: iso(T - 10 * MIN + 4_000),
      eventKey: '2f000000-0000-4000-8000-000000000002',
    };
    broker.append(CONTROL_TOPICS.settings, after, Buffer.from(JSON.stringify(sentinel), 'utf8'), T - 10 * MIN + 4_000);
    const sync: ControlSync = startControlSync(svc, { source: broker, codec: controlEventCodec, sessions: false, retryMs: 10 });
    closers.push(() => sync.stop());
    await vi.waitFor(() => expect(sync.settings.get(after)).not.toBeUndefined(), { timeout: 2_000, interval: 5 });
    expect(applied.mock.calls.filter(([n]) => n === ONSALE_ONE_IN)).toHaveLength(1);
    expect(svc.logs.sampleOneIn).toBe(ONSALE_ONE_IN);
    expect(sync.settings.get(MESSAGE_KEY)?.expiresAt).toBe(T + 60 * MIN);
  });
});

describe('F025-LOGS 생산 규칙 세부(ADR-0334 결정 3)', () => {
  test('F025-LOGS ① 윈도우 경계: 오픈 −10분 정각은 안, −10분 −1ms는 밖, +60분 −1ms는 안, +60분 정각은 밖이다. 겹치면 가장 늦은 끝이다', () => {
    const big: OnsaleOpen = { eventId: A, opensAtMs: T, scale: 'LARGE' };
    expect(logSamplingEndOf([big], T - 10 * MIN - 1)).toBeUndefined();
    expect(logSamplingEndOf([big], T - 10 * MIN)).toBe(T + 60 * MIN);
    expect(logSamplingEndOf([big], T + 60 * MIN - 1)).toBe(T + 60 * MIN);
    expect(logSamplingEndOf([big], T + 60 * MIN)).toBeUndefined();
    const mid: OnsaleOpen = { eventId: B, opensAtMs: T + 30 * MIN, scale: 'MEDIUM' };
    expect(logSamplingEndOf([mid, big], T + 20 * MIN)).toBe(T + 90 * MIN);
    expect(logSamplingEndOf([big, mid], T + 20 * MIN - 1)).toBe(T + 60 * MIN);
  });

  test('F025-LOGS ② 소형과 규모 없음은 윈도우가 없고, 빈 일정은 구간 밖이다', () => {
    expect(logSamplingEndOf([{ eventId: C, opensAtMs: T, scale: 'SMALL' }], T)).toBeUndefined();
    expect(logSamplingEndOf([{ eventId: D, opensAtMs: T, scale: null }], T)).toBeUndefined();
    expect(logSamplingEndOf([], T)).toBeUndefined();
  });

  test('F025-LOGS ③ 사건 꼴: 같은 끝이면 낸 시각이 달라도 commandId가 같고, 끝이 다르면 다르다. 행위자는 SYSTEM, 값은 oneIn 100이다', () => {
    const a = logSamplingSettingOf(T + 60 * MIN, T - 10 * MIN);
    const b = logSamplingSettingOf(T + 60 * MIN, T - 7 * MIN);
    const c = logSamplingSettingOf(T + 90 * MIN, T + 20 * MIN);
    expect(a).toEqual({
      kind: 'LOG_SAMPLING',
      scope: 'PLATFORM',
      target: '*',
      value: { oneIn: 100 },
      expiresAtMs: T + 60 * MIN,
      occurredAtMs: T - 10 * MIN,
      actorRef: SYSTEM_ACTOR_REF,
      commandId: a.commandId,
    });
    expect(a.commandId).toMatch(UUID);
    expect(b.commandId).toBe(a.commandId);
    expect(b.occurredAtMs).toBe(T - 7 * MIN);
    expect(c.commandId).not.toBe(a.commandId);
    expect(LOG_SAMPLING_ONE_IN).toBe(100);
  });

  test('F025-LOGS ④ core 일정을 읽지 못하면 SCHEDULE_UNAVAILABLE이고 사건을 내지 않으며, 이미 낸 값은 그대로 둔다(되돌리는 사건 없음)', async () => {
    const s = setup();
    s.schedule.fail = true;
    expect(await roundAt(s, s.job, T - 10 * MIN)).toEqual({ status: 'SCHEDULE_UNAVAILABLE' });
    expect(sampling(s)).toEqual([]);
    s.schedule.fail = false;
    expect(await roundAt(s, s.job, T - 9 * MIN)).toEqual({ status: 'PUBLISHED', expiresAtMs: T + 60 * MIN });
    s.schedule.fail = true;
    for (const at of [T + 20 * MIN, T + 30 * MIN]) expect(await roundAt(s, s.job, at), iso(at)).toEqual({ status: 'SCHEDULE_UNAVAILABLE' });
    expect(sampling(s).map((r) => r.setting.expiresAtMs)).toEqual([T + 60 * MIN]);
    // 다시 읽히면 그때 걸친 끝(T+90분)을 낸다
    s.schedule.fail = false;
    expect(await roundAt(s, s.job, T + 31 * MIN)).toEqual({ status: 'PUBLISHED', expiresAtMs: T + 90 * MIN });
  });

  test('F025-LOGS ⑤ 일정은 앞으로 2시간 안의 오픈을 읽는다: T−10분 바퀴의 물음 구간이 T(오픈)와 T+110분을 덮는다', async () => {
    const s = setup();
    await roundAt(s, s.job, T - 10 * MIN);
    const q = s.schedule.asked.at(-1)!;
    expect(q.fromMs).toBeLessThanOrEqual(T - 10 * MIN);
    expect(q.untilMs).toBeGreaterThanOrEqual(T - 10 * MIN + 120 * MIN);
  });
});
