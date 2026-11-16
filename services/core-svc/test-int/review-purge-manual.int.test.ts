// I-T83 ⑦⑨(W8-audit2a 웨이브 끝 보안 리뷰 S1, 계획 §9.1, 정본 docs/features/identity.md §8 '손으로 처리'): 손으로 하는 파기(DrizzleReviewStore.purgeHeldWithdrawal)를
// 실제 PostgreSQL 18에서 운영과 같은 DB 역할(core_app)로 본다. 그 계정의 처리 안 한 탈퇴 보류 사건(held_event, 토픽 identity.accounts-withdrawn,
// 업무 키 또는 Kafka 키가 그 계정)이 있을 때만 한 트랜잭션에서 보류 행 잠금 → 다시 정리 예약 → 파기 → reprocessed_at 표시를 한다.
// 기준 시각은 DB 서버 시각에서 잡는다. 시험 자료 넣기와 확인은 관리자(슈퍼유저) 연결로 한다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { review } from '../src/modules/review/adapters/db/schema.js';
import { DrizzleReviewStore } from '../src/modules/review/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let app: Database;
/** DB 서버 시각(beforeAll) */
let NOW: number;
const MIN = 60_000;
const TOPIC = 'identity.accounts-withdrawn';

const codeOf = async (db: Database, text: string, params: unknown[] = []): Promise<string> => {
  try {
    await db.pool.query(text, params);
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};
const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
};

let offset = 0;
/** 보류 행 하나(관리자 연결). 값은 pid 없이 null(core는 읽지 못한 값을 값 없이 둔다) */
async function seedHeld(o: { topic?: string; eventKey: string | null; businessKey: string; msgKey: string | null; reprocessedAt?: Date | null }): Promise<string> {
  const id = randomUUID();
  offset += 1;
  await admin.pool.query(
    `insert into held_event (id, topic, partition, kafka_offset, event_key, business_key, error, msg_key, record_at, value, headers, held_at, reprocessed_at)
     values ($1, $2, 0, $3, $4, $5, 'Error: 시험', $6, $7, null, '{}'::jsonb, $7, $8)`,
    [id, o.topic ?? TOPIC, offset, o.eventKey, o.businessKey, o.msgKey, new Date(NOW - 10 * MIN), o.reprocessedAt ?? null],
  );
  return id;
}
async function seedReview(accountId: string): Promise<string> {
  const id = randomUUID();
  const at = new Date(NOW - 86_400_000);
  await admin.db.insert(review).values({
    id,
    eventId: randomUUID(),
    accountId,
    basisOrderId: randomUUID(),
    rating: 5,
    body: '손 처리 통합 시험용 후기 본문입니다.',
    status: 'VISIBLE',
    contentFingerprint: `fp-${id}`,
    authorDisplay: '김**',
    createdAt: at,
    updatedAt: at,
  });
  return id;
}
const reviewOf = async (id: string) => (await admin.pool.query('select status, rating, account_id, updated_at from review where id = $1', [id])).rows[0] as { status: string; rating: number | null; account_id: string; updated_at: Date };
const heldOf = async (ids: string[]) =>
  (await admin.pool.query('select id, reprocessed_at from held_event where id = any($1::uuid[]) order by id', [ids])).rows as { id: string; reprocessed_at: Date | null }[];
const recheckOf = async (accountId: string) => (await admin.pool.query('select due_at from review_withdrawal_recheck where account_id = $1', [accountId])).rows as { due_at: Date }[];

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-review-purge-manual-admin', max: 3 });
  app = await loginFor(admin, pg, 'core_app_review_purge_manual', 'core_app', 2);
  NOW = Math.floor(Number((await admin.pool.query('select (extract(epoch from now()) * 1000)::float8 as ms')).rows[0].ms));
});
afterAll(async () => {
  await app?.close();
  await admin?.close();
  pg?.stop();
});

describe('I-T83 손으로 하는 파기(실제 DB, 웨이브 끝 리뷰 S1)', () => {
  test('I-T83 ⑨ 보류된 탈퇴 사건이 없으면 아무것도 바꾸지 않는다', async () => {
    const store = new DrizzleReviewStore(app);
    const [none, onlyReprocessed, otherTopic] = [randomUUID(), randomUUID(), randomUUID()];
    const reviews = [await seedReview(none), await seedReview(onlyReprocessed), await seedReview(otherTopic)];
    await seedHeld({ eventKey: randomUUID(), businessKey: onlyReprocessed, msgKey: onlyReprocessed, reprocessedAt: new Date(NOW - MIN) });
    await seedHeld({ topic: 'trade.orders', eventKey: randomUUID(), businessKey: otherTopic, msgKey: otherTopic });
    for (const who of [none, onlyReprocessed, otherTopic]) {
      expect(await store.purgeHeldWithdrawal(who, { nowMs: NOW, recheckAtMs: NOW + 16 * MIN }), who).toBeUndefined();
      expect(await recheckOf(who), who).toEqual([]);
    }
    for (const id of reviews) expect((await reviewOf(id)).status, id).toBe('VISIBLE');
  });

  test('I-T83 ⑨ 보류된 탈퇴 사건이 있으면 파기하고 보류 행을 다시 처리로 표시하며 예약을 쓴다', async () => {
    const store = new DrizzleReviewStore(app);
    const A = randomUUID();
    const r1 = await seedReview(A);
    const r2 = await seedReview(A);
    const other = await seedReview(randomUUID());
    const keyA1 = randomUUID();
    const keyA2 = randomUUID();
    // 업무 키가 그 계정인 보류, 값을 읽지 못해 Kafka 키(대문자)만 그 계정인 보류, 다른 계정의 보류
    const h1 = await seedHeld({ eventKey: keyA1, businessKey: A, msgKey: A });
    const h2 = await seedHeld({ eventKey: keyA2, businessKey: `unreadable-${offset}`, msgKey: A.toUpperCase() });
    const hOther = await seedHeld({ eventKey: randomUUID(), businessKey: randomUUID(), msgKey: null });
    const recheckAtMs = NOW + 16 * MIN;

    const r = await store.purgeHeldWithdrawal(A, { nowMs: NOW, recheckAtMs });
    expect(r?.purged).toBe(2);
    expect([...(r?.heldEventKeys ?? [])].sort()).toEqual([keyA1, keyA2].sort());
    for (const id of [r1, r2]) expect(await reviewOf(id), id).toEqual({ status: 'DELETED', rating: null, account_id: id, updated_at: new Date(NOW) });
    expect((await reviewOf(other)).status).toBe('VISIBLE');
    const held = await heldOf([h1, h2, hOther]);
    expect(held.find((h) => h.id === h1)?.reprocessed_at).toEqual(new Date(NOW));
    expect(held.find((h) => h.id === h2)?.reprocessed_at).toEqual(new Date(NOW));
    expect(held.find((h) => h.id === hOther)?.reprocessed_at).toBeNull();
    expect(await recheckOf(A)).toEqual([{ due_at: new Date(recheckAtMs) }]);
    // 다시 부르면 처리할 보류가 없다
    expect(await store.purgeHeldWithdrawal(A, { nowMs: NOW + MIN, recheckAtMs: NOW + 17 * MIN })).toBeUndefined();
  });

  test('I-T83 ⑨ 보류 행 표시가 실패하면 파기·예약도 남지 않는다', async () => {
    // 한 트랜잭션: 마지막 문장(보류 행 reprocessed_at 표시)만 실패하게 관리자 연결로 그 칸 권한을 잠시 거둔다
    const store = new DrizzleReviewStore(app);
    const A = randomUUID();
    const r1 = await seedReview(A);
    const h1 = await seedHeld({ eventKey: randomUUID(), businessKey: A, msgKey: A });
    await admin.pool.query('revoke update (reprocessed_at) on held_event from core_app');
    const rejected: unknown[] = [];
    try {
      await store.purgeHeldWithdrawal(A, { nowMs: NOW, recheckAtMs: NOW + 16 * MIN }).catch((err: unknown) => void rejected.push(err));
    } finally {
      await admin.pool.query('grant update (reprocessed_at) on held_event to core_app');
    }
    // 끊긴 사례가 실제로 있었다(거절 1건, 권한 오류). 후기·예약·보류 행이 모두 그대로다
    expect(rejected).toHaveLength(1);
    expect(pgCode(rejected[0])).toBe('42501');
    expect((await reviewOf(r1)).status).toBe('VISIBLE');
    expect(await recheckOf(A)).toEqual([]);
    expect((await heldOf([h1]))[0]?.reprocessed_at).toBeNull();
    // 권한을 돌린 뒤 다시 하면 셋 다 있다
    expect((await store.purgeHeldWithdrawal(A, { nowMs: NOW, recheckAtMs: NOW + 16 * MIN }))?.purged).toBe(1);
    expect((await reviewOf(r1)).status).toBe('DELETED');
    expect(await recheckOf(A)).toHaveLength(1);
    expect((await heldOf([h1]))[0]?.reprocessed_at).toEqual(new Date(NOW));
  });

  test('I-T83 ⑦⑨ 0026은 core_app에 held_event의 reprocessed_at 고치기만 더 준다', async () => {
    const h = await seedHeld({ eventKey: randomUUID(), businessKey: randomUUID(), msgKey: null });
    // 대조군(허용 쪽): 다시 처리 표시
    expect(await codeOf(app, 'update held_event set reprocessed_at = $1 where id = $2', [new Date(NOW), h])).toBe('OK');
    // 거부 쪽: 다른 칸 고치기, 지우기, 비우기
    const denied: [string, string, unknown[]][] = [
      ['error 고치기', "update held_event set error = 'x' where id = $1", [h]],
      ['value 고치기', 'update held_event set value = null where id = $1', [h]],
      ['business_key 고치기', "update held_event set business_key = 'x' where id = $1", [h]],
      ['지우기', 'delete from held_event where id = $1', [h]],
      ['비우기', 'truncate held_event', []],
    ];
    for (const [what, text, params] of denied) expect(await codeOf(app, text, params), what).toBe('42501');
  });
});
