// F-06-5 core-svc support 문의 PostgreSQL 18 통합 시험(계획 §6·§8, 작업 폴더 lane2-F-06-5-opencode).
// 실제 마이그레이션 0055(와 저널에 함께 올린 0049)를 적용하고 표·CHECK·인덱스·권한, Drizzle 저장소의
// 접수·멱등·BOLA·추가 문의·답변·닫기·3년 파기와 Outbox 파티션 삽입을 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase, ensureOutboxPartitions, fakeClock, systemClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleAppealStore } from '../src/modules/support/adapters/db/drizzle-appeals.js';
import { DrizzleInquiryStore } from '../src/modules/support/adapters/db/drizzle-inquiries.js';
import { Inquiries } from '../src/modules/support/application/inquiries.js';
import { addYears, PURGE_YEARS } from '../src/modules/support/domain/inquiry.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

let container: PostgresContainer;
let admin: Database;
let database: Database;
let store: DrizzleInquiryStore;
let inquiries: Inquiries;

const NOW = Date.parse('2026-11-27T05:00:00.000Z');
const DAY = 86_400_000;
const clock = fakeClock({ now: NOW });

beforeAll(async () => {
  container = await startPostgres({ name: 'peaket-f065-support-inquiry-it' });
  await migrateCore(container.url);
  admin = createDatabase({ url: container.url, applicationName: 'core-svc-support-inquiry-it-admin', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  database = await loginFor(admin, container, 'core_app_support_inquiry_it', 'core_app', 4);
  store = new DrizzleInquiryStore(database);
  inquiries = new Inquiries({ store, clock, holidays: new Set() });
}, 240_000);

afterAll(async () => {
  await database?.close();
  await admin?.close();
  container?.stop();
});

const codeOf = async (text: string, params: unknown[] = []): Promise<string> => {
  try {
    await admin.pool.query(text, params);
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

const errOf = async (p: Promise<unknown>): Promise<{ status?: number; slug?: string } | undefined> => {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err as { status?: number; slug?: string };
  }
};

const submit = (accountId: string, title: string, body: string, key = randomUUID(), hash = `h-${randomUUID()}`) =>
  inquiries.submit(accountId, { category: 'OTHER', title, body }, key, hash);

describe('0055 support 문의 표·제약·권한(실제 PostgreSQL 18)', () => {
  test('R-T27 ① 0055가 적용되어 inquiry·inquiry_message 칸과 request_key·request_hash·purge_at이 있다', async () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url)), 'utf8')) as { entries: unknown[] };
    const applied = Number((await admin.pool.query<{ n: string }>('select count(*)::text as n from drizzle.__drizzle_migrations')).rows[0]!.n);
    expect(applied).toBe(journal.entries.length);
    const cols = (
      await admin.pool.query<{ table_name: string; column_name: string; is_nullable: string; udt_name: string }>(
        "select table_name, column_name, is_nullable, udt_name from information_schema.columns where table_schema = 'public' and table_name in ('inquiry', 'inquiry_message') order by table_name, ordinal_position",
      )
    ).rows;
    const inquiryCols = cols.filter((c) => c.table_name === 'inquiry');
    expect(inquiryCols.map((c) => c.column_name)).toEqual([
      'id', 'number', 'account_id', 'category', 'order_ref', 'order_summary', 'title', 'body', 'status', 'case_id',
      'request_key', 'request_hash', 'created_at', 'answered_at', 'fan_viewed_at', 'closed_at', 'purge_at', 'progress_due_at', 'result_due_at',
    ]);
    const byName = new Map(inquiryCols.map((c) => [c.column_name, c]));
    expect(byName.get('request_key')?.is_nullable).toBe('NO');
    expect(byName.get('request_hash')?.is_nullable).toBe('NO');
    expect(byName.get('purge_at')?.is_nullable).toBe('YES');
    expect(byName.get('result_due_at')?.is_nullable).toBe('NO');
    expect(cols.filter((c) => c.table_name === 'inquiry_message').map((c) => c.column_name)).toEqual(['id', 'inquiry_id', 'author_kind', 'kind', 'body', 'request_key', 'request_hash', 'created_at']);
  });

  test('R-T27 ① 12유형·4상태·작성자·종류 CHECK와 접수 번호 UNIQUE가 실제로 막는다', async () => {
    const checks = new Map(
      (await admin.pool.query<{ conname: string; def: string }>("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'inquiry'::regclass and contype = 'c'")).rows.map((r) => [r.conname, r.def]),
    );
    expect(checks.get('inquiry_category_check')).toContain('BOOKING_PAYMENT');
    expect(checks.get('inquiry_category_check')).toContain('OTHER');
    expect(checks.get('inquiry_status_check')).toContain('CLOSED');
    const msgChecks = new Map(
      (await admin.pool.query<{ conname: string; def: string }>("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'inquiry_message'::regclass and contype = 'c'")).rows.map((r) => [r.conname, r.def]),
    );
    expect(msgChecks.get('inquiry_message_author_check')).toContain('AGENT');
    expect(msgChecks.get('inquiry_message_kind_check')).toContain('ANSWER');

    expect(await codeOf(`insert into inquiry (id, number, account_id, category, title, body, status, request_key, request_hash, created_at, result_due_at) values ($1, $2, $3, 'NOT_A_CATEGORY', '제목', '본문 열 글자 이상입니다', 'RECEIVED', $4, 'h', now(), now())`, [randomUUID(), randomUUID(), randomUUID(), randomUUID()])).toBe('23514');
    expect(await codeOf(`insert into inquiry (id, number, account_id, category, title, body, status, request_key, request_hash, created_at, result_due_at) values ($1, $2, $3, 'OTHER', '제목', '본문 열 글자 이상입니다', 'NOT_A_STATUS', $4, 'h', now(), now())`, [randomUUID(), randomUUID(), randomUUID(), randomUUID()])).toBe('23514');
    expect(await codeOf('insert into inquiry (id, number, account_id, category, title, body, status, request_key, request_hash, created_at, result_due_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [randomUUID(), 'Q-2611-9001', randomUUID(), 'OTHER', '제목', '본문 열 글자 이상입니다', 'RECEIVED', randomUUID(), 'h', new Date(NOW), new Date(NOW + 3 * DAY)])).toBe('OK');
    expect(await codeOf('insert into inquiry (id, number, account_id, category, title, body, status, request_key, request_hash, created_at, result_due_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [randomUUID(), 'Q-2611-9001', randomUUID(), 'OTHER', '제목', '본문 열 글자 이상입니다', 'RECEIVED', randomUUID(), 'h', new Date(NOW), new Date(NOW + 3 * DAY)])).toBe('23505');

    const account = randomUUID();
    const key = randomUUID();
    expect(await codeOf('insert into inquiry (id, number, account_id, category, title, body, status, request_key, request_hash, created_at, result_due_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [randomUUID(), randomUUID(), account, 'OTHER', '제목', '본문 열 글자 이상입니다', 'RECEIVED', key, 'h', new Date(NOW), new Date(NOW + 3 * DAY)])).toBe('OK');
    expect(await codeOf('insert into inquiry (id, number, account_id, category, title, body, status, request_key, request_hash, created_at, result_due_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [randomUUID(), randomUUID(), account, 'OTHER', '제목', '본문 열 글자 이상입니다', 'RECEIVED', key, 'h', new Date(NOW), new Date(NOW + 3 * DAY)])).toBe('23505');

    const inquiryId = randomUUID();
    expect(await codeOf('insert into inquiry (id, number, account_id, category, title, body, status, request_key, request_hash, created_at, result_due_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [inquiryId, randomUUID(), randomUUID(), 'OTHER', '제목', '본문 열 글자 이상입니다', 'RECEIVED', randomUUID(), 'h', new Date(NOW), new Date(NOW + 3 * DAY)])).toBe('OK');
    expect(await codeOf('insert into inquiry_message (id, inquiry_id, author_kind, kind, body, created_at) values ($1, $2, $3, $4, $5, now())', [randomUUID(), inquiryId, 'ROBOT', 'MESSAGE', '본문'])).toBe('23514');
    expect(await codeOf('insert into inquiry_message (id, inquiry_id, author_kind, kind, body, created_at) values ($1, $2, $3, $4, $5, now())', [randomUUID(), inquiryId, 'FAN', 'NOTE', '본문'])).toBe('23514');
    expect(await codeOf('insert into inquiry_message (id, inquiry_id, author_kind, kind, body, created_at) values ($1, $2, $3, $4, $5, now())', [randomUUID(), randomUUID(), 'FAN', 'MESSAGE', '본문'])).toBe('23503');
  });

  test('0049 support 소명 표가 함께 적용되고 소명 Outbox도 UUIDv7 파티션에 들어간다', async () => {
    const appeals = new DrizzleAppealStore(database);
    const appealId = randomUUID();
    await appeals.saveAppeal(
      {
        appealId,
        accountId: randomUUID(),
        kind: 'RESTRICTION',
        targetId: randomUUID(),
        body: '예매 제한에 대한 소명 본문입니다.',
        status: 'SUBMITTED',
        result: null,
        resultNote: null,
        caseId: null,
        submittedAtMs: NOW,
        decidedAtMs: null,
        dispatchState: 'PENDING',
        dispatchAttempts: 0,
        nextDispatchAtMs: NOW,
        dispatchedAtMs: null,
      },
      { eventKey: appealId, kind: 'APPEAL', sourceId: appealId, category: 'RESTRICTION', createdAt: new Date(NOW).toISOString() },
    );
    expect((await admin.pool.query('select 1 from appeal where id = $1', [appealId])).rowCount).toBe(1);
    const outbox = (await admin.pool.query<{ topic: string }>('select topic from outbox where msg_key = $1', [appealId])).rows;
    expect(outbox.map((r) => r.topic)).toEqual(['support.cases-requested']);
  });

  test('R-T27 ① 조회 인덱스 넷·메시지 인덱스 둘과 core_app 권한이 있다', async () => {
    const idx = (await admin.pool.query<{ indexname: string; indexdef: string }>("select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('inquiry', 'inquiry_message') order by indexname")).rows;
    const names = idx.map((r) => r.indexname);
    for (const name of ['inquiry_account_created_idx', 'inquiry_status_purge_idx', 'inquiry_case_idx', 'inquiry_request_key_idx', 'inquiry_message_inquiry_idx', 'inquiry_message_request_key_idx']) expect(names, name).toContain(name);
    const requestKey = idx.find((r) => r.indexname === 'inquiry_request_key_idx')!;
    expect(requestKey.indexdef).toContain('UNIQUE');
    expect(requestKey.indexdef).toContain('account_id, request_key');
    const messageKey = idx.find((r) => r.indexname === 'inquiry_message_request_key_idx')!;
    expect(messageKey.indexdef).toContain('UNIQUE');
    const grants = (
      await admin.pool.query<{ inquiry: boolean; message: boolean }>(
        "select has_table_privilege('core_app', 'inquiry', 'SELECT,INSERT,UPDATE,DELETE') as inquiry, has_table_privilege('core_app', 'inquiry_message', 'SELECT,INSERT,UPDATE,DELETE') as message",
      )
    ).rows[0]!;
    expect(grants).toEqual({ inquiry: true, message: true });
  });
});

describe('DrizzleInquiryStore 문의 접수·멱등·BOLA·답변·닫기(실제 PostgreSQL 18)', () => {
  test('R-T27 ①③ 문의·첫 메시지·Outbox가 한 트랜잭션에 들어가고 Outbox에 본문·계정이 새지 않는다', async () => {
    const account = randomUUID();
    const body = '계좌번호 110-123-456789 로 환불받고 싶습니다. 열 글자 이상입니다.';
    const r = await inquiries.submit(account, { category: 'CANCEL_REFUND', title: '환불 계좌를 확인해 주세요', body }, `k-${randomUUID()}`, `h-${randomUUID()}`);
    expect(r.inquiryId).toBeTruthy();
    expect(r.status).toBe('RECEIVED');
    expect(r.number).toMatch(/^Q-2611-\d{4}$/);
    const row = (await admin.pool.query<Record<string, unknown>>('select * from inquiry where id = $1', [r.inquiryId])).rows[0]!;
    expect(row).toMatchObject({ account_id: account, category: 'CANCEL_REFUND', status: 'RECEIVED', case_id: null, purge_at: null });
    const messages = await store.messages(r.inquiryId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ authorKind: 'FAN', kind: 'MESSAGE', body });
    const outbox = (await admin.pool.query<{ topic: string; msg_key: string; payload: Buffer }>('select topic, msg_key, payload from outbox where msg_key = $1', [r.inquiryId])).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.topic).toBe('support.cases-requested');
    const payload = outbox[0]!.payload.toString('utf8');
    expect(JSON.parse(payload)).toMatchObject({ eventKey: r.inquiryId, kind: 'INQUIRY', sourceId: r.inquiryId, category: 'CANCEL_REFUND' });
    expect(payload).not.toContain('110-123-456789');
    expect(payload).not.toContain(account);
  });

  test('R-T27 ① 같은 멱등 키·같은 본문은 같은 문의를 돌려주고 다른 본문은 422다', async () => {
    const account = randomUUID();
    const key = `k-${randomUUID()}`;
    const first = await inquiries.submit(account, { category: 'OTHER', title: '같은 키의 문의', body: '같은 키로 두 번 접수합니다.' }, key, 'same');
    const again = await inquiries.submit(account, { category: 'OTHER', title: '같은 키의 문의', body: '같은 키로 두 번 접수합니다.' }, key, 'same');
    expect(again.inquiryId).toBe(first.inquiryId);
    const count = (await admin.pool.query<{ n: string }>('select count(*)::text as n from inquiry where account_id = $1', [account])).rows[0]!.n;
    expect(Number(count)).toBe(1);
    const err = await errOf(inquiries.submit(account, { category: 'OTHER', title: '다른 본문의 문의', body: '같은 키에 다른 본문을 보냅니다.' }, key, 'different'));
    expect(err).toMatchObject({ status: 422, slug: 'idempotency-key-reused' });
  });

  test('R-T27 ④ 남의 문의는 상세·추가 문의 모두 404(BOLA)이고 하루 10건을 넘으면 429다', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const r = await submit(owner, '내 문의입니다', '내 문의 본문입니다 열 글자 이상입니다.');
    expect((await errOf(inquiries.detail(other, r.inquiryId)))?.status).toBe(404);
    expect((await errOf(inquiries.addMessage(other, r.inquiryId, '남의 문의에 추가합니다.', `k-${randomUUID()}`, 'h')))?.status).toBe(404);

    const limitAccount = randomUUID();
    for (let i = 0; i < 10; i += 1) await submit(limitAccount, `한도 문의 ${i}`, '하루 한도 열 건을 채우는 본문입니다.');
    expect((await errOf(submit(limitAccount, '열한 번째 문의', '하루 한도를 넘는 열한 번째 본문입니다.')))?.slug).toBe('inquiry-daily-limit');
  });

  test('R-T27 ⑤⑥ 추가 문의·답변·열람·닫기가 저장되고 닫을 때 purge_at이 3년 뒤다', async () => {
    const account = randomUUID();
    const r = await submit(account, '답변을 기다리는 문의', '답변을 기다리는 문의 본문입니다 열 글자 이상.');
    clock.advance(1_000);
    const added = await inquiries.addMessage(account, r.inquiryId, '추가로 적는 문의 내용입니다 열 글자 이상.', `k-${randomUUID()}`, `h-${randomUUID()}`);
    expect(added.authorKind).toBe('FAN');
    clock.advance(1_000);
    let row = (await admin.pool.query<{ status: string }>('select status from inquiry where id = $1', [r.inquiryId])).rows[0]!;
    expect(row.status).toBe('IN_PROGRESS');
    const outboxCount = (await admin.pool.query<{ n: string }>('select count(*)::text as n from outbox where msg_key = $1', [r.inquiryId])).rows[0]!.n;
    expect(Number(outboxCount)).toBe(2);

    const reply = await inquiries.recordReply(r.inquiryId, 'ANSWER', '고객센터 답변입니다. 확인했습니다.', `k-${randomUUID()}`, `h-${randomUUID()}`);
    expect(reply.result).toBe('RECORDED');
    const answered = (await admin.pool.query<{ status: string; answered_at: Date | null }>('select status, answered_at from inquiry where id = $1', [r.inquiryId])).rows[0]!;
    expect(answered.status).toBe('ANSWERED');
    expect(answered.answered_at).not.toBeNull();

    const first = await inquiries.detail(account, r.inquiryId);
    expect(first.hasNewAnswer).toBe(true);
    expect(first.messages.map((m) => m.authorKind)).toEqual(['FAN', 'FAN', 'AGENT']);
    expect(first.messages.at(-1)).toMatchObject({ authorDisplay: '피켓 고객센터' });
    const second = await inquiries.detail(account, r.inquiryId);
    expect(second.hasNewAnswer).toBe(false);

    const closed = await inquiries.closeInquiry(r.inquiryId);
    expect(closed.status).toBe('CLOSED');
    const closedRow = (await admin.pool.query<{ status: string; closed_at: Date; purge_at: Date }>('select status, closed_at, purge_at from inquiry where id = $1', [r.inquiryId])).rows[0]!;
    expect(closedRow.status).toBe('CLOSED');
    expect(closedRow.purge_at.getTime()).toBe(addYears(closedRow.closed_at.getTime(), PURGE_YEARS));
    expect((await errOf(inquiries.addMessage(account, r.inquiryId, '닫힌 문의에 추가합니다.', `k-${randomUUID()}`, 'h')))?.slug).toBe('inquiry-closed');
  });

  test('R-T27 ⑤ 답변 뒤 14일이 지난 문의는 closeIdle이 닫고 purge_at을 3년 뒤로 둔다', async () => {
    const account = randomUUID();
    const r = await submit(account, '오래된 답변 문의', '답변한 지 보름이 지난 문의 본문입니다.');
    await inquiries.recordReply(r.inquiryId, 'ANSWER', '답변했습니다. 더 물을 것이 없으면 닫습니다.', `k-${randomUUID()}`, `h-${randomUUID()}`);
    const old = new Date(NOW - 15 * DAY);
    await admin.pool.query('update inquiry set answered_at = $2 where id = $1', [r.inquiryId, old]);
    const changed = await inquiries.closeIdle(NOW);
    expect(changed).toBeGreaterThanOrEqual(1);
    const row = (await admin.pool.query<{ status: string; purge_at: Date }>('select status, purge_at from inquiry where id = $1', [r.inquiryId])).rows[0]!;
    expect(row.status).toBe('CLOSED');
    expect(row.purge_at.getTime()).toBe(addYears(NOW, PURGE_YEARS));
  });
});
