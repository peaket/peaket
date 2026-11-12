// Drizzle 설정(openspec 변경 add-service-structure-and-request-checks 결정 9, ADR-0037·0070·0083, authz-matrix §5.3).
// - 앱 연결 풀은 node-postgres pg.Pool. 풀 대기 한도(핫패스 100ms·일반 1초)를 넘으면 기다리지 않고 429 server-busy(architecture §5)
// - 연결 시작 매개변수로 statement_timeout을 보내지 않는다(PgBouncer 트랜잭션 풀링이 거절하거나 버린다, ADR-0070)
// - 트랜잭션에만 걸 값은 첫 문장에서 set_config(…, true)(= SET LOCAL)로 건다. 끝나면 사라진다(ADR-0083)
// - SQL형 빌더만 쓴다(Relational Queries를 쓰지 않으므로 스키마를 넘기지 않는다, ADR-0037 결정 1)
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { serverBusy } from './problem.js';

export type DatabaseProfile = 'hot' | 'general';

/** 풀 기본값(architecture §5 '시간 초과 기본값', ADR-0070. 값은 BAS-080에서 잰다) */
export const POOL_DEFAULTS = {
  connectionTimeoutMillis: { hot: 100, general: 1000 },
  idleTimeoutMillis: 10_000,
  maxLifetimeSeconds: 30 * 60,
} as const;

/**
 * 연결을 대기 한도 안에 받지 못했을 때의 pg-pool 3.x 메시지 둘. 풀이 꽉 차 기다리다 넘긴 것과, 쉬는 연결이 없어 새 연결을 맺다
 * 넘긴 것이다. 둘 다 '대기 한도 안에 연결을 못 받음'이라 429 server-busy다(BSL-040 v0 시험에서 뒤엣것이 500으로 새는 것을 찾음)
 */
const CONNECT_TIMEOUTS: ReadonlySet<string> = new Set(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']);

const toBusy = (err: unknown): unknown => (err instanceof Error && CONNECT_TIMEOUTS.has(err.message) ? serverBusy(err) : err);

type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => void;

/** 풀 대기 초과를 429 server-busy로 바꾸는 풀. 질의(pool.query)도 안에서 connect를 부르므로 함께 바뀐다 */
class PlatformPool extends pg.Pool {
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    if (callback) {
      super.connect((err, client, done) => callback(err ? (toBusy(err) as Error) : undefined, client, done));
      return;
    }
    return super.connect().catch((err: unknown) => {
      throw toBusy(err);
    });
  }
}

export interface DatabaseOptions {
  /** 접속 주소(postgres://…). 서비스는 비밀 관리에서 받은 값을 넣는다 */
  url: string;
  /** 핫패스(풀 대기 100ms)·일반(1초). 기본 general */
  profile?: DatabaseProfile;
  /** 풀 크기(PgBouncer 연결 수와 함께 정한다). 기본 10 */
  max?: number;
  /** 연결 대기 한도(ms). 없으면 profile 기본값(핫패스 100ms·일반 1초). BAT-034: purchase-svc 핫패스는 250ms를 넘긴다 */
  connectionTimeoutMillis?: number;
  /** pg_stat_activity의 application_name(서비스 이름) */
  applicationName?: string;
}

export type DbTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface TransactionOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  accessMode?: 'read only' | 'read write';
  /** 파트너 요청의 테넌트(요청마다 identity에서 받은 값). app.tenant_id로 걸어 행 보안이 거른다(authz-matrix §5.3) */
  tenantId?: string;
  /** 이 트랜잭션의 문장 시간 초과(ms). 남은 데드라인이 역할 상한보다 짧을 때 쓴다(architecture §5) */
  statementTimeoutMs?: number;
}

export interface Database {
  /** Drizzle(SQL형 빌더) */
  readonly db: NodePgDatabase;
  readonly pool: pg.Pool;
  /** 트랜잭션 하나. 던지면 되돌린다. 걸어 둔 설정은 끝나면 사라진다 */
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
}

/** Nest 주입 이름(@Inject(DATABASE)) */
export const DATABASE = Symbol.for('peaket.platform.database');

export function createDatabase(o: DatabaseOptions): Database {
  const profile = o.profile ?? 'general';
  if (o.connectionTimeoutMillis !== undefined && (!Number.isInteger(o.connectionTimeoutMillis) || o.connectionTimeoutMillis < 1)) {
    throw new RangeError(`connectionTimeoutMillis는 양의 정수(ms)여야 한다: ${String(o.connectionTimeoutMillis)}`);
  }
  const pool = new PlatformPool({
    connectionString: o.url,
    max: o.max ?? 10,
    connectionTimeoutMillis: o.connectionTimeoutMillis ?? POOL_DEFAULTS.connectionTimeoutMillis[profile],
    idleTimeoutMillis: POOL_DEFAULTS.idleTimeoutMillis,
    maxLifetimeSeconds: POOL_DEFAULTS.maxLifetimeSeconds,
    application_name: o.applicationName,
  });
  // 쉬는 연결의 오류(서버 재시작 등)가 프로세스를 죽이지 않게 받는다. 그 연결은 풀이 버린다
  pool.on('error', () => {});
  const db = drizzle({ client: pool });
  return {
    db,
    pool,
    // async: 선택지가 틀려도 던지지 않고 거절된 Promise를 돌려준다(.catch()로 이은 호출이 잡게, 코드 리뷰 2026-11-01)
    async transaction<T>(fn: (tx: DbTransaction) => Promise<T>, t: TransactionOptions = {}): Promise<T> {
      if (t.statementTimeoutMs !== undefined && !(Number.isInteger(t.statementTimeoutMs) && t.statementTimeoutMs > 0)) {
        throw new RangeError(`statementTimeoutMs는 양의 정수(ms)여야 한다: ${t.statementTimeoutMs}`);
      }
      if (t.tenantId !== undefined && t.tenantId.length === 0) throw new RangeError('tenantId가 비었다');
      const config = t.isolationLevel || t.accessMode ? { isolationLevel: t.isolationLevel, accessMode: t.accessMode } : undefined;
      return db.transaction(async (tx) => {
        // 값은 매개변수로 묶는다(SET LOCAL은 값을 매개변수로 받지 못해 set_config(이름, 값, true)를 쓴다)
        if (t.tenantId !== undefined && t.statementTimeoutMs !== undefined) {
          await tx.execute(sql`select set_config('app.tenant_id', ${t.tenantId}, true), set_config('statement_timeout', ${String(t.statementTimeoutMs)}, true)`);
        } else if (t.tenantId !== undefined) {
          await tx.execute(sql`select set_config('app.tenant_id', ${t.tenantId}, true)`);
        } else if (t.statementTimeoutMs !== undefined) {
          await tx.execute(sql`select set_config('statement_timeout', ${String(t.statementTimeoutMs)}, true)`);
        }
        return fn(tx);
      }, config);
    },
    close: () => pool.end(),
  };
}

/** 서비스 모듈이 가져온다: imports: [databaseModule(db)]. 처리기·어댑터는 @Inject(DATABASE)로 받는다 */
export function databaseModule(database: Database): DynamicModule {
  @Global()
  @Module({})
  class PlatformDatabaseModule {}
  return { module: PlatformDatabaseModule, providers: [{ provide: DATABASE, useValue: database }], exports: [DATABASE] };
}
