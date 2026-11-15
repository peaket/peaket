// COV2-06 ⑫(W7-audit): 실제 Kafka 3.9(KRaft)와 PostgreSQL 18에서 core-svc 소비자(startCoreConsumers)가 탈퇴 사건을 받아 후기를 익명화하고,
// 읽지 못한 사건은 pid 없이 held_event에 보류하는지 본다(docs/streaming.md §2.6 'core-svc 소비자', docs/features/identity.md §8 '후기 익명화',
// docs/security/data-classification.md '탈퇴 사건의 pid 사본'). 값은 JSON 대역이다(Avro는 BAS-030). DB는 운영과 같은 역할(core_app)로 붙는다.
// 네이티브 Kafka 모듈이 이 PC의 응용 프로그램 제어에 막히면 CI에서만 돈다.
import 'reflect-metadata';
import { createDatabase, systemClock, type Database } from '@peaket/platform';
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

/** 정본 값(asyncapi 채널 이름, streaming.md §2.6 그룹 이름). 운영 상수를 가져오지 않고 따로 적는다 */
const TOPIC = 'identity.accounts-withdrawn';
const ENV = 'ci';
const GROUP = 'peaket.core-svc.ci';
const PID = 'pidSECRETcurrent_7788';
const OLD_PID = 'pidSECRETprevious_9900';

let kafka: KafkaContainer;
let pg: PostgresContainer;
let admin: Database;
let app: Database;
let producer: KafkaProducer;
let consumers: CoreConsumers;

beforeAll(async () => {
  [kafka, pg] = await Promise.all([startKafka(), startPostgres()]);
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-withdrawn-consumer-admin', max: 2 });
  app = await loginFor(admin, pg, 'core_app_withdrawn_consumer', 'core_app', 4);
  await kafka.createTopic(TOPIC, 1);
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'it-producer', kind: 'default' });
  await producer.connect();
  const reviews = new Reviews({
    store: new DrizzleReviewStore(app),
    events: new MemoryReviewEventDirectory(new MemoryCatalogRepository()),
    eligibility: new MemoryReviewEligibility(),
    fanProfile: new MemoryFanProfile(),
    notifier: new MemoryReviewNotifier(),
    cases: new MemoryReviewCaseSink(),
    clock: systemClock,
  });
  consumers = startCoreConsumers({
    env: ENV,
    brokers: kafka.brokers,
    clientId: 'core-svc-ci-it',
    database: app,
    handler: new ReviewAccountWithdrawnHandler(reviews),
    commitEveryMs: 200,
    measureHeldEveryMs: 200,
  });
  await consumers.started;
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

describe('COV2-06 core 탈퇴 소비자(실제 Kafka)', () => {
  test(
    'COV2-06 ⑫ 실제 Kafka의 탈퇴 사건이 core 후기를 익명화하고, 읽지 못한 사건은 pid 없이 held_event에 보류된다',
    async () => {
      const A = randomUUID();
      const reviewId = await seedReview(A);
      const withdrawnAt = new Date().toISOString();
      const purgeBy = new Date(Date.now() + 5 * 86_400_000).toISOString();
      await send(A, { eventKey: randomUUID(), accountId: A, pids: [PID, OLD_PID], withdrawnAt, purgeBy });

      await until(async () => {
        const r = await admin.pool.query('select account_id, basis_order_id, author_display from review where id = $1', [reviewId]);
        return r.rows[0]?.account_id === reviewId;
      }, '탈퇴 사건 뒤 후기 익명화', 60_000);
      const after = (await admin.pool.query('select account_id, basis_order_id, author_display from review where id = $1', [reviewId])).rows[0];
      expect(after).toEqual({ account_id: reviewId, basis_order_id: reviewId, author_display: '탈퇴한 사용자' });

      // pid가 들고 accountId가 틀린 사건: 처리기가 읽지 못해 보류된다. 보류 행에는 pid가 없다
      const badKey = `bad-${randomUUID()}`;
      await send(badKey, { eventKey: randomUUID(), accountId: 'not-a-uuid', pids: [PID, OLD_PID], withdrawnAt, purgeBy });
      await until(async () => {
        const r = await admin.pool.query('select count(*)::int as n from held_event where topic = $1', [TOPIC]);
        return r.rows[0].n >= 1;
      }, '읽지 못한 탈퇴 사건의 보류', 90_000);
      const held = (await admin.pool.query('select topic, value, headers::text as headers, row_to_json(h)::text as whole from held_event h where topic = $1', [TOPIC])).rows;
      expect(held).toHaveLength(1);
      expect(held[0].topic).toBe(TOPIC);
      expect(held[0].value).toBeNull();
      for (const secret of [PID, OLD_PID]) {
        expect(held[0].headers).not.toContain(secret);
        expect(held[0].whole).not.toContain(secret);
      }

      // 소비자 그룹은 peaket.core-svc.<환경>이고 두 사건 뒤까지 커밋한다
      await until(async () => ((await kafka.groupOffsets(GROUP, TOPIC)).get(0) ?? 0) >= 2, `${GROUP} 커밋`, 60_000);
    },
    240_000,
  );
});
