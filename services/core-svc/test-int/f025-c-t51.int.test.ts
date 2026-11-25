// C-T51 오래 끈 기능 플래그(docs/features/control-tower.md §14 C-T51, ADR-0103 결정 2·4, ADR-0365 결정 17·20, BUILD_ORDER F-02-5 OPS-300, 계획 B17~B19).
// 실제 Kafka(컨테이너 한 대)에 kind 무대 선언(tools/local/v1-objects.mjs KAFKA_TOPIC_CONFIGS)대로 압축 토픽 control.settings를 만들고,
// ops-svc가 내는 꼴(asyncapi SettingChanged JSON)의 사건을 넣은 뒤 새 core-svc 인스턴스(createService + 후기 모듈 + startServiceControlSync)를 띄워 본다.
// - 후기 저장소는 메모리다(이 시험이 보는 것은 설정 소비와 후기 경로 가드다. 후기 DB 저장은 review.int.test.ts가 본다).
// - 시계: 서비스 시계를 사건보다 8일 + 1분 뒤로 둔다(정본 '시계를 8일 넘긴 뒤'). 압축이 실제로 돌았는지는 보지 않는다(계획 14절 7).
// - 준비 시간 한도: 정본 30초 [가정](ADR-0103 결정 2)을 시험에서 1,700ms로 줄인다(코드 기본값 30,000과 다르게 고른다. 30초 기본값은 platform D-T29 ④가 본다).
// - 압축 설정 정본 값: cleanup.policy=compact, min.compaction.lag.ms=86400000(1일), delete.retention.ms=604800000(7일)(ADR-0365 결정 20).
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CONTROL_TOPICS, createService, fakeClock, type PlatformService, type SettingsStore } from '@peaket/platform';
import { createKafkaAdmin, createKafkaProducer, startServiceControlSync, type KafkaProducer, type ServiceControlSync, type ServiceControlSyncOptions } from '@peaket/platform/stream-worker';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type Production } from '../src/modules/catalog/index.js';
import { MemoryReviewEligibility, MemoryReviewStore } from '../src/modules/review/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { startKafka, until, type KafkaContainer } from './kafka.js';

const SERVICE = 'core-svc';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 시험용 준비 시간 한도(정본 30초를 줄인 값, 코드 기본값과 다르게) */
const DEGRADE_MS = 1_700;
const FLAG_KEY = 'PLATFORM:FEATURE_FLAG:reviews';
const LOG_KEY = `PLATFORM:LOG_LEVEL:${SERVICE}`;
const ACTOR = '3b0c8f5e-2d41-4a7e-9f10-6c2e1d4b8a77';
/** 시작 설정 로그 수준(PEAKET_LOG_LEVEL). 기본 info·사건 값 debug와 다르게 고른다 */
const START_LEVEL = 'warn';

let kafka: KafkaContainer;
let producer: KafkaProducer;
/** 명령 9 사건의 판(occurredAt 밀리초) */
let flagVersion = 0;

/** 브로커 컨테이너 ID(무작위 호스트 포트로 찾는다). 토픽 설정은 컨테이너 안 kafka-configs.sh로 읽는다(관리 클라이언트에 describeConfigs가 없다) */
function brokerContainer(): string {
  const port = kafka.brokers[0]!.split(':')[1]!;
  const id = execFileSync('docker', ['ps', '-q', '--filter', `publish=${port}`], { encoding: 'utf8' }).trim();
  if (!id) throw new Error(`포트 ${port}의 Kafka 컨테이너를 찾지 못했다`);
  return id;
}

/** 브로커에 저장된 토픽 설정(동적 설정만, '이름=값') */
function topicConfigs(topic: string): Record<string, string> {
  const out = execFileSync('docker', ['exec', brokerContainer(), '/opt/kafka/bin/kafka-configs.sh', '--bootstrap-server', 'localhost:9094', '--describe', '--entity-type', 'topics', '--entity-name', topic], { encoding: 'utf8', timeout: 120_000 });
  // 'Dynamic configs for topic control.settings are:' 뒤 줄마다 '  이름=값 sensitive=false synonyms={…}'
  const configs: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+([a-z.]+)=(\S*)\s+sensitive=/.exec(line);
    if (m) configs[m[1]!] = m[2]!;
  }
  return configs;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** ops-svc가 내는 꼴(asyncapi SettingChanged JSON)의 설정 사건 */
async function publish(messageKey: string, body: { key: string; value: unknown; occurredAt: number; expiresAt?: number }): Promise<void> {
  const value = {
    commandId: randomUUID(),
    key: body.key,
    scope: 'PLATFORM',
    value: body.value,
    ...(body.expiresAt !== undefined ? { expiresAt: iso(body.expiresAt) } : {}),
    actor: ACTOR,
    occurredAt: iso(body.occurredAt),
    eventKey: randomUUID(),
  };
  await producer.send({ topic: CONTROL_TOPICS.settings, messages: [{ key: messageKey, value: Buffer.from(JSON.stringify(value), 'utf8') }] });
}

beforeAll(async () => {
  kafka = await startKafka();
  const admin = createKafkaAdmin({ brokers: kafka.brokers, clientId: 'it-f025-topics' });
  await admin.connect();
  try {
    // 선언 원천(tools/local/v1-objects.mjs)은 checkJs가 켜진 이 패키지의 타입 검사에 끌려들지 않게
    // 값이 아닌 URL로 동적 가져온다(계획 8.4). 없으면 undefined라 시험이 압축 설정 없이 실패한다
    const mod = (await import(/* @vite-ignore */ new URL('../../../tools/local/v1-objects.mjs', import.meta.url).href)) as { KAFKA_TOPIC_CONFIGS?: Record<string, Record<string, string>> };
    const declared: Record<string, string> = mod.KAFKA_TOPIC_CONFIGS?.[CONTROL_TOPICS.settings] ?? {};
    await admin.createTopics({
      topics: [
        { topic: CONTROL_TOPICS.settings, numPartitions: 3, replicationFactor: 1, configEntries: Object.entries(declared).map(([name, value]) => ({ name, value })) },
        { topic: CONTROL_TOPICS.sessionsTerminated, numPartitions: 3, replicationFactor: 1 },
      ],
    });
  } finally {
    await admin.disconnect();
  }
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'it-f025-ops', kind: 'outbox-relay' });
  await producer.connect();
}, 180_000);

afterAll(async () => {
  await producer?.disconnect().catch(() => {});
  kafka?.stop();
});

interface Pod {
  svc: PlatformService;
  sync: ServiceControlSync;
  eventId: string;
  ready(): Promise<{ statusCode: number; pending: string[] }>;
  metrics(): Promise<string>;
  reviews(): Promise<{ statusCode: number; type?: string; retryAfter?: unknown }>;
}

const pods: Pod[] = [];
afterEach(async () => {
  while (pods.length) {
    const p = pods.pop()!;
    await p.svc.close().catch(() => {});
    await p.sync.close();
  }
});

/** 새 core-svc 인스턴스 하나(서비스 시계 nowMs). 후기 모듈의 설정 저장소는 시작 파일처럼 제어 소비가 만든 저장소를 가리킨다 */
async function pod(name: string, nowMs: number, o: ServiceControlSyncOptions = {}): Promise<Pod> {
  const repo = new MemoryCatalogRepository();
  const promoter = randomUUID();
  repo.sellerNames.set(promoter, '(주)피켓공연');
  const p: Production = { id: randomUUID(), promoterId: promoter, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') };
  repo.productions.set(p.id, p);
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: p.id, venueId: randomUUID(), openAt: new Date('2026-01-01T00:00:00Z'), startsAt: new Date('2026-01-01T10:00:00Z'), status: 'SCHEDULED' });
  // 시작 파일(main.ts)처럼 서비스를 만든 뒤 제어 소비를 시작하므로, 후기 모듈에는 나중에 채워지는 저장소를 읽는 꼴을 넘긴다
  const holder: { current?: SettingsStore } = {};
  const settings: Pick<SettingsStore, 'get'> = { get: (key) => holder.current?.get(key) };
  const svc = await createService({
    name: SERVICE,
    module: AppModule.register({ memory: true, catalog: repo, review: { store: new MemoryReviewStore(), eligibility: new MemoryReviewEligibility(), settings } }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: START_LEVEL },
    clock: fakeClock({ now: nowMs }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  const sync = startServiceControlSync(svc, { PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: kafka.brokers.join(','), PEAKET_POD: name }, o);
  if (!sync) throw new Error('브로커 주소를 줬는데 제어 소비가 켜지지 않았다');
  holder.current = sync.sync.settings;
  const it: Pod = {
    svc,
    sync,
    eventId,
    ready: async () => {
      const r = await svc.management.inject({ method: 'GET', url: '/ready' });
      const body = JSON.parse(r.payload) as { pending?: string[] };
      return { statusCode: r.statusCode, pending: [...(body.pending ?? [])].sort() };
    },
    metrics: async () => (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload,
    reviews: async () => {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}/reviews` });
      const type = r.statusCode === 503 ? (JSON.parse(r.payload) as { type?: string }).type : undefined;
      return { statusCode: r.statusCode, ...(type !== undefined ? { type } : {}), retryAfter: r.headers['retry-after'] };
    },
  };
  pods.push(it);
  return it;
}

/** 프로메테우스 글에서 한 줄의 값(라벨이 모두 맞는 첫 줄) */
function sample(text: string, name: string, labels: Record<string, string>): number | undefined {
  for (const line of text.split('\n')) {
    const m = /^([^{\s]+)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = Object.fromEntries([...(m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) return Number(m[3]);
  }
  return undefined;
}

const readyIn = (p: Pod, ms: number) => until(async () => (await p.ready()).statusCode === 200, '인스턴스 준비', ms, 100);

describe('C-T51 오래 끈 기능 플래그(ADR-0103 결정 2·4)', () => {
  test('C-T51 ① kind 무대 선언대로 만든 control.settings는 압축 토픽이고, 명령 9로 끈 후기 플래그는 시계 8일 뒤 새로 띄운 core-svc에서도 503이다', async () => {
    // 만든 토픽의 설정을 Kafka에서 다시 읽는다(선언 → 브로커)
    expect(topicConfigs(CONTROL_TOPICS.settings)).toEqual({
      'cleanup.policy': 'compact',
      'delete.retention.ms': String(7 * DAY_MS),
      'min.compaction.lag.ms': String(1 * DAY_MS),
    });
    flagVersion = Date.now();
    await publish(FLAG_KEY, { key: 'FEATURE_FLAG', value: { enabled: false }, occurredAt: flagVersion });
    const p = await pod('core-pod-8d', flagVersion + 8 * DAY_MS + 60_000);
    await readyIn(p, 60_000);
    // 압축 토픽을 처음부터 읽어 그 판을 적용했다
    expect(sample(await p.metrics(), 'control_settings_applied_version', { service: SERVICE, key: FLAG_KEY })).toBe(flagVersion);
    expect(await p.reviews()).toEqual({ statusCode: 503, type: expect.stringMatching(/review-feature-off$/), retryAfter: '60' });
    // 되돌리기 사건(enabled: true, 새 판)을 받으면 다음 요청부터 200이다(같은 인스턴스, 다시 띄우지 않는다)
    await publish(FLAG_KEY, { key: 'FEATURE_FLAG', value: { enabled: true }, occurredAt: flagVersion + 1 });
    await until(async () => (await p.reviews()).statusCode === 200, '되돌리기 사건 반영', 15_000, 100);
    // 다시 끈다(③은 막힌 채 뜬 파드가 이 값을 읽지 못한 기본값을 쓰는지 본다)
    await publish(FLAG_KEY, { key: 'FEATURE_FLAG', value: { enabled: false }, occurredAt: flagVersion + 2 });
    await until(async () => (await p.reviews()).statusCode === 503, '다시 끈 사건 반영', 15_000, 100);
  }, 120_000);

  test('C-T51 ② 만료가 지난 로그 레벨 사건은 새로 띄운 인스턴스가 적용하지 않고, 살아 있는 값은 적용한다', async () => {
    const t0 = Date.now();
    // 30분 만료(명령 8)가 지난 DEBUG
    await publish(LOG_KEY, { key: 'LOG_LEVEL', value: { level: 'DEBUG' }, occurredAt: t0, expiresAt: t0 + 30 * 60_000 });
    const now = t0 + 8 * DAY_MS;
    const p = await pod('core-pod-log', now);
    await readyIn(p, 60_000);
    // 판은 받았지만(지표) 만료라 로거 수준은 시작 설정 값 그대로다
    await until(async () => sample(await p.metrics(), 'control_settings_applied_version', { service: SERVICE, key: LOG_KEY }) === t0, '만료 사건 판 받기', 15_000, 100);
    expect(p.svc.logger.level).toBe(START_LEVEL);
    // 대조: 같은 인스턴스가 만료 전 사건(새 판)은 바로 적용한다(이 길이 막혀 있어 통과한 것이 아니다)
    await publish(LOG_KEY, { key: 'LOG_LEVEL', value: { level: 'DEBUG' }, occurredAt: t0 + 1, expiresAt: now + 30 * 60_000 });
    await until(() => p.svc.logger.level === 'debug', '살아 있는 로그 레벨 적용', 15_000, 100);
    // 되돌리기(INFO, 만료 없음)로 원래 정본 기본 수준
    await publish(LOG_KEY, { key: 'LOG_LEVEL', value: { level: 'INFO' }, occurredAt: t0 + 2 });
    await until(() => p.svc.logger.level === 'info', 'INFO 사건 적용', 15_000, 100);
  }, 120_000);

  test(`C-T51 ③ Kafka를 막은 채 띄우면 ${DEGRADE_MS}ms 전에는 준비 아님, 뒤에는 준비·control_sync_lagging{kind="settings"}=1이고 후기는 기본값(켜짐)이다`, async () => {
    kafka.pause();
    try {
      const started = Date.now();
      const p = await pod('core-pod-blocked', started, { degradeAfterMs: DEGRADE_MS, retryMs: 300 });
      const first = await p.ready();
      expect(first.statusCode).toBe(503);
      expect(first.pending).toContain('settings');
      await readyIn(p, DEGRADE_MS + 15_000);
      expect(Date.now() - started).toBeGreaterThanOrEqual(DEGRADE_MS - 50);
      const m = await p.metrics();
      expect(sample(m, 'control_sync_lagging', { service: SERVICE, kind: 'settings' })).toBe(1);
      // 막힘이 실제로 있었다: ①이 끈 플래그(마지막 값 enabled: false)를 읽지 못해 기본값(켜짐)이다
      expect(sample(m, 'control_settings_applied_version', { service: SERVICE, key: FLAG_KEY })).toBeUndefined();
      expect((await p.reviews()).statusCode).toBe(200);
    } finally {
      await kafka.resume();
    }
  }, 120_000);
});
