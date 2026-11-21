// 준비된 뒤 종료 세션 토픽 읽기가 던지며 끊겼다 돌아오면 '지금 − 15분'을 다시 재어 끊긴 동안의 사건까지 읽는지 본다
// (docs/features/identity.md §12 I-T48 ③, ADR-0103 결정 2 '종료 세션 목록은 Kafka가 돌아오면 지금 − 15분부터 다시 읽는다',
// BUILD_ORDER HOT-401 묶음 BAT-059 검증 '시험 담당에게 넘길 시험' M18b·R1). 실제 Kafka의 끊김(컨테이너 일시 정지)은 읽기가 던지지 않아
// test-int/control-sync.int.test.ts I-T48 ③-2가 이 갈래를 지나지 않는다. 그래서 방송형 읽기 포트의 메모리 대역이 읽는 중에 던지게 한다
// (허용 목록 '장애 주입(연결 오류)'). 판정은 isTerminated가 아니라 신원 역할 처리기의 HTTP 401이다.
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
import { collector } from './fixture.js';

/** 정본(ADR-0103 결정 2, docs/features/identity.md §3): 종료 세션 목록을 되감는 창은 '지금 − 15분' */
const REWIND_MS = 900_000;
const SERVICE = 'reread-svc';
const MIN = 60_000;

@Controller('v1/r1')
class FanController {
  @Get('me')
  @Roles(['fan'])
  me() {
    return { ok: true };
  }
}

@Module({ controllers: [FanController] })
class R1Module {}

/**
 * 파티션 하나짜리 방송형 토픽의 메모리 대역(BroadcastSource 포트를 구현한다). drop()은 읽고 있던 read를 던지게 하고, 다시 up이 참이
 * 될 때까지 모든 호출이 던진다(Kafka 연결이 끊긴 것처럼). 끊긴 동안 append한 레코드는 토픽에만 쌓인다
 */
class DroppableBroadcast implements BroadcastSource {
  up = true;
  /** 토픽마다 read가 던진 횟수(끊김이 실제로 있었는지 보는 데 쓴다) */
  readonly readThrows = new Map<string, number>();
  readonly asked: { topic: string; at: number }[] = [];
  readonly topics = new Map<string, BroadcastRecord[]>();
  #wake: (() => void)[] = [];

  append(topic: string, value: string, timestamp: number): void {
    const list = this.topics.get(topic) ?? [];
    list.push({ topic, partition: 0, offset: BigInt(list.length), key: 'acc-1', value: Buffer.from(value, 'utf8'), headers: {}, timestamp });
    this.topics.set(topic, list);
    if (this.up) for (const w of this.#wake.splice(0)) w();
  }

  drop(): void {
    this.up = false;
    for (const w of this.#wake.splice(0)) w();
  }

  #down(what: string): Error {
    return Object.assign(new Error(`Kafka에 닿지 않는다(${what})`), { code: 'ECONNREFUSED' });
  }

  async watermarks(topic: string) {
    if (!this.up) throw this.#down('watermarks');
    return new Map([[0, { low: 0n, high: BigInt(this.topics.get(topic)?.length ?? 0) }]]);
  }

  async offsetsAt(topic: string, at: number) {
    if (!this.up) throw this.#down('offsetsAt');
    this.asked.push({ topic, at });
    const list = this.topics.get(topic) ?? [];
    const i = list.findIndex((r) => r.timestamp >= at);
    return new Map([[0, BigInt(i < 0 ? list.length : i)]]);
  }

  async read(topic: string, from: Map<number, bigint>, onRecord: (r: BroadcastRecord) => Promise<void> | void, signal: AbortSignal) {
    let next = Number(from.get(0) ?? 0n);
    while (!signal.aborted) {
      if (!this.up) {
        this.readThrows.set(topic, (this.readThrows.get(topic) ?? 0) + 1);
        throw this.#down('read');
      }
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

describe('I-T48 ③ 준비 뒤 끊김에서 되살린 뒤 다시 읽기(ADR-0103 결정 2, 복구 경로 장애 주입 R1)', () => {
  test("I-T48 ③-3 (복구 경로 장애 주입) 준비된 뒤 읽기가 던지며 끊기면, 돌아올 때 그때의 '지금 − 15분'(900000ms)을 다시 재어 끊긴 동안 들어온 종료 사건의 sid를 401로 막고 끊기기 전 sid도 401 그대로다", async () => {
    const s0 = Date.parse('2026-11-22T01:00:00.000Z');
    const clock: FakeClock = fakeClock({ now: s0 });
    const logs = collector();
    const svc = await createService({ name: SERVICE, module: R1Module, env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' }, clock, logDestination: logs.stream });
    const broker = new DroppableBroadcast();
    // 기간 값은 코드 기본값(30초·1초·2초·5초)과 다르게 둔다. 준비 한도는 길게 두어 끊김 동안 '포기하고 준비'로 빠지지 않게 한다
    const sync = startControlSync(svc, { source: broker, codec: controlEventCodec, degradeAfterMs: 120_000, retryMs: 15, reconcileMs: 25, measureMs: 25 });
    stops.push(async () => {
      await sync.stop();
      await svc.close();
    });
    const topic = CONTROL_TOPICS.sessionsTerminated;
    const status = async (sid: string) =>
      (await svc.http.inject({ method: 'GET', url: '/v1/r1/me', headers: { 'x-user-id': 'acc-1', 'x-session-id': sid, 'x-user-aud': 'fan' } })).statusCode;
    const end = (sid: string, at: number) =>
      broker.append(topic, JSON.stringify({ accountId: 'acc-1', sessionId: sid, reason: 'LOGOUT', terminatedAt: new Date(at).toISOString() }), at);

    await until(async () => (await svc.management.inject({ method: 'GET', url: '/ready' })).statusCode === 200, '준비 상태');
    expect(broker.asked.filter((a) => a.topic === topic)).toEqual([{ topic, at: s0 - REWIND_MS }]);

    // 준비 뒤 받은 사건(끊기기 전)
    end('s-before', s0);
    await until(async () => (await status('s-before')) === 401, '끊기기 전 사건 401');

    // 읽는 중에 끊긴다. 끊긴 동안 종료 사건이 토픽에 들어오고 시간이 2분 흐른다
    broker.drop();
    await until(() => (broker.readThrows.get(topic) ?? 0) >= 1, '읽기가 던짐');
    end('s-gap', s0 + 2 * MIN);
    clock.advance(2 * MIN);
    // 끊김이 실제로 있었다: 끊긴 동안 들어온 사건은 아직 막지 않는다
    expect(await status('s-gap')).toBe(200);
    expect(await status('s-live')).toBe(200);

    broker.up = true;
    await until(async () => (await status('s-gap')) === 401, '끊긴 동안 들어온 사건 401');
    expect(await status('s-before')).toBe(401);
    expect(await status('s-live')).toBe(200);
    // 돌아올 때 그때의 '지금 − 15분'을 다시 쟀다(앞서 받은 위치나 끝 위치를 쓰지 않았다)
    const sessionsAsked = broker.asked.filter((a) => a.topic === topic);
    expect(sessionsAsked[0]).toEqual({ topic, at: s0 - REWIND_MS });
    expect(sessionsAsked.at(-1)).toEqual({ topic, at: s0 + 2 * MIN - REWIND_MS });
    expect(logs.lines.some((l) => l.kind === 'control-sync' && typeof l.msg === 'string' && l.msg.includes(`${topic} 읽기가 끊겼다`))).toBe(true);
  });
});
