// 실제 Kafka(컨테이너 한 대)로 서비스의 종료 세션 목록 소비 도우미(startServiceControlSync)를 본다
// (docs/features/identity.md §3 '세션 즉시 무효화 전파'·§12 I-T3 ①·I-T48 ①②③, ADR-0103 결정 2·3, ADR-0333 결정 2, BUILD_ORDER HOT-401 묶음 BAT-059).
// 같은 서비스 이름에 파드 이름만 다른 인스턴스(createService)를 여럿 띄우고, 판정은 신원 역할 처리기의 HTTP 401로 본다.
// 정본 값: '수 초'의 시험 값 5초 [가정], 새 파드는 '지금 − 15분'부터 읽은 뒤 준비, Kafka에 닿지 못하면 정한 시간 뒤 준비 + control_sync_lagging{kind}=1.
// 준비 시간 한도는 시험에서 정본 기본값(30초)과 다른 4초로 줄인다(30초 기본값 자체는 test/control.test.ts D-T29 ④가 본다).
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Controller, Get, Module } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { CONTROL_TOPICS, Roles, createService, type PlatformService } from '../src/index.js';
import { createKafkaAdmin, createKafkaProducer, startServiceControlSync, type KafkaProducer, type ServiceControlSync, type ServiceControlSyncOptions } from '../src/stream-worker.js';
import { sample } from '../test/fixture.js';
import { startKafka, type KafkaContainer } from './containers.js';

const SERVICE = 'it3-svc';
/** 정본 I-T3 ① '수 초'의 시험 값(docs/features/identity.md §12, 5초 [가정]) */
const PROPAGATION_MS = 5_000;
/** 시험용 준비 시간 한도(정본 기본값 30초와 다르게 고른다) */
const DEGRADE_MS = 4_000;

@Controller('v1/it3')
class FanController {
  @Get('me')
  @Roles(['fan'])
  me() {
    return { ok: true };
  }
}

@Module({ controllers: [FanController] })
class It3Module {}

let kafka: KafkaContainer;
let producer: KafkaProducer;

beforeAll(async () => {
  kafka = await startKafka();
  // 운영처럼 파티션을 여럿 둔다(파드마다 모든 파티션을 읽어야 한다)
  await kafka.createTopic(CONTROL_TOPICS.settings, 2);
  await kafka.createTopic(CONTROL_TOPICS.sessionsTerminated, 3);
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'it3-producer', kind: 'outbox-relay' });
  await producer.connect();
}, 180_000);

afterAll(async () => {
  await producer?.disconnect().catch(() => {});
  kafka?.stop();
});

const until = async (cond: () => boolean | Promise<boolean>, what: string, ms: number, every = 50) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`기다린 조건이 ${ms}ms 안에 오지 않았다: ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
};

interface Pod {
  pod: string;
  svc: PlatformService;
  sync: ServiceControlSync;
  status(sid: string): Promise<number>;
  ready(): Promise<{ statusCode: number; pending: string[] }>;
  metrics(): Promise<string>;
}

const pods: Pod[] = [];
afterEach(async () => {
  while (pods.length) {
    const p = pods.pop()!;
    await p.svc.close().catch(() => {});
    await p.sync.close();
  }
});

async function pod(name: string, o: ServiceControlSyncOptions = {}, env: Record<string, string> = {}): Promise<Pod> {
  const svc = await createService({
    name: SERVICE,
    module: It3Module,
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'fatal', ...env },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const sync = startServiceControlSync(svc, { PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: kafka.brokers.join(','), PEAKET_POD: name }, o);
  if (!sync) throw new Error('브로커 주소를 줬는데 소비가 켜지지 않았다');
  const p: Pod = {
    pod: name,
    svc,
    sync,
    status: async (sid) => (await svc.http.inject({ method: 'GET', url: '/v1/it3/me', headers: { 'x-user-id': 'acc-it3', 'x-session-id': sid, 'x-user-aud': 'fan' } })).statusCode,
    ready: async () => {
      const r = await svc.management.inject({ method: 'GET', url: '/ready' });
      const body = JSON.parse(r.payload) as { pending?: string[] };
      return { statusCode: r.statusCode, pending: [...(body.pending ?? [])].sort() };
    },
    metrics: async () => (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload,
  };
  pods.push(p);
  return p;
}

const readyAll = (ps: Pod[]) => until(async () => (await Promise.all(ps.map((p) => p.ready()))).every((r) => r.statusCode === 200), '모든 인스턴스 준비', 60_000);

let seq = 0;
/** identity가 Outbox로 내는 꼴(asyncapi SessionTerminated JSON, 종료 시각 ISO 글)로 세션 종료 사건을 넣는다. 계정 키는 사건마다 달라 파티션이 갈린다 */
async function terminate(sessionId: string, at = Date.now()) {
  const accountId = `acc-it3-${(seq += 1)}`;
  await producer.send({
    topic: CONTROL_TOPICS.sessionsTerminated,
    messages: [{ key: accountId, value: Buffer.from(JSON.stringify({ accountId, sessionId, reason: 'LOGOUT', terminatedAt: new Date(at).toISOString() })), timestamp: String(at) }],
  });
}

describe('I-T3 ① 방송형 소비(ADR-0103 결정 3)', () => {
  test(`I-T3 ① 파드 이름이 다른 인스턴스 둘이 실제 Kafka의 같은 종료 사건을 모두 받아 넣은 뒤 ${PROPAGATION_MS}ms 안에 둘 다 그 sid를 401로 막고 다른 sid는 통과시키며, 소비자 그룹이 파드마다 따로다 [ASVS v5.0.0-7.4.1]`, async () => {
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    await readyAll([a, b]);
    for (const p of [a, b]) expect(await p.status('s-it3-1'), p.pod).toBe(200);
    const sent = Date.now();
    await terminate('s-it3-1');
    await until(async () => (await a.status('s-it3-1')) === 401 && (await b.status('s-it3-1')) === 401, '두 인스턴스 401', PROPAGATION_MS - (Date.now() - sent));
    for (const p of [a, b]) expect(await p.status('s-it3-other'), p.pod).toBe(200);
    const admin = createKafkaAdmin({ brokers: kafka.brokers, clientId: 'it3-groups' });
    await admin.connect();
    try {
      const groups = (await admin.listGroups()).groups.map((g) => g.groupId).filter((g) => g.startsWith(`${SERVICE}-`));
      expect(groups).toEqual(expect.arrayContaining([`${SERVICE}-pod-a.${CONTROL_TOPICS.sessionsTerminated}`, `${SERVICE}-pod-b.${CONTROL_TOPICS.sessionsTerminated}`]));
      expect(groups).not.toContain(`${SERVICE}.${CONTROL_TOPICS.sessionsTerminated}`);
    } finally {
      await admin.disconnect();
    }
  }, 120_000);
});

describe('I-T3 ③ 실제 Kafka 레코드 시각(ADR-0333 결정 4, BAT-059 리뷰 반영 R059-1)', () => {
  test('I-T3 ③-10 실제 Kafka 레코드 시각으로 견주어 identity 꼴 정상 사건(지금 ISO 종료 시각)은 시각을 바꾸지 않는다', async () => {
    const p = await pod('pod-t3-10');
    await readyAll([p]);
    const accountId = `acc-it3-${(seq += 1)}`;
    const sent = Date.now();
    // Outbox 릴레이처럼 레코드 시각을 주지 않는다(Kafka 클라이언트가 보낸 때를 적는다). 종료 시각은 보내기 직전의 지금(ISO 글)이다
    await producer.send({
      topic: CONTROL_TOPICS.sessionsTerminated,
      messages: [{ key: accountId, value: Buffer.from(JSON.stringify({ accountId, sessionId: 's-it3-10', reason: 'LOGOUT', terminatedAt: new Date(sent).toISOString() })) }],
    });
    await until(async () => (await p.status('s-it3-10')) === 401, 's-it3-10 401', PROPAGATION_MS);
    expect(await p.status('s-it3-live')).toBe(200);
    // 읽기 포트가 낸 레코드 시각이 밀리초라 범위 안이다(초 단위로 내면 미래 쪽 밖이 되어 time_replaced가 오른다)
    const m = await p.metrics();
    expect(sample(m, 'control_sync_skipped_total', { service: SERVICE, topic: CONTROL_TOPICS.sessionsTerminated, reason: 'time_replaced' })).toBe(0);
    expect(sample(m, 'control_sync_skipped_total', { service: SERVICE, topic: CONTROL_TOPICS.sessionsTerminated, reason: 'unreadable' })).toBe(0);
  }, 120_000);
});

describe('I-T48 새 파드의 종료 세션(ADR-0103 결정 2)', () => {
  test('I-T48 ① 로그아웃 직후(1초 안) 새로 띄운 인스턴스는 15분 창을 다 읽기 전에는 준비가 아니고(503, 남은 작업 sessions·settings), 준비가 된 직후 첫 요청부터 그 sid를 401로 막는다', async () => {
    await terminate('s-it48-1');
    const sent = Date.now();
    const fresh = await pod('pod-fresh');
    expect(Date.now() - sent).toBeLessThan(1_000);
    const first = await fresh.ready();
    expect(first).toEqual({ statusCode: 503, pending: ['sessions', 'settings'] });
    await readyAll([fresh]);
    expect(await fresh.status('s-it48-1')).toBe(401);
    expect(await fresh.status('s-it48-live')).toBe(200);
    expect(sample(await fresh.metrics(), 'control_sync_lagging', { service: SERVICE, kind: 'sessions' })).toBe(0);
  }, 120_000);

  test('I-T48 ② 같은 서비스 인스턴스 셋 모두가 그 세션 토큰의 요청을 401로 막는다(사건이 인스턴스 하나에만 가지 않는다)', async () => {
    const three = [await pod('pod-1'), await pod('pod-2'), await pod('pod-3')];
    await readyAll(three);
    await terminate('s-it48-2');
    await until(async () => (await Promise.all(three.map((p) => p.status('s-it48-2')))).every((s) => s === 401), '세 인스턴스 401', PROPAGATION_MS);
    for (const p of three) expect(await p.status('s-it48-live'), p.pod).toBe(200);
  }, 120_000);

  test(`I-T48 ③ Kafka를 막은 채 띄우면 ${DEGRADE_MS}ms 전에는 503, 뒤에는 빈 목록으로 200이고 control_sync_lagging{kind="sessions"}=1이며, Kafka가 돌아오면 15분 창을 다시 읽어 그 sid를 401로 막고 0으로 돌아간다 [ASVS v5.0.0-16.5.2]`, async () => {
    // 막기 전에 끝난 세션(새 인스턴스는 아직 읽지 못했다)
    await terminate('s-it48-3');
    kafka.pause();
    let resumed = false;
    try {
      const started = Date.now();
      const blocked = await pod('pod-blocked', { degradeAfterMs: DEGRADE_MS, retryMs: 300 });
      expect(await blocked.ready()).toEqual({ statusCode: 503, pending: ['sessions', 'settings'] });
      await until(async () => (await blocked.ready()).statusCode === 200, '정한 시간 뒤 준비', DEGRADE_MS + 10_000);
      expect(Date.now() - started).toBeGreaterThanOrEqual(DEGRADE_MS - 50);
      const m = await blocked.metrics();
      expect(sample(m, 'control_sync_lagging', { service: SERVICE, kind: 'sessions' })).toBe(1);
      expect(sample(m, 'control_sync_lagging', { service: SERVICE, kind: 'settings' })).toBe(1);
      // 막힘이 실제로 있었다: 목록이 비어 그 sid가 아직 통한다
      expect(await blocked.status('s-it48-3')).toBe(200);
      await kafka.resume();
      resumed = true;
      await until(async () => (await blocked.status('s-it48-3')) === 401, '되살린 뒤 15분 창 다시 읽기', 60_000, 200);
      await until(async () => sample(await blocked.metrics(), 'control_sync_lagging', { service: SERVICE, kind: 'sessions' }) === 0, '따라잡은 뒤 게이지 0', 30_000, 200);
      // 따라잡은 뒤에 온 사건도 받는다
      await terminate('s-it48-4');
      await until(async () => (await blocked.status('s-it48-4')) === 401, '따라잡은 뒤 새 사건', PROPAGATION_MS * 2);
      expect(await blocked.status('s-it48-live')).toBe(200);
    } finally {
      if (!resumed) await kafka.resume();
    }
  }, 240_000);

  test('I-T48 ③-2 (복구 경로 장애 주입) 준비된 뒤 Kafka가 끊겼다 돌아오면 읽기를 이어, 끊기기 전 사건은 그대로 막고 돌아온 뒤 넣은 사건도 401로 막는다', async () => {
    const p = await pod('pod-reconnect', { degradeAfterMs: DEGRADE_MS, retryMs: 300 });
    await readyAll([p]);
    await terminate('s-it48-5');
    await until(async () => (await p.status('s-it48-5')) === 401, '끊기기 전 사건', PROPAGATION_MS);
    kafka.pause();
    let resumed = false;
    try {
      // 끊긴 동안에도 이미 받은 목록으로 막는다(준비 상태는 그대로다)
      expect(await p.status('s-it48-5')).toBe(401);
      expect((await p.ready()).statusCode).toBe(200);
      await kafka.resume();
      resumed = true;
      await terminate('s-it48-6');
      await until(async () => (await p.status('s-it48-6')) === 401, '돌아온 뒤 새 사건', 60_000, 200);
      expect(await p.status('s-it48-5')).toBe(401);
      expect(await p.status('s-it48-live')).toBe(200);
    } finally {
      if (!resumed) await kafka.resume();
    }
  }, 240_000);
});

describe('C-T75 실제 Kafka의 온세일 로그 표본(ADR-0334 결정 1·2, BUILD_ORDER BAT-215)', () => {
  /** 시작 설정 값(PEAKET_LOG_SAMPLE_ONE_IN). 기본 10·온세일 100과 다르게 고른다 */
  const START_ONE_IN = 7;
  /** 다시 맞춤 주기 기본값(CONTROL_SYNC_DEFAULTS.reconcileMs, 정본 '2초 [가정]' ADR-0103)의 여유를 둔 시험 한도 */
  const SWEEP_SLACK_MS = 2_000 + 3_000;

  test('C-T75 ② C-T75 ⑤ ops-svc 꼴(JSON, ISO 시각) LOG_SAMPLING을 실제 Kafka에 넣으면 이미 뜬 파드 둘(하나는 설정 토픽만 읽는 sessions: false)이 정상 줄 비율 100을 적용하고, 구간 안에 새로 뜬 파드도 100이며, 끝이 지나면 셋 모두 시작 설정 값으로 돌아가고 그 뒤에 뜬 파드는 만료된 값을 무시한다', async () => {
    const env = { PEAKET_LOG_SAMPLE_ONE_IN: String(START_ONE_IN) };
    const a = await pod('pod-ls-a', {}, env);
    const b = await pod('pod-ls-b', { sessions: false }, env);
    await readyAll([a, b]);
    for (const p of [a, b]) expect(p.svc.logs.sampleOneIn, p.pod).toBe(START_ONE_IN);
    // 설정 토픽만 읽는 파드는 종료 세션 목록 소비를 켰다고 표시하지 않는다
    expect(a.svc.controlSync.started).toBe(true);
    expect(b.svc.controlSync.started).toBe(false);

    const occurredAt = Date.now();
    const expiresAt = occurredAt + 15_000;
    const key = 'PLATFORM:LOG_SAMPLING:*';
    const value = {
      commandId: 'cmd-it-log-sampling',
      key: 'LOG_SAMPLING',
      scope: 'PLATFORM',
      value: { oneIn: 100 },
      expiresAt: new Date(expiresAt).toISOString(),
      actor: '6f1d2c3b-4a59-4e8d-9c7b-0a1b2c3d4e5f',
      occurredAt: new Date(occurredAt).toISOString(),
      eventKey: '7a1c0f3e-2b4d-4c5e-9f60-718293a4b5c6',
    };
    await producer.send({ topic: CONTROL_TOPICS.settings, messages: [{ key, value: Buffer.from(JSON.stringify(value)) }] });
    await until(() => a.svc.logs.sampleOneIn === 100 && b.svc.logs.sampleOneIn === 100, '두 파드 100 적용', PROPAGATION_MS);

    // 구간 안에 새로 뜬 파드는 압축 토픽에 남은 마지막 값을 시작 작업에서 적용한다
    const c = await pod('pod-ls-c', { sessions: false }, env);
    await readyAll([c]);
    expect(c.svc.logs.sampleOneIn).toBe(100);

    await until(() => [a, b, c].every((p) => p.svc.logs.sampleOneIn === START_ONE_IN), '끝이 지난 뒤 시작 설정 값', Math.max(0, expiresAt - Date.now()) + SWEEP_SLACK_MS, 200);
    expect(Date.now()).toBeGreaterThanOrEqual(expiresAt);

    // 끝이 지난 뒤 뜬 파드는 만료된 값을 무시한다
    const d = await pod('pod-ls-d', { sessions: false }, env);
    await readyAll([d]);
    expect(d.svc.logs.sampleOneIn).toBe(START_ONE_IN);

    // 설정 토픽만 읽는 파드는 종료 세션 토픽의 소비자 그룹을 만들지 않는다
    const admin = createKafkaAdmin({ brokers: kafka.brokers, clientId: 'it-log-sampling-groups' });
    await admin.connect();
    try {
      const groups = (await admin.listGroups()).groups.map((g) => g.groupId);
      expect(groups).toEqual(expect.arrayContaining([`${SERVICE}-pod-ls-a.${CONTROL_TOPICS.sessionsTerminated}`, `${SERVICE}-pod-ls-b.${CONTROL_TOPICS.settings}`]));
      for (const name of ['pod-ls-b', 'pod-ls-c', 'pod-ls-d']) expect(groups, name).not.toContain(`${SERVICE}-${name}.${CONTROL_TOPICS.sessionsTerminated}`);
    } finally {
      await admin.disconnect();
    }
  }, 180_000);
});
