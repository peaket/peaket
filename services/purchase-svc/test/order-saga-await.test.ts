// 승인 명령 접수 뒤의 Saga 작업 행(BUILD_ORDER PRF-171 설계 1·2, docs/features/payment.md §2 'Saga 1단계의 첫 구현' 단계 CONFIRM·
// '결제 결과 당기기의 첫 구현' 결과를 기다리는 주문 찾기·Saga 실행기와 갈림, docs/data.md order_saga_job·§5.1, ADR-0140)를 DB 없이 본다.
// DrizzleSaga(adapters/db/drizzle-saga.ts)가 내는 SQL을 적는 Database 대역으로:
// - done(ConfirmSent): 작업 행을 지우지 않고 한 트랜잭션에서 step = 'AWAIT'(CONFIRM 행·자기 임대 조건, confirm_sent_at은 그대로) → 결제 참조 지우기
// - claimDue·claim(SagaJobs): Saga 실행기의 잡기가 AWAIT 행을 고르지 않는다(AWAIT 행은 결과 당기기가 고른다)
// SQL 모양은 몇 가지 쓰는 법(step <> 'AWAIT'·step not in ('AWAIT')·step in (RESERVE·CONFIRM·RELEASE))을 받아 준다.
// 실제 PostgreSQL에서 접수 뒤 행이 AWAIT로 남고 Saga 잡기가 고르지 않는지는 test-int/payment-pull.int.test.ts(다른 담당)가 본다.
import { fakeClock, type Database, type TransactionOptions } from '@peaket/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { DrizzleSaga, SAGA_STATEMENT_TIMEOUT_MS } from '../src/modules/booking/index.js';
import { ORDER_ID } from './accept-cases.js';
import { NOW } from './order-cases.js';

const dialect = new PgDialect();
/** 집은 작업의 임대 끝(지금 + 30초) */
const LEASE = NOW + 30_000;
const LEASE_ISO = new Date(LEASE).toISOString().toLowerCase();
const clock = fakeClock({ now: NOW });

/** SQL 글에 매개변수를 따옴표로 넣고(날짜는 ISO) 공백을 접어 소문자로 만든다(견주기용) */
function textOf(q: SQL): string {
  const { sql: text, params } = dialect.sqlToQuery(q);
  return text
    .replace(/\$(\d+)/g, (_m, n: string) => {
      const v = params[Number(n) - 1];
      if (v instanceof Date) return `'${v.toISOString()}'`;
      if (typeof v === 'string') return `'${v}'`;
      return String(v);
    })
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 실행한 문장을 적고 rowsFor의 행을 돌려주는 Database 대역(트랜잭션은 같은 대역에서 바로 돈다) */
function recordingDb(rowsFor: (text: string) => unknown[] = () => []) {
  const statements: string[] = [];
  const txOptions: (TransactionOptions | undefined)[] = [];
  const execute = async (q: SQL) => {
    const text = textOf(q);
    statements.push(text);
    return { rows: rowsFor(text) };
  };
  const database = {
    db: { execute },
    pool: undefined,
    close: async () => {},
    transaction: async (fn: (tx: unknown) => Promise<unknown>, o?: TransactionOptions) => {
      txOptions.push(o);
      return fn({ execute });
    },
  } as unknown as Database;
  return { database, statements, txOptions };
}

const sagaOf = (database: Database) => new DrizzleSaga({ database, store: {} as never, sales: {} as never, clock });

/** 작업 행을 지우는 문장 */
const DELETE_JOB = /\bdelete from order_saga_job\b/;
/** 작업 행을 바꾸는 문장 */
const UPDATE_JOB = /^update order_saga_job\b/;
/** 결제 참조를 지우는 문장 */
const CLEAR_REFS = /^update payment_attempt set pg_payment_key = null, pg_tx_id = null, pg_payment_token = null\b/;

/** 문장이 AWAIT 행을 빼는가(쓰는 법 몇 가지를 받아 준다) */
function excludesAwait(s: string): boolean {
  if (/\bstep\s*(<>|!=)\s*'await'/.test(s)) return true;
  if (/\bstep\s+not\s+in\s*\(\s*'await'\s*\)/.test(s)) return true;
  const inList = /\bstep\s+in\s*\(([^)]*)\)/.exec(s);
  if (inList) {
    const values = [...inList[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    return values.length > 0 && !values.includes('await') && values.every((v) => ['reserve', 'confirm', 'release'].includes(v!));
  }
  return false;
}

describe('ConfirmSent.done: 승인 명령 접수 뒤 작업 행 AWAIT(설계 1)', () => {
  test('승인 명령이 접수되면 한 트랜잭션(READ COMMITTED·5초)에서 작업 행을 지우지 않고 step = AWAIT로 바꾸고(CONFIRM 행·자기 임대 조건, confirm_sent_at은 그대로) 결제 참조를 지운다. 바꿨으면 true (P-T47, ADR0140) [ASVS v5.0.0-2.3.3]', async () => {
    const { database, statements, txOptions } = recordingDb((t) => (UPDATE_JOB.test(t) ? [{ order_id: ORDER_ID }] : []));
    expect(await sagaOf(database).done(ORDER_ID, LEASE)).toBe(true);
    expect(txOptions).toEqual([{ isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS }]);
    expect(statements.filter((s) => DELETE_JOB.test(s)), statements.join('\n')).toEqual([]);
    const i = statements.findIndex((s) => UPDATE_JOB.test(s));
    expect(i, statements.join('\n')).toBeGreaterThanOrEqual(0);
    const job = statements[i]!;
    const [setPart, wherePart = ''] = job.split(/ where /);
    expect(setPart).toMatch(/\bstep\s*=\s*'await'/);
    // 보낸 시각은 그대로 둔다(당기기가 '접수 뒤 5초'·'기록 없음 10분'을 이 값으로 잰다)
    expect(setPart).not.toMatch(/confirm_sent_at\s*=/);
    expect(wherePart).toContain(`order_id = '${ORDER_ID}'`);
    expect(wherePart).toMatch(/\bstep\s*=\s*'confirm'/);
    expect(wherePart).toContain(`lease_until = '${LEASE_ISO}'`);
    // 잠금 차례 작업 행 → 결제 시도 행(결제 키·거래 ID·토큰을 지운다. 5년 보관은 payment-svc 결제 원장)
    const refs = statements.findIndex((s) => CLEAR_REFS.test(s));
    expect(refs, statements.join('\n')).toBeGreaterThan(i);
  });

  test('그 주문의 CONFIRM 행이 없으면(0행: 다른 실행이 먼저 끝냈거나 결과 반영이 지웠다) false이고 결제 참조를 지우지 않으며 작업 행을 지우는 문도 없다 (ADR0140) [ASVS v5.0.0-2.3.3]', async () => {
    const { database, statements } = recordingDb(() => []);
    expect(await sagaOf(database).done(ORDER_ID, LEASE)).toBe(false);
    expect(statements.filter((s) => CLEAR_REFS.test(s))).toEqual([]);
    expect(statements.filter((s) => DELETE_JOB.test(s))).toEqual([]);
    expect(statements.filter((s) => UPDATE_JOB.test(s)), statements.join('\n')).toHaveLength(1);
  });

  test('자기 임대를 주지 않으면(손질·시험) 임대 조건 없이 CONFIRM 행만 바꾼다', async () => {
    const { database, statements } = recordingDb((t) => (UPDATE_JOB.test(t) ? [{ order_id: ORDER_ID }] : []));
    expect(await sagaOf(database).done(ORDER_ID)).toBe(true);
    const job = statements.find((s) => UPDATE_JOB.test(s))!;
    expect(job).toMatch(/\bstep\s*=\s*'await'/);
    expect(job.split(/ where /)[1]).not.toContain('lease_until');
  });
});

describe('SagaJobs 잡기: Saga 실행기는 AWAIT 행을 고르지 않는다(설계 2)', () => {
  test('claimDue의 고르기(FOR UPDATE SKIP LOCKED)는 AWAIT 행을 뺀다(AWAIT 행은 결과 당기기가 고른다). 기한·임대 조건은 그대로다 (ADR0140) [ASVS v5.0.0-2.3.4]', async () => {
    const { database, statements } = recordingDb();
    expect(await sagaOf(database).claimDue(50, 30_000)).toEqual([]);
    const pick = statements.find((s) => /for update skip locked/.test(s));
    expect(pick, statements.join('\n')).toBeDefined();
    expect(excludesAwait(pick!), pick).toBe(true);
    expect(pick).toMatch(/next_attempt_at <= '/);
    expect(pick).toMatch(/lease_until is null or lease_until <= '/);
  });

  test('claim(접수 직후 kick이 쓰는 한 주문 집기)도 AWAIT 행을 고르지 않는다(접수 뒤 kick·runOne이 승인 명령을 다시 보내지 않게) (ADR0140) [ASVS v5.0.0-2.3.4]', async () => {
    const { database, statements } = recordingDb();
    expect(await sagaOf(database).claim(ORDER_ID, 30_000)).toBeUndefined();
    const pick = statements.find((s) => /for update skip locked/.test(s));
    expect(pick, statements.join('\n')).toBeDefined();
    expect(excludesAwait(pick!), pick).toBe(true);
    expect(pick).toContain(`order_id = '${ORDER_ID}'`);
  });

  test('시험 도구 확인: AWAIT를 빼는 쓰는 법 몇 가지는 받고, 빼지 않는 고르기는 받지 않는다', () => {
    expect(excludesAwait("where step <> 'await' and next_attempt_at <= now()")).toBe(true);
    expect(excludesAwait("where j.step != 'await'")).toBe(true);
    expect(excludesAwait("where step not in ('await')")).toBe(true);
    expect(excludesAwait("where step in ('reserve', 'confirm', 'release')")).toBe(true);
    expect(excludesAwait("where step in ('confirm', 'await')")).toBe(false);
    expect(excludesAwait('where next_attempt_at <= now() and (lease_until is null or lease_until <= now())')).toBe(false);
  });
});
