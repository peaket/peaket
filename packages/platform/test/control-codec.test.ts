// 종료 세션 사건의 운영 해독기(controlEventCodec)와 startControlSync를 거쳐 공용 인증 가드가 그 sid를 401로 막는지 본다
// (docs/features/identity.md §3 '서비스에 잇기'·§12 I-T3 ③, ADR-0333 결정 4, BUILD_ORDER HOT-401 묶음 BAT-059).
// Kafka 대신 방송형 읽기 포트(BroadcastSource)를 구현한 메모리 대역을 쓴다(실제 Kafka는 test-int/control-sync.int.test.ts).
// 판정은 isTerminated가 아니라 신원 역할 처리기의 HTTP 401로 본다. 15분은 정본 값(팬·관리 액세스 토큰 수명)이다.
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
  return { svc, clock, broker, sync, status, metrics, end, logs };
}

const event = (o: Record<string, unknown>) => JSON.stringify({ accountId: 'acc-1', reason: 'LOGOUT', ...o });

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
    expect(sample(await t.metrics(), 'control_sync_skipped_total', { service: SERVICE, topic: CONTROL_TOPICS.sessionsTerminated })).toBe(0);
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
    expect(sample(await t.metrics(), 'control_sync_skipped_total', { service: SERVICE, topic: CONTROL_TOPICS.sessionsTerminated })).toBe(0);
  });

  test('I-T3 ③-5 sessionId가 없거나 빈 글·글이 아니거나 값이 JSON 객체가 아니면 건너뛰고 control_sync_skipped_total{topic}을 정확히 1씩 올리며 뒤 사건은 그대로 받는다 [ASVS v5.0.0-16.3.4]', async () => {
    const t = await boot();
    const m = async (topic: string) => sample(await t.metrics(), 'control_sync_skipped_total', { service: SERVICE, topic });
    // 두 토픽 모두 0으로 미리 낸다(경보가 '없음'과 '0'을 가르지 않아도 되게)
    expect(await m(CONTROL_TOPICS.sessionsTerminated)).toBe(0);
    expect(await m(CONTROL_TOPICS.settings)).toBe(0);
    const now = new Date(t.clock.now()).toISOString();
    const bad = [event({ terminatedAt: now }), event({ sessionId: '', terminatedAt: now }), event({ sessionId: 42, terminatedAt: now }), 'not-json{', '["s-arr"]', 'null', '"s-str"'];
    for (const [i, value] of bad.entries()) {
      t.end(value);
      t.end(event({ sessionId: `s-after${i}`, terminatedAt: now }));
      await until(async () => (await t.status(`s-after${i}`)) === 401, `s-after${i} 401`);
      expect(await m(CONTROL_TOPICS.sessionsTerminated), value).toBe(i + 1);
    }
    expect(await m(CONTROL_TOPICS.settings)).toBe(0);
    expect(await t.status('s-arr')).toBe(200);
    expect(await t.status('s-str')).toBe(200);
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
    expect(sample(await t.metrics(), 'control_sync_skipped_total', { service: SERVICE, topic: CONTROL_TOPICS.settings })).toBe(1);
    expect(sample(await t.metrics(), 'control_sync_skipped_total', { service: SERVICE, topic: CONTROL_TOPICS.sessionsTerminated })).toBe(0);
  });
});
