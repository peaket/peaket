// 저장소의 데드라인 처리(docs/api/proto/README.md §2 '데드라인', docs/features/payment.md §2 '승인 명령 접수의 첫 구현', BUILD_ORDER PRF-180 코드 리뷰 M4).
// 가짜 Database로 '연결을 받기까지 걸린 시간'을 정해 넣는다. 트랜잭션·문장 시간 한도의 실제 동작은 test-int가 본다.
import type { Database } from '@peaket/platform';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { BATCH_GET_STATEMENT_TIMEOUT_MS, CONFIRM_STATEMENT_TIMEOUT_MS, DrizzlePaymentStore } from '../src/modules/payment/adapters/db/drizzle-payment-store.js';
import { PaymentDeadlineError } from '../src/modules/payment/domain/confirm-command.js';
import { commandOf, NOW, ORDER_ID, PAYMENT_ID, rejectedBy, uuidAt } from './confirm-cases.js';

const VALUES = { paymentId: PAYMENT_ID, eventKey: uuidAt(50), nowMs: NOW };
const dialect = new PgDialect();

/** 끝까지 가면 시험이 관심 없는 곳이라 여기서 멈춘다 */
class Stop extends Error {}

/** 연결을 받기까지 waitMs가 걸리는 Database. 문장 시간 한도를 건 뒤 첫 쓰기·읽기에서 멈춘다 */
function fakeDatabase(waitMs: number) {
  const options: unknown[] = [];
  const statements: { sql: string; params: unknown[] }[] = [];
  let touched = 0;
  const stop = (): never => {
    touched += 1;
    throw new Stop();
  };
  const tx = {
    execute: async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      statements.push({ sql, params });
      return { rows: [] };
    },
    insert: stop,
    select: stop,
  };
  const database = {
    transaction: async (fn: (t: unknown) => Promise<unknown>, o?: unknown) => {
      options.push(o);
      await new Promise((r) => setTimeout(r, waitMs));
      return fn(tx);
    },
  } as unknown as Database;
  return { database, options, statements, touched: () => touched };
}

const storeOf = (d: ReturnType<typeof fakeDatabase>) => new DrizzlePaymentStore({ database: d.database, batchDatabase: d.database });
const limitOf = (d: ReturnType<typeof fakeDatabase>): number => {
  expect(d.statements, JSON.stringify(d.statements)).toHaveLength(1);
  expect(d.statements[0]!.sql).toContain("set_config('statement_timeout'");
  return Number(d.statements[0]!.params[0]);
};

describe('ConfirmPayment 트랜잭션', () => {
  test('P-T53_리뷰 고침 M4: READ COMMITTED를 직접 고른다', async () => {
    const d = fakeDatabase(0);
    await rejectedBy(storeOf(d).store(commandOf(), VALUES, { remainingMs: 5_000 }));
    expect(d.options[0]).toMatchObject({ isolationLevel: 'read committed' });
  });

  test('P-T53_리뷰 고침 M4: 남은 시간이 넉넉하면 문장 시간 한도는 상한 200ms다', async () => {
    expect(CONFIRM_STATEMENT_TIMEOUT_MS).toBe(200);
    const d = fakeDatabase(0);
    await rejectedBy(storeOf(d).store(commandOf(), VALUES, { remainingMs: 5_000 }));
    expect(limitOf(d)).toBe(200);
  });

  test('P-T53_리뷰 고침 M4: 남은 시간이 상한보다 짧으면 그 시간이 한도다', async () => {
    const d = fakeDatabase(0);
    await rejectedBy(storeOf(d).store(commandOf(), VALUES, { remainingMs: 120 }));
    expect(limitOf(d)).toBeLessThanOrEqual(120);
    expect(limitOf(d)).toBeGreaterThanOrEqual(50);
  });

  test('P-T53_리뷰 고침 M4: 남은 시간 없는 호출(시험·내부 호출)은 상한을 쓴다', async () => {
    const d = fakeDatabase(0);
    await rejectedBy(storeOf(d).store(commandOf(), VALUES));
    expect(limitOf(d)).toBe(200);
  });

  test('P-T53_리뷰 고침 M4: 연결을 기다린 시간은 남은 시간에서 뺀다', async () => {
    const d = fakeDatabase(60);
    await rejectedBy(storeOf(d).store(commandOf(), VALUES, { remainingMs: 150 }));
    expect(limitOf(d)).toBeLessThanOrEqual(95);
  });

  test('P-T53_리뷰 고침 M4: 연결을 기다리다 남은 시간이 50ms [가정] 아래로 내려가면 쓰지 않고 PaymentDeadlineError다 [ASVS v5.0.0-2.3.3]', async () => {
    const d = fakeDatabase(80);
    expect(await rejectedBy(storeOf(d).store(commandOf(), VALUES, { remainingMs: 100 }))).toBeInstanceOf(PaymentDeadlineError);
    expect(d.statements).toEqual([]);
    expect(d.touched()).toBe(0);
  });
});

describe('BatchGetPayments 트랜잭션', () => {
  test('P-T54_리뷰 고침 M4: 남은 시간이 넉넉하면 문장 시간 한도는 상한 400ms다', async () => {
    expect(BATCH_GET_STATEMENT_TIMEOUT_MS).toBe(400);
    const d = fakeDatabase(0);
    await rejectedBy(storeOf(d).batchGet([ORDER_ID], { remainingMs: 5_000 }));
    expect(limitOf(d)).toBe(400);
  });

  test('P-T54_리뷰 고침 M4: 남은 시간이 상한보다 짧으면 그 시간이 한도다', async () => {
    const d = fakeDatabase(0);
    await rejectedBy(storeOf(d).batchGet([ORDER_ID], { remainingMs: 300 }));
    expect(limitOf(d)).toBeLessThanOrEqual(300);
    expect(limitOf(d)).toBeGreaterThanOrEqual(250);
  });

  test('P-T54_리뷰 고침 M4: 연결을 기다리다 남은 시간이 모자라면 읽지 않고 PaymentDeadlineError다', async () => {
    const d = fakeDatabase(80);
    expect(await rejectedBy(storeOf(d).batchGet([ORDER_ID], { remainingMs: 100 }))).toBeInstanceOf(PaymentDeadlineError);
    expect(d.statements).toEqual([]);
    expect(d.touched()).toBe(0);
  });
});
