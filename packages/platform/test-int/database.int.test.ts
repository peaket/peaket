// Drizzle 설정의 실제 PostgreSQL 시험(openspec 변경 add-service-structure-and-request-checks 결정 9, BUILD_ORDER FND-070).
// 연결 풀 대기 한도·429(architecture §5, ADR-0070), 트랜잭션 범위 설정(ADR-0083), 테넌트 행 보안(authz-matrix §5.3), 잠금 절(ADR-0037 결정 4).
import 'reflect-metadata';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DATABASE, ProblemError, Roles, createDatabase, createService, databaseModule, fakeClock, type Database } from '../src/index.js';
import { collector } from '../test/fixture.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const notes = pgTable('note', { id: text('id').primaryKey(), body: text('body').notNull() });
const A = '0190f3a1-7c2e-7a00-8000-00000000000a';
const B = '0190f3a1-7c2e-7a00-8000-00000000000b';

let pgc: PostgresContainer;
const opened: Database[] = [];
const open = (o: Parameters<typeof createDatabase>[0]) => {
  const d = createDatabase(o);
  opened.push(d);
  return d;
};

beforeAll(async () => {
  pgc = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query(`
    create table note (id text primary key, body text not null);
    create role app_partner login password 'pw';
    create table tenant_note (promoter_id uuid not null, body text not null);
    alter table tenant_note enable row level security;
    -- authz-matrix §5.3의 정책. 값이 없거나 빈 문자열이면 NULL로 보아 아무 행도 보이지 않는다
    create policy tenant_only on tenant_note using (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
    grant select on tenant_note to app_partner;
    insert into tenant_note values ('${A}', 'a-1'), ('${A}', 'a-2'), ('${B}', 'b-1');
  `);
  await admin.end();
}, 120_000);

afterAll(async () => {
  for (const d of opened) await d.close().catch(() => {});
  pgc?.stop();
});

describe('Drizzle 설정', () => {
  test('FND070_Drizzle로질의하고_트랜잭션이던지면되돌린다', async () => {
    const d = open({ url: pgc.url });
    await d.transaction(async (tx) => {
      await tx.insert(notes).values({ id: 'n1', body: '남김' });
    });
    await expect(
      d.transaction(async (tx) => {
        await tx.insert(notes).values({ id: 'n2', body: '되돌림' });
        throw new Error('되돌린다');
      }),
    ).rejects.toThrow('되돌린다');
    const rows = await d.db.select().from(notes).orderBy(notes.id);
    expect(rows).toEqual([{ id: 'n1', body: '남김' }]);
  });

  test('AUTHZ_5_3_FND070_테넌트설정은_행보안으로거르고_같은연결의다음트랜잭션에남지않는다', async () => {
    const d = open({ url: pgc.urlFor('app_partner', 'pw'), max: 1 });
    const read = (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => tx.execute(sql`select body from tenant_note order by body`);
    const a = await d.transaction(read, { tenantId: A });
    expect(a.rows.map((r) => r.body)).toEqual(['a-1', 'a-2']);
    const none = await d.transaction(read);
    expect(none.rows).toEqual([]);
    const b = await d.transaction(read, { tenantId: B });
    expect(b.rows.map((r) => r.body)).toEqual(['b-1']);
    const after = await d.db.execute(sql`select current_setting('app.tenant_id', true) as t`);
    expect([null, '']).toContain(after.rows[0]!.t);
  });

  test('FND070_문장시간초과는_그트랜잭션에만걸린다', async () => {
    const d = open({ url: pgc.url, max: 1 });
    const err = await d.transaction((tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(((err as { cause?: { code?: string } }).cause ?? err as { code?: string }).code).toBe('57014');
    const shown = await d.transaction((tx) => tx.execute(sql`show statement_timeout`));
    expect(shown.rows[0]!.statement_timeout).toBe('0');
  });

  test('FND070_연결시작매개변수로_statement_timeout을보내지않는다', async () => {
    const d = open({ url: pgc.url, applicationName: 'note-svc' });
    const r = await d.db.execute(sql`select current_setting('statement_timeout') as st, current_setting('application_name') as app`);
    expect(r.rows[0]).toEqual({ st: '0', app: 'note-svc' });
  });

  test('ADR0037_잠금절은_생성SQL로확인한다', () => {
    const d = open({ url: pgc.url });
    const q = d.db.select().from(notes).where(eq(notes.id, 'x')).for('update', { skipLocked: true }).toSQL();
    expect(q.sql).toMatch(/for update skip locked$/);
    expect(q.params).toEqual(['x']);
  });

  test('FND070_풀대기가한도를넘으면_기다리지않고429_server_busy다 [ASVS v5.0.0-13.1.2]', async () => {
    const d = open({ url: pgc.url, max: 1, profile: 'hot' });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = d.transaction(async () => {
      entered();
      await held;
    });
    await inside;
    const t0 = performance.now();
    const err = await d.db.execute(sql`select 1`).catch((e: unknown) => e);
    const waited = performance.now() - t0;
    const problem = err instanceof ProblemError ? err : (err as { cause?: unknown }).cause;
    expect(problem).toBeInstanceOf(ProblemError);
    expect({ slug: (problem as ProblemError).slug, status: (problem as ProblemError).status, retry: (problem as ProblemError).retryAfterSeconds }).toEqual({ slug: 'server-busy', status: 429, retry: 1 });
    expect(waited).toBeLessThan(1000);
    await expect(d.transaction(async () => 1)).rejects.toBeInstanceOf(ProblemError);
    release();
    await holder;
  });
});

describe('서비스 안의 DB 오류', () => {
  @Controller('v1/db')
  @Roles(['public'])
  class DbController {
    constructor(@Inject(DATABASE) private readonly d: Database) {}

    @Get('dup')
    async dup() {
      await this.d.db.insert(notes).values({ id: 'dup', body: 'first' }).onConflictDoNothing();
      await this.d.db.insert(notes).values({ id: 'dup', body: 'secret-param-value@example.com' });
      return { ok: true };
    }

    @Get('busy')
    async busy() {
      await this.d.db.execute(sql`select 1`);
      return { ok: true };
    }
  }

  test('FND070_쿼리오류의줄에는_매개변수값이없고_풀대기초과는429다 [ASVS v5.0.0-16.2.5]', async () => {
    const d = open({ url: pgc.url, max: 1, profile: 'hot' });
    @Module({ imports: [databaseModule(d)], controllers: [DbController] })
    class DbModule {}
    const logs = collector();
    const svc = await createService({ name: 'db-svc', module: DbModule, env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' }, clock: fakeClock(), logDestination: logs.stream });
    try {
      // 연결 하나짜리 핫패스 풀은 대기 한도가 짧아, 몰리는 러너에서 첫 연결을 맺는 동안 첫 요청이 429를 받는다(CI 42517395423). 연결을 먼저 맺어 둔다
      for (let tries = 0; ; tries += 1) {
        try {
          await d.db.execute(sql`select 1`);
          break;
        } catch (e) {
          if (tries >= 20) throw e;
          await new Promise((res) => setTimeout(res, 250));
        }
      }
      const r = await svc.http.inject({ method: 'GET', url: '/v1/db/dup' });
      expect(r.statusCode).toBe(500);
      const line = logs.lines.find((l) => l.msg === 'request' && l.status === 500)!;
      expect(JSON.stringify(line)).not.toContain('secret-param-value');
      expect((line.err as Record<string, string>).message).toMatch(/^Failed query: insert into "note"/);
      expect((line.err as Record<string, string>).message).toContain('23505');

      let release!: () => void;
      const held = new Promise<void>((res) => (release = res));
      let entered!: () => void;
      const inside = new Promise<void>((res) => (entered = res));
      const holder = d.transaction(async () => {
        entered();
        await held;
      });
      await inside;
      const busy = await svc.http.inject({ method: 'GET', url: '/v1/db/busy' });
      release();
      await holder;
      expect(busy.statusCode).toBe(429);
      expect(busy.headers['retry-after']).toBe('1');
      expect(JSON.parse(busy.payload)).toMatchObject({ type: 'https://peaket.example/problems/server-busy', status: 429 });
    } finally {
      await svc.close();
    }
  });
});
