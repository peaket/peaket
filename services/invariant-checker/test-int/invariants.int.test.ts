// 불변식 SQL 통합 시험(실제 PostgreSQL 18). 불변식마다 지켜짐과 깨짐을 본다(docs/verification.md §2.5, K2, K7, S-T2, J-T25, ADR-0106, ADR-0129 중간-043).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyRecords, type TestRecords } from '../src/records.js';
import { runInvariantChecks, type CheckRun } from '../src/run.js';
import type { SourceName } from '../src/tables.js';
import { TABLES, startPostgres, type DbName, type PostgresServer } from './postgres.js';

let server: PostgresServer;
const db: Partial<Record<DbName, pg.Client>> = {};

beforeAll(async () => {
  server = await startPostgres();
  for (const name of ['purchase', 'payment', 'ticket', 'bare'] as const) {
    db[name] = new pg.Client({ connectionString: server.url(name) });
    await db[name]!.connect();
  }
});
afterAll(async () => {
  for (const c of Object.values(db)) await c?.end().catch(() => {});
  server?.stop();
});
beforeEach(async () => {
  for (const [name, tables] of Object.entries(TABLES)) await db[name as DbName]!.query(`TRUNCATE ${tables.join(', ')}`);
});

/** 시험 데이터 넣기(표·칸 이름은 시험 코드의 고정 값이다) */
async function ins(name: 'purchase' | 'payment' | 'ticket', table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  await db[name]!.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => row[k]));
}

const AS_OF = '2026-11-02T11:00:00+09:00';
async function check(o: { records?: TestRecords | null; sources?: Array<'purchase' | 'payment' | 'ticket'>; payment?: DbName; asOf?: string; checkDb?: DbName; keep?: boolean } = {}) {
  const c = new pg.Client({ connectionString: server.url(o.checkDb ?? 'bare') });
  // 시험이 실패해 닫지 못한 연결이 컨테이너를 내릴 때 처리되지 않은 오류가 되지 않게
  c.on('error', () => {});
  await c.connect();
  const sources: Partial<Record<SourceName, pg.ClientBase>> = {};
  for (const s of o.sources ?? ['purchase', 'payment', 'ticket']) sources[s] = db[s === 'payment' ? (o.payment ?? 'payment') : s]!;
  const run = await runInvariantChecks({ check: c, sources, records: o.records === null ? undefined : (o.records ?? emptyRecords()), clock: { now: () => Date.parse(o.asOf ?? AS_OF) } });
  if (!o.keep) await c.end();
  return { run, client: c };
}
const res = (run: CheckRun, id: string) => run.results.find((r) => r.id === id)!;
const failed = (run: CheckRun) => run.results.filter((r) => r.result === 'FAIL').map((r) => r.id);

const EVENT = randomUUID();
const order = async (o: { account?: string; status?: string; amount?: number; event?: string } = {}) => {
  const id = randomUUID();
  await ins('purchase', 'purchase_order', { id, account_id: o.account ?? randomUUID(), event_id: o.event ?? EVENT, status: o.status ?? 'CONFIRMED', amount: o.amount ?? 10_000, buyer_name: '홍길동', buyer_phone: '010-0000-0000' });
  return id;
};
const event = (orderId: string, seq: number, to: string, at: string) => ins('purchase', 'order_event', { order_id: orderId, seq, to_status: to, occurred_at: at });
const payment = async (o: { orderId: string; status?: string; approvedAt?: string | null; amount?: number; pg?: string; event?: string }) => {
  const id = randomUUID();
  await ins('payment', 'payment', { id, order_id: o.orderId, event_id: o.event ?? EVENT, pg: o.pg ?? 'SIMULATOR', amount: o.amount ?? 10_000, status: o.status ?? 'APPROVED', approved_at: o.approvedAt === undefined ? '2026-11-02T10:00:00+09:00' : o.approvedAt });
  return id;
};

describe('원본·기록이 없을 때', () => {
  it('비어 있으면 17개가 모두 PASS다', async () => {
    const { run } = await check();
    expect(run.results.map((r) => r.id)).toEqual(['Q1', 'Q2', 'S1', 'S2', 'S3', 'S4', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'M1', 'M2', 'M3', 'M4', 'M5']);
    expect(run.results.every((r) => r.result === 'PASS')).toBe(true);
  });

  it('기록이 없으면 기록을 쓰는 불변식만 SKIPPED다', async () => {
    const { run } = await check({ records: null });
    expect(run.results.filter((r) => r.result === 'SKIPPED').map((r) => r.id)).toEqual(['Q1', 'Q2', 'P2', 'P6']);
    expect(res(run, 'Q1').reason).toMatch(/기록/);
  });

  it('ticket 원본이 없으면 S3·P5가 SKIPPED다', async () => {
    const { run } = await check({ sources: ['purchase', 'payment'] });
    expect(run.results.filter((r) => r.result === 'SKIPPED').map((r) => r.id)).toEqual(['S3', 'P5']);
    expect(res(run, 'S3').reason).toMatch(/ticket/);
  });

  it('원본 DB에 표가 없으면 그 표를 쓰는 불변식이 SKIPPED다', async () => {
    const { run } = await check({ payment: 'bare' });
    expect(run.results.filter((r) => r.result === 'SKIPPED').map((r) => r.id)).toEqual(['P1', 'P3', 'P4', 'P5', 'P6', 'M1', 'M2', 'M3', 'M4', 'M5']);
    expect(res(run, 'M4').reason).toMatch(/statement_source/);
  });
});

describe('원본을 바꾸지 않는다([ASVS v5.0.0-13.2.2]·[ASVS v5.0.0-14.2.6])', () => {
  it('purchase DB를 검사 DB로 써도 원본 행이 그대로이고 임시 표가 남지 않으며 개인정보 칸을 읽지 않는다', async () => {
    const acct = randomUUID();
    const o1 = await order({ account: acct });
    await ins('purchase', 'purchase_quota', { account_id: acct, event_id: EVENT, used: 1, limit_count: 4 });
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: o1, status: 'SOLD' });
    const tablesBefore = (await db.purchase!.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n;
    const { run, client } = await check({ checkDb: 'purchase', keep: true });
    expect(failed(run)).toEqual([]);
    const cols = (await client.query('SELECT * FROM pg_temp.purchase_order LIMIT 0')).fields.map((f) => f.name);
    expect(cols).not.toContain('buyer_name');
    expect(cols).not.toContain('buyer_phone');
    await client.end();
    expect((await db.purchase!.query('SELECT count(*)::int AS n FROM seat_sale')).rows[0].n).toBe(1);
    expect((await db.purchase!.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n).toBe(tablesBefore);
    // 연결을 닫은 서버 프로세스가 임시 표를 지우는 데 잠깐 걸린다
    let temp = -1;
    for (let i = 0; i < 40 && temp !== 0; i++) {
      temp = (await db.purchase!.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname LIKE 'pg_temp%'")).rows[0].n;
      if (temp !== 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(temp).toBe(0);
  });
});

describe('같은 연결 객체', () => {
  it('검사 연결을 원본으로도 넘기면 거절한다(원본 읽기가 임시 표를 읽어 위반을 놓친다)', async () => {
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: await order(), status: 'SOLD' });
    const c = new pg.Client({ connectionString: server.url('purchase') });
    c.on('error', () => {});
    await c.connect();
    try {
      await expect(runInvariantChecks({ check: c, sources: { purchase: c }, records: emptyRecords() })).rejects.toThrow(/같은 연결/);
    } finally {
      await c.end();
    }
  });
});

describe('대기열(기록, 결과 모름은 위반을 확정하지 않는다)', () => {
  const at = (s: string) => `2026-11-02T10:00:${s}+09:00`;
  const op = (o: Partial<TestRecords['queue_admit'][number]>) => ({ event_id: EVENT, account_ref: 'a1', request_id: randomUUID(), result: 'ok' as const, seq: 1, generation: 1, started_at: at('00'), ended_at: at('01'), ...o });

  it('Q1 차례 전 입장: 끝난 때까지 본 serving보다 큰 순번이 성공으로 입장', async () => {
    const records = emptyRecords();
    records.queue_serving.push({ event_id: EVENT, serving: 100, observed_at: at('05') }, { event_id: EVENT, serving: 200, observed_at: at('30') });
    records.queue_admit.push(
      op({ seq: 100, started_at: at('06'), ended_at: at('07') }),
      op({ seq: 101, account_ref: 'a2', started_at: at('06'), ended_at: at('07') }),
      op({ seq: 150, account_ref: 'a3', result: 'unknown', started_at: at('06'), ended_at: at('07') }),
      op({ seq: 150, account_ref: 'a4', started_at: at('31'), ended_at: at('32') }),
      op({ seq: 1, account_ref: 'a5', started_at: at('01'), ended_at: at('02') }),
    );
    const { run } = await check({ records });
    expect(res(run, 'Q1')).toMatchObject({ violations: 2, unknown: 1, result: 'FAIL' });
    expect(res(run, 'Q1').details.map((d) => d.subject).sort()).toEqual([`${EVENT}:1`, `${EVENT}:101`]);
    // 위반 행의 시각도 KST로 쓴다(검사 연결의 시간대가 무엇이든)
    expect(res(run, 'Q1').details.every((d) => /ended_at=2026-11-02 10:00:0[27]\+09$/.test(d.detail))).toBe(true);
  });

  it('PRF215_재확인9_v1 serving 1초 칸 기록을 실행 도구의 변환 그대로(servingLogFromZset → servingRecords → 기록 파일) Q1에 넣으면 칸 값 + 1 순번 입장은 위반이고 칸 값 이하는 아니다', async () => {
    // 실행 도구 쪽 변환(loadtest/runner/v1.mjs·results.mjs, lib/records.mjs)을 그대로 불러 기록 파일 글을 만들고, 검사기의 기록 읽기(parseRecords)와 Q1 SQL로 판정한다
    const root = new URL('../../../loadtest/', import.meta.url);
    const { servingLogFromZset } = (await import(new URL('runner/v1.mjs', root).href)) as { servingLogFromZset: (raw: unknown) => { atMs: number; serving: number }[] };
    const { servingRecords } = (await import(new URL('runner/results.mjs', root).href)) as { servingRecords: (e: string, log: { atMs: number; serving: number }[]) => string[] };
    const { queueOpRecord } = (await import(new URL('lib/records.mjs', root).href)) as { queueOpRecord: (kind: string, o: Record<string, unknown>) => Record<string, unknown> };
    const { parseRecords } = await import('../src/records.js');
    const slot = 1_794_302_809; // 이 초 칸의 마지막 serving 6, 다음 칸 36
    const lines = servingRecords(EVENT, servingLogFromZset([String(slot), '6', String(slot + 1), '36']));
    const admit = (account: string, seqNo: number, endedMs: number) =>
      JSON.stringify(queueOpRecord('queue_admit', { eventId: EVENT, accountRef: account, requestId: `adm-${account}`, result: 'ok', seq: seqNo, generation: 1, startedMs: endedMs - 5, endedMs }));
    lines.push(
      admit('a7', 7, slot * 1000 + 500), // 칸 값 + 1: 같은 칸 안에서도 위반
      admit('a6', 6, slot * 1000 + 500), // 칸 값: 위반 아님
      admit('a36', 36, (slot + 1) * 1000 + 1), // 다음 칸 값, 그 칸 시작 뒤: 위반 아님(같은 초 안의 이른 입장은 놓친다)
      admit('a37', 37, (slot + 1) * 1000 + 900), // 다음 칸 값 + 1: 위반
    );
    const records = parseRecords(`${lines.join('\n')}\n`);
    const { run } = await check({ records });
    expect(res(run, 'Q1')).toMatchObject({ violations: 2, result: 'FAIL' });
    expect(res(run, 'Q1').details.map((d) => d.subject).sort()).toEqual([`${EVENT}:37`, `${EVENT}:7`].sort());
  });

  it('Q2 같은 세대 순번 중복: 다른 사람 둘이 성공으로 받으면 위반, 하나가 결과 모름이면 아님', async () => {
    const records = emptyRecords();
    records.queue_entry.push(op({ seq: 7 }), op({ seq: 7, account_ref: 'a2', result: 'unknown' }), op({ seq: 7, request_id: 'retry' }), op({ seq: 7, generation: 2, account_ref: 'a3' }));
    let r = (await check({ records })).run;
    expect(res(r, 'Q2')).toMatchObject({ violations: 0, unknown: 1, result: 'PASS' });
    records.queue_entry.push(op({ seq: 7, account_ref: 'a4' }));
    r = (await check({ records })).run;
    expect(res(r, 'Q2')).toMatchObject({ violations: 1, result: 'FAIL' });
    expect(res(r, 'Q2').details[0]!.subject).toBe(`${EVENT}:1:7`);
  });
});

describe('좌석(K2, S-T2)', () => {
  it('S1 오버셀: 한 좌석에 PENDING과 SOLD가 함께 있으면 위반, RETURNED는 세지 않는다', async () => {
    const seat = randomUUID();
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: seat, order_id: await order(), status: 'SOLD' });
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: seat, order_id: await order(), status: 'RETURNED' });
    expect(res((await check()).run, 'S1').violations).toBe(0);
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: seat, order_id: await order(), status: 'PENDING' });
    expect(res((await check()).run, 'S1')).toMatchObject({ violations: 1, result: 'FAIL' });
  });

  it('S2 판매 대상 좌석 수 초과', async () => {
    await ins('purchase', 'event_sale', { event_id: EVENT, sellable_seats: 2 });
    for (let i = 0; i < 2; i++) await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: await order(), status: 'SOLD' });
    expect(res((await check()).run, 'S2').violations).toBe(0);
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: await order(), status: 'PENDING' });
    expect(res((await check()).run, 'S2')).toMatchObject({ violations: 1, details: [{ subject: EVENT, detail: 'active=3 sellable=2' }] });
  });

  it('S3 한 좌석에 유효 티켓 둘', async () => {
    const seat = randomUUID();
    const t = (status: string) => ins('ticket', 'ticket', { id: randomUUID(), account_id: randomUUID(), payer_account_id: randomUUID(), event_id: EVENT, seat_id: seat, status });
    await t('ACTIVE');
    await t('REFUNDED');
    await ins('ticket', 'ticket', { id: randomUUID(), account_id: randomUUID(), payer_account_id: randomUUID(), event_id: EVENT, seat_id: null, status: 'ACTIVE' });
    expect(res((await check()).run, 'S3').violations).toBe(0);
    await t('TRANSFER_PENDING');
    expect(res((await check()).run, 'S3').violations).toBe(1);
  });

  it('S4 1인 한도 초과: 한도 2매에 활성 판매 3석, 한도 행 없는 판매도 위반', async () => {
    const acct = randomUUID();
    await ins('purchase', 'purchase_quota', { account_id: acct, event_id: EVENT, used: 3, limit_count: 2 });
    const o1 = await order({ account: acct });
    const o2 = await order({ account: acct });
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: o1, status: 'SOLD' });
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: o1, status: 'SOLD' });
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: o2, status: 'RETURNED' });
    expect(res((await check()).run, 'S4').violations).toBe(0);
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: o2, status: 'PENDING' });
    expect(res((await check()).run, 'S4')).toMatchObject({ violations: 1, details: [{ subject: `${acct}:${EVENT}`, detail: 'seats=3 limit=2' }] });
    await ins('purchase', 'seat_sale', { event_id: EVENT, seat_id: randomUUID(), order_id: await order(), status: 'SOLD' });
    expect(res((await check()).run, 'S4').violations).toBe(2);
  });
});

describe('결제(K7, NFR-005·006, ADR-0106)', () => {
  it('P1 결제 원장에 한 주문의 승인 둘', async () => {
    const o = await order();
    await payment({ orderId: o });
    await payment({ orderId: o, status: 'FAILED', approvedAt: null });
    expect(res((await check()).run, 'P1').violations).toBe(0);
    await payment({ orderId: o, status: 'CANCELED' });
    expect(res((await check()).run, 'P1').violations).toBe(1);
  });

  it('P2 결제사 원장에서 한 주문의 승인 둘(포트원 pay- 접두어를 벗긴다)', async () => {
    const o = randomUUID();
    const records = emptyRecords();
    const charge = (pgName: 'SIMULATOR' | 'PORTONE', ref: string, approved: string | null) => ({ pg: pgName, payment_ref: randomUUID(), order_ref: ref, amount: 10_000, status: 'DONE', approved_at: approved, canceled_amount: 0 });
    records.pg_charge.push(charge('SIMULATOR', o, '2026-11-02T10:00:00+09:00'), charge('SIMULATOR', o, null));
    expect(res((await check({ records })).run, 'P2').violations).toBe(0);
    records.pg_charge.push(charge('PORTONE', `pay-${o}`, '2026-11-02T10:00:03+09:00'));
    expect(res((await check({ records })).run, 'P2')).toMatchObject({ violations: 1, details: [{ subject: o }] });
  });

  it('P3 승인 뒤 60초 안에 큐 등록(주문 APPROVED·CONFIRMED)이 없다', async () => {
    const late = await order();
    await payment({ orderId: late });
    await event(late, 1, 'APPROVED', '2026-11-02T10:01:05+09:00');
    const ok = await order();
    await payment({ orderId: ok });
    await event(ok, 1, 'APPROVED', '2026-11-02T10:00:30+09:00');
    const canceled = await order({ status: 'FAILED' });
    const cp = await payment({ orderId: canceled, status: 'CANCELED' });
    await ins('payment', 'payment_cancel', { id: randomUUID(), payment_id: cp, amount: 10_000, status: 'CANCELED', canceled_at: '2026-11-02T10:00:30+09:00' });
    const missing = await order({ status: 'APPROVED' });
    await payment({ orderId: missing });
    let r = (await check()).run;
    expect(res(r, 'P3').details.map((d) => d.subject).sort()).toEqual([late, missing].sort());
    // 승인 뒤 60초가 아직 안 지났으면 없는 등록을 위반으로 보지 않는다
    r = (await check({ asOf: '2026-11-02T10:00:45+09:00' })).run;
    expect(res(r, 'P3').details.map((d) => d.subject)).toEqual([late]);
  });

  it('P4 승인 뒤 30분 안에 발권·보상으로 끝나지 않음, 기한이 지난 발권 큐 행', async () => {
    const late = await order();
    await payment({ orderId: late });
    await event(late, 1, 'APPROVED', '2026-11-02T10:00:05+09:00');
    await event(late, 2, 'CONFIRMED', '2026-11-02T10:31:00+09:00');
    const ok = await order();
    await payment({ orderId: ok });
    await event(ok, 1, 'APPROVED', '2026-11-02T10:00:05+09:00');
    await event(ok, 2, 'CONFIRMED', '2026-11-02T10:29:00+09:00');
    const waiting = await order({ status: 'APPROVED' });
    await payment({ orderId: waiting, approvedAt: '2026-11-02T10:40:00+09:00' });
    await event(waiting, 1, 'APPROVED', '2026-11-02T10:40:02+09:00');
    await ins('purchase', 'ticket_issue_job', { order_id: waiting, event_id: EVENT, issue_due_at: '2026-11-02T11:10:00+09:00', created_at: '2026-11-02T10:40:02+09:00' });
    let r = (await check()).run;
    expect(res(r, 'P4').details.map((d) => d.subject)).toEqual([late]);
    r = (await check({ asOf: '2026-11-02T11:10:01+09:00' })).run;
    expect(res(r, 'P4').details.map((d) => d.subject).sort()).toEqual([late, waiting].sort());
  });

  it('P3 P-T36 ④_입금 오류로 되돌린 뒤 다시 들어온 승인은 마지막 입금 대기 뒤의 사건만 본다', async () => {
    const missing = await order({ status: 'AWAITING_DEPOSIT' });
    await payment({ orderId: missing, approvedAt: '2026-11-02T11:00:00+09:00' });
    await event(missing, 1, 'APPROVED', '2026-11-02T10:00:05+09:00');
    await event(missing, 2, 'CONFIRMED', '2026-11-02T10:00:06+09:00');
    await event(missing, 3, 'AWAITING_DEPOSIT', '2026-11-02T10:30:00+09:00');
    const ok = await order();
    await payment({ orderId: ok, approvedAt: '2026-11-02T11:00:00+09:00' });
    await event(ok, 1, 'APPROVED', '2026-11-02T10:00:05+09:00');
    await event(ok, 2, 'CONFIRMED', '2026-11-02T10:00:06+09:00');
    await event(ok, 3, 'AWAITING_DEPOSIT', '2026-11-02T10:30:00+09:00');
    await event(ok, 4, 'APPROVED', '2026-11-02T11:00:05+09:00');
    const r = (await check({ asOf: '2026-11-02T11:02:00+09:00' })).run;
    expect(res(r, 'P3').details.map((d) => d.subject)).toEqual([missing]);
  });

  it('P4 P-T36 ④_다시 들어온 승인의 발권 기한은 첫 CONFIRMED로 덮이지 않는다', async () => {
    const stuck = await order({ status: 'APPROVED' });
    await payment({ orderId: stuck, approvedAt: '2026-11-02T11:00:00+09:00' });
    await event(stuck, 1, 'APPROVED', '2026-11-02T10:00:05+09:00');
    await event(stuck, 2, 'CONFIRMED', '2026-11-02T10:00:06+09:00');
    await event(stuck, 3, 'AWAITING_DEPOSIT', '2026-11-02T10:30:00+09:00');
    await event(stuck, 4, 'APPROVED', '2026-11-02T11:00:05+09:00');
    const done = await order();
    await payment({ orderId: done, approvedAt: '2026-11-02T11:00:00+09:00' });
    await event(done, 1, 'APPROVED', '2026-11-02T10:00:05+09:00');
    await event(done, 2, 'CONFIRMED', '2026-11-02T10:00:06+09:00');
    await event(done, 3, 'AWAITING_DEPOSIT', '2026-11-02T10:30:00+09:00');
    await event(done, 4, 'APPROVED', '2026-11-02T11:00:05+09:00');
    await event(done, 5, 'CONFIRMED', '2026-11-02T11:10:00+09:00');
    const r = (await check({ asOf: '2026-11-02T11:40:00+09:00' })).run;
    expect(res(r, 'P4').details.map((d) => d.subject)).toEqual([stuck]);
  });

  it('P5 살아 있는 승인이 없는 유효 티켓(결제 취소, 주문 없음, 환불된 취소)', async () => {
    const mk = async (payStatus: string) => {
      const o = await order();
      await payment({ orderId: o, status: payStatus });
      const t = randomUUID();
      await ins('purchase', 'order_item', { order_id: o, line_no: 1, seat_id: randomUUID(), ticket_id: t });
      await ins('ticket', 'ticket', { id: t, account_id: randomUUID(), payer_account_id: randomUUID(), event_id: EVENT, seat_id: randomUUID(), status: 'ACTIVE' });
      return { o, t };
    };
    await mk('APPROVED');
    const partial = await mk('PARTIAL_CANCELED');
    const voided = await mk('CANCELED');
    // 환불된 티켓은 유효 티켓이 아니라 세지 않는다
    await ins('ticket', 'ticket', { id: randomUUID(), account_id: randomUUID(), payer_account_id: randomUUID(), event_id: EVENT, seat_id: randomUUID(), status: 'REFUNDED' });
    expect(res((await check()).run, 'P5').details.map((d) => d.subject)).toEqual([voided.t]);
    const orphan = randomUUID();
    await ins('ticket', 'ticket', { id: orphan, account_id: randomUUID(), payer_account_id: randomUUID(), event_id: EVENT, seat_id: randomUUID(), status: 'ISSUED' });
    await ins('purchase', 'order_cancellation', { id: randomUUID(), order_id: partial.o, ticket_id: partial.t, status: 'REFUNDED' });
    expect(res((await check()).run, 'P5').details.map((d) => d.subject).sort()).toEqual([voided.t, orphan, partial.t].sort());
  });

  it('P6 결제사가 승인했는데 결제 원장이 모르는 결제(승인 뒤 60초가 지난 것만)', async () => {
    const known = await order();
    await payment({ orderId: known });
    const records = emptyRecords();
    const charge = (ref: string, approved: string, canceled = 0) => ({ pg: 'SIMULATOR' as const, payment_ref: `tsim_${ref.slice(0, 8)}`, order_ref: ref, amount: 10_000, status: 'DONE', approved_at: approved, canceled_amount: canceled });
    const lost = randomUUID();
    const recent = randomUUID();
    records.pg_charge.push(charge(known, '2026-11-02T10:00:00+09:00'), charge(lost, '2026-11-02T10:00:00+09:00'), charge(recent, '2026-11-02T10:59:30+09:00'), charge(randomUUID(), '2026-11-02T10:00:00+09:00', 10_000));
    expect(res((await check({ records })).run, 'P6').details.map((d) => d.subject)).toEqual([`SIMULATOR:tsim_${lost.slice(0, 8)}`]);
  });
});

describe('정산 돈 불변식(J-T25, settlement §13)', () => {
  const PROMOTER = randomUUID();
  /** J-T1 정산서: 판매 3,000만 원(승인 3건), 환급 200만 원, 수수료 280만 원, 부가세 28만 원, 지급액 2,492만 원 */
  async function jt25() {
    const st = randomUUID();
    const pays: string[] = [];
    for (const amount of [10_000_000, 12_000_000, 8_000_000]) {
      const p = await payment({ orderId: await order({ amount }), amount, approvedAt: '2026-11-02T08:30:00+09:00' });
      pays.push(p);
      await ins('payment', 'statement_source', { statement_id: st, source_id: p, kind: 'GROSS', payment_id: p, amount });
    }
    const cancel = randomUUID();
    await ins('payment', 'payment_cancel', { id: cancel, payment_id: pays[2], amount: 2_000_000, status: 'CANCELED', canceled_at: '2026-11-02T09:00:00+09:00' });
    await ins('payment', 'statement_source', { statement_id: st, source_id: cancel, kind: 'REFUND', payment_id: pays[2], amount: 2_000_000 });
    // 승인 시각은 KST 11월 2일 08:30(UTC로는 11월 1일 23:30). 대사 날짜는 KST라 11월 2일 대사가 DONE이어야 한다
    await ins('payment', 'reconciliation_run', { id: randomUUID(), pg: 'SIMULATOR', recon_date: '2026-11-02', status: 'DONE' });
    await ins('payment', 'reconciliation_run', { id: randomUUID(), pg: 'SIMULATOR', recon_date: '2026-11-01', status: 'FAILED' });
    await ins('payment', 'settlement_statement', {
      id: st, promoter_id: PROMOTER, kind: 'EVENT', event_id: EVENT, pg: 'SIMULATOR', gross_amount: 30_000_000, refund_amount: 2_000_000,
      commission_amount: 2_800_000, commission_vat: 280_000, offset_amount: 0, payout_amount: 24_920_000, revision: 1, status: 'PAID',
    });
    await ins('payment', 'payout', { id: randomUUID(), statement_id: st, seq: 1, amount: 10_000_000, ref_payout_id: `${st}-1`, status: 'COMPLETED' });
    await ins('payment', 'payout', { id: randomUUID(), statement_id: st, seq: 2, amount: 14_920_000, ref_payout_id: `${st}-2`, status: 'COMPLETED' });
    await ins('payment', 'payout', { id: randomUUID(), statement_id: st, seq: 3, amount: 5_000_000, ref_payout_id: `${st}-3`, status: 'FAILED' });
    // J-T24: 미수금 100만 원을 30만·70만 원으로 상계하고 70만 원을 되돌렸다 → 남은 금액 70만 원
    const rcv = randomUUID();
    await ins('payment', 'partner_receivable', { id: rcv, promoter_id: PROMOTER, cause: 'REFUND_AFTER_PAYOUT', pg: 'SIMULATOR', amount: 1_000_000, remaining: 700_000, status: 'OPEN' });
    const m2 = randomUUID();
    await ins('payment', 'receivable_movement', { id: randomUUID(), receivable_id: rcv, statement_id: randomUUID(), kind: 'OFFSET', amount: 300_000 });
    await ins('payment', 'receivable_movement', { id: m2, receivable_id: rcv, statement_id: randomUUID(), kind: 'OFFSET', amount: 700_000 });
    await ins('payment', 'receivable_movement', { id: randomUUID(), receivable_id: rcv, kind: 'REVERSAL', amount: 700_000, reverses_id: m2 });
    return { st, pays, cancel, rcv };
  }
  const settle = async () => (await check()).run.results.filter((r) => r.id.startsWith('M'));

  it('J-T25 시험 데이터에서 다섯 불변식이 모두 0건이다', async () => {
    await jt25();
    expect((await settle()).map((r) => [r.id, r.violations])).toEqual([['M1', 0], ['M2', 0], ['M3', 0], ['M4', 0], ['M5', 0]]);
  });

  it('원본 연결의 날짜 표기 설정(DateStyle)이 ISO가 아니어도 날짜·시각을 똑같이 읽는다(새 맥락 리뷰 2)', async () => {
    await jt25();
    await db.payment!.query("SET DateStyle = 'SQL, DMY'");
    await db.purchase!.query("SET DateStyle = 'German'");
    try {
      expect((await settle()).map((r) => [r.id, r.violations])).toEqual([['M1', 0], ['M2', 0], ['M3', 0], ['M4', 0], ['M5', 0]]);
    } finally {
      await db.payment!.query('RESET DateStyle');
      await db.purchase!.query('RESET DateStyle');
    }
  });

  it('M1 PAID 정산서의 완료 지급 합이 지급액과 다르다', async () => {
    const { st } = await jt25();
    await db.payment!.query("UPDATE payout SET status = 'FAILED' WHERE statement_id = $1 AND seq = 2", [st]);
    expect(res((await check()).run, 'M1')).toMatchObject({ violations: 1, details: [{ subject: st, detail: 'payout_amount=24920000 completed=10000000' }] });
  });

  it('M2 지급 건(실패·취소 제외) 합이 지급액보다 크다', async () => {
    const { st } = await jt25();
    await db.payment!.query("UPDATE payout SET status = 'REQUESTED' WHERE statement_id = $1 AND seq = 3", [st]);
    expect(res((await check()).run, 'M2').violations).toBe(1);
  });

  it('M3 되돌림을 빼지 않은 남은 금액, 음수 남은 금액', async () => {
    const { rcv } = await jt25();
    await db.payment!.query('UPDATE partner_receivable SET remaining = 0 WHERE id = $1', [rcv]);
    expect(res((await check()).run, 'M3')).toMatchObject({ violations: 1, details: [{ subject: rcv, detail: 'amount=1000000 remaining=0 moved=300000' }] });
    const neg = randomUUID();
    await ins('payment', 'partner_receivable', { id: neg, promoter_id: PROMOTER, cause: 'CHARGEBACK', amount: 100, remaining: -50, status: 'OPEN' });
    await ins('payment', 'receivable_movement', { id: randomUUID(), receivable_id: neg, kind: 'OFFSET', amount: 150 });
    expect(res((await check()).run, 'M3').violations).toBe(2);
  });

  it('M4 한 환급이 SUPERSEDED가 아닌 정산서 둘에 들어갔다', async () => {
    const { pays, cancel } = await jt25();
    const v2 = randomUUID();
    await ins('payment', 'settlement_statement', {
      id: v2, promoter_id: PROMOTER, kind: 'EVENT', event_id: EVENT, pg: 'SIMULATOR', gross_amount: 0, refund_amount: 2_000_000,
      commission_amount: 0, commission_vat: 0, offset_amount: 0, payout_amount: 0, revision: 2, status: 'SUPERSEDED',
    });
    await ins('payment', 'statement_source', { statement_id: v2, source_id: cancel, kind: 'REFUND', payment_id: pays[2], amount: 2_000_000 });
    expect(res((await check()).run, 'M4').violations).toBe(0);
    await db.payment!.query("UPDATE settlement_statement SET status = 'CALCULATED' WHERE id = $1", [v2]);
    expect(res((await check()).run, 'M4')).toMatchObject({ violations: 1, details: [{ subject: cancel }] });
  });

  it('M5 판매 대금 ≠ 쓴 승인 합, 대사가 끝나지 않은 날, 뺀 결제 목록에 든 결제, 다른 회차의 결제', async () => {
    const { st, pays } = await jt25();
    await db.payment!.query("UPDATE reconciliation_run SET status = 'RUNNING' WHERE recon_date = '2026-11-02'");
    expect(res((await check()).run, 'M5').details.map((d) => d.detail)).toEqual(['not_reconciled', 'not_reconciled', 'not_reconciled']);
    await db.payment!.query("UPDATE reconciliation_run SET status = 'DONE' WHERE recon_date = '2026-11-02'");
    await db.payment!.query('UPDATE settlement_statement SET gross_amount = 29000000, excluded_payments = $2::jsonb WHERE id = $1', [st, JSON.stringify([pays[0]])]);
    const other = await payment({ orderId: await order(), event: randomUUID(), approvedAt: '2026-11-02T12:00:00+09:00', amount: 500 });
    await ins('payment', 'statement_source', { statement_id: st, source_id: other, kind: 'GROSS', payment_id: other, amount: 500 });
    const r = res((await check()).run, 'M5');
    expect(r.details).toEqual(
      expect.arrayContaining([
        { subject: st, detail: 'gross_amount=29000000 sources=30000500' },
        { subject: `${st}:${pays[0]}`, detail: 'excluded' },
        { subject: `${st}:${other}`, detail: 'other_event_or_pg' },
      ]),
    );
    expect(r.violations).toBe(3);
  });
});

describe('시각 기준', () => {
  it('as_of는 주입한 시계다', async () => {
    const { run } = await check({ asOf: '2026-11-02T01:00:00Z' });
    expect(run.asOf).toBe(Date.parse('2026-11-02T10:00:00+09:00'));
  });
});
