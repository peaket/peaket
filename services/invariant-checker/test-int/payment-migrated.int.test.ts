// 불변식 검사기를 payment-svc 마이그레이션을 모두 적용한 실제 payment DB에 붙여 본다(docs/verification.md §2.5 '건너뜀(SKIPPED)을 드러내기', FIX-invariant-m3).
// 손으로 만든 표(postgres.ts SCHEMA)는 정본 이름으로 만들어 마이그레이션과 검사기의 표 이름 차이를 못 봤다(payment 0016 receivable_move → M3가 실제 DB에서 늘 SKIPPED).
// 그래서 이 파일은 빈 DB에 payment-svc의 마이그레이터(services/payment-svc/scripts/migrate.mjs, bundle·purchase-svc 통합 시험과 같은 것)를 돌린 표만 쓴다.
// 시험 ID는 정본 M3 시나리오 J-T24(docs/features/settlement.md §13: 남은 금액이 늘 '금액 − 이동 기록 합'과 같다)다. 계획의 'J-T25 M3 ①~⑤'와의 대응은 계획 파일 '시험 결과'에 있다.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli-main.js';
import { emptyRecords } from '../src/records.js';
import { runInvariantChecks, type CheckRun } from '../src/run.js';
import { SOURCE_TABLES } from '../src/tables.js';
import { startPostgres, type PostgresServer } from './postgres.js';

let server: PostgresServer;
let migrated: pg.Client;

beforeAll(async () => {
  server = await startPostgres();
  // 의존 선언 밖 상대 경로 가져오기(CLAUDE.md '큰 그림'): 검사기는 payment-svc에 기대지 않으므로 시험에서만 마이그레이터를 부른다.
  // 경로 글로 부르는 동적 가져오기라 반환 모양을 여기서 적는다(같은 파일 invariants.int.test.ts의 loadtest 가져오기와 같은 방식)
  const { migratePayment } = (await import(new URL('../../payment-svc/scripts/migrate.mjs', import.meta.url).href)) as { migratePayment: (url: string) => Promise<void> };
  await migratePayment(server.url('payment_migrated'));
  migrated = new pg.Client({ connectionString: server.url('payment_migrated') });
  migrated.on('error', () => {});
  await migrated.connect();
});
afterAll(async () => {
  await migrated?.end().catch(() => {});
  server?.stop();
});
// 시험마다 이 파일이 넣는 행만 지운다(외래 키 차례: 이동 기록 → 미수금 → 정산서). 다른 payment 표는 이 파일이 쓰지 않아 비어 있다
beforeEach(async () => {
  await migrated.query('delete from receivable_movement');
  await migrated.query('delete from partner_receivable');
  await migrated.query('delete from settlement_statement');
});

async function ins(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  await migrated.query(`insert into ${table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => row[k]));
}

const NOW = '2026-11-23T09:00:00+09:00';
/** 정산서 한 판(정본 칸과 not null을 지킨다). 지급 전(CONFIRMED)·판매 대금 0이라 M1·M2·M4·M5는 위반이 아니다 */
async function statement(promoterId: string) {
  const id = randomUUID();
  await ins('settlement_statement', {
    id, promoter_id: promoterId, kind: 'EVENT', event_id: randomUUID(), pg: 'TOSS', pg_store: 'STANDARD',
    gross_amount: 0, refund_amount: 0, commission_amount: 0, commission_vat: 0, payout_amount: 0, status: 'CONFIRMED', payout_date: '2026-11-27', created_at: NOW, updated_at: NOW,
  });
  return id;
}

/**
 * J-T24의 금액: 미수금 100만 원을 정산서 A에서 30만 원 상계, B의 보증 충당 20만 원, B에서 50만 원 상계 뒤 그 50만 원을 되돌림(B 지급 실패).
 * 이동 기록 합 = 30 + 20 + 50 − 50 = 50만 원이라 남은 금액은 50만 원이다. 넣기는 정본 이름 표(receivable_movement)로 한다
 */
async function seedJT24() {
  const promoter = randomUUID();
  const a = await statement(promoter);
  const b = await statement(promoter);
  const rcv = randomUUID();
  await ins('partner_receivable', { id: rcv, promoter_id: promoter, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 1_000_000, remaining: 500_000, status: 'OPEN', created_at: NOW, updated_at: NOW });
  await ins('receivable_movement', { receivable_id: rcv, statement_id: a, kind: 'OFFSET', amount: 300_000, moved_at: NOW });
  await ins('receivable_movement', { receivable_id: rcv, statement_id: b, kind: 'GUARANTEE', amount: 200_000, moved_at: NOW });
  await ins('receivable_movement', { receivable_id: rcv, statement_id: b, kind: 'OFFSET', amount: 500_000, moved_at: NOW });
  await ins('receivable_movement', { receivable_id: rcv, statement_id: b, kind: 'REVERSAL', amount: 500_000, moved_at: NOW });
  return { rcv };
}

/** payment 원본만 준 검사(검사 연결은 bare, 원본 연결은 따로 연다) */
async function checkPayment(o: { payment?: 'payment_migrated' | 'bare' } = {}): Promise<CheckRun> {
  const check = new pg.Client({ connectionString: server.url('bare') });
  const src = new pg.Client({ connectionString: server.url(o.payment ?? 'payment_migrated') });
  for (const c of [check, src]) {
    c.on('error', () => {});
    await c.connect();
  }
  try {
    return await runInvariantChecks({ check, sources: { payment: src }, records: emptyRecords(), clock: { now: () => Date.parse(NOW) } });
  } finally {
    await check.end();
    await src.end();
  }
}
const verdicts = (run: CheckRun) => run.results.map((r) => [r.id, r.result, r.violations]);

describe('실제 payment 마이그레이션 DB에서 검사기의 표 목록(docs/verification.md §2.5)', () => {
  it('J-T24 ① M3 검사기가 읽는 payment 표 아홉이 마이그레이션을 모두 적용한 DB에 표로 있고, payment 원본만 주면 P1·P6·M1~M5가 SKIPPED 없이 세어지며 표가 없어 건너뛴 불변식이 없다', async () => {
    // 검사기 표 목록(tables.ts)의 payment 몫이 docs/data.md ERD의 표 이름 아홉이다. 이 목록이 비면 아래 확인이 0번 돌므로 목록부터 못 박는다
    const paymentTables = SOURCE_TABLES.filter((t) => t.source === 'payment').map((t) => t.name);
    expect(paymentTables).toEqual(['payment', 'payment_event', 'payment_cancel', 'settlement_statement', 'statement_source', 'payout', 'partner_receivable', 'receivable_movement', 'reconciliation_run']);
    const kinds = await migrated.query<{ relname: string; relkind: string }>(
      "select relname, relkind from pg_class where relnamespace = 'public'::regnamespace and relname = any($1) order by relname",
      [paymentTables],
    );
    // 아홉 모두 실제 표(relkind r)다. 옛 이름 뷰 receivable_move(0028)가 아니라 표 receivable_movement를 읽는다
    expect(kinds.rows).toEqual([...paymentTables].sort().map((relname) => ({ relname, relkind: 'r' })));
    const run = await checkPayment();
    expect(verdicts(run)).toEqual([
      ['Q1', 'PASS', 0],
      ['Q2', 'PASS', 0],
      ['S1', 'SKIPPED', 0],
      ['S2', 'SKIPPED', 0],
      ['S3', 'SKIPPED', 0],
      ['S4', 'SKIPPED', 0],
      ['P1', 'PASS', 0],
      ['P2', 'PASS', 0],
      ['P3', 'SKIPPED', 0],
      ['P4', 'SKIPPED', 0],
      ['P5', 'SKIPPED', 0],
      ['P6', 'PASS', 0],
      ['M1', 'PASS', 0],
      ['M2', 'PASS', 0],
      ['M3', 'PASS', 0],
      ['M4', 'PASS', 0],
      ['M5', 'PASS', 0],
    ]);
    // 건너뛴 것은 모두 원본(purchase·ticket)을 주지 않아서다. 붙은 payment 원본에 표가 없어 건너뛴 것은 없다
    expect(run.results.filter((r) => r.result === 'SKIPPED').map((r) => [r.id, r.skip])).toEqual([
      ['S1', { kind: 'source', names: ['purchase'] }],
      ['S2', { kind: 'source', names: ['purchase'] }],
      ['S3', { kind: 'source', names: ['ticket'] }],
      ['S4', { kind: 'source', names: ['purchase'] }],
      ['P3', { kind: 'source', names: ['purchase'] }],
      ['P4', { kind: 'source', names: ['purchase'] }],
      ['P5', { kind: 'source', names: ['purchase', 'ticket'] }],
    ]);
  });

  it('J-T24 ② M3 실제 스키마에 상계·보증 충당·상계·되돌림을 넣고 남은 금액이 금액 − 이동 기록 합(50만 원)이면 0건이고, 남은 금액을 0으로 틀리게 두면 그 미수금 1건이 위반이다', async () => {
    const { rcv } = await seedJT24();
    let run = await checkPayment();
    expect(run.results.find((r) => r.id === 'M3')).toMatchObject({ result: 'PASS', violations: 0, details: [] });
    // 다른 정산 불변식도 이 데이터에서 위반이 없다(M3만 깨는 데이터를 만들기 위한 바탕)
    expect(verdicts(run).filter(([id]) => String(id).startsWith('M'))).toEqual([['M1', 'PASS', 0], ['M2', 'PASS', 0], ['M3', 'PASS', 0], ['M4', 'PASS', 0], ['M5', 'PASS', 0]]);
    await migrated.query('update partner_receivable set remaining = 0 where id = $1', [rcv]);
    run = await checkPayment();
    expect(run.results.find((r) => r.id === 'M3')).toMatchObject({ result: 'FAIL', violations: 1, details: [{ subject: rcv, detail: 'amount=1000000 remaining=0 moved=500000' }] });
    // 하나만 깼으니 다른 불변식은 그대로다
    expect(run.results.filter((r) => r.result === 'FAIL').map((r) => r.id)).toEqual(['M3']);
  });
});

describe('명령 경계 runCli(표준 출력·표준 오류·끝 코드·결과 파일, docs/verification.md §2.5)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  async function cli(payment: 'payment_migrated' | 'bare') {
    const out = mkdtempSync(join(tmpdir(), 'peaket-inv-m3-'));
    dirs.push(out);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(['--out', out], { INVARIANT_CHECK_DB_URL: server.url('bare'), INVARIANT_PAYMENT_DB_URL: server.url(payment) }, { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) });
    const csv = readFileSync(join(out, 'invariants.csv'), 'utf8').trim().split('\n');
    /** invariants.csv 한 줄에서 id·violations·result(이름 칸은 보지 않는다) */
    const row = (id: string) => {
      const c = csv.find((l) => l.startsWith(`${id},`))!.split(',');
      return { id: c[0], violations: c[c.length - 4], result: c[c.length - 2] };
    };
    return { code, out: stdout.join(''), err: stderr.join(''), csv, row };
  }
  const warn = (id: string, names: string) => `경고: ${id} 원본(payment)에 붙었는데 표가 없다: ${names} — 기능이 아직 없거나 표 이름이 docs/data.md와 다르다`;
  const SOURCE_SKIPS =
    'Q1(시험 기록 없음), Q2(시험 기록 없음), S1(원본 없음: purchase), S2(원본 없음: purchase), S3(원본 없음: ticket), S4(원본 없음: purchase), P2(시험 기록 없음), P3(원본 없음: purchase), P4(원본 없음: purchase), P5(원본 없음: purchase, ticket), P6(시험 기록 없음)';

  it('J-T24 ⑤ M3 payment만 준 실행은 불변식마다 한 줄 뒤 끝 줄이 요약이고(M3는 세어져 SKIPPED에 없다) 표준 오류가 비며 SKIPPED만 있어도 끝 코드 0이다', async () => {
    await seedJT24();
    const r = await cli('payment_migrated');
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    // 불변식 17줄 + 요약 1줄, 글 끝은 줄바꿈
    expect(lines).toHaveLength(19);
    expect(lines.at(-1)).toBe('');
    expect(lines[14]).toBe('M3 PASS violations=0');
    expect(lines[17]).toBe(`요약: PASS 6 · FAIL 0 · SKIPPED 11 — ${SOURCE_SKIPS}`);
    expect(r.err).toBe('');
    expect(r.csv).toHaveLength(18);
    expect(r.row('M3')).toEqual({ id: 'M3', violations: '0', result: 'PASS' });
  });

  it('J-T24 ⑤ M3 payment 원본으로 표가 없는 DB를 주면 표준 오류에 표 없는 불변식(P1·M1~M5)마다 경고 한 줄이 나고 끝 코드는 0이다', async () => {
    const r = await cli('bare');
    expect(r.code).toBe(0);
    expect(r.err.split('\n')).toEqual([
      warn('P1', 'payment'),
      warn('M1', 'settlement_statement, payout'),
      warn('M2', 'settlement_statement, payout'),
      warn('M3', 'partner_receivable, receivable_movement'),
      warn('M4', 'settlement_statement, statement_source'),
      warn('M5', 'settlement_statement, statement_source, payment, reconciliation_run'),
      '',
    ]);
    // 경고는 표준 출력에 섞이지 않는다. 요약은 표준 출력 끝 줄이다
    expect(r.out).not.toContain('경고:');
    const lines = r.out.trimEnd().split('\n');
    expect(lines).toHaveLength(18);
    expect(lines.at(-1)).toBe(
      `요약: PASS 0 · FAIL 0 · SKIPPED 17 — Q1(시험 기록 없음), Q2(시험 기록 없음), S1(원본 없음: purchase), S2(원본 없음: purchase), S3(원본 없음: ticket), S4(원본 없음: purchase), P1(원본에 표 없음: payment), P2(시험 기록 없음), P3(원본 없음: purchase), P4(원본 없음: purchase), P5(원본 없음: purchase, ticket), P6(시험 기록 없음), M1(원본에 표 없음: settlement_statement, payout), M2(원본에 표 없음: settlement_statement, payout), M3(원본에 표 없음: partner_receivable, receivable_movement), M4(원본에 표 없음: settlement_statement, statement_source), M5(원본에 표 없음: settlement_statement, statement_source, payment, reconciliation_run)`,
    );
    expect(r.row('M3')).toEqual({ id: 'M3', violations: '', result: 'SKIPPED' });
  });

  it('J-T24 ⑤ M3 실제 payment DB의 미수금 남은 금액을 틀리게 둔 실행은 끝 코드 1이고 요약에 FAIL 1이 적히며 결과 파일에 M3 FAIL이 남는다', async () => {
    const { rcv } = await seedJT24();
    await migrated.query('update partner_receivable set remaining = 0 where id = $1', [rcv]);
    const r = await cli('payment_migrated');
    expect(r.code).toBe(1);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[14]).toBe('M3 FAIL violations=1');
    expect(lines.at(-1)).toBe(`요약: PASS 5 · FAIL 1 · SKIPPED 11 — ${SOURCE_SKIPS}`);
    expect(r.err).toBe('');
    expect(r.row('M3')).toEqual({ id: 'M3', violations: '1', result: 'FAIL' });
  });
});
