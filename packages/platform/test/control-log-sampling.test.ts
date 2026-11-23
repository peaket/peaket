// 온세일 구간의 정상 로그 줄 표본(control.settings LOG_SAMPLING)을 서비스 파드가 받아 적용하고 만료되면 되돌리는지 본다
// (docs/features/control-tower.md C-T75 ②③⑤, ADR-0334 결정 1·2·4, docs/observability.md §7 '표본', POL-028, BUILD_ORDER BAT-215 OPS-020).
// - 사건 생산(ops-svc, C-T75 ①④)은 BAT-365가 본다. 여기서는 ops-svc가 내는 꼴(asyncapi SettingChanged JSON, 시각은 ISO 글)을 운영 해독기(controlEventCodec)로 읽는다.
// - Kafka 대신 방송형 읽기 포트(BroadcastSource)를 구현한 메모리 대역을 쓴다(실제 Kafka는 test-int/control-sync.int.test.ts).
// - 시간: 서비스 시계는 fakeClock, 만료를 알리는 다시 맞춤 주기(setInterval)만 가짜 타이머로 돌린다(한 주기를 정확히 돌려 경계 직전·경계를 잰다).
// - 정본 값: 윈도우는 [오픈 − 10분, 오픈 + 60분)(POL-028, ADR-0334 결정 3), 온세일 비율 oneIn 100, 범위 1~10,000(asyncapi LogSamplingValue).
//   시작 설정 값(PEAKET_LOG_SAMPLE_ONE_IN)은 기본 10과 다르게 7로 고른다.
// - 정상 줄 표본(C-T75 ②)은 정한 trace ID로 확정한다. 운영에서 요청의 trace ID는 자동 계측이 세운 서버 span(활성 OTel 맥락)에서 오고,
//   inject는 node:http를 거치지 않아 그 span이 없다. 그래서 OTel SDK(startTelemetry, 맥락 관리자를 세운다)를 띄우고 요청을 정한 span 맥락 안에서 보낸다.
import { ROOT_CONTEXT, TraceFlags, context, trace } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { CONTROL_TOPICS, controlEventCodec, startControlSync, type BroadcastRecord, type BroadcastSource, type ControlSyncOptions } from '../src/index.js';
import { startTelemetry } from '../src/telemetry.js';
import { sample, start, type LogLine, type Started } from './fixture.js';

// 내보내기 없이 맥락 관리자만 쓴다(span은 어디에도 보내지 않는다)
const telemetry = startTelemetry({ serviceName: 'demo-svc', env: 'ci', spanProcessors: [] });
afterAll(async () => {
  await telemetry.shutdown();
});

// 이 일꾼에서 서비스를 처음 띄우는 값(Nest 모듈 구성 등, 한가할 때 약 1초)을 시험 본문 밖에서 한 번 치른다. 그러지 않으면 파일의 첫 시험이
// 그 값을 떠안아, 붐비는 기계에서 본문 5초 한도를 넘는다(FIX-ct75 실측: 시험 본문의 요청 18건은 약 50ms). 준비 단계만 30초로 둔다
beforeAll(async () => {
  const warm = await start({ PEAKET_ENV: 'ci' });
  await warm.svc.close();
}, 30_000);

const MIN = 60_000;
/** 대형 회차 A의 오픈 시각 T(KST 20:00) */
const T = Date.parse('2026-12-05T11:00:00.000Z');
/** 시작 설정 값(PEAKET_LOG_SAMPLE_ONE_IN). 기본 10·온세일 100과 다르게 고른다 */
const START_ONE_IN = 7;
/** 온세일 비율(C-T75 ①, docs/observability.md §7 '온세일 구간에 100') */
const ONSALE_ONE_IN = 100;
/** 다시 맞춤 주기(시험 값). 이 주기의 가짜 타이머를 한 번 돌리면 만료를 본다 */
const RECONCILE_MS = 25;
const ALL = 'PLATFORM:LOG_SAMPLING:*';
const SERVICE = 'demo-svc';
const ACTOR = '6f1d2c3b-4a59-4e8d-9c7b-0a1b2c3d4e5f';

/** 파티션 하나짜리 방송형 토픽의 메모리 대역(BroadcastSource 포트를 구현한다). 값은 JSON 글 바이트, 읽기를 부른 토픽을 기록한다 */
class MemoryBroadcast implements BroadcastSource {
  readonly topics = new Map<string, BroadcastRecord[]>();
  readonly touched = new Set<string>();
  #wake: (() => void)[] = [];

  append(topic: string, key: string, value: object, timestamp: number): void {
    const list = this.topics.get(topic) ?? [];
    list.push({ topic, partition: 0, offset: BigInt(list.length), key, value: Buffer.from(JSON.stringify(value), 'utf8'), headers: {}, timestamp });
    this.topics.set(topic, list);
    for (const w of this.#wake.splice(0)) w();
  }

  async watermarks(topic: string) {
    this.touched.add(topic);
    return new Map([[0, { low: 0n, high: BigInt(this.topics.get(topic)?.length ?? 0) }]]);
  }

  async offsetsAt(topic: string, at: number) {
    this.touched.add(topic);
    const list = this.topics.get(topic) ?? [];
    const i = list.findIndex((r) => r.timestamp >= at);
    return new Map([[0, BigInt(i < 0 ? list.length : i)]]);
  }

  async read(topic: string, from: Map<number, bigint>, onRecord: (r: BroadcastRecord) => Promise<void> | void, signal: AbortSignal) {
    this.touched.add(topic);
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

const iso = (ms: number) => new Date(ms).toISOString();
let keySeq = 0;
const newEventKey = () => `00000000-0000-4000-8000-${String((keySeq += 1)).padStart(12, '0')}`;

/** ops-svc가 내는 꼴의 LOG_SAMPLING 사건(asyncapi SettingChanged). 칸을 바꿔 틀린 사건도 만든다 */
function sampling(o: { oneIn?: unknown; value?: unknown; occurredAt: number; expiresAt?: number | null; eventKey?: string; scope?: string; key?: string }) {
  const body: Record<string, unknown> = {
    commandId: `cmd-${o.occurredAt}`,
    key: o.key ?? 'LOG_SAMPLING',
    scope: o.scope ?? 'PLATFORM',
    value: 'value' in o ? o.value : { oneIn: o.oneIn ?? ONSALE_ONE_IN },
    actor: ACTOR,
    occurredAt: iso(o.occurredAt),
    eventKey: o.eventKey ?? newEventKey(),
  };
  if (o.expiresAt !== null) body.expiresAt = iso(o.expiresAt ?? T + 60 * MIN);
  return body;
}

const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`기다린 조건이 오지 않았다: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
  vi.useRealTimers();
});

interface Pod {
  s: Started;
  broker: MemoryBroadcast;
  /** 지금 적용된 정상 줄 비율(정규 로그 줄이 읽는 값) */
  oneIn(): number;
  /** 다시 맞춤 주기 하나를 돌린다(만료 알림) */
  sweep(): Promise<void>;
  /** 이 서비스가 처리한 설정 사건의 판(control_settings_applied_version) */
  applied(key?: string): Promise<number | undefined>;
  controlLines(): LogLine[];
}

/** 서비스 파드 하나를 now에 띄워 시작 작업이 끝날 때까지 기다린다. 미리 넣은 사건(broker)이 있으면 새 파드가 그것을 읽는다 */
async function pod(now: number, o: { broker?: MemoryBroadcast; options?: Partial<ControlSyncOptions> } = {}): Promise<Pod> {
  const s = await start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: String(START_ONE_IN) }, { now });
  const broker = o.broker ?? new MemoryBroadcast();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const sync = startControlSync(s.svc, { source: broker, codec: controlEventCodec, degradeAfterMs: 60_000, retryMs: 10, reconcileMs: RECONCILE_MS, measureMs: RECONCILE_MS, ...o.options });
  stops.push(async () => {
    await sync.stop();
    await s.svc.close();
  });
  await until(async () => (await s.svc.management.inject({ method: 'GET', url: '/ready' })).statusCode === 200, '준비 상태');
  return {
    s,
    broker,
    oneIn: () => s.svc.logs.sampleOneIn,
    sweep: async () => {
      await vi.advanceTimersByTimeAsync(RECONCILE_MS);
    },
    applied: async (key = ALL) => sample(await s.metrics(), 'control_settings_applied_version', { service: SERVICE, key }),
    controlLines: () => s.lines.filter((l) => l.kind === 'control-sync'),
  };
}

/** 사건을 넣고 그 판(occurredAt)이 처리될 때까지 기다린다 */
async function deliver(p: Pod, key: string, body: ReturnType<typeof sampling>, kafkaAt: number) {
  p.broker.append(CONTROL_TOPICS.settings, key, body, kafkaAt);
  const version = Date.parse(String(body.occurredAt));
  await until(async () => (await p.applied(key)) === version, `${key} 판 ${body.occurredAt} 처리`);
}

/** 거른 사건은 판이 바뀌지 않으므로 경고 줄로 처리된 것을 본다 */
async function deliverRejected(p: Pod, key: string, body: ReturnType<typeof sampling>, kafkaAt: number) {
  const before = p.controlLines().length;
  p.broker.append(CONTROL_TOPICS.settings, key, body, kafkaAt);
  await until(() => p.controlLines().length > before, `${key} 거름 경고 줄`);
  return p.controlLines().slice(before);
}

const requestLines = (p: Pod) => p.s.requests();

// 정상 표본 문턱(docs/observability.md §7 '표본'): T = 2^56 − ⌊2^56 / N⌋, trace ID 끝 56비트 R ≥ T면 남긴다
const TWO56 = 2n ** 56n;
const threshold = (oneIn: number) => TWO56 - TWO56 / BigInt(oneIn);
const T_START = threshold(START_ONE_IN);
const T_ONSALE = threshold(ONSALE_ONE_IN);
/** 문턱 경계 양쪽의 R. 1/7로 남기는 R이 1/100로 남기는 R을 모두 품는다(T_START < T_ONSALE) */
const R = {
  top: TWO56 - 1n, // 둘 다 남김
  onsaleEdge: T_ONSALE, // 1/100에서 남기는 가장 작은 R
  belowOnsale: T_ONSALE - 1n, // 1/100에서 버림, 1/7에서 남김
  startEdge: T_START, // 1/7에서 남기는 가장 작은 R, 1/100에서 버림
  belowStart: T_START - 1n, // 둘 다 버림
  zero: 0n, // 둘 다 버림
} as const;
type RName = keyof typeof R;
const R_NAMES = Object.keys(R) as RName[];
/** 앞 18자리 head(요청 묶음 구별)와 끝 56비트 R로 만든 trace ID */
const traceWith = (head: string, r: bigint) => `${head}${r.toString(16).padStart(14, '0')}`;
const SPAN_ID = 'b7ad6b7169203331';

/**
 * 정한 trace ID의 span 맥락 안에서 요청한다(표본 표시는 끈다: 남김은 문턱만으로 정해진다).
 * Fastify inject는 then을 부를 때 요청을 보내는 지연 객체라, 맥락 안에서 await해야 처리기가 그 맥락을 본다
 */
const injectAs = (p: Pod, traceId: string, req: { method: string; url: string }) =>
  context.with(trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId: SPAN_ID, traceFlags: TraceFlags.NONE }), async () => await p.s.inject(req));

describe('C-T75 ② 서비스 파드가 LOG_SAMPLING을 받는다(ADR-0334 결정 2·4)', () => {
  test('C-T75 ② LOG_SAMPLING(PLATFORM, oneIn 100)을 받으면 정상 2xx 줄의 sampleRate가 100이고 4xx·5xx 줄은 모두 sampleRate 1로 남는다', async () => {
    // 고른 R이 정본 문턱의 경계 양쪽에 있다(1/7 문턱 < 1/100 문턱)
    expect(T_START < T_ONSALE).toBe(true);
    expect([R.onsaleEdge >= T_ONSALE, R.belowOnsale >= T_ONSALE, R.belowOnsale >= T_START, R.startEdge >= T_START, R.startEdge >= T_ONSALE, R.belowStart >= T_START]).toEqual([
      true,
      false,
      true,
      true,
      false,
      false,
    ]);

    const p = await pod(T - 10 * MIN);
    expect(p.oneIn()).toBe(START_ONE_IN);
    // 시작 설정 값(1/7)일 때 같은 R 묶음: top·onsaleEdge·belowOnsale·startEdge 넷이 sampleRate 7로 남는다
    const before = 'a7a7a7a7a7a7a7a7a7';
    for (const n of R_NAMES) await injectAs(p, traceWith(before, R[n]), { method: 'GET', url: '/v1/demo/items/a1' });
    expect(requestLines(p).map((l) => [l.status, l.traceId, l.sampleRate])).toEqual(
      (['top', 'onsaleEdge', 'belowOnsale', 'startEdge'] as const).map((n) => [200, traceWith(before, R[n]), START_ONE_IN]),
    );

    await deliver(p, ALL, sampling({ occurredAt: T - 10 * MIN, expiresAt: T + 60 * MIN }), T - 10 * MIN);
    expect(p.oneIn()).toBe(ONSALE_ONE_IN);
    const seen = requestLines(p).length;

    // 온세일 1/100: 같은 R 묶음에서 top·onsaleEdge 둘만 sampleRate 100으로 남는다(belowOnsale·startEdge는 이제 버린다)
    const after = 'b100b100b100b100b1';
    for (const n of R_NAMES) await injectAs(p, traceWith(after, R[n]), { method: 'GET', url: '/v1/demo/items/a1' });
    // 4xx·5xx는 표본에서 버릴 trace ID(belowOnsale·zero)여도 모두 sampleRate 1로 남는다
    const err = 'e000e000e000e000e0';
    for (const n of ['belowOnsale', 'zero', 'belowOnsale'] as const) {
      await injectAs(p, traceWith(err, R[n]), { method: 'POST', url: '/v1/demo/holds' });
      await injectAs(p, traceWith(err, R[n]), { method: 'GET', url: '/v1/demo/boom' });
    }
    const lines = requestLines(p).slice(seen);
    expect(lines.filter((l) => l.status === 200).map((l) => [l.traceId, l.sampleRate])).toEqual(
      (['top', 'onsaleEdge'] as const).map((n) => [traceWith(after, R[n]), ONSALE_ONE_IN]),
    );
    expect(lines.filter((l) => l.status !== 200).map((l) => [l.status, l.traceId, l.sampleRate])).toEqual(
      (['belowOnsale', 'zero', 'belowOnsale'] as const).flatMap((n) => [
        [409, traceWith(err, R[n]), 1],
        [500, traceWith(err, R[n]), 1],
      ]),
    );
    // 비율이 바뀐 때 정보 줄 하나(docs/observability.md §7 '표본' 받는 쪽 세부)
    expect(p.controlLines().map((l) => [l.level, l.msg, l.oneIn, l.key, l.expiresAt])).toEqual([['info', 'LOG_SAMPLING 적용', ONSALE_ONE_IN, ALL, iso(T + 60 * MIN)]]);
  });

  test('C-T75 ② 같은 eventKey를 다시 받으면(ops-svc 복제 둘) 다시 적용하지 않아, 늦게 온 첫 사건의 복제가 늘린 끝(T+90분)을 T+60분으로 되돌리지 못한다', async () => {
    const p = await pod(T - 10 * MIN);
    const first = sampling({ occurredAt: T - 10 * MIN, expiresAt: T + 60 * MIN });
    await deliver(p, ALL, first, T - 10 * MIN);
    p.s.clock.advance(30 * MIN);
    const longer = sampling({ occurredAt: T + 20 * MIN, expiresAt: T + 90 * MIN });
    await deliver(p, ALL, longer, T + 20 * MIN);
    // 다른 복제가 같은 사건(같은 eventKey·같은 끝)을 늦게 냈다. 판(occurredAt)은 더 크다
    const replica = { ...first, occurredAt: iso(T + 25 * MIN), commandId: 'cmd-replica-2' };
    p.s.clock.advance(5 * MIN);
    p.broker.append(CONTROL_TOPICS.settings, ALL, replica, T + 25 * MIN);
    // 그 뒤의 다른 대상 사건이 처리되면 앞의 복제도 처리된 것이다(한 파티션, 차례대로)
    await deliver(p, 'PLATFORM:LOG_SAMPLING:other-svc', sampling({ occurredAt: T + 26 * MIN, oneIn: 3, expiresAt: T + 90 * MIN }), T + 26 * MIN);
    expect(await p.applied(ALL)).toBe(T + 20 * MIN);

    p.s.clock.advance(T + 60 * MIN - p.s.clock.now());
    await p.sweep();
    expect(p.oneIn()).toBe(ONSALE_ONE_IN);
    p.s.clock.advance(30 * MIN);
    await p.sweep();
    expect(p.oneIn()).toBe(START_ONE_IN);
    // 다른 서비스 대상(other-svc)은 이 파드에 적용하지 않고 경고도 없다. 처음 적용과 만료 되돌림 두 줄뿐이다
    expect(p.controlLines().map((l) => l.msg)).toEqual(['LOG_SAMPLING 적용', 'LOG_SAMPLING 만료, 시작 설정 값으로 돌림']);
  });

  test('C-T75 ② 범위·갈래·대상·만료 시각이 틀린 사건은 적용하지 않고 경고 줄(kind control-sync, reason) 하나를 남기며, 지금 값과 그 끝은 그대로다', async () => {
    const p = await pod(T - 10 * MIN);
    await deliver(p, ALL, sampling({ occurredAt: T - 10 * MIN, expiresAt: T + 60 * MIN }), T - 10 * MIN);
    // 모두 지금 값(100)과 다른 비율·더 늦은 끝(T+120분)을 들고 온다. 하나라도 적용되면 비율이나 끝이 바뀐다
    const later = T + 120 * MIN;
    const cases: { name: string; key: string; body: ReturnType<typeof sampling>; reason: string }[] = [
      { name: 'oneIn 0', key: ALL, body: sampling({ occurredAt: T - 9 * MIN, oneIn: 0, expiresAt: later }), reason: 'range' },
      { name: 'oneIn 10,001', key: ALL, body: sampling({ occurredAt: T - 8 * MIN, oneIn: 10_001, expiresAt: later }), reason: 'range' },
      { name: 'oneIn 정수 아님', key: ALL, body: sampling({ occurredAt: T - 7 * MIN, oneIn: 2.5, expiresAt: later }), reason: 'range' },
      { name: '음수', key: ALL, body: sampling({ occurredAt: T - 6 * MIN, oneIn: -100, expiresAt: later }), reason: 'range' },
      { name: '다른 갈래(로그 레벨 값)', key: ALL, body: sampling({ occurredAt: T - 5 * MIN, value: { level: 'DEBUG' }, expiresAt: later }), reason: 'branch' },
      { name: '값 null', key: ALL, body: sampling({ occurredAt: T - 4 * MIN, value: null, expiresAt: later }), reason: 'branch' },
      { name: 'key 칸이 LOG_LEVEL', key: ALL, body: sampling({ occurredAt: T - 3 * MIN, key: 'LOG_LEVEL', oneIn: 50, expiresAt: later }), reason: 'branch' },
      { name: '범위가 회차', key: ALL, body: sampling({ occurredAt: T - 2 * MIN, scope: 'ev-a', oneIn: 50, expiresAt: later }), reason: 'scope' },
      { name: '메시지 키 범위가 회차', key: 'ev-a:LOG_SAMPLING:*', body: sampling({ occurredAt: T - 2 * MIN, oneIn: 50, expiresAt: later }), reason: 'scope' },
      { name: '만료 시각 없음', key: ALL, body: sampling({ occurredAt: T - 1 * MIN, oneIn: 50, expiresAt: null }), reason: 'expires_at' },
    ];
    for (const c of cases) {
      const got = await deliverRejected(p, c.key, c.body, p.s.clock.now());
      expect(got, c.name).toEqual([expect.objectContaining({ level: 'warn', kind: 'control-sync', msg: 'LOG_SAMPLING 값 무시', reason: c.reason, key: c.key, eventKey: c.body.eventKey })]);
      expect(p.oneIn(), c.name).toBe(ONSALE_ONE_IN);
    }
    expect(await p.applied(ALL)).toBe(T - 10 * MIN);
    // 끝도 그대로다: 처음 사건의 끝(T+60분)에 시작 설정 값으로 돌아간다
    p.s.clock.advance(T + 60 * MIN - p.s.clock.now());
    await p.sweep();
    expect(p.oneIn()).toBe(START_ONE_IN);
  });

  test('C-T75 ② oneIn 범위의 양 끝 1과 10,000은 적용하고, 서비스 이름 대상이 모든 서비스 대상(*)보다 먼저이며 다른 서비스 대상은 적용하지 않는다', async () => {
    const p = await pod(T - 10 * MIN);
    await deliver(p, ALL, sampling({ occurredAt: T - 10 * MIN, oneIn: 10_000, expiresAt: T + 60 * MIN }), T - 10 * MIN);
    expect(p.oneIn()).toBe(10_000);
    await deliver(p, ALL, sampling({ occurredAt: T - 9 * MIN, oneIn: 1, expiresAt: T + 60 * MIN }), T - 9 * MIN);
    expect(p.oneIn()).toBe(1);
    await deliver(p, ALL, sampling({ occurredAt: T - 8 * MIN, expiresAt: T + 60 * MIN }), T - 8 * MIN);
    expect(p.oneIn()).toBe(ONSALE_ONE_IN);
    // 다른 서비스 대상은 이 파드의 비율을 바꾸지 않는다
    await deliver(p, 'PLATFORM:LOG_SAMPLING:other-svc', sampling({ occurredAt: T - 7 * MIN, oneIn: 3, expiresAt: T + 60 * MIN }), T - 7 * MIN);
    expect(p.oneIn()).toBe(ONSALE_ONE_IN);
    // 이 서비스 대상(끝 T+30분)이 살아 있는 동안은 그 값, 끝나면 모든 서비스 대상(끝 T+60분)으로, 그것도 끝나면 시작 설정 값으로
    const mine = `PLATFORM:LOG_SAMPLING:${SERVICE}`;
    await deliver(p, mine, sampling({ occurredAt: T - 6 * MIN, oneIn: 50, expiresAt: T + 30 * MIN }), T - 6 * MIN);
    expect(p.oneIn()).toBe(50);
    p.s.clock.advance(T + 30 * MIN - 1 - p.s.clock.now());
    await p.sweep();
    expect(p.oneIn()).toBe(50);
    p.s.clock.advance(1);
    await p.sweep();
    expect(p.oneIn()).toBe(ONSALE_ONE_IN);
    p.s.clock.advance(30 * MIN);
    await p.sweep();
    expect(p.oneIn()).toBe(START_ONE_IN);
    expect(p.controlLines().filter((l) => l.level === 'warn')).toEqual([]);
  });
});

describe('C-T75 ③ 끝을 늦춘 사건(겹친 윈도우, ADR-0334 결정 2·3)', () => {
  test('C-T75 ③ T+20분에 끝을 T+90분으로 늦춘 사건을 받으면 처음 끝(T+60분)에도 100이고, T+90분 − 1ms까지 100, T+90분에 시작 설정 값으로 돌아간다', async () => {
    const p = await pod(T - 10 * MIN);
    await deliver(p, ALL, sampling({ occurredAt: T - 10 * MIN, expiresAt: T + 60 * MIN }), T - 10 * MIN);
    expect(p.oneIn()).toBe(ONSALE_ONE_IN);
    // B 구간 시작(B 오픈 T+30분의 10분 전) 직후 늦춘 사건
    p.s.clock.advance(30 * MIN);
    await deliver(p, ALL, sampling({ occurredAt: T + 20 * MIN, expiresAt: T + 90 * MIN }), T + 20 * MIN);

    for (const at of [T + 60 * MIN - 1, T + 60 * MIN, T + 60 * MIN + 1, T + 90 * MIN - 1]) {
      p.s.clock.advance(at - p.s.clock.now());
      await p.sweep();
      expect(p.oneIn(), iso(at)).toBe(ONSALE_ONE_IN);
    }
    p.s.clock.advance(1);
    await p.sweep();
    expect(p.oneIn()).toBe(START_ONE_IN);
    // 늦춘 사건은 비율이 같아 정보 줄을 더하지 않는다. 적용 한 줄, 되돌림 한 줄
    expect(p.controlLines().map((l) => [l.msg, l.oneIn])).toEqual([
      ['LOG_SAMPLING 적용', ONSALE_ONE_IN],
      ['LOG_SAMPLING 만료, 시작 설정 값으로 돌림', START_ONE_IN],
    ]);

    // 되돌린 뒤 정상 줄은 시작 설정 값으로 남는다(4xx는 그대로 1). 300건이면 한 건도 남지 않을 확률이 (6/7)^300 ≈ 1e-20이다
    for (let i = 0; i < 300; i += 1) await p.s.inject({ method: 'GET', url: '/v1/demo/items/a1' });
    await p.s.inject({ method: 'POST', url: '/v1/demo/holds' });
    const ok = requestLines(p).filter((l) => l.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((l) => l.sampleRate))).toEqual(new Set([START_ONE_IN]));
    expect(requestLines(p).filter((l) => l.status === 409).map((l) => l.sampleRate)).toEqual([1]);
  });
});

describe('C-T75 ⑤ 새로 뜬 파드(ADR-0334 결정 2, C-T51과 같은 규칙)', () => {
  /** 압축 토픽에 남은 두 사건: 처음 사건(끝 T+60분)과 늦춘 사건(끝 T+90분) */
  function retained() {
    const b = new MemoryBroadcast();
    b.append(CONTROL_TOPICS.settings, ALL, sampling({ occurredAt: T - 10 * MIN, expiresAt: T + 60 * MIN }), T - 10 * MIN);
    b.append(CONTROL_TOPICS.settings, ALL, sampling({ occurredAt: T + 20 * MIN, expiresAt: T + 90 * MIN }), T + 20 * MIN);
    return b;
  }

  test('C-T75 ⑤ 구간 안(T+40분, T+90분 − 1ms)에 뜬 파드는 시작 작업에서 마지막 값(100)을 적용하고 T+90분에 시작 설정 값으로 돌린다', async () => {
    const p = await pod(T + 40 * MIN, { broker: retained() });
    expect(p.oneIn()).toBe(ONSALE_ONE_IN);
    expect(await p.applied()).toBe(T + 20 * MIN);
    p.s.clock.advance(T + 90 * MIN - p.s.clock.now());
    await p.sweep();
    expect(p.oneIn()).toBe(START_ONE_IN);

    const edge = await pod(T + 90 * MIN - 1, { broker: retained() });
    expect(edge.oneIn()).toBe(ONSALE_ONE_IN);
  });

  test('C-T75 ⑤ 구간이 끝난 뒤(T+90분, T+3시간) 뜬 파드는 만료된 값을 무시해 시작 설정 값이고 적용 줄·경고 줄이 없다', async () => {
    for (const at of [T + 90 * MIN, T + 180 * MIN]) {
      const p = await pod(at, { broker: retained() });
      // 사건은 읽었다(판이 남는다). 그래도 만료라 적용하지 않는다
      expect(await p.applied(), iso(at)).toBe(T + 20 * MIN);
      await p.sweep();
      expect(p.oneIn(), iso(at)).toBe(START_ONE_IN);
      expect(p.controlLines(), iso(at)).toEqual([]);
    }
  });

  test('C-T75 ⑤ 설정 토픽만 읽는 파드(sessions: false, 신원 처리기가 없는 서비스)도 마지막 값을 적용하고 종료 세션 토픽은 읽지 않는다', async () => {
    const broker = retained();
    const p = await pod(T + 40 * MIN, { broker, options: { sessions: false } });
    expect(p.oneIn()).toBe(ONSALE_ONE_IN);
    expect([...broker.touched].sort()).toEqual([CONTROL_TOPICS.settings]);
    const ready = JSON.parse((await p.s.svc.management.inject({ method: 'GET', url: '/ready' })).payload) as { status: string };
    expect(ready.status).toBe('ready');
  });
});
