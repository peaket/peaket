// BAT-034: 핫패스 DB 풀의 연결 대기 한도가 429 server-busy를 가르는지 실제 PostgreSQL로 확인한다.
// 100ms(기존)는 200ms 점유된 연결을 기다리지 못해 429, 250ms(수정)는 흡수해 성공한다.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabase, ProblemError } from '@peaket/platform';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pg: PostgresContainer;

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);

afterAll(() => {
  pg?.stop();
});

async function waitForBusyConnection(connectionTimeoutMillis: number): Promise<{ error: unknown; ms: number }> {
  const db = createDatabase({ url: pg.url, profile: 'hot', max: 1, connectionTimeoutMillis });
  const held = await db.pool.connect();
  let released = false;
  const hold = (async () => {
    await held.query('select pg_sleep(0.2)');
    held.release();
    released = true;
  })();
  try {
    const t0 = performance.now();
    const error = await db.pool.query('select 1').then(
      () => undefined,
      (e: unknown) => e,
    );
    const ms = performance.now() - t0;
    await hold;
    return { error, ms };
  } finally {
    if (!released) held.release();
    await db.close();
  }
}

describe('BAT-034 purchase-svc 핫패스 DB 풀 대기', () => {
  test('100ms는 200ms 점유를 429 server-busy로 거절한다', async () => {
    const { error, ms } = await waitForBusyConnection(100);
    expect(error).toBeInstanceOf(ProblemError);
    expect({ slug: (error as ProblemError).slug, status: (error as ProblemError).status }).toEqual({ slug: 'server-busy', status: 429 });
    expect(ms).toBeGreaterThanOrEqual(80);
  }, 30_000);

  test('250ms는 200ms 점유를 흡수한다', async () => {
    const { error, ms } = await waitForBusyConnection(250);
    expect(error).toBeUndefined();
    expect(ms).toBeGreaterThanOrEqual(150);
  }, 30_000);
});
