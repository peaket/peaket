// I-T83 ⑦⑨(W8-audit2a 웨이브 끝 보안 리뷰 S1, 계획 §9.1, 정본 docs/features/identity.md §8 '손으로 처리'): 손으로 하는 파기(DrizzleReviewStore.purgeHeldWithdrawal)를
// 실제 PostgreSQL 18에서 운영과 같은 DB 역할(core_app)로 본다. 그 계정의 처리 안 한 탈퇴 보류 사건(held_event, 토픽 identity.accounts-withdrawn,
// 업무 키 또는 Kafka 키가 그 계정)이 있을 때만 한 트랜잭션에서 보류 행 잠금 → 다시 정리 예약 → 파기 → reprocessed_at 표시를 한다.
// 기준 시각은 DB 서버 시각에서 잡는다. 시험 자료 넣기와 확인은 관리자(슈퍼유저) 연결로 한다.
// 다시 보기 N1·N3(계획 §10.5): 처리한 보류 행은 eventKey가 없는 행(해독하지 못한 사건, docs/data.md §4의 15)까지 모두 held로 돌려주고, 한 번에 보류 행 ID 차례로 50개까지 잠근다.
// 한 트랜잭션은 마지막 문장(reprocessed_at 표시)에만 걸리는 BEFORE UPDATE 방아쇠로 증명한다.
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
/** 오류 자신과 cause의 글(Drizzle은 드라이버 오류를 cause에 싼다) */
const pgMessage = (err: unknown): string => {
  const e = err as { message?: unknown; cause?: { message?: unknown } } | undefined;
  return [e?.message, e?.cause?.message].filter((m): m is string => typeof m === 'string').join(' | ');
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 한 번에 처리하는 보류 행 상한(정본 docs/features/identity.md §8 '손으로 처리', 50개 [가정]) */
const LIMIT = 50;

let offset = 0;
/** 보류 행 하나(관리자 연결). 값은 pid 없이 null(core는 읽지 못한 값을 값 없이 둔다) */
async function seedHeld(o: { id?: string; topic?: string; eventKey: string | null; businessKey: string; msgKey: string | null; reprocessedAt?: Date | null }): Promise<string> {
  const id = o.id ?? randomUUID();
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
/** 관리자 연결로 order by id해 읽은 보류 행(기대 차례의 기준) */
const heldById = async (ids: string[]) =>
  ((await admin.pool.query('select id::text as id, event_key from held_event where id = any($1::uuid[]) order by id', [ids])).rows as { id: string; event_key: string | null }[]).map((h) => ({
    id: h.id,
    eventKey: h.event_key,
  }));
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
      expect(await store.purgeHeldWithdrawal(who, { nowMs: NOW, recheckAtMs: NOW + 16 * MIN, limit: LIMIT }), who).toBeUndefined();
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
    // 업무 키가 그 계정인 보류(키 있음), 값을 읽지 못해 eventKey 없이 Kafka 키(대문자)만 그 계정인 보류, 같은 꼴로 Kafka 키(소문자)만 그 계정인 보류, 다른 계정의 보류.
    // 운영 소비자는 해독하지 못한 사건을 event_key 없이 보류한다(리뷰 N1: 전에는 h2에 eventKey를 넣어 결함을 덮었다)
    const h1 = await seedHeld({ eventKey: keyA1, businessKey: A, msgKey: A });
    const h2 = await seedHeld({ eventKey: null, businessKey: `unreadable-${offset}`, msgKey: A.toUpperCase() });
    const h3 = await seedHeld({ eventKey: null, businessKey: `unreadable-${offset}`, msgKey: A });
    const hOther = await seedHeld({ eventKey: randomUUID(), businessKey: randomUUID(), msgKey: null });
    const recheckAtMs = NOW + 16 * MIN;
    // 기대 차례는 관리자 연결의 order by id다. 넣은 값이 그대로인지 먼저 본다(h1만 키 있음)
    const expected = await heldById([h1, h2, h3]);
    expect(new Map(expected.map((h) => [h.id, h.eventKey]))).toEqual(new Map([[h1, keyA1], [h2, null], [h3, null]]));

    const r = await store.purgeHeldWithdrawal(A, { nowMs: NOW, recheckAtMs, limit: LIMIT });
    // 처리한 보류 행 셋을 모두 돌려준다(eventKey가 있든 없든, 보류 행 ID 차례)
    expect(r).toEqual({ purged: 2, held: expected });
    for (const id of [r1, r2]) expect(await reviewOf(id), id).toEqual({ status: 'DELETED', rating: null, account_id: id, updated_at: new Date(NOW) });
    expect((await reviewOf(other)).status).toBe('VISIBLE');
    const held = await heldOf([h1, h2, h3, hOther]);
    for (const id of [h1, h2, h3]) expect(held.find((h) => h.id === id)?.reprocessed_at, id).toEqual(new Date(NOW));
    expect(held.find((h) => h.id === hOther)?.reprocessed_at).toBeNull();
    expect(await recheckOf(A)).toEqual([{ due_at: new Date(recheckAtMs) }]);
    // 다시 부르면 처리할 보류가 없다
    expect(await store.purgeHeldWithdrawal(A, { nowMs: NOW + MIN, recheckAtMs: NOW + 17 * MIN, limit: LIMIT })).toBeUndefined();
  });

  test('I-T83 ⑨ 키 없는 보류 행만 있는 계정도 처리하고 그 행 ID를 돌려준다', async () => {
    // 리뷰 N1의 꼴: 해독하지 못한 사건의 보류 행(event_key null, 업무 키는 읽지 못한 값, Kafka 키는 대문자 계정 ID) 하나뿐인 계정. 실제 SQL의 null 처리를 본다
    const store = new DrizzleReviewStore(app);
    const G = randomUUID();
    const r1 = await seedReview(G);
    const h = await seedHeld({ eventKey: null, businessKey: `unreadable-${randomUUID()}`, msgKey: G.toUpperCase() });
    const recheckAtMs = NOW + 16 * MIN;

    expect(await store.purgeHeldWithdrawal(G, { nowMs: NOW, recheckAtMs, limit: LIMIT })).toEqual({ purged: 1, held: [{ id: h, eventKey: null }] });
    expect(await reviewOf(r1)).toEqual({ status: 'DELETED', rating: null, account_id: r1, updated_at: new Date(NOW) });
    expect((await heldOf([h]))[0]?.reprocessed_at).toEqual(new Date(NOW));
    expect(await recheckOf(G)).toEqual([{ due_at: new Date(recheckAtMs) }]);
    expect(await store.purgeHeldWithdrawal(G, { nowMs: NOW + MIN, recheckAtMs: NOW + 17 * MIN, limit: LIMIT })).toBeUndefined();
  });

  test('I-T83 ⑨ 한 번에 잠그는 보류 행은 ID 차례로 50개까지다', async () => {
    // Drizzle 쪽 order by id·limit은 메모리 시험으로 볼 수 없어 여기서 본다
    const store = new DrizzleReviewStore(app);
    const A = randomUUID();
    const r1 = await seedReview(A);
    // 키 없는 보류 행 51개. ID를 먼저 만들어 정렬하고, 넣는 차례는 ID 차례와 다르게(i × 7 mod 51) 한다.
    // order by id 없이 limit만 걸면 넣은 차례(힙 차례)로 잡혀, 맨 끝에 넣은 행 대신 가장 큰 ID 행이 처리된다
    const sorted = Array.from({ length: 51 }, () => randomUUID()).sort();
    for (let k = 0; k < 51; k += 1) {
      const i = (k * 7) % 51;
      await seedHeld({ id: sorted[i]!, eventKey: null, businessKey: `unreadable-${randomUUID()}`, msgKey: i % 2 === 0 ? A : A.toUpperCase() });
    }
    // 기대 차례는 관리자 연결로 order by id해 읽은 그 계정 보류 행 ID다
    const byId = (await heldById(sorted)).map((h) => h.id);
    expect(byId).toHaveLength(51);

    const first = await store.purgeHeldWithdrawal(A, { nowMs: NOW, recheckAtMs: NOW + 16 * MIN, limit: LIMIT });
    expect(first).toEqual({ purged: 1, held: byId.slice(0, 50).map((id) => ({ id, eventKey: null })) });
    // 나머지 하나(가장 큰 ID)만 reprocessed_at이 비어 있다
    const marked = await heldOf(byId);
    expect(marked.filter((h) => h.reprocessed_at === null).map((h) => h.id)).toEqual([byId[50]]);
    for (const h of marked.filter((x) => x.reprocessed_at !== null)) expect(h.reprocessed_at, h.id).toEqual(new Date(NOW));
    expect((await reviewOf(r1)).status).toBe('DELETED');

    // 다시 부르면 그 하나를 처리한다(이미 파기한 후기는 0건, 예약은 늦은 쪽)
    const second = await store.purgeHeldWithdrawal(A, { nowMs: NOW + MIN, recheckAtMs: NOW + 17 * MIN, limit: LIMIT });
    expect(second).toEqual({ purged: 0, held: [{ id: byId[50], eventKey: null }] });
    expect((await heldOf([byId[50]!]))[0]?.reprocessed_at).toEqual(new Date(NOW + MIN));
    expect(await recheckOf(A)).toEqual([{ due_at: new Date(NOW + 17 * MIN) }]);
    expect(await store.purgeHeldWithdrawal(A, { nowMs: NOW + 2 * MIN, recheckAtMs: NOW + 18 * MIN, limit: LIMIT })).toBeUndefined();
  });

  test('I-T83 ⑨ 보류 행 표시가 실패하면 파기·예약도 남지 않는다', async () => {
    // 한 트랜잭션(리뷰 N3): 마지막 문장(보류 행 reprocessed_at 표시)에만 걸리는 BEFORE UPDATE 방아쇠로 그 문장만 실패시킨다.
    // REVOKE UPDATE (reprocessed_at)는 쓰지 않는다. core_app의 held_event 고치기 권한은 그 칸 하나뿐인데 SELECT … FOR UPDATE도 칸 UPDATE 권한이 있어야 해서,
    // 첫 문장(보류 행 잠금)에서 42501로 끝나 예약·파기가 처음부터 돌지 않기 때문이다. 행 잠금(FOR UPDATE)은 방아쇠를 부르지 않는다.
    // 방아쇠 함수는 같은 트랜잭션에서 앞 문장들(예약·파기)이 이미 돈 흔적을 읽어 오류 글에 싣는다(부른 역할 core_app의 권한으로 돈다)
    const store = new DrizzleReviewStore(app);
    const A = randomUUID();
    const r1 = await seedReview(A);
    const key = randomUUID();
    const h1 = await seedHeld({ eventKey: key, businessKey: A, msgKey: A });
    // SQL 글에 넣는 값은 시험이 만든 UUID뿐이다
    for (const v of [A, r1, h1]) expect(v).toMatch(UUID_RE);
    const rejected: unknown[] = [];
    try {
      await admin.pool.query(`create function i_t83_n3_fail() returns trigger language plpgsql as $$
        begin
          raise exception using errcode = 'P0001', message = format('i-t83-n3 recheck=%s review=%s',
            (select count(*) from review_withdrawal_recheck where account_id = '${A}'::uuid),
            (select status from review where id = '${r1}'::uuid));
        end $$`);
      // when (old.id = …)로 그 행에만 건다(같은 파일의 다른 시험이 닿지 않게)
      await admin.pool.query(`create trigger i_t83_n3 before update on held_event for each row when (old.id = '${h1}'::uuid) execute function i_t83_n3_fail()`);
      await store.purgeHeldWithdrawal(A, { nowMs: NOW, recheckAtMs: NOW + 16 * MIN, limit: LIMIT }).catch((err: unknown) => void rejected.push(err));
    } finally {
      await admin.pool.query('drop trigger if exists i_t83_n3 on held_event');
      await admin.pool.query('drop function if exists i_t83_n3_fail()');
    }
    // 거절 1건. 오류 글은 잠금 → 예약 → 파기가 표시보다 먼저 같은 트랜잭션에서 돌았다는 증거다
    expect(rejected).toHaveLength(1);
    expect(pgCode(rejected[0])).toBe('P0001');
    expect(pgMessage(rejected[0])).toContain('i-t83-n3 recheck=1 review=DELETED');
    // 셋 다 되돌려졌다: 후기 VISIBLE, 예약 없음, reprocessed_at 비어 있음
    expect((await reviewOf(r1)).status).toBe('VISIBLE');
    expect(await recheckOf(A)).toEqual([]);
    expect((await heldOf([h1]))[0]?.reprocessed_at).toBeNull();
    // 방아쇠를 지운 뒤 다시 하면 셋 다 남는다
    expect(await store.purgeHeldWithdrawal(A, { nowMs: NOW, recheckAtMs: NOW + 16 * MIN, limit: LIMIT })).toEqual({ purged: 1, held: [{ id: h1, eventKey: key }] });
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
