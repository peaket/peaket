// identity가 로그아웃에서 실제로 남긴 세션 종료 사건 값(Outbox, asyncapi SessionTerminated JSON)을 서비스 파드의 운영 해독기(controlEventCodec)와
// 시작 작업(startControlSync)이 읽어 공용 인증 가드가 그 sid를 401로 막는지 본다(docs/features/identity.md §12 I-T3 ③, ADR-0333 결정 4, BUILD_ORDER HOT-401 묶음 BAT-059).
// identity 자신의 경로는 DB로도 끝난 세션을 막으므로(겹친 가드, §8 '남는 한계') 여기서는 DB 확인이 없는 처리기(목록만 막는 곳)로 본다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Controller, Get, Module } from '@nestjs/common';
import { CONTROL_TOPICS, Roles, controlEventCodec, createService, startControlSync, type BroadcastRecord, type BroadcastSource } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { kit, newKey } from './support.js';

/** 정본(docs/features/identity.md §3): 종료 세션 목록 항목은 종료 시각 + 15분까지 */
const LIST_MS = 15 * 60_000;

@Controller('v1/elsewhere')
class ElsewhereController {
  @Get('me')
  @Roles(['fan'])
  me() {
    return { ok: true };
  }
}

@Module({ controllers: [ElsewhereController] })
class ElsewhereModule {}

/** 파티션 하나짜리 방송형 토픽의 메모리 대역(BroadcastSource 포트를 구현한다) */
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

describe('I-T3 ③ identity 로그아웃 사건 값을 다른 서비스 파드가 읽는다', () => {
  test('I-T3 ③-6 identity 로그아웃이 Outbox에 남긴 값(종료 시각 ISO 글)을 운영 해독기로 읽어 종료 시각 + 15분 직전까지 그 sid를 401로 막고 15분에 통과시키며 다른 세션은 그대로다 [ASVS v5.0.0-7.4.1]', async () => {
    const store = new MemorySessionStore();
    const k = await kit(store);
    const login = () => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `u-${newKey().slice(0, 8)}`, email: null, deviceId: 'dev-T3' });
    const ended = await login();
    const live = await login();
    const terminatedAt = k.clock.now();
    await k.end.run({ sessionId: ended.sessionId, accountId: ended.accountId });
    const out = store.outboxMessages().filter((m) => m.topic === CONTROL_TOPICS.sessionsTerminated && m.key === ended.accountId);
    expect(out).toHaveLength(1);
    const payload = Buffer.from(out[0]!.payload);
    // 정본: 종료 시각은 ISO 시각 글이다(asyncapi date-time)
    expect(JSON.parse(payload.toString('utf8'))).toMatchObject({ sessionId: ended.sessionId, reason: 'LOGOUT', terminatedAt: new Date(terminatedAt).toISOString() });

    // 다른 서비스 파드: 사건은 로그아웃 1분 뒤에 닿는다(받은 때가 아니라 종료 시각부터 센다)
    const svc = await createService({ name: 'elsewhere-svc', module: ElsewhereModule, env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'fatal' }, clock: k.clock, logDestination: new Writable({ write: (_c, _e, cb) => cb() }) });
    const broker = new MemoryBroadcast();
    const sync = startControlSync(svc, { source: broker, codec: controlEventCodec, degradeAfterMs: 60_000, retryMs: 10, reconcileMs: 20, measureMs: 20 });
    stops.push(async () => {
      await sync.stop();
      await svc.close();
    });
    await until(async () => (await svc.management.inject({ method: 'GET', url: '/ready' })).statusCode === 200, '준비 상태');
    const status = async (s: { accountId: string; sessionId: string }) =>
      (await svc.http.inject({ method: 'GET', url: '/v1/elsewhere/me', headers: { 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan' } })).statusCode;
    expect(await status(ended)).toBe(200);
    k.clock.advance(60_000);
    broker.append(CONTROL_TOPICS.sessionsTerminated, out[0]!.key, payload, k.clock.now());
    await until(async () => (await status(ended)) === 401, '끝난 세션 401');
    expect(await status(live)).toBe(200);
    k.clock.advance(terminatedAt + LIST_MS - 1 - k.clock.now());
    expect(await status(ended)).toBe(401);
    k.clock.advance(1);
    expect(await status(ended)).toBe(200);
  });
});
