// 종료 세션 사건의 운영 해독기(controlEventCodec)와 startControlSync를 거쳐 공용 인증 가드가 그 sid를 401로 막는지 본다
// (docs/features/identity.md §3 '서비스에 잇기'·§12 I-T3 ③, ADR-0333 결정 4, BUILD_ORDER HOT-401 묶음 BAT-059).
// Kafka 대신 방송형 읽기 포트(BroadcastSource)를 구현한 메모리 대역을 쓴다(실제 Kafka는 test-int/control-sync.int.test.ts).
// 판정은 isTerminated가 아니라 신원 역할 처리기의 HTTP 401로 본다. 15분은 정본 값(팬·관리 액세스 토큰 수명)이다.
// ③-7~③-9는 종료 시각의 믿을 범위(Kafka 시각 기준, 미래 쪽 1분 [가정])와 셈의 까닭 라벨을 본다(BAT-059 리뷰 반영 R059-1).
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CONTROL_TOPICS,
  Roles,
  controlEventCodec,
  createService,
  fakeClock,
  startControlSync,
  type BroadcastRecord,
  type BroadcastSource,
  type FakeClock,
} from '../src/index.js';
import { collector, sample } from './fixture.js';

/** 정본(docs/features/identity.md §3): 종료 세션 목록 항목은 종료 시각 + 15분까지 */
const LIST_MS = 15 * 60_000;
/** 정본(ADR-0333 결정 4 셋째 줄): 종료 시각을 그대로 쓰는 미래 쪽 끝은 Kafka 시각 + 1분 [가정] */
const FUTURE_MS = 60_000;
/** asyncapi SessionTerminated.reason 목록(docs/api/asyncapi.yaml) */
const REASONS = ['LOGOUT', 'DELETE', 'ADMIN_FORCE', 'REFRESH_REUSE', 'STAFF_REVOKED', 'DEVICE_REVOKED', 'MERGED', 'DEVICE_LIMIT', 'ACCOUNT_LOCKED', 'ROLE_CHANGED', 'PASSWORD_CHANGED', 'LOGIN_METHOD_CHANGED'];
const SERVICE = 't3-svc';

@Controller('v1/t3')
class FanController {
  @Get('me')
  @Roles(['fan'])
  me() {
    return { ok: true };
  }
}

@Module({ controllers: [FanController] })
class T3Module {}

/** 파티션 하나짜리 방송형 토픽의 메모리 대역(BroadcastSource 포트를 구현한다). 값은 날것의 바이트로 넣는다 */
class MemoryBroadcast implements BroadcastSource {
  readonly topics = new Map<string, BroadcastRecord[]>();
  #wake: (() => void)[] = [];

  append(topic: string, value: string, timestamp: number, key = 'acc-1'): void {
    const list = this.topics.get(topic) ?? [];
    list.push({ topic, partition: 0, offset: BigInt(list.length), key, value: Buffer.from(value, 'utf8'), headers: {}, timestamp });
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
});

async function boot() {
  const clock: FakeClock = fakeClock({ now: Date.parse('2026-11-21T09:00:00.000Z') });
  const logs = collector();
  const svc = await createService({ name: SERVICE, module: T3Module, env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' }, clock, logDestination: logs.stream });
  const broker = new MemoryBroadcast();
  const sync = startControlSync(svc, { source: broker, codec: controlEventCodec, degradeAfterMs: 60_000, retryMs: 10, reconcileMs: 20, measureMs: 20 });
  stops.push(async () => {
    await sync.stop();
    await svc.close();
  });
  await until(async () => (await svc.management.inject({ method: 'GET', url: '/ready' })).statusCode === 200, '준비 상태');
  const status = async (sid: string) =>
    (await svc.http.inject({ method: 'GET', url: '/v1/t3/me', headers: { 'x-user-id': 'acc-1', 'x-session-id': sid, 'x-user-aud': 'fan' } })).statusCode;
  const metrics = async () => (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload;
  const end = (value: string) => broker.append(CONTROL_TOPICS.sessionsTerminated, value, clock.now());
  /** 레코드의 Kafka 시각(BroadcastRecord.timestamp)을 받은 때와 따로 준다 */
  const endAt = (value: string, kafkaAt: number) => broker.append(CONTROL_TOPICS.sessionsTerminated, value, kafkaAt);
  /** control_sync_skipped_total{service,topic,reason}. fixture sample은 라벨이 일부만 맞아도 첫 줄을 돌려주므로 라벨 셋을 다 준다 */
  const skipped = async (topic: string, reason: 'unreadable' | 'time_replaced') => sample(await metrics(), 'control_sync_skipped_total', { service: SERVICE, topic, reason });
  return { svc, clock, broker, sync, status, metrics, end, endAt, skipped, logs };
}

const event = (o: Record<string, unknown>) => JSON.stringify({ accountId: 'acc-1', reason: 'LOGOUT', ...o });
const iso = (ms: number) => new Date(ms).toISOString();

describe('I-T3 ③ 종료 세션 사건의 운영 해독(ADR-0333 결정 4)', () => {
  test('I-T3 ③-1 identity가 남긴 값(종료 시각 ISO 글)을 읽어 종료 시각 + 15분 직전(− 1ms)까지 그 sid를 401로 막고 15분이 되면 통과시키며 다른 sid는 그대로다 [ASVS v5.0.0-7.4.1]', async () => {
    const t = await boot();
    // 2분 전에 끝난 세션: 받은 때가 아니라 종료 시각부터 센다
    const terminatedAt = t.clock.now() - 2 * 60_000;
    t.end(event({ sessionId: 's-iso', terminatedAt: new Date(terminatedAt).toISOString() }));
    await until(async () => (await t.status('s-iso')) === 401, 's-iso 401');
    expect(await t.status('s-live')).toBe(200);
    t.clock.advance(terminatedAt + LIST_MS - 1 - t.clock.now());
    expect(await t.status('s-iso')).toBe(401);
    t.clock.advance(1);
    expect(await t.status('s-iso')).toBe(200);
  });

  test('I-T3 ③-2 종료 시각이 밀리초 수(Avro timestamp-millis 꼴)여도 그 시각 + 15분 직전까지 401이고 15분에 통과한다', async () => {
    const t = await boot();
    const terminatedAt = t.clock.now() - 3 * 60_000;
    t.end(event({ sessionId: 's-ms', terminatedAt }));
    await until(async () => (await t.status('s-ms')) === 401, 's-ms 401');
    t.clock.advance(terminatedAt + LIST_MS - 1 - t.clock.now());
    expect(await t.status('s-ms')).toBe(401);
    t.clock.advance(1);
    expect(await t.status('s-ms')).toBe(200);
  });

  test('I-T3 ③-3 이유 값이 asyncapi 목록의 값마다, 그리고 목록 밖 값(NEW_REASON)·빈 글·수여도 그 sid를 401로 막는다', async () => {
    const t = await boot();
    const now = new Date(t.clock.now()).toISOString();
    const reasons: unknown[] = [...REASONS, 'NEW_REASON', '', 7];
    reasons.forEach((reason, i) => t.end(JSON.stringify({ accountId: 'acc-1', sessionId: `s-r${i}`, reason, terminatedAt: now })));
    await until(async () => (await t.status(`s-r${reasons.length - 1}`)) === 401, '마지막 이유 401');
    for (const [i, reason] of reasons.entries()) expect(await t.status(`s-r${i}`), String(reason)).toBe(401);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'unreadable')).toBe(0);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'time_replaced')).toBe(0);
  });

  test('I-T3 ③-4 종료 시각이 없거나 읽지 못하는 값이면 건너뛰지 않고 받은 때부터 15분 직전까지 401, 15분에 통과한다', async () => {
    const t = await boot();
    const received = t.clock.now();
    const broken: Record<string, unknown>[] = [{}, { terminatedAt: null }, { terminatedAt: 'yesterday' }, { terminatedAt: '2026-13-45T25:61:00Z' }, { terminatedAt: { at: 1 } }, { terminatedAt: true }];
    broken.forEach((b, i) => t.end(event({ sessionId: `s-b${i}`, ...b })));
    await until(async () => (await t.status(`s-b${broken.length - 1}`)) === 401, '마지막 깨진 시각 401');
    for (const [i, b] of broken.entries()) expect(await t.status(`s-b${i}`), JSON.stringify(b)).toBe(401);
    t.clock.advance(received + LIST_MS - 1 - t.clock.now());
    for (const [i, b] of broken.entries()) expect(await t.status(`s-b${i}`), JSON.stringify(b)).toBe(401);
    t.clock.advance(1);
    for (const [i, b] of broken.entries()) expect(await t.status(`s-b${i}`), JSON.stringify(b)).toBe(200);
    // 여섯 모두 건너뛰지 않고 받은 때로 바꿨다(ADR-0333 결정 4 '까닭 라벨')
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'time_replaced')).toBe(6);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'unreadable')).toBe(0);
  });

  test('I-T3 ③-5 sessionId가 없거나 빈 글·글이 아니거나 값이 JSON 객체가 아니면 건너뛰고 control_sync_skipped_total{topic}을 정확히 1씩 올리며 뒤 사건은 그대로 받는다 [ASVS v5.0.0-16.3.4]', async () => {
    const t = await boot();
    // 세 줄(두 토픽의 unreadable, 종료 사건 토픽의 time_replaced)을 0으로 미리 낸다(ADR-0333 결정 4. 경보가 '없음'과 '0'을 가르지 않아도 되게)
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'unreadable')).toBe(0);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'time_replaced')).toBe(0);
    expect(await t.skipped(CONTROL_TOPICS.settings, 'unreadable')).toBe(0);
    const now = new Date(t.clock.now()).toISOString();
    const bad = [event({ terminatedAt: now }), event({ sessionId: '', terminatedAt: now }), event({ sessionId: 42, terminatedAt: now }), 'not-json{', '["s-arr"]', 'null', '"s-str"'];
    for (const [i, value] of bad.entries()) {
      t.end(value);
      t.end(event({ sessionId: `s-after${i}`, terminatedAt: now }));
      await until(async () => (await t.status(`s-after${i}`)) === 401, `s-after${i} 401`);
      expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'unreadable'), value).toBe(i + 1);
    }
    // 건너뛴 레코드는 시각을 바꾼 것으로 세지 않고, 다른 토픽에도 세지 않는다
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'time_replaced')).toBe(0);
    expect(await t.skipped(CONTROL_TOPICS.settings, 'unreadable')).toBe(0);
    expect(await t.status('s-arr')).toBe(200);
    expect(await t.status('s-str')).toBe(200);
  });

  // 아래 셋의 범위(ADR-0333 결정 4 셋째·넷째 줄): Kafka 시각 k에 대해 k − 15분 < 종료 시각 ≤ k + 1분이면 그 시각대로, 밖이면 받은 때 n부터 15분.
  // 판정은 신원 처리기의 401·200이고, 셈은 시험 끝에 한 번 본다(시험마다 새 서비스라 그 시험의 값만 센다)
  test('I-T3 ③-7 종료 시각 + 15분이 Kafka 시각 이하면 받은 때부터 15분 막고 time_replaced로 센다(바로 안쪽은 그 시각대로) [ASVS v5.0.0-7.4.1]', async () => {
    const t = await boot();
    // 받은 때를 초 단위가 아니게 둔다(초 단위 수를 밀리초로 고쳐 읽는 구현이 받은 때와 같은 값을 우연히 내지 않게)
    t.clock.advance(1_234);
    const n = t.clock.now();
    const k = n;
    // (가) 이른 쪽 끝 정각(종료 시각 + 15분 = Kafka 시각) (나) 큰 오류 넷: 0, 음수, 초 단위 수, 1970년 ISO
    const replaced: [string, unknown][] = [
      ['s-7a-edge', iso(k - LIST_MS)],
      ['s-7b-zero', 0],
      ['s-7b-neg', -1],
      ['s-7b-sec', Math.floor(n / 1000)],
      ['s-7b-1970', '1970-01-01T00:00:00Z'],
    ];
    for (const [sessionId, terminatedAt] of replaced) t.endAt(event({ sessionId, terminatedAt }), k);
    // (다) 바로 안쪽(이른 쪽 끝 + 1ms). 마지막에 넣는다: 이것이 401이면 앞 레코드도 모두 읽었다
    t.endAt(event({ sessionId: 's-7c-inner', terminatedAt: iso(k - LIST_MS + 1) }), k);
    await until(async () => (await t.status('s-7c-inner')) === 401, '(다) 401');
    for (const [sid, v] of replaced) expect(await t.status(sid), `받은 때 n: ${JSON.stringify(v)}`).toBe(401);
    t.clock.advance(1);
    expect(await t.status('s-7c-inner'), '(다) 종료 시각 + 15분').toBe(200);
    for (const [sid, v] of replaced) expect(await t.status(sid), `n + 1ms: ${JSON.stringify(v)}`).toBe(401);
    t.clock.advance(n + LIST_MS - 1 - t.clock.now());
    for (const [sid, v] of replaced) expect(await t.status(sid), `n + 15분 − 1ms: ${JSON.stringify(v)}`).toBe(401);
    t.clock.advance(1);
    for (const [sid, v] of replaced) expect(await t.status(sid), `n + 15분: ${JSON.stringify(v)}`).toBe(200);
    // (가)(나) 다섯만 센다. (다)는 세지 않는다
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'time_replaced')).toBe(5);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'unreadable')).toBe(0);
  });

  test('I-T3 ③-8 종료 시각이 Kafka 시각 + 1분보다 뒤면 받은 때부터 15분 막고 time_replaced로 센다(1분 정각은 그 시각대로) [ASVS v5.0.0-7.4.1]', async () => {
    const t = await boot();
    const n = t.clock.now();
    const k = n;
    // (가) 미래 쪽 끝 + 1ms (나) 큰 오류 둘: 마이크로초 단위 수, 9999년 ISO. 경계는 밀리초 수 꼴로 본다(③-7의 경계는 ISO 꼴)
    const replaced: [string, unknown][] = [
      ['s-8a-edge', k + FUTURE_MS + 1],
      ['s-8b-micro', n * 1000],
      ['s-8b-9999', '9999-12-31T23:59:59Z'],
    ];
    for (const [sessionId, terminatedAt] of replaced) t.endAt(event({ sessionId, terminatedAt }), k);
    // (다) 미래 쪽 끝 정각. 마지막에 넣는다
    t.endAt(event({ sessionId: 's-8c-inner', terminatedAt: k + FUTURE_MS }), k);
    await until(async () => (await t.status('s-8c-inner')) === 401, '(다) 401');
    for (const [sid, v] of replaced) expect(await t.status(sid), `받은 때 n: ${JSON.stringify(v)}`).toBe(401);
    t.clock.advance(n + LIST_MS - 1 - t.clock.now());
    for (const [sid, v] of replaced) expect(await t.status(sid), `n + 15분 − 1ms: ${JSON.stringify(v)}`).toBe(401);
    t.clock.advance(1);
    for (const [sid, v] of replaced) expect(await t.status(sid), `n + 15분: ${JSON.stringify(v)}`).toBe(200);
    expect(await t.status('s-8c-inner'), '(다) n + 15분').toBe(401);
    t.clock.advance(k + FUTURE_MS + LIST_MS - 1 - t.clock.now());
    expect(await t.status('s-8c-inner'), '(다) 종료 시각 + 15분 − 1ms').toBe(401);
    t.clock.advance(1);
    expect(await t.status('s-8c-inner'), '(다) 종료 시각 + 15분').toBe(200);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'time_replaced')).toBe(3);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'unreadable')).toBe(0);
  });

  test('I-T3 ③-9 범위는 받은 때가 아니라 그 레코드의 Kafka 시각으로 견주고, 레코드 시각이 없으면 받은 때로 견준다 [ASVS v5.0.0-7.4.1]', async () => {
    const t = await boot();
    const n = t.clock.now();
    const MIN = 60_000;
    // (가) Kafka 시각 n − 10분, 종료 시각은 그 + 2분: 받은 때로 견주면 범위 안, Kafka 시각으로 견주면 미래 쪽 밖
    const kA = n - 10 * MIN;
    t.endAt(event({ sessionId: 's-9a', terminatedAt: iso(kA + 2 * MIN) }), kA);
    // (나) Kafka 시각 n − 14분, 종료 시각은 그 − 2분: Kafka에 들어간 때는 13분 남았고 받은 때는 이미 지났다(늦게 받은 옛 사건)
    const kB = n - 14 * MIN;
    t.endAt(event({ sessionId: 's-9b', terminatedAt: iso(kB - 2 * MIN) }), kB);
    // (다) 레코드 시각 0(없음), 종료 시각 n − 2분: 받은 때로 견주어 범위 안. 마지막에 넣는다
    t.endAt(event({ sessionId: 's-9c', terminatedAt: iso(n - 2 * MIN) }), 0);
    await until(async () => (await t.status('s-9c')) === 401, '(다) 401');
    expect(await t.status('s-9a'), '(가) 받은 때 n').toBe(401);
    // (나)는 지금처럼 목록에 넣지 않는다(그 세션의 토큰은 이미 수명이 끝났다)
    expect(await t.status('s-9b'), '(나) 받은 때 n').toBe(200);
    t.clock.advance(n + 13 * MIN - 1 - t.clock.now());
    expect(await t.status('s-9c'), '(다) 종료 시각 + 15분 − 1ms').toBe(401);
    expect(await t.status('s-9a'), '(가) n + 13분 − 1ms').toBe(401);
    t.clock.advance(1);
    expect(await t.status('s-9c'), '(다) 종료 시각 + 15분').toBe(200);
    t.clock.advance(n + LIST_MS - 1 - t.clock.now());
    expect(await t.status('s-9a'), '(가) n + 15분 − 1ms').toBe(401);
    t.clock.advance(1);
    expect(await t.status('s-9a'), '(가) n + 15분').toBe(200);
    // (가)만 센다. (나)(다)는 세지 않는다
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'time_replaced')).toBe(1);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'unreadable')).toBe(0);
  });
});

describe('ADR-0333 결정 4 설정 사건의 운영 해독', () => {
  test('ADR0333_결정4_설정사건은_ISO시각을밀리초로바꿔적용하고_모양이틀린값은건너뛰어settings토픽으로센다', async () => {
    const t = await boot();
    const at = t.clock.now() - 60_000;
    const setting = (o: Record<string, unknown>) =>
      JSON.stringify({ commandId: 'c-1', key: 'FEATURE_FLAG', scope: 'PLATFORM', value: { enabled: true }, expiresAt: null, actor: 'op-1', occurredAt: new Date(at).toISOString(), eventKey: 'e-1', ...o });
    const key = 'PLATFORM:FEATURE_FLAG:reviews';
    t.broker.append(CONTROL_TOPICS.settings, setting({ occurredAt: 'soon' }), at, key);
    t.broker.append(CONTROL_TOPICS.settings, setting({}), at, key);
    await until(() => t.sync.settings.get(key) !== undefined, '설정 적용');
    expect(t.sync.settings.entries().map((s) => ({ key: s.key, value: s.value, version: s.version }))).toEqual([{ key, value: { enabled: true }, version: at }]);
    expect(await t.skipped(CONTROL_TOPICS.settings, 'unreadable')).toBe(1);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'unreadable')).toBe(0);
    expect(await t.skipped(CONTROL_TOPICS.sessionsTerminated, 'time_replaced')).toBe(0);
  });
});
