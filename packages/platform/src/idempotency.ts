// 공용 멱등 모듈(docs/api/guidelines.md §4, ADR-0146 결정 1, 기술 검토 중간-046, openspec 변경 add-idempotency-and-outbox 결정 1~6).
// - 키는 머리 스키마가 아니라 이 모듈만 본다. 인증 가드가 신원을 판정한 바로 뒤, 경로 스키마의 붙여 둔 검사 실패보다 먼저 본다(결정 1)
// - 범위는 계정 × 작업(@Idempotent의 operation), 지문은 SHA-256(메서드 LF 받은 경로와 쿼리 LF 본문 바이트)(결정 3)
// - PostgreSQL 기록은 업무 쓰기와 같은 트랜잭션의 첫 쓰기다. 키 행을 넣는 문장만 lock_timeout 1초 [가정]로 묶는다(결정 6)
import { createHash, timingSafeEqual } from 'node:crypto';
import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { check, customType, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import type { Clock } from './clock.js';
import type { DbTransaction } from './database.js';
import { ProblemError } from './problem.js';
import { rawBodyOf } from './raw-body.js';

/** 처리기 장식자의 메타데이터 이름 */
export const IDEMPOTENT_METADATA = 'peaket:idempotent';

/** 작업 이름(그 서비스 작업 목록, 표의 CHECK와 같다). 대문자·숫자·밑줄 */
const OPERATION = /^[A-Z][A-Z0-9_]*$/;

export interface IdempotentOptions {
  /** 그 서비스 작업 목록의 이름(예: CREATE_ORDER). 범위는 계정 × 이 작업이다 */
  operation: string;
}

/** 다시 보내면 효과가 두 번 생길 수 있는 쓰기 처리기에 단다. 공개 역할을 허용한 처리기에는 달 수 없다(시작 실패) */
export function Idempotent(o: IdempotentOptions): MethodDecorator {
  if (!OPERATION.test(o.operation)) throw new Error(`멱등 작업 이름은 대문자·숫자·밑줄이다: ${o.operation}`);
  return SetMetadata(IDEMPOTENT_METADATA, { operation: o.operation } satisfies IdempotentOptions);
}

/** 멱등 처리에 넘기는 요청 값. 좌석 홀드는 같은 값을 Redis Lua에 넘긴다 */
export interface IdempotencyRequest {
  /** 인증 가드가 판정한 계정 ID */
  readonly accountRef: string;
  readonly operation: string;
  /** 소문자로 맞춘 UUID v4 */
  readonly key: string;
  /** 요청 지문(SHA-256, 32바이트) */
  readonly requestHash: Uint8Array;
}

const IDEMPOTENCY = Symbol('peaket.idempotency');

/** 처리기 매개변수: @IdempotencyRequest() idem: IdempotencyRequest. @Idempotent가 없는 처리기에서 쓰면 던진다 */
export const IdempotencyRequest = createParamDecorator((_data: unknown, ctx: ExecutionContext): IdempotencyRequest => {
  const r = (ctx.switchToHttp().getRequest<FastifyRequest>() as unknown as Record<symbol, IdempotencyRequest | undefined>)[IDEMPOTENCY];
  if (!r) throw new Error('@IdempotencyRequest()는 @Idempotent를 단 처리기에서만 쓴다');
  return r;
});

// 따옴표 없는 UUID v4(RFC 9562): 판 자리 4, 변형 자리 8~b. 대소문자는 가리지 않는다
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 머리 값이 정확히 하나의 따옴표 없는 UUID v4이면 소문자로 돌려주고, 아니면 undefined(결정 2) */
export function parseIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !UUID_V4.test(value)) return undefined;
  return value.toLowerCase();
}

/** 요청 지문: SHA-256(메서드 LF 요청 대상 LF 본문 바이트). 머리는 넣지 않는다(결정 3) */
export function requestFingerprint(method: string, target: string, body: Uint8Array | undefined): Uint8Array {
  const h = createHash('sha256');
  h.update(`${method.toUpperCase()}\n${target}\n`, 'utf8');
  if (body && body.length) h.update(body);
  return new Uint8Array(h.digest());
}

export function idempotencyKeyInvalid(): ProblemError {
  return new ProblemError({ type: 'idempotency-key-invalid', status: 400, title: '멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다' });
}

export function idempotencyKeyReused(): ProblemError {
  return new ProblemError({ type: 'idempotency-key-reused', status: 422, title: '같은 멱등 키를 다른 요청에 썼습니다' });
}

/** 첫 요청이 아직 처리 중이다. 같은 키로 다시 보낸다(정상 분기로 센다) */
export function idempotencyRequestInProgress(cause?: unknown): ProblemError {
  return new ProblemError({ type: 'idempotency-request-in-progress', status: 409, title: '같은 요청을 아직 처리하고 있습니다', retryAfterSeconds: 1, normalBranch: true, cause });
}

/**
 * 인증 가드가 신원을 판정한 뒤 부른다. @Idempotent 처리기면 키를 보고(틀리면 400) 요청 값을 요청에 붙인다.
 * 요청 대상은 받은 그대로의 경로와 쿼리다
 */
export function prepareIdempotency(request: FastifyRequest, options: IdempotentOptions, accountRef: string): void {
  const key = parseIdempotencyKey(request.headers['idempotency-key']);
  if (!key) throw idempotencyKeyInvalid();
  const target = request.raw.url ?? request.url;
  const value: IdempotencyRequest = { accountRef, operation: options.operation, key, requestHash: requestFingerprint(request.method, target, rawBodyOf(request)) };
  (request as unknown as Record<symbol, IdempotencyRequest>)[IDEMPOTENCY] = value;
}

// ---- PostgreSQL 멱등 기록(결정 6) ----

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** 멱등 기록 표 이름(서비스마다 하나, data.md '서비스마다 둔 멱등 기록 표'). purchase의 주문 세 작업은 order_idempotency */
export const IDEMPOTENCY_RECORD_TABLE = 'idempotency_record';
/** 보관 기간(guidelines §4, 24시간 [가정]) */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 처리 중인 같은 키를 기다리는 시간(guidelines §4, 1초 [가정]) */
export const IDEMPOTENCY_WAIT_MS = 1000;

/**
 * 서비스 스키마의 멱등 기록 표 정의(drizzle-kit이 마이그레이션을 만든다). operations는 그 서비스 작업 목록이고 CHECK가 된다
 * @param operations 작업 이름들(대문자·숫자·밑줄)
 */
export function idempotencyRecordTable(operations: readonly string[], name: string = IDEMPOTENCY_RECORD_TABLE) {
  if (operations.length === 0) throw new Error('멱등 작업 목록이 비었다');
  for (const o of operations) if (!OPERATION.test(o)) throw new Error(`멱등 작업 이름은 대문자·숫자·밑줄이다: ${o}`);
  // 이름은 위 규칙으로 걸렀으므로 그대로 넣는다(CHECK 정의에는 매개변수를 쓸 수 없다)
  const list = sql.raw(operations.map((o) => `'${o}'`).join(', '));
  return pgTable(
    name,
    {
      accountRef: text('account_ref').notNull(),
      operation: text('operation').notNull(),
      idempotencyKey: uuid('idempotency_key').notNull(),
      requestHash: bytea('request_hash').notNull(),
      resultRef: text('result_ref'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.accountRef, t.operation, t.idempotencyKey] }),
      index(`${name}_created_at_idx`).on(t.createdAt),
      check(`${name}_operation_check`, sql`${t.operation} in (${list})`),
    ],
  );
}

export interface IdempotencyStoreOptions {
  clock: Clock;
  /** 기본 idempotency_record */
  table?: string;
  /** 기본 24시간 [가정] */
  retentionMs?: number;
  /** 기본 1초 [가정] */
  waitMs?: number;
}

export interface IdempotentSteps<T> {
  /** 처음 온 요청의 업무. 같은 트랜잭션에서 쓰고, 다시 돌려줄 결과의 참조(예: 만든 행 ID)와 값을 돌려준다 */
  execute(): Promise<{ resultRef: string; value: T }>;
  /** 다시 온 요청. 처음 커밋한 결과를 참조로 읽어 같은 값을 만든다 */
  replay(resultRef: string): Promise<T>;
}

const pgCode = (e: unknown): string | undefined => {
  const any = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const c = any?.code ?? any?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};
/**
 * 키 행을 기다리다 끝난 오류: lock_not_available(lock_timeout을 넘김)과 query_canceled(문장 시간 한도를 넘김).
 * 핫패스 역할의 문장 한도(1초)나 남은 데드라인으로 건 한도가 키 기다림보다 먼저 끝날 수 있다(코드 리뷰 2026-11-01)
 */
const WAIT_ENDED = new Set(['55P03', '57014']);

/** 멱등 기록을 업무 쓰기와 같은 트랜잭션에서 다룬다(결정 6) */
export class IdempotencyStore {
  private readonly clock: Clock;
  private readonly table: ReturnType<typeof sql.identifier>;
  private readonly retentionMs: number;
  private readonly wait: string;

  constructor(o: IdempotencyStoreOptions) {
    this.clock = o.clock;
    this.table = sql.identifier(o.table ?? IDEMPOTENCY_RECORD_TABLE);
    this.retentionMs = o.retentionMs ?? IDEMPOTENCY_RETENTION_MS;
    const waitMs = o.waitMs ?? IDEMPOTENCY_WAIT_MS;
    if (!(Number.isInteger(waitMs) && waitMs > 0)) throw new RangeError(`waitMs는 양의 정수(ms)여야 한다: ${waitMs}`);
    this.wait = `${waitMs}ms`;
  }

  /**
   * 키 행을 잡고(처음이면 execute, 다시 온 요청이면 replay) 결과를 돌려준다. 트랜잭션의 첫 쓰기로 부른다.
   * 다른 지문 → 422, 첫 요청이 기다림 안에 끝나지 않음 → 409. execute가 던지면 트랜잭션째 되돌아가 키 행도 남지 않는다
   */
  async run<T>(tx: DbTransaction, req: IdempotencyRequest, steps: IdempotentSteps<T>): Promise<T> {
    const now = this.clock.now();
    const hash = Buffer.from(req.requestHash);
    const t = this.table;
    let claimed: boolean;
    try {
      await tx.execute(sql`select set_config('lock_timeout', ${this.wait}, true)`);
      // 보관 기간이 지난 행은 새 요청으로 다시 잡는다. 아직 커밋하지 않은 같은 키가 있으면 이 문장이 그 트랜잭션을 기다린다
      const r = await tx.execute(sql`
        insert into ${t} (account_ref, operation, idempotency_key, request_hash, result_ref, created_at)
        values (${req.accountRef}, ${req.operation}, ${req.key}, ${hash}, null, ${new Date(now)})
        on conflict (account_ref, operation, idempotency_key) do update
          set request_hash = excluded.request_hash, result_ref = null, created_at = excluded.created_at
          where ${t}.created_at <= ${new Date(now - this.retentionMs)}
        returning 1 as claimed`);
      claimed = r.rows.length === 1;
    } catch (e) {
      const code = pgCode(e);
      if (code !== undefined && WAIT_ENDED.has(code)) throw idempotencyRequestInProgress(e);
      throw e;
    }
    // 역할 기본값으로 돌린다(업무 문장에는 키 기다림 한도를 걸지 않는다)
    await tx.execute(sql`set local lock_timeout to default`);
    const where = sql`account_ref = ${req.accountRef} and operation = ${req.operation} and idempotency_key = ${req.key}`;
    if (claimed) {
      const out = await steps.execute();
      if (typeof out.resultRef !== 'string' || out.resultRef.length === 0) throw new Error('멱등 결과 참조(resultRef)가 비었다');
      await tx.execute(sql`update ${t} set result_ref = ${out.resultRef} where ${where}`);
      return out.value;
    }
    const rows = (await tx.execute(sql`select request_hash, result_ref from ${t} where ${where}`)).rows as { request_hash: Buffer; result_ref: string | null }[];
    const row = rows[0];
    // 그사이 정비 잡이 지웠다: 처리 중과 같게 다시 보내게 한다
    if (!row) throw idempotencyRequestInProgress();
    const stored = Buffer.from(row.request_hash);
    if (stored.length !== hash.length || !timingSafeEqual(stored, hash)) throw idempotencyKeyReused();
    if (row.result_ref === null) throw new Error('커밋된 멱등 기록에 결과 참조가 없다(execute 밖에서 커밋했다)');
    return steps.replay(row.result_ref);
  }
}

/**
 * 보관 기간이 지난 멱등 기록을 batchSize씩 지운다(정비 시간, data.md '서비스마다 둔 멱등 기록 표'). 지운 수를 돌려준다.
 * 일정(정비 시간 04:00~06:00)은 정비 잡이 정한다(BUILD_ORDER FND-090)
 */
export async function deleteExpiredIdempotencyRecords(
  database: { db: { execute(q: SQL): Promise<{ rowCount?: number | null }> } },
  o: { clock: Clock; table?: string; retentionMs?: number; batchSize?: number; pause?: () => Promise<void>; signal?: AbortSignal },
): Promise<number> {
  const t = sql.identifier(o.table ?? IDEMPOTENCY_RECORD_TABLE);
  const before = new Date(o.clock.now() - (o.retentionMs ?? IDEMPOTENCY_RETENTION_MS));
  const batch = o.batchSize ?? 10_000;
  let total = 0;
  for (;;) {
    // 멈춤 신호(프로세스 종료)를 받으면 다음 묶음을 시작하지 않는다. 남은 행은 다음 정비가 이어 지운다
    if (o.signal?.aborted) return total;
    // 바깥에도 기한 조건을 둔다: 지우려던 행을 새 요청이 다시 잡아 커밋하면, 기다린 DELETE가 그 새 판을 다시 보고 남긴다
    // (안쪽 질의에만 두면 새로 커밋된 기록을 지워 같은 키가 다시 처리됐다, 코드 리뷰 2026-11-01)
    const r = await database.db.execute(sql`
      delete from ${t} where created_at <= ${before} and (account_ref, operation, idempotency_key) in (
        select account_ref, operation, idempotency_key from ${t} where created_at <= ${before} order by created_at limit ${batch})`);
    const n = r.rowCount ?? 0;
    total += n;
    if (n < batch) return total;
    await o.pause?.();
  }
}
