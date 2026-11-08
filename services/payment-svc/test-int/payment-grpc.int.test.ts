// payment-svc 승인 명령 접수와 결과 조회(BUILD_ORDER PRF-180)를 실제 PostgreSQL 18과 실제 gRPC 서버로 돈다.
// 정본: docs/features/payment.md §2 '승인 명령 접수의 첫 구현'·'결제 결과 당기기의 첫 구현'과 시험 표 P-T53·P-T54·P-T15·P-T47, docs/data.md payment·payment_event·payment_confirm_job·§4 '결제 표 마이그레이션'·§5·§5.1,
// docs/api/proto/peaket/payment/v1/payment.proto, docs/security/asvs/payment.md.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓴다. 시험마다 새 주문 ID라 서로 닿지 않는다(행 수를 볼 때는 앞뒤 차이로 본다).
// - 서버 조립(stack)은 처음 부를 때 한다. 뼈대 단계에서는 시험마다 그 자리에서 실패하고, 씨앗 SQL은 그 앞에서 돌아 맞는지 드러난다.
// - 시계는 멈춘 가짜 시계다(행의 시각이 시계 값과 같은지 본다). gRPC 데드라인은 넉넉히 5초다(운영 200ms·500ms는 부르는 쪽의 값이다).
// - 트랜잭션 실패는 test_hooks 스키마의 트리거로 만든다(운영 표의 정의는 건드리지 않고, 표시한 주문의 INSERT만 실패시킨다).
// - 수출 사건은 승인 실행기(PRF-181)가 아직 없어 만드는 길이 없다. 이력 행은 SQL로 직접 넣는다.
// - 실행 계획은 서버가 실제로 보낸 문장을 pg.Client 쪽에서 엿봐 큰 표에서 EXPLAIN한다(order-expiry·sale-state 본보기).
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, type Database, ensureOutboxPartitions, systemClock, writeOutbox } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { GrpcPaymentConfirms } from '../../purchase-svc/src/modules/booking/adapters/grpc-payment-confirm.js';
import { GrpcPaymentResultReader } from '../../purchase-svc/src/modules/booking/adapters/grpc-payment-results.js';
import { paymentStateToResultEvent } from '../../purchase-svc/src/modules/booking/domain/payment-pull.js';
import { type ConfirmCommand, type ConfirmOutcome, PaymentPullCallError } from '../../purchase-svc/src/modules/booking/domain/ports.js';
import { migratePayment } from '../scripts/migrate.mjs';
import { BATCH_GET_STATEMENT_TIMEOUT_MS, DrizzlePaymentStore, PaymentDeadlineError } from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type ConfirmFixture, failure, type GrpcStack, issuedSecrets, ledgerOf, msOf, newId, outcomeCount, portoneConfirm, putPayment, startGrpcStack, tableCounts, tossConfirm, type TossFixture, unary } from './support.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IN_PROGRESS = 'CONFIRM_RESULT_IN_PROGRESS';
const CONFIRMS = 'payment_confirm_commands_total';
const BATCHES = 'payment_batch_get_requests_total';

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let stacked: Promise<GrpcStack> | undefined;

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-it-admin' });
  // 시험의 풀은 일반 프로필로 넉넉히 잡는다: 동시 20개가 풀 대기 100ms(핫패스)에 걸려 실패하는 것은 이 시험이 볼 일이 아니다
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-it-batch' });
  await ensureOutboxPartitions(admin, systemClock);
  await admin.pool.query(`
    create schema test_hooks;
    create table test_hooks.fail_order (order_id uuid not null, table_name text not null, primary key (order_id, table_name));
    create function test_hooks.fail_insert() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_order f join public.payment p on p.order_id = f.order_id where p.id = new.payment_id and f.table_name = tg_table_name) then
        raise exception 'test-forced-failure';
      end if;
      return new;
    end $f$;
    create trigger test_fail_job before insert on public.payment_confirm_job for each row execute function test_hooks.fail_insert();
    create trigger test_fail_event before insert on public.payment_event for each row execute function test_hooks.fail_insert();
  `);
}, 180_000);

afterAll(async () => {
  const s = await stacked?.catch(() => undefined);
  await s?.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close()]);
  pgc?.stop();
});

const stack = (): Promise<GrpcStack> => (stacked ??= startGrpcStack({ hot, batch }));
const q = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query<R>(text, params)).rows;
const confirm = async (request: object) => unary((await stack()).client, 'ConfirmPayment', request);
const batchGet = async (orderIds: string[]) => (await unary((await stack()).client, 'BatchGetPayments', { order_ids: orderIds })).payments as Record<string, unknown>[];

// ───────────────────────────── 마이그레이션 ─────────────────────────────

const COLUMNS: Record<string, Record<string, [string, 'YES' | 'NO']>> = {
  payment: {
    id: ['uuid', 'NO'],
    order_id: ['uuid', 'NO'],
    event_id: ['uuid', 'NO'],
    attempt_id: ['uuid', 'NO'],
    attempt_no: ['integer', 'NO'],
    pg: ['text', 'NO'],
    pg_payment_ref: ['text', 'NO'],
    pg_confirm_token: ['text', 'YES'],
    deposit_secret_hash: ['bytea', 'YES'],
    amount: ['integer', 'NO'],
    status: ['text', 'NO'],
    deposit_due_at: ['timestamp with time zone', 'YES'],
    virtual_account_no: ['text', 'YES'],
    virtual_account_bank: ['text', 'YES'],
    idempotency_key: ['text', 'NO'],
    payment_method_ref: ['text', 'YES'],
    card_bin: ['text', 'YES'],
    authenticated_at: ['timestamp with time zone', 'NO'],
    created_at: ['timestamp with time zone', 'NO'],
    approved_at: ['timestamp with time zone', 'YES'],
    status_changed_at: ['timestamp with time zone', 'NO'],
    failure_category: ['text', 'YES'],
    next_query_at: ['timestamp with time zone', 'YES'],
    query_attempts: ['integer', 'NO'],
    overdue_at: ['timestamp with time zone', 'YES'],
    anomaly_logged_at: ['timestamp with time zone', 'YES'],
  },
  payment_event: {
    payment_id: ['uuid', 'NO'],
    seq: ['bigint', 'NO'],
    event_key: ['uuid', 'NO'],
    type: ['text', 'NO'],
    exported: ['boolean', 'NO'],
    occurred_at: ['timestamp with time zone', 'NO'],
  },
  payment_confirm_job: {
    payment_id: ['uuid', 'NO'],
    next_attempt_at: ['timestamp with time zone', 'NO'],
    lease_owner: ['text', 'YES'],
    lease_until: ['timestamp with time zone', 'YES'],
    attempts: ['integer', 'NO'],
    created_at: ['timestamp with time zone', 'NO'],
  },
};

/** 제약을 시험할 원장 행(칸을 덮어 쓴다) */
const insertPayment = (over: Record<string, unknown> = {}) => {
  const v: Record<string, unknown> = {
    id: newId(),
    order_id: newId(),
    event_id: newId(),
    attempt_id: newId(),
    attempt_no: 1,
    pg: 'TOSS',
    pg_payment_ref: 'ref',
    amount: 1,
    status: 'ACCEPTED',
    idempotency_key: 'k',
    authenticated_at: new Date(),
    status_changed_at: new Date(),
    ...over,
  };
  const cols = Object.keys(v);
  return q(`insert into payment (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(v));
};

describe('마이그레이션과 표 모양', () => {
  test('PRF180_PRF181_PRF182_마이그레이션(0000·0001·0002)을 더 돌려도 오류가 없고 표가 그대로이며 적용 기록은 3개다', async () => {
    const tables = async () => (await q<{ relname: string }>(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and relname !~ '^outbox_p' order by relname`)).map((r) => r.relname);
    const before = await tables();
    expect(before).toEqual(['outbox', 'payment', 'payment_confirm_job', 'payment_event']);
    await migratePayment(pgc!.url);
    await migratePayment(pgc!.url);
    expect(await tables()).toEqual(before);
    expect((await q<{ n: string }>('select count(*) as n from drizzle.__drizzle_migrations'))[0]!.n).toBe('3');
  });

  test.each(Object.keys(COLUMNS))('PRF180_%s 표의 칸 이름·종류·빈 값 허용이 docs/data.md ERD와 같다', async (table) => {
    const rows = await q<{ column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }>(
      `select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [table],
    );
    expect(Object.fromEntries(rows.map((r) => [r.column_name, [r.data_type, r.is_nullable]]))).toEqual(COLUMNS[table]);
  });

  test('PRF180_PRF182_payment_confirm_job.attempts와 payment.query_attempts 기본값은 0이고 payment.created_at·payment_confirm_job.created_at 기본값은 now()다', async () => {
    const rows = await q<{ table_name: string; column_name: string; column_default: string }>(
      `select table_name, column_name, column_default from information_schema.columns where table_schema = 'public' and column_default is not null and table_name in ('payment', 'payment_confirm_job') order by table_name, column_name`,
    );
    expect(rows).toEqual([
      { table_name: 'payment', column_name: 'created_at', column_default: 'now()' },
      { table_name: 'payment', column_name: 'query_attempts', column_default: '0' },
      { table_name: 'payment_confirm_job', column_name: 'attempts', column_default: '0' },
      { table_name: 'payment_confirm_job', column_name: 'created_at', column_default: 'now()' },
    ]);
  });

  test('PRF180_CHECK: 상태 일곱 값과 결제사 셋만 받고, 금액 0 이하·순번 0·결제 수단 참조와 BIN의 짝이 어긋나면 23514로 거절한다 [ASVS v5.0.0-2.3.4]', async () => {
    for (const status of ['ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED']) await expect(insertPayment({ status, ...(status === 'UNKNOWN' ? { next_query_at: new Date() } : {}) }), status).resolves.toBeDefined();
    for (const p of ['TOSS', 'PORTONE', 'SIMULATOR']) await expect(insertPayment({ pg: p }), p).resolves.toBeDefined();
    await expect(insertPayment({ payment_method_ref: 'r', card_bin: '123456' })).resolves.toBeDefined();
    const bads: Record<string, unknown>[] = [
      { status: 'CONFIRM_SENT' },
      { status: 'accepted' },
      { pg: 'KAKAO' },
      { amount: 0 },
      { amount: -1 },
      { attempt_no: 0 },
      { payment_method_ref: 'r' },
      { card_bin: '123456' },
    ];
    for (const bad of bads) await expect(insertPayment(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '23514' });

    const id = newId();
    await insertPayment({ id });
    await expect(q(`insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) values ($1, 0, $2, 'X', false, now())`, [id, newId()])).rejects.toMatchObject({ code: '23514' });
    await expect(q(`insert into payment_confirm_job (payment_id, next_attempt_at, attempts) values ($1, now(), -1)`, [id])).rejects.toMatchObject({ code: '23514' });
  });

  test('PRF180_유일·외래 키: 한 주문에 결제 1건, 이력은 (결제, 순번)마다 1행, 승인 명령은 결제마다 1행이고 없는 결제를 가리키면 23503이다 [ASVS v5.0.0-2.3.4]', async () => {
    const orderId = newId();
    const id = newId();
    await insertPayment({ id, order_id: orderId });
    await expect(insertPayment({ order_id: orderId })).rejects.toMatchObject({ code: '23505', constraint: 'payment_order_id_key' });

    const putEvent = (paymentId: string, seq: number) => q(`insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) values ($1, $2, $3, 'X', false, now())`, [paymentId, seq, newId()]);
    await putEvent(id, 1);
    await expect(putEvent(id, 1)).rejects.toMatchObject({ code: '23505', constraint: 'payment_event_payment_id_seq_pk' });
    await expect(putEvent(newId(), 1)).rejects.toMatchObject({ code: '23503' });

    const putJob = (paymentId: string) => q('insert into payment_confirm_job (payment_id, next_attempt_at) values ($1, now())', [paymentId]);
    await putJob(id);
    await expect(putJob(id)).rejects.toMatchObject({ code: '23505' });
    await expect(putJob(newId())).rejects.toMatchObject({ code: '23503' });
  });

  test('PRF180_인덱스: payment (order_id) 유일, 승인 명령 잡기 (next_attempt_at), Outbox 미전송 부분 인덱스가 정본 그대로다', async () => {
    const indexes = await q<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname in ('payment_order_id_key', 'payment_confirm_job_next_idx', 'outbox_unsent_idx') order by indexname`,
    );
    expect(indexes).toEqual([
      { indexname: 'outbox_unsent_idx', indexdef: 'CREATE INDEX outbox_unsent_idx ON ONLY public.outbox USING btree (seq) WHERE (sent_at IS NULL)' },
      { indexname: 'payment_confirm_job_next_idx', indexdef: 'CREATE INDEX payment_confirm_job_next_idx ON public.payment_confirm_job USING btree (next_attempt_at)' },
      { indexname: 'payment_order_id_key', indexdef: 'CREATE UNIQUE INDEX payment_order_id_key ON public.payment USING btree (order_id)' },
    ]);
  });

  test('PRF180_payment 세 표는 나누지 않고 Outbox 부모만 ID 범위로 나누며(ADR-0114), 일 파티션을 만든 뒤 Outbox 쓰기가 된다', async () => {
    const kind = async (name: string) => (await q<{ relkind: string }>(`select relkind from pg_class where relnamespace = 'public'::regnamespace and relname = $1`, [name]))[0]?.relkind;
    expect(await kind('payment')).toBe('r');
    expect(await kind('payment_event')).toBe('r');
    expect(await kind('payment_confirm_job')).toBe('r');
    expect(await kind('outbox')).toBe('p');

    const key = newId();
    const [id] = await admin.transaction((tx) => writeOutbox(tx, systemClock, [{ topic: 'trade.payments', key, payload: Buffer.from('{}', 'utf8') }]));
    expect(await q('select msg_key, sent_at from outbox where id = $1', [id])).toEqual([{ msg_key: key, sent_at: null }]);
  });

  test('PRF180_권한 관례: 마이그레이션은 역할을 만들거나 권한을 주지 않고(역할은 운영 실행기의 몫, docs/data.md §4의 7번), 표 주인은 마이그레이션을 돈 사용자다', async () => {
    expect((await q<{ rolname: string }>(`select rolname from pg_roles where rolname !~ '^pg_'`)).map((r) => r.rolname)).toEqual(['postgres']);
    const grants = await q(`select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name in ('payment', 'payment_event', 'payment_confirm_job', 'outbox') and grantee <> 'postgres'`);
    expect(grants).toEqual([]);
    const owners = await q<{ tablename: string; tableowner: string }>(`select tablename, tableowner from pg_tables where schemaname = 'public' and tablename in ('payment', 'payment_event', 'payment_confirm_job', 'outbox') order by tablename`);
    expect(owners.every((o) => o.tableowner === 'postgres')).toBe(true);
    expect(owners.map((o) => o.tablename)).toEqual(['outbox', 'payment', 'payment_confirm_job', 'payment_event']);
  });
});

// ───────────────────────────── 승인 명령 접수 ─────────────────────────────

describe('승인 명령 접수 ConfirmPayment', () => {
  test('P-T53_처음 받은 명령은 원장 ACCEPTED·idempotency_key confirm-{orderId}·이력 순번 1 exported false·승인 명령 한 행을 쓰고 IN_PROGRESS로 답한다 [ASVS v5.0.0-2.3.3]', async () => {
    const f = tossConfirm();
    const reply = await confirm(f.request);
    const s = await stack();
    const now = s.clock.now();

    const { payments, events, jobs } = await ledgerOf(admin, f.orderId);
    expect(payments).toHaveLength(1);
    const p = payments[0]!;
    expect(p.id).toMatch(UUID_V7);
    expect(p).toMatchObject({
      order_id: f.orderId,
      event_id: f.eventId,
      attempt_id: f.attemptId,
      attempt_no: 1,
      pg: 'TOSS',
      pg_payment_ref: f.paymentKey,
      pg_confirm_token: null,
      amount: f.amount,
      status: 'ACCEPTED',
      idempotency_key: `confirm-${f.orderId}`,
      approved_at: null,
    });
    expect(p.authenticated_at.getTime()).toBe(f.authenticatedAtMs);
    expect(p.created_at.getTime()).toBe(now);
    expect(p.status_changed_at.getTime()).toBe(now);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payment_id: p.id, seq: '1', type: 'ACCEPTED', exported: false });
    expect(events[0]!.event_key).toMatch(UUID_V7);
    expect(events[0]!.occurred_at.getTime()).toBe(now);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payment_id: p.id, lease_owner: null, lease_until: null, attempts: 0 });
    expect(jobs[0]!.next_attempt_at.getTime()).toBe(now);

    expect(reply).toMatchObject({ result: IN_PROGRESS, payment_id: p.id, approved_at: null, failure_category: 'FAILURE_CATEGORY_UNSPECIFIED' });
  });

  test('P-T53_포트원 명령은 pg_payment_ref에 payment_id, pg_confirm_token에 토큰을 적고 tx_id는 저장하지 않는다', async () => {
    const f = portoneConfirm();
    await expect(confirm(f.request)).resolves.toMatchObject({ result: IN_PROGRESS });
    const { payments } = await ledgerOf(admin, f.orderId);
    expect(payments[0]).toMatchObject({ pg: 'PORTONE', pg_payment_ref: f.paymentId, pg_confirm_token: f.paymentToken });
    expect(JSON.stringify(payments[0])).not.toContain(f.txId);
  });

  test('P-T53_시뮬레이터 명령은 toss 칸으로 받아 pg SIMULATOR로 적는다', async () => {
    const f = tossConfirm({ pg: 'SIMULATOR' });
    await expect(confirm(f.request)).resolves.toMatchObject({ result: IN_PROGRESS });
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg: 'SIMULATOR', pg_payment_ref: f.paymentKey, pg_confirm_token: null });
  });

  test.each([['payment_confirm_job'], ['payment_event']])(
    'P-T53_%s 쓰기가 실패하면 INTERNAL(내부 정보 없는 글)이고 세 표에 아무것도 남지 않으며, 원인을 없앤 뒤 같은 명령을 다시 보내면 처음처럼 쓴다 [ASVS v5.0.0-2.3.3]',
    async (table) => {
      const f = tossConfirm();
      await q('insert into test_hooks.fail_order (order_id, table_name) values ($1, $2)', [f.orderId, table]);
      const s = await stack();
      const errorsBefore = s.errors.length;
      const before = await tableCounts(admin);
      const metricsBefore = await s.metrics();

      const err = await failure(confirm(f.request));

      expect(err.code).toBe(grpc.status.INTERNAL);
      expect(err.details).not.toContain('test-forced-failure');
      expect(err.details).not.toContain(f.paymentKey);
      expect(await tableCounts(admin)).toEqual(before);
      expect(await ledgerOf(admin, f.orderId)).toEqual({ payments: [], events: [], jobs: [] });
      // 예상하지 못한 오류는 서버 쪽 기록으로 간다. 처음 받은 수로 세지 않고 저장 실패(error)로 센다(리뷰 고침 L7)
      expect(s.errors.length).toBe(errorsBefore + 1);
      expect(s.errors.at(-1)!.method).toBe('ConfirmPayment');
      const metricsAfter = await s.metrics();
      expect(outcomeCount(metricsAfter, CONFIRMS, 'accepted')).toBe(outcomeCount(metricsBefore, CONFIRMS, 'accepted'));
      expect(outcomeCount(metricsAfter, CONFIRMS, 'error') - outcomeCount(metricsBefore, CONFIRMS, 'error')).toBe(1);

      await q('delete from test_hooks.fail_order where order_id = $1', [f.orderId]);
      await expect(confirm(f.request)).resolves.toMatchObject({ result: IN_PROGRESS });
      const after = await ledgerOf(admin, f.orderId);
      expect([after.payments.length, after.events.length, after.jobs.length]).toEqual([1, 1, 1]);
    },
    60_000,
  );

  test('P-T53_같은 주문의 ConfirmPayment 20개가 동시에 와도 원장·이력·승인 명령은 1행씩이고 모두 같은 payment_id의 IN_PROGRESS다 [ASVS v5.0.0-2.3.4]', async () => {
    const f = tossConfirm();
    const s = await stack();
    const metricsBefore = await s.metrics();

    const replies = await Promise.all(Array.from({ length: 20 }, () => confirm(f.request)));

    const { payments, events, jobs } = await ledgerOf(admin, f.orderId);
    expect([payments.length, events.length, jobs.length]).toEqual([1, 1, 1]);
    expect(replies).toHaveLength(20);
    for (const r of replies) expect(r).toMatchObject({ result: IN_PROGRESS, payment_id: payments[0]!.id });
    const text = await s.metrics();
    expect(outcomeCount(text, CONFIRMS, 'accepted') - outcomeCount(metricsBefore, CONFIRMS, 'accepted')).toBe(1);
    expect(outcomeCount(text, CONFIRMS, 'replayed') - outcomeCount(metricsBefore, CONFIRMS, 'replayed')).toBe(19);
  }, 60_000);

  test('P-T53_답을 받은 뒤 같은 명령을 다시 보내면 같은 답이고 아무것도 더 쓰거나 바꾸지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const f = tossConfirm();
    const first = await confirm(f.request);
    const before = await ledgerOf(admin, f.orderId);
    (await stack()).clock.advance(1_000);

    const again = await confirm(f.request);

    expect(again).toEqual(first);
    expect(await ledgerOf(admin, f.orderId)).toEqual(before);
  });

  test('P-T53_결제 참조만 다른 재전송은 같은 명령이라(대조 칸은 attempt_id·pg·amount) 같은 답이고 원장의 참조는 그대로다', async () => {
    const f = tossConfirm();
    const first = await confirm(f.request);
    const other = tossConfirm().paymentKey;
    await expect(confirm({ ...f.request, toss: { payment_key: other } })).resolves.toEqual(first);
    expect((await ledgerOf(admin, f.orderId)).payments[0]!.pg_payment_ref).toBe(f.paymentKey);
  });

  const sameOrder = (f: ConfirmFixture) => ({ orderId: f.orderId, attemptId: f.attemptId, eventId: f.eventId, amount: f.amount, authenticatedAtMs: f.authenticatedAtMs });

  test.each<[string, (f: ConfirmFixture) => object]>([
    ['다른 결제사(토스 → 포트원)', (f) => portoneConfirm(sameOrder(f)).request],
    ['다른 결제사(토스 → 시뮬레이터)', (f) => tossConfirm({ ...sameOrder(f), pg: 'SIMULATOR' }).request],
    ['다른 결제 시도', (f) => ({ ...f.request, attempt_id: newId() })],
    ['다른 금액', (f) => ({ ...f.request, amount: { krw: f.amount + 1 } })],
  ])(
    'P-T53_이미 받은 명령과 %s로 다시 부르면 FAILED_PRECONDITION이고 원장은 그대로이며 SEV2 로그 한 줄에 주문 ID만 싣는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-16.2.5]',
    async (_name, build) => {
      const f = tossConfirm();
      await confirm(f.request);
      const before = await ledgerOf(admin, f.orderId);
      const s = await stack();
      const metricsBefore = await s.metrics();

      const err = await failure(confirm(build(f)));

      expect(err.code).toBe(grpc.status.FAILED_PRECONDITION);
      expect(err.details).not.toContain(f.orderId);
      expect(await ledgerOf(admin, f.orderId)).toEqual(before);
      expect(outcomeCount(await s.metrics(), CONFIRMS, 'mismatch') - outcomeCount(metricsBefore, CONFIRMS, 'mismatch')).toBe(1);

      const lines = s.logs.filter((l) => l.includes('payment-confirm-mismatch') && l.includes(f.orderId));
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(line.level).toBe('error');
      expect(Object.keys(line).filter((k) => /amount|payment_?key|token|attempt/i.test(k))).toEqual([]);
      expect(lines[0]).not.toContain(f.paymentKey);
      expect(lines[0]).not.toContain(f.attemptId);
    },
  );

  test('P-T53_거절된 다른 명령 뒤에도 처음 명령을 다시 보내면 처음 답 그대로다', async () => {
    const f = tossConfirm();
    const first = await confirm(f.request);
    await failure(confirm({ ...f.request, amount: { krw: f.amount + 1 } }));
    await expect(confirm(f.request)).resolves.toEqual(first);
  });

  test.each([
    ['APPROVED', 'CONFIRM_RESULT_APPROVED', true],
    ['PARTIAL_CANCELED', 'CONFIRM_RESULT_APPROVED', true],
    ['CANCELED', 'CONFIRM_RESULT_APPROVED', true],
    ['FAILED', 'CONFIRM_RESULT_DECLINED', false],
    ['AWAITING_DEPOSIT', 'CONFIRM_RESULT_WAITING_FOR_DEPOSIT', false],
    ['UNKNOWN', IN_PROGRESS, false],
  ] as const)('P-T53_원장 상태가 %s로 바뀐 결제의 재전송 답은 %s이고 원장을 바꾸지 않는다', async (status, result, approved) => {
    const f = tossConfirm();
    const first = await confirm(f.request);
    const approvedAtMs = Date.parse('2026-11-09T02:03:04.567Z');
    await q(`update payment set status = $2::text, approved_at = $3, next_query_at = case when $2::text = 'UNKNOWN' then now() end where order_id = $1`, [f.orderId, status, approved ? new Date(approvedAtMs) : null]);
    const before = await ledgerOf(admin, f.orderId);

    const reply = await confirm(f.request);

    expect(reply).toMatchObject({ result, payment_id: first.payment_id, failure_category: 'FAILURE_CATEGORY_UNSPECIFIED' });
    if (approved) expect(msOf(reply.approved_at)).toBe(approvedAtMs);
    else expect(reply.approved_at).toBeNull();
    expect(await ledgerOf(admin, f.orderId)).toEqual(before);
  });

  test('P-T53_실행기가 끝내 승인 명령 행이 지워진 결제에 같은 명령이 다시 와도 명령 행을 되살리지 않는다(결제사 승인이 두 번 나가지 않게) [ASVS v5.0.0-2.3.4]', async () => {
    const f = tossConfirm();
    const first = await confirm(f.request);
    await q('update payment set status = $2, approved_at = $3 where order_id = $1', [f.orderId, 'APPROVED', new Date(APPROVED_AT_MS)]);
    await q('delete from payment_confirm_job where payment_id = $1', [first.payment_id]);
    const before = await ledgerOf(admin, f.orderId);
    expect(before.jobs).toEqual([]);

    await expect(confirm(f.request)).resolves.toMatchObject({ result: 'CONFIRM_RESULT_APPROVED', payment_id: first.payment_id });

    expect(await ledgerOf(admin, f.orderId)).toEqual(before);
  });

  const omit =(r: Record<string, unknown>, key: string): object => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));
  const CONTROL_CHARS = 'a b\u0007c';

  test.each<[string, (r: Record<string, unknown>) => object]>([
    ['order_id가 대문자 UUID', (r) => ({ ...r, order_id: String(r.order_id).toUpperCase() })],
    ['order_id가 UUID 모양이 아님', (r) => ({ ...r, order_id: 'not-a-uuid' })],
    ['attempt_id가 빔', (r) => ({ ...r, attempt_id: '' })],
    ['event_id가 UUID 모양이 아님', (r) => ({ ...r, event_id: 'event-1' })],
    ['금액 0', (r) => ({ ...r, amount: { krw: 0 } })],
    ['금액 음수', (r) => ({ ...r, amount: { krw: -1 } })],
    ['금액이 원장 int 상한을 넘음', (r) => ({ ...r, amount: { krw: 2_147_483_648 } })],
    ['금액 칸 없음', (r) => omit(r, 'amount')],
    ['attempt_no 0', (r) => ({ ...r, attempt_no: 0 })],
    ['attempt_no 음수', (r) => ({ ...r, attempt_no: -1 })],
    ['authenticated_at 없음', (r) => omit(r, 'authenticated_at')],
    ['리뷰 고침 L8: authenticated_at이 지금 + 5분보다 뒤', (r) => ({ ...r, authenticated_at: { seconds: Math.floor(Date.now() / 1000) + 3_600, nanos: 0 } })],
    ['리뷰 고침 L8: authenticated_at이 연도 10000 이상', (r) => ({ ...r, authenticated_at: { seconds: 253_402_300_800, nanos: 0 } })],
    ['pg 미지정', (r) => ({ ...r, pg: 'PG_PROVIDER_UNSPECIFIED' })],
    ['결제 참조 없음', (r) => omit(r, 'toss')],
    ['결제 키가 빔', (r) => ({ ...r, toss: { payment_key: '' } })],
    ['결제 키 201자', (r) => ({ ...r, toss: { payment_key: 'k'.repeat(201) } })],
    ['결제 키에 공백·제어 문자', (r) => ({ ...r, toss: { payment_key: CONTROL_CHARS } })],
    ['결제 키에 ASCII 밖 글자', (r) => ({ ...r, toss: { payment_key: '결제키' } })],
  ])('P-T53_틀린 입력(%s)은 INVALID_ARGUMENT이고 아무것도 쓰지 않으며 값은 오류 글에 실리지 않는다 [ASVS v5.0.0-2.2.1]', async (_name, build) => {
    const f = tossConfirm();
    const s = await stack();
    const before = await tableCounts(admin);
    const metricsBefore = await s.metrics();

    const err = await failure(confirm(build(f.request)));

    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.details).not.toContain(f.paymentKey);
    expect(err.details).not.toContain(f.orderId);
    expect(await tableCounts(admin)).toEqual(before);
    expect(outcomeCount(await s.metrics(), CONFIRMS, 'invalid') - outcomeCount(metricsBefore, CONFIRMS, 'invalid')).toBe(1);
  });

  test.each<[string, () => object]>([
    ['토스인데 포트원 칸', () => ({ ...portoneConfirm().request, pg: 'PG_PROVIDER_TOSS' })],
    ['시뮬레이터인데 포트원 칸', () => ({ ...portoneConfirm().request, pg: 'PG_PROVIDER_SIMULATOR' })],
    ['포트원인데 토스 칸', () => ({ ...tossConfirm().request, pg: 'PG_PROVIDER_PORTONE' })],
    [
      '포트원 payment_id가 pay-{orderId}가 아님',
      () => {
        const f = portoneConfirm();
        return { ...f.request, portone: { payment_id: `pay-${newId()}`, tx_id: f.txId, payment_token: f.paymentToken } };
      },
    ],
    [
      '포트원 토큰이 빔',
      () => {
        const f = portoneConfirm();
        return { ...f.request, portone: { payment_id: f.paymentId, tx_id: f.txId, payment_token: '' } };
      },
    ],
  ])('P-T53_결제사와 결제 참조의 짝이 틀림(%s)은 INVALID_ARGUMENT이고 아무것도 쓰지 않는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-2.2.1]', async (_name, build) => {
    const before = await tableCounts(admin);
    const err = await failure(confirm(build()));
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await tableCounts(admin)).toEqual(before);
  });

  test.each(['GetPayment', 'CancelPayment', 'PrepareCheckout', 'RegisterPayoutSeller', 'ApprovePayoutBatch', 'GetNewPaymentPause'])('PRF180_이 단계에 만들지 않은 RPC %s는 UNIMPLEMENTED다', async (method) => {
    const s = await stack();
    expect((await failure(unary(s.client, method, {}))).code).toBe(grpc.status.UNIMPLEMENTED);
  });

  test('PRF180_저장소를 직접 부르면 처음은 CREATED, 다시는 EXISTING이고 있는 행의 시도·결제사·금액·상태를 돌려주며 더 쓰지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = await stack();
    const f = tossConfirm();
    const command = { orderId: f.orderId, attemptId: f.attemptId, attemptNo: 1, eventId: f.eventId, pg: 'TOSS' as const, paymentRef: { kind: 'toss' as const, paymentKey: f.paymentKey }, amount: f.amount, authenticatedAtMs: f.authenticatedAtMs };
    const paymentId = newId();
    const first = await s.store.store(command, { paymentId, eventKey: newId(), nowMs: s.clock.now() });
    expect(first).toMatchObject({ kind: 'CREATED', record: { paymentId, orderId: f.orderId, attemptId: f.attemptId, pg: 'TOSS', amount: f.amount, status: 'ACCEPTED' } });
    const before = await ledgerOf(admin, f.orderId);

    const second = await s.store.store(command, { paymentId: newId(), eventKey: newId(), nowMs: s.clock.now() });

    expect(second).toMatchObject({ kind: 'EXISTING', record: { paymentId, orderId: f.orderId, attemptId: f.attemptId, pg: 'TOSS', amount: f.amount, status: 'ACCEPTED' } });
    expect(await ledgerOf(admin, f.orderId)).toEqual(before);
  });

  const storedCommand = (f: TossFixture) => ({
    orderId: f.orderId,
    attemptId: f.attemptId,
    attemptNo: 1,
    eventId: f.eventId,
    pg: 'TOSS' as const,
    paymentRef: { kind: 'toss' as const, paymentKey: f.paymentKey },
    amount: f.amount,
    authenticatedAtMs: f.authenticatedAtMs,
  });

  test('P-T53_리뷰 고침 M4: 표가 잠겨 쓰지 못하면 데드라인(5초)까지 기다리지 않고 문장 시간 한도 200ms에서 DEADLINE_EXCEEDED로 끝나며 아무것도 쓰지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const f = tossConfirm();
    const s = await stack();
    await confirm(tossConfirm().request); // 연결을 맺어 둔다(재는 시간에 연결 시간이 끼지 않게)
    const metricsBefore = await s.metrics();
    const client = await admin.pool.connect();
    let err: grpc.ServiceError;
    let elapsed: number;
    try {
      await client.query('begin');
      await client.query('lock table payment in access exclusive mode');
      const t0 = Date.now();
      err = await failure(confirm(f.request));
      elapsed = Date.now() - t0;
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
    expect(err.code).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect(err.details).not.toMatch(/statement timeout|canceling/i);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3_000);
    expect(await ledgerOf(admin, f.orderId)).toEqual({ payments: [], events: [], jobs: [] });
    expect(outcomeCount(await s.metrics(), CONFIRMS, 'error') - outcomeCount(metricsBefore, CONFIRMS, 'error')).toBe(1);
  }, 60_000);

  test('P-T53_리뷰 고침 M4: 트랜잭션은 READ COMMITTED로 시작하고, 남은 시간이 상한보다 짧으면 그 시간을 문장 시간 한도로 건다', async () => {
    const s = await stack();
    const f = tossConfirm();
    const statements = await statementsDuring(() => s.store.store(storedCommand(f), { paymentId: newId(), eventKey: newId(), nowMs: s.clock.now() }, { remainingMs: 150 }));
    expect(statements.some((st) => /isolation level read committed/i.test(st.text)), JSON.stringify(statements.map((st) => st.text))).toBe(true);
    const limit = statements.find((st) => st.text.includes("set_config('statement_timeout'"));
    expect(limit, JSON.stringify(statements.map((st) => st.text))).toBeDefined();
    expect(Number(limit!.values[0])).toBeLessThanOrEqual(150);
    expect(Number(limit!.values[0])).toBeGreaterThanOrEqual(50);
  });

  test('P-T53_리뷰 고침 M4: 풀에서 연결을 기다리다 남은 시간이 모자라면 쓰지 않고 PaymentDeadlineError다(풀 대기도 데드라인 안) [ASVS v5.0.0-2.3.3]', async () => {
    const tiny = createDatabase({ url: pgc!.url, profile: 'general', max: 1, applicationName: 'payment-it-tiny' });
    const held = await tiny.pool.connect();
    try {
      const f = tossConfirm();
      const pending = new DrizzlePaymentStore({ database: tiny, batchDatabase: tiny })
        .store(storedCommand(f), { paymentId: newId(), eventKey: newId(), nowMs: Date.now() }, { remainingMs: 120 })
        .then(
          () => 'stored' as const,
          (e: unknown) => e,
        );
      await new Promise((r) => setTimeout(r, 200));
      held.release();
      expect(await pending).toBeInstanceOf(PaymentDeadlineError);
      expect(await ledgerOf(admin, f.orderId)).toEqual({ payments: [], events: [], jobs: [] });
    } finally {
      await tiny.close();
    }
  });

  test('P-T53_서비스 로그 어디에도 결제 키·토큰이 없다(이 파일의 모든 호출 뒤에 본다) [ASVS v5.0.0-16.2.5]', async () => {
    const s = await stack();
    expect(issuedSecrets.length).toBeGreaterThan(10);
    const text = s.logs.join('\n');
    for (const v of issuedSecrets) expect(text).not.toContain(v);
  });
});

// ───────────────────────────── 결과 조회 ─────────────────────────────

/** EXPLAIN(FORMAT JSON) 계획의 노드들(평평하게) */
function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const kids = (plan.Plans as Record<string, unknown>[] | undefined) ?? [];
  return [plan, ...kids.flatMap(planNodes)];
}

/** fn이 도는 동안 이 프로세스의 pg.Client로 나간 문장을 모은다(Drizzle 트랜잭션 안의 문장도 잡히게 풀이 아니라 Client에서 본다) */
async function statementsDuring(fn: () => Promise<unknown>): Promise<{ text: string; values: unknown[] }[]> {
  const spy = vi.spyOn(pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown }, 'query');
  try {
    await fn();
    return spy.mock.calls.map(([a, b]) => ({
      text: typeof a === 'string' ? a : String((a as { text?: unknown }).text),
      values: Array.isArray(b) ? (b as unknown[]) : (((a as { values?: unknown[] }).values as unknown[] | undefined) ?? []),
    }));
  } finally {
    spy.mockRestore();
  }
}

/** 운영처럼 결제 표를 크게(결제 2만 건, 결제마다 이력 3행) 같은 트랜잭션에 넣고 통계를 낸 뒤 문장의 실행 계획을 낸다(되돌려 남기지 않는다) */
async function planOnBigTable(s: { text: string; values: unknown[] }): Promise<Record<string, unknown>[]> {
  const client = await admin.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, status_changed_at)
       select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'TOSS', 'big', 1, 'APPROVED', 'k', now(), now() from generate_series(1, 20000)`,
    );
    await client.query(`insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) select p.id, s, gen_random_uuid(), 'APPROVED', true, now() from payment p cross join generate_series(1, 3) s where p.pg_payment_ref = 'big'`);
    await client.query('analyze payment');
    await client.query('analyze payment_event');
    const r = await client.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`explain (format json) ${s.text}`, s.values);
    return planNodes(r.rows[0]!['QUERY PLAN'][0].Plan);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

const APPROVED_AT_MS = Date.parse('2026-11-09T03:04:05.678Z');
const approvedEvents = [
  { seq: 1, type: 'ACCEPTED', exported: false },
  { seq: 2, type: 'CONFIRM_SENT', exported: false },
  { seq: 3, type: 'APPROVED', exported: true },
] as const;

describe('결과 조회 BatchGetPayments', () => {
  test('P-T54_P-T47_승인 사건이 있는 결제는 원장의 결제 ID·결제사·상태·금액·승인 시각과 마지막 수출 사건의 event_key·event_seq를 돌려준다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', pg: 'PORTONE', amount: 2_147_483_647, approvedAtMs: APPROVED_AT_MS, events: approvedEvents });
    const [r, ...rest] = await batchGet([p.orderId]);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({
      order_id: p.orderId,
      payment_id: p.paymentId,
      pg: 'PG_PROVIDER_PORTONE',
      status: 'PAYMENT_STATUS_APPROVED',
      amount: { krw: 2_147_483_647 },
      failure_category: 'FAILURE_CATEGORY_UNSPECIFIED',
      event_key: p.events[2]!.eventKey,
      event_seq: 3,
    });
    expect(msOf(r!.approved_at)).toBe(APPROVED_AT_MS);
  });

  test('P-T54_P-T15_RESOLVED가 마지막이면 그것을 빼고 그 앞의 수출 사건을 돌려준다(부르는 쪽 순번 거르기가 어긋나지 않게)', async () => {
    const p = await putPayment(admin, {
      status: 'APPROVED',
      approvedAtMs: APPROVED_AT_MS,
      events: [...approvedEvents, { seq: 4, type: 'RESOLVED', exported: true }],
    });
    expect((await batchGet([p.orderId]))[0]).toMatchObject({ event_key: p.events[2]!.eventKey, event_seq: 3 });
  });

  test('P-T54_P-T15_수출 사건 뒤의 내부 표시(exported false)는 고르지 않고, 순번은 삽입 차례가 아니라 값으로 고른다', async () => {
    const p = await putPayment(admin, {
      status: 'APPROVED',
      approvedAtMs: APPROVED_AT_MS,
      events: [
        { seq: 5, type: 'APPROVED', exported: true },
        { seq: 3, type: 'UNKNOWN', exported: true },
        { seq: 6, type: 'NOTE', exported: false },
        { seq: 1, type: 'ACCEPTED', exported: false },
      ],
    });
    expect((await batchGet([p.orderId]))[0]).toMatchObject({ event_key: p.events[0]!.eventKey, event_seq: 5 });
  });

  test('P-T54_수출 사건이 없는(아직 ACCEPTED) 결제는 event_key·event_seq를 비운다', async () => {
    const p = await putPayment(admin, { status: 'ACCEPTED', events: [{ seq: 1, type: 'ACCEPTED', exported: false }] });
    expect((await batchGet([p.orderId]))[0]).toMatchObject({ status: 'PAYMENT_STATUS_ACCEPTED', event_key: '', event_seq: 0, approved_at: null });
  });

  test('P-T54_이력이 아예 없는 결제도 빠지지 않고 event_key·event_seq만 비운다(왼쪽 조인)', async () => {
    const p = await putPayment(admin, { status: 'UNKNOWN' });
    expect(await batchGet([p.orderId])).toEqual([expect.objectContaining({ order_id: p.orderId, status: 'PAYMENT_STATUS_UNKNOWN', event_key: '', event_seq: 0 })]);
  });

  test('P-T54_같은 표에 쓰인 ConfirmPayment 결과가 바로 읽힌다(쓰기 인스턴스, event_key·event_seq는 빔)', async () => {
    const f = tossConfirm();
    const a = await confirm(f.request);
    expect(await batchGet([f.orderId])).toEqual([expect.objectContaining({ order_id: f.orderId, payment_id: a.payment_id, status: 'PAYMENT_STATUS_ACCEPTED', event_key: '', event_seq: 0 })]);
  });

  test.each(['ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED'])('P-T54_원장 상태 %s는 같은 이름의 PaymentStatus로 답한다', async (status) => {
    const p = await putPayment(admin, { status });
    expect((await batchGet([p.orderId]))[0]!.status).toBe(`PAYMENT_STATUS_${status}`);
  });

  test('P-T54_없는 주문은 답에 넣지 않고 있는 주문만 돌려준다', async () => {
    const p = await putPayment(admin);
    const missing = newId();
    const got = await batchGet([missing, p.orderId]);
    expect(got.map((r) => r.order_id)).toEqual([p.orderId]);
    expect(await batchGet([missing])).toEqual([]);
  });

  test('P-T54_같은 주문 ID를 두 번 물어도 한 건만 돌려준다', async () => {
    const p = await putPayment(admin);
    expect(await batchGet([p.orderId, p.orderId])).toHaveLength(1);
  });

  test('P-T54_한 번에 100건을 물을 수 있고 모두 돌려준다', async () => {
    const seeded = await Promise.all(Array.from({ length: 100 }, () => putPayment(admin)));
    const ids = seeded.map((p) => p.orderId);
    const got = await batchGet(ids);
    expect(got.map((r) => r.order_id).sort()).toEqual([...ids].sort());
  }, 60_000);

  test.each<[string, () => string[]]>([
    ['101건', () => Array.from({ length: 101 }, () => newId())],
    ['0건', () => []],
    ['대문자 UUID', () => [newId().toUpperCase()]],
    ['UUID 모양이 아닌 값', () => ['not-a-uuid']],
  ])('P-T54_틀린 묻기(%s)는 INVALID_ARGUMENT다 [ASVS v5.0.0-2.2.1]', async (_name, ids) => {
    const s = await stack();
    const metricsBefore = await s.metrics();
    const err = await failure(unary(s.client, 'BatchGetPayments', { order_ids: ids() }));
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(outcomeCount(await s.metrics(), BATCHES, 'invalid') - outcomeCount(metricsBefore, BATCHES, 'invalid')).toBe(1);
  });

  test('P-T54_리뷰 고침 H3: 문장 시간 한도 400ms: 표가 잠겨 읽지 못하면 데드라인(5초)까지 기다리지 않고 한도에서 DEADLINE_EXCEEDED로 실패하며 지표 error가 오른다', async () => {
    expect(BATCH_GET_STATEMENT_TIMEOUT_MS).toBe(400);
    const p = await putPayment(admin);
    const s = await stack();
    const metricsBefore = await s.metrics();
    const client = await admin.pool.connect();
    try {
      await client.query('begin');
      await client.query('lock table payment in access exclusive mode');
      const t0 = Date.now();
      const err = await failure(unary(s.client, 'BatchGetPayments', { order_ids: [p.orderId] }));
      const elapsed = Date.now() - t0;
      expect(err.code).toBe(grpc.status.DEADLINE_EXCEEDED);
      expect(err.details).not.toMatch(/statement timeout|canceling/i);
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
    expect(outcomeCount(await s.metrics(), BATCHES, 'error') - outcomeCount(metricsBefore, BATCHES, 'error')).toBe(1);
    expect(s.errors.at(-1)!.method).toBe('BatchGetPayments');
  });

  test('P-T54_정상 묻기는 지표 ok를 올린다', async () => {
    const p = await putPayment(admin);
    const s = await stack();
    const metricsBefore = await s.metrics();
    await batchGet([p.orderId]);
    expect(outcomeCount(await s.metrics(), BATCHES, 'ok') - outcomeCount(metricsBefore, BATCHES, 'ok')).toBe(1);
  });

  test('P-T54_결과 조회는 일반 풀만, 승인 명령 쓰기는 핫패스 풀만 쓴다(반대쪽 풀이 닫혀 있어도 된다)', async () => {
    const closed = createDatabase({ url: pgc!.url, max: 1, applicationName: 'payment-it-closed' });
    await closed.close();
    const p = await putPayment(admin);
    const reader = new DrizzlePaymentStore({ database: closed, batchDatabase: batch });
    await expect(reader.batchGet([p.orderId])).resolves.toHaveLength(1);

    const writer = new DrizzlePaymentStore({ database: hot, batchDatabase: closed });
    const f = tossConfirm();
    await expect(
      writer.store(
        { orderId: f.orderId, attemptId: f.attemptId, attemptNo: 1, eventId: f.eventId, pg: 'TOSS', paymentRef: { kind: 'toss', paymentKey: f.paymentKey }, amount: f.amount, authenticatedAtMs: f.authenticatedAtMs },
        { paymentId: newId(), eventKey: newId(), nowMs: Date.now() },
      ),
    ).resolves.toMatchObject({ kind: 'CREATED' });
  });

  test('P-T54_실행 계획: 큰 표에서 BatchGetPayments의 한 문장이 payment (order_id) 유일 인덱스와 payment_event 기본 키를 타고 두 표를 통째로 읽지 않는다', async () => {
    const seeded = await Promise.all([putPayment(admin, { events: approvedEvents }), putPayment(admin, { events: approvedEvents }), putPayment(admin)]);
    const statements = await statementsDuring(() => batchGet(seeded.map((p) => p.orderId)));
    const onLedger = statements.filter((st) => /\bpayment(_event)?\b/i.test(st.text));
    expect(onLedger, JSON.stringify(statements.map((st) => st.text))).toHaveLength(1);

    const nodes = await planOnBigTable(onLedger[0]!);

    const names = nodes.map((n) => n['Index Name']).filter(Boolean);
    expect(names).toContain('payment_order_id_key');
    expect(names).toContain('payment_event_payment_id_seq_pk');
    expect(nodes.filter((n) => n['Node Type'] === 'Seq Scan' && ['payment', 'payment_event'].includes(String(n['Relation Name'])))).toEqual([]);
  }, 60_000);
});

// ───────────────────────────── purchase-svc 실제 클라이언트(계약) ─────────────────────────────

/** 시험 환경의 첫 호출은 연결을 맺느라 승인 명령 데드라인 200ms를 넘길 수 있다. 다시 보내기는 Saga 실행기가 하는 일과 같다(멱등) */
async function confirmUntilAnswered(c: GrpcPaymentConfirms, command: ConfirmCommand): Promise<ConfirmOutcome> {
  for (let i = 0; ; i += 1) {
    const out = await c.confirm(command);
    if (out.status !== 'RETRYABLE' || i >= 30) return out;
  }
}

/** 첫 호출의 연결 지연으로 500ms를 넘기면 다시 묻는다(실행기의 다음 점검과 같다) */
async function pullUntilAnswered(r: GrpcPaymentResultReader, ids: string[]) {
  for (let i = 0; ; i += 1) {
    try {
      return await r.batchGet(ids);
    } catch (e) {
      if (!(e instanceof PaymentPullCallError) || !['DEADLINE_EXCEEDED', 'UNAVAILABLE'].includes(e.code) || i >= 30) throw e;
    }
  }
}

const commandOf = (f: ConfirmFixture, refs: ConfirmCommand['refs']): ConfirmCommand => ({
  orderId: f.orderId,
  attemptId: f.attemptId,
  eventId: f.eventId,
  attemptNo: f.attemptNo,
  authenticatedAtMs: f.authenticatedAtMs,
  pg: refs.pg,
  refs,
  amount: f.amount,
  deadlineMs: 200,
});

describe('purchase-svc 실제 클라이언트로 부르기(계약)', () => {
  let confirms: GrpcPaymentConfirms | undefined;
  let reader: GrpcPaymentResultReader | undefined;
  const clients = async () => {
    const s = await stack();
    confirms ??= new GrpcPaymentConfirms({ address: s.address });
    reader ??= new GrpcPaymentResultReader({ address: s.address });
    return { confirms, reader };
  };
  afterAll(() => {
    confirms?.close();
    reader?.close();
  });

  test('P-T53_GrpcPaymentConfirms로 토스 명령을 보내면 ACCEPTED IN_PROGRESS이고 회차·시도 순번·인증 시각이 원장에 적힌다', async () => {
    const f = tossConfirm({ attemptNo: 2 });
    const { confirms: c } = await clients();
    await expect(confirmUntilAnswered(c, commandOf(f, { pg: 'TOSS', paymentKey: f.paymentKey }))).resolves.toEqual({ status: 'ACCEPTED', result: 'IN_PROGRESS' });
    const p = (await ledgerOf(admin, f.orderId)).payments[0]!;
    expect(p).toMatchObject({ event_id: f.eventId, attempt_id: f.attemptId, attempt_no: 2, pg: 'TOSS', amount: f.amount, pg_payment_ref: f.paymentKey });
    expect(p.authenticated_at.getTime()).toBe(f.authenticatedAtMs);
  });

  test('P-T53_GrpcPaymentConfirms로 포트원 명령을 보내면 ACCEPTED IN_PROGRESS다', async () => {
    const f = portoneConfirm();
    const { confirms: c } = await clients();
    await expect(confirmUntilAnswered(c, commandOf(f, { pg: 'PORTONE', paymentId: f.paymentId, txId: f.txId, paymentToken: f.paymentToken }))).resolves.toEqual({ status: 'ACCEPTED', result: 'IN_PROGRESS' });
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg: 'PORTONE', pg_confirm_token: f.paymentToken });
  });

  test('P-T53_GrpcPaymentConfirms로 다른 금액을 다시 보내면 REJECTED failed_precondition, 인증 시각이 없으면 REJECTED invalid_argument다', async () => {
    const f = tossConfirm();
    const { confirms: c } = await clients();
    const refs = { pg: 'TOSS', paymentKey: f.paymentKey } as const;
    await expect(confirmUntilAnswered(c, commandOf(f, refs))).resolves.toMatchObject({ status: 'ACCEPTED' });
    await expect(confirmUntilAnswered(c, { ...commandOf(f, refs), amount: f.amount + 1 })).resolves.toEqual({ status: 'REJECTED', reason: 'failed_precondition' });

    const g = tossConfirm();
    const { authenticatedAtMs: _dropped, ...noAuth } = commandOf(g, { pg: 'TOSS', paymentKey: g.paymentKey });
    await expect(confirmUntilAnswered(c, noAuth)).resolves.toEqual({ status: 'REJECTED', reason: 'invalid_argument' });
  });

  test('P-T47_GrpcPaymentResultReader가 ACCEPTED 결제를 읽으면 순번·키가 비어 있고 부르는 쪽 판단은 WAIT다', async () => {
    const f = tossConfirm();
    const { confirms: c, reader: r } = await clients();
    await confirmUntilAnswered(c, commandOf(f, { pg: 'TOSS', paymentKey: f.paymentKey }));
    const [state, ...rest] = await pullUntilAnswered(r, [f.orderId]);
    expect(rest).toEqual([]);
    expect(state).toMatchObject({ orderId: f.orderId, pg: 'TOSS', status: 'ACCEPTED', amount: f.amount, eventKey: '', eventSeq: 0 });
    expect(state!.approvedAtMs).toBeUndefined();
    expect(paymentStateToResultEvent(state!, { eventId: f.eventId, attemptNo: 1, confirmSentAtMs: Date.now(), pulledAtMs: Date.now() })).toEqual({ kind: 'WAIT' });
  });

  test('P-T47_P-T15_GrpcPaymentResultReader가 승인 결제를 읽으면 사건 길과 같은 결과 사건(event_key·event_seq·금액)으로 바뀌고 없는 주문은 빠진다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', approvedAtMs: APPROVED_AT_MS, events: approvedEvents });
    const { reader: r } = await clients();
    const got = await pullUntilAnswered(r, [p.orderId, newId()]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ orderId: p.orderId, paymentId: p.paymentId, pg: 'TOSS', status: 'APPROVED', amount: p.amount, approvedAtMs: APPROVED_AT_MS, eventKey: p.events[2]!.eventKey, eventSeq: 3 });

    const eventId = newId();
    const decision = paymentStateToResultEvent(got[0]!, { eventId, attemptNo: 1, confirmSentAtMs: APPROVED_AT_MS - 1_000, pulledAtMs: APPROVED_AT_MS + 1_000 });
    expect(decision).toMatchObject({ kind: 'APPLY', event: { orderId: p.orderId, eventId, pg: 'TOSS', amount: p.amount, eventKey: p.events[2]!.eventKey, eventSeq: 3, type: 'APPROVED' } });
  });
});
