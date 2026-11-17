// I-T83 ①④(W8-audit2a, 소유자 결정 2026-11-16 OPEN[42]·[44], ADR-0278)·COV2-06 ⑫(W7-audit): 실제 Kafka 3.9(KRaft)와 PostgreSQL 18에서
// core-svc 소비자(startCoreConsumers)가 탈퇴 사건을 받아 후기를 파기하고 '다시 정리 예약'을 쓰며, 함께 켠 반복이 예약 시각에 그 계정을 다시 파기하는지 본다.
// 읽지 못한 사건은 pid 없이 held_event에 보류한다(docs/streaming.md §2.6 'core-svc 소비자', docs/features/identity.md §8 '후기 파기'·'다시 정리',
// docs/security/data-classification.md '탈퇴 사건의 pid 사본'). 값은 JSON 대역이다(Avro는 BAS-030). DB는 운영과 같은 역할(core_app)로 붙는다.
// 소비자와 반복은 실제 시계(systemClock)로 돈다. 그래서 탈퇴 시각·예약 시각의 기준은 이 프로세스의 지금(Date.now())이다(고정 날짜를 쓰지 않는다, W8-ci-fix 교훈).
// 네이티브 Kafka 모듈이 이 PC의 응용 프로그램 제어에 막히면 CI에서만 돈다.
import 'reflect-metadata';
import { createDatabase, PlatformMetrics, systemClock, type Database } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer } from '@peaket/platform/stream-worker';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { type CoreConsumers, startCoreConsumers } from '../src/consumers/start.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { review } from '../src/modules/review/adapters/db/schema.js';
import { MemoryReviewEventDirectory } from '../src/modules/review/adapters/memory-review-event-directory.js';
import {
  DrizzleReviewStore,
  MemoryFanProfile,
  MemoryReviewCaseSink,
  MemoryReviewEligibility,
  MemoryReviewNotifier,
  ReviewAccountWithdrawnHandler,
  Reviews,
} from '../src/modules/review/index.js';
import { type KafkaContainer, startKafka, until } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

/** 정본 값(asyncapi 채널 이름, streaming.md §2.6 그룹 이름, identity.md §8 예약 16분). 운영 상수를 가져오지 않고 따로 적는다 */
const TOPIC = 'identity.accounts-withdrawn';
const ENV = 'ci';
const GROUP = 'peaket.core-svc.ci';
const PID = 'pidSECRETcurrent_7788';
const OLD_PID = 'pidSECRETprevious_9900';
const MIN = 60_000;
const RECHECK_DELAY = 16 * MIN;

let kafka: KafkaContainer;
let pg: PostgresContainer;
let admin: Database;
let app: Database;
let producer: KafkaProducer;
let reviews: Reviews;
let consumers: CoreConsumers | undefined;
/** 소비자 지표 저장소(main.ts의 service.metrics.registry 자리) */
const metrics = new PlatformMetrics('core-svc');

beforeAll(async () => {
  [kafka, pg] = await Promise.all([startKafka(), startPostgres()]);
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-withdrawn-consumer-admin', max: 2 });
  app = await loginFor(admin, pg, 'core_app_withdrawn_consumer', 'core_app', 4);
  await kafka.createTopic(TOPIC, 1);
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'it-producer', kind: 'default' });
  await producer.connect();
  reviews = new Reviews({
    store: new DrizzleReviewStore(app),
    events: new MemoryReviewEventDirectory(new MemoryCatalogRepository()),
    eligibility: new MemoryReviewEligibility(),
    fanProfile: new MemoryFanProfile(),
    notifier: new MemoryReviewNotifier(),
    cases: new MemoryReviewCaseSink(),
    clock: systemClock,
  });
}, 180_000);

afterAll(async () => {
  await consumers?.stop().catch(() => {});
  await producer?.disconnect().catch(() => {});
  await app?.close();
  await admin?.close();
  kafka?.stop();
  pg?.stop();
});

const send = (key: string, value: unknown) => producer.send({ topic: TOPIC, messages: [{ key, value: JSON.stringify(value) }] });

/** 소비자(다시 정리 반복 포함)를 한 번만 켠다. 시험 안에서 켜서 켜기가 실패하면 그 시험의 실패로 남게 한다 */
async function ensureConsumers(): Promise<void> {
  if (consumers) return;
  consumers = startCoreConsumers({
    env: ENV,
    brokers: kafka.brokers,
    clientId: 'core-svc-ci-it',
    database: app,
    handler: new ReviewAccountWithdrawnHandler(reviews),
    // 웨이브 끝 리뷰 K9: main.ts처럼 지표 저장소를 넘겨 보류 수 세기(heldEventCounts, core_app으로 held_event 읽기)도 거친다
    registry: metrics.registry,
    // I-T83 ⑤: 반복은 처리기와 같은 소비자 풀 Reviews를 쓴다(main.ts의 consumerReviews 자리). 간격은 시험이 줄인다
    recheck: reviews,
    recheckEveryMs: 200,
    commitEveryMs: 200,
    measureHeldEveryMs: 200,
  });
  await consumers.started;
}

async function seedReview(accountId: string): Promise<string> {
  const id = randomUUID();
  const at = new Date('2026-11-10T00:00:00Z');
  await admin.db.insert(review).values({
    id,
    eventId: randomUUID(),
    accountId,
    basisOrderId: randomUUID(),
    rating: 4,
    body: '소비자 통합 시험용 후기 본문입니다.',
    status: 'VISIBLE',
    contentFingerprint: `fp-${id}`,
    authorDisplay: '김**',
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

const reviewRow = async (id: string) =>
  (await admin.pool.query('select account_id, basis_order_id, author_display, status, rating, body, content_fingerprint, updated_at from review where id = $1', [id])).rows[0] as
    | { account_id: string; basis_order_id: string; author_display: string; status: string; rating: number | null; body: string; content_fingerprint: string | null; updated_at: Date }
    | undefined;
const recheckOf = async (accountId: string): Promise<{ due_at: Date }[]> => (await admin.pool.query('select due_at from review_withdrawal_recheck where account_id = $1', [accountId])).rows;
/** docs/data.md §2 '후기 파기'의 칸(관리자 SQL로 읽은 모양) */
const purgedRow = (id: string) => ({ account_id: id, basis_order_id: id, author_display: '', status: 'DELETED', rating: null, body: '', content_fingerprint: null });

describe('I-T83 core 탈퇴 소비자(실제 Kafka)', () => {
  test(
    'I-T83 ① 실제 Kafka의 탈퇴 사건이 core 후기를 파기하고, 읽지 못한 사건은 pid 없이 held_event에 보류된다 (COV2-06 ⑫)',
    async () => {
      await ensureConsumers();

      const A = randomUUID();
      const reviewId = await seedReview(A);
      const withdrawnAt = new Date().toISOString();
      const purgeBy = new Date(Date.now() + 5 * 86_400_000).toISOString();
      await send(A, { eventKey: randomUUID(), accountId: A, pids: [PID, OLD_PID], withdrawnAt, purgeBy });

      await until(async () => (await reviewRow(reviewId))?.status === 'DELETED', '탈퇴 사건 뒤 후기 파기', 60_000);
      const { updated_at: _u, ...after } = (await reviewRow(reviewId))!;
      expect(after).toEqual(purgedRow(reviewId));
      // 같은 트랜잭션에 다시 정리 예약(탈퇴 시각 + 16분)이 있다
      expect(await recheckOf(A)).toEqual([{ due_at: new Date(Date.parse(withdrawnAt) + RECHECK_DELAY) }]);

      // pid가 들고 accountId가 틀린 사건: 처리기가 읽지 못해 보류된다. 보류 행에는 pid가 없다
      const badKey = `bad-${randomUUID()}`;
      await send(badKey, { eventKey: randomUUID(), accountId: 'not-a-uuid', pids: [PID, OLD_PID], withdrawnAt, purgeBy });
      await until(async () => {
        const r = await admin.pool.query('select count(*)::int as n from held_event where topic = $1', [TOPIC]);
        return r.rows[0].n >= 1;
      }, '읽지 못한 탈퇴 사건의 보류', 90_000);
      const held = (await admin.pool.query('select topic, value, event_key, msg_key, headers::text as headers, row_to_json(h)::text as whole from held_event h where topic = $1', [TOPIC])).rows;
      expect(held).toHaveLength(1);
      expect(held[0].topic).toBe(TOPIC);
      expect(held[0].value).toBeNull();
      // 해독하지 못한 사건은 eventKey 없이 Kafka 키로만 보류된다(I-T83 ⑨ 손으로 처리가 다루는 꼴, 다시 보기 N1의 전제)
      expect(held[0].event_key).toBeNull();
      expect(held[0].msg_key).toBe(badKey);
      for (const secret of [PID, OLD_PID]) {
        expect(held[0].headers).not.toContain(secret);
        expect(held[0].whole).not.toContain(secret);
      }

      // K9: 보류 수 지표(consumer_held_events)가 탈퇴 토픽에서 1이 된다
      await until(
        async () => /consumer_held_events\{[^}]*topic="identity\.accounts-withdrawn"[^}]*\} 1\b/.test(await metrics.registry.getSingleMetricAsString('consumer_held_events')),
        'consumer_held_events 1',
        30_000,
      );

      // 소비자 그룹은 peaket.core-svc.<환경>이고 두 사건 뒤까지 커밋한다
      await until(async () => ((await kafka.groupOffsets(GROUP, TOPIC)).get(0) ?? 0) >= 2, `${GROUP} 커밋`, 60_000);
    },
    240_000,
  );

  test(
    'I-T83 ④ 실제 Kafka 탈퇴 사건 뒤 예약 행이 생기고 반복이 그 시각에 다시 파기한다',
    async () => {
      await ensureConsumers();

      const A = randomUUID();
      const first = await seedReview(A);
      // 기준은 소비자·반복이 쓰는 실제 시계다. 탈퇴 시각을 (16분 − 20초) 전으로 두면 예약은 지금 + 20초다(사건 처리가 그 전에 끝나게 여유를 둔다)
      const withdrawnAtMs = Date.now() - RECHECK_DELAY + 20_000;
      const dueMs = withdrawnAtMs + RECHECK_DELAY;
      await send(A, { eventKey: randomUUID(), accountId: A, pids: [PID], withdrawnAt: new Date(withdrawnAtMs).toISOString(), purgeBy: new Date(Date.now() + 5 * 86_400_000).toISOString() });

      await until(async () => (await reviewRow(first))?.status === 'DELETED', '탈퇴 사건 뒤 후기 파기', 60_000);
      expect(Date.now(), '사건 처리가 예약 시각 전에 끝났다(아니면 이 시험의 전제가 깨진다)').toBeLessThan(dueMs - 1_000);
      expect(await recheckOf(A)).toEqual([{ due_at: new Date(dueMs) }]);

      // 탈퇴 전 토큰으로 사건 처리 뒤에 새 후기를 쓴다(흉내: 저장소에 바로 넣는다)
      const late = await seedReview(A);
      // 예약 시각 전에는 반복(200ms 간격)이 그 후기를 건드리지 않는다
      await new Promise((r) => setTimeout(r, 1_000));
      if (Date.now() < dueMs - 200) {
        expect((await reviewRow(late))?.status).toBe('VISIBLE');
        expect(await recheckOf(A)).toHaveLength(1);
      }
      // 예약 시각이 지나면 3초 안에 파기되고 예약이 지워진다
      await until(async () => (await reviewRow(late))?.status === 'DELETED' && (await recheckOf(A)).length === 0, '예약 시각 뒤 다시 파기', Math.max(0, dueMs - Date.now()) + 3_000);
      const row = (await reviewRow(late))!;
      const { updated_at, ...fields } = row;
      expect(fields).toEqual(purgedRow(late));
      // 다시 파기한 때(반복의 지금)는 예약 시각보다 이르지 않다
      expect(updated_at.getTime()).toBeGreaterThanOrEqual(dueMs);
    },
    120_000,
  );
});
