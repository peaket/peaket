// Drizzle 설정(openspec 변경 add-service-structure-and-request-checks 결정 9, ADR-0037·0070·0083, authz-matrix §5.3).
// - 앱 연결 풀은 node-postgres pg.Pool. 풀 대기 한도(핫패스 100ms·일반 1초)를 넘으면 기다리지 않고 429 server-busy(architecture §5)
// - 연결 시작 매개변수로 statement_timeout을 보내지 않는다(PgBouncer 트랜잭션 풀링이 거절하거나 버린다, ADR-0070)
// - 트랜잭션에만 걸 값은 첫 문장에서 set_config(…, true)(= SET LOCAL)로 건다. 끝나면 사라진다(ADR-0083)
// - SQL형 빌더만 쓴다(Relational Queries를 쓰지 않으므로 스키마를 넘기지 않는다, ADR-0037 결정 1)
// - 풀 대기 초과는 db_pool_wait_timeout_total{service}, 서버 상한으로 취소된 문장(SQLSTATE 57014)은 db_statement_timeout_total{role}로 센다(ADR-0070, BUILD_ORDER BAS-080)
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TIMEOUT_METRICS } from './metrics.js';
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

/** 서버 상한(statement_timeout)으로 취소된 문장의 SQLSTATE. 사람이 끊은 문장(pg_cancel_backend)도 같은 값이다 */
const STATEMENT_TIMEOUT_SQLSTATE = '57014';

const isStatementTimeout = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === STATEMENT_TIMEOUT_SQLSTATE;

type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => void;

const COUNTED = Symbol('peaket.platform.statementTimeoutCounted');

/**
 * 연결 하나의 query가 57014로 실패하면 센다. 부른 쪽이 받는 값은 그대로다: 약속을 돌려주는 꼴은 그 약속 자체를 돌려주고 옆에 관찰만 붙이며,
 * 콜백 꼴은 콜백 앞에서 오류만 본다. 그 밖의 꼴(Submittable·커서)은 돌려준 값을 그대로 넘긴다. 연결마다 한 번만 감싼다.
 * 감쌀 때 연결에 이미 자기 query가 있으면(계측·시험이 'connect' 사건에서 단 것) 그것을 부르고, 없으면 부를 때마다 원형(prototype)에서 찾는다
 * (그 뒤 원형에 건 관찰도 지나게, BAT-075 PR CI)
 */
function countStatementTimeouts(client: pg.PoolClient, onTimeout: () => void): void {
  const marked = client as pg.PoolClient & { [COUNTED]?: true };
  if (marked[COUNTED]) return;
  marked[COUNTED] = true;
  type Query = (...args: unknown[]) => unknown;
  const own = Object.prototype.hasOwnProperty.call(client, 'query') ? (client.query as Query) : undefined;
  const proto = Object.getPrototypeOf(client) as { query: Query };
  const next = (self: unknown, args: unknown[]): unknown => (own ?? proto.query).apply(self, args);
  (client as unknown as { query: Query }).query = function (this: unknown, ...args: unknown[]) {
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === 'function') {
      args[last] = function (this: unknown, err: unknown, ...rest: unknown[]) {
        if (isStatementTimeout(err)) onTimeout();
        return (callback as Query).call(this, err, ...rest);
      };
      return next(this, args);
    }
    const r = next(this, args);
    if (r instanceof Promise) {
      // 옆 가지에서만 본다(다시 던지지 않아 이 가지가 처리되지 않은 거부를 만들지 않는다). 돌려주는 것은 원래 약속이다
      r.then(undefined, (err: unknown) => {
        if (isStatementTimeout(err)) onTimeout();
      });
    }
    return r;
  };
}

/** 풀 대기 초과를 429 server-busy로 바꾸고 시간 초과를 세는 풀. 질의(pool.query)도 안에서 connect를 부르므로 함께 바뀐다 */
class PlatformPool extends pg.Pool {
  readonly #labels: { service: string; role: string };

  constructor(config: pg.PoolConfig, labels: { service: string; role: string }) {
    super(config);
    this.#labels = labels;
  }

  #toBusy(err: unknown): unknown {
    if (!(err instanceof Error && CONNECT_TIMEOUTS.has(err.message))) return err;
    TIMEOUT_METRICS.dbPoolWaitTimeouts.inc({ service: this.#labels.service });
    return serverBusy(err);
  }

  #counted(client: pg.PoolClient | undefined): pg.PoolClient | undefined {
    if (client) countStatementTimeouts(client, () => TIMEOUT_METRICS.dbStatementTimeouts.inc({ role: this.#labels.role }));
    return client;
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    if (callback) {
      super.connect((err, client, done) => callback(err ? (this.#toBusy(err) as Error) : undefined, this.#counted(client), done));
      return;
    }
    return super.connect().then(
      (client) => this.#counted(client)!,
      (err: unknown) => {
        throw this.#toBusy(err);
      },
    );
  }
}

/** 접속 주소의 사용자 이름(DB 역할). 읽지 못하면 undefined다. 비밀번호는 읽지 않는다 */
function roleOf(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).username);
    return name === '' ? undefined : name;
  } catch {
    return undefined;
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
  /** db_pool_wait_timeout_total의 service 라벨. 기본 applicationName(없으면 unknown) */
  service?: string;
  /** db_statement_timeout_total의 role 라벨(DB 역할). 기본 접속 주소의 사용자 이름(없으면 unknown) */
  role?: string;
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
  const pool = new PlatformPool(
    {
      connectionString: o.url,
      max: o.max ?? 10,
      connectionTimeoutMillis: o.connectionTimeoutMillis ?? POOL_DEFAULTS.connectionTimeoutMillis[profile],
      idleTimeoutMillis: POOL_DEFAULTS.idleTimeoutMillis,
      maxLifetimeSeconds: POOL_DEFAULTS.maxLifetimeSeconds,
      application_name: o.applicationName,
    },
    { service: o.service ?? o.applicationName ?? 'unknown', role: o.role ?? roleOf(o.url) ?? 'unknown' },
  );
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
