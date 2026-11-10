// 낮춘 결제사 채널 상한 표(payment_channel_limit)와 포트원 채널의 관측 하위 결제사 표(payment_pg_channel_observed)
// (docs/data.md §2 ④·§5·§5.1, docs/features/payment.md §2 '낮춘 상한의 유지·전파·회복'·§2.2 '하위 결제사 검사의 첫 구현', BUILD_ORDER PRF-203).
// 두 표 모두 행이 결제사·채널 키 몇 개뿐이라 기본 키 말고 인덱스가 없다. main.ts가 어느 풀로 만들지 정한다(상한 표는 일반 풀, 관측 표 읽기는 핫패스 풀).
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { PgName } from '../../domain/payment-gateway.js';
import type { PgChannelLimitRow, PgLimitLowering } from '../../domain/pg-channel-limit.js';
import type { CallBudget, PgChannelLimitStore, PgChannelObservationReader, PgChannelObservationStore } from '../../domain/ports.js';
import { armStatementLimit } from './drizzle-payment-store.js';

/** 파드마다 1초 [가정] 읽기의 문장 시간 한도 150ms [가정](docs/data.md §5.1) */
export const PG_CHANNEL_LIMIT_READ_TIMEOUT_MS = 150;
/** 낮출 때의 쓰기·다시 읽기 문장 시간 한도 400ms [가정](실행기 밖에서 돈다) */
export const PG_CHANNEL_LIMIT_WRITE_TIMEOUT_MS = 400;

type LimitRow = { pg: string; ratio_percent: number; lowered_at: Date | string; expires_at: Date | string; version: number | string };

const rowOf = (r: LimitRow): PgChannelLimitRow => ({ pg: r.pg as PgName, ratioPercent: Number(r.ratio_percent), loweredAtMs: new Date(r.lowered_at).getTime(), expiresAtMs: new Date(r.expires_at).getTime(), version: Number(r.version) });

export class DrizzlePgChannelLimit implements PgChannelLimitStore {
  constructor(private readonly o: { readonly database: Database }) {}

  async readAll(budget?: CallBudget): Promise<ReadonlyMap<PgName, PgChannelLimitRow>> {
    const startedAt = performance.now();
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, PG_CHANNEL_LIMIT_READ_TIMEOUT_MS, budget, startedAt);
      return tx.execute(sql`select pg, ratio_percent, lowered_at, expires_at, version from payment_channel_limit where channel = 'ALL'`);
    });
    return new Map((r.rows as LimitRow[]).map((row) => [row.pg as PgName, rowOf(row)]));
  }

  async read(pg: PgName): Promise<PgChannelLimitRow | undefined> {
    const startedAt = performance.now();
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, PG_CHANNEL_LIMIT_WRITE_TIMEOUT_MS, undefined, startedAt);
      return tx.execute(sql`select pg, ratio_percent, lowered_at, expires_at, version from payment_channel_limit where pg = ${pg} and channel = 'ALL'`);
    });
    const row = r.rows[0] as LimitRow | undefined;
    return row === undefined ? undefined : rowOf(row);
  }

  /** 아는 행이 없으면 판 번호 1의 INSERT(겨루면 0행), 있으면 그 판 번호가 그대로일 때만 UPDATE한 문장이다 */
  async write(basis: PgChannelLimitRow | undefined, next: Pick<PgLimitLowering, 'pg' | 'ratioPercent' | 'loweredAtMs' | 'expiresAtMs'>, nowMs: number): Promise<PgChannelLimitRow | undefined> {
    const startedAt = performance.now();
    const lowered = new Date(next.loweredAtMs);
    const expires = new Date(next.expiresAtMs);
    const updated = new Date(nowMs);
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, PG_CHANNEL_LIMIT_WRITE_TIMEOUT_MS, undefined, startedAt);
      if (basis === undefined) {
        return tx.execute(sql`
          insert into payment_channel_limit (pg, channel, ratio_percent, lowered_at, expires_at, version, updated_at)
          values (${next.pg}, 'ALL', ${next.ratioPercent}::int, ${lowered}::timestamptz, ${expires}::timestamptz, 1, ${updated}::timestamptz)
          on conflict (pg, channel) do nothing
          returning pg, ratio_percent, lowered_at, expires_at, version`);
      }
      return tx.execute(sql`
        update payment_channel_limit set ratio_percent = ${next.ratioPercent}::int, lowered_at = ${lowered}::timestamptz, expires_at = ${expires}::timestamptz, version = version + 1, updated_at = ${updated}::timestamptz
        where pg = ${next.pg} and channel = 'ALL' and version = ${basis.version}::bigint
        returning pg, ratio_percent, lowered_at, expires_at, version`);
    });
    const row = r.rows[0] as LimitRow | undefined;
    return row === undefined ? undefined : rowOf(row);
  }
}

/** 관측 표 읽기 문장 시간 한도 150ms [가정](결제창 준비의 데드라인 300ms 안) */
export const PG_CHANNEL_OBSERVED_READ_TIMEOUT_MS = 150;

export class DrizzlePgChannelObserved implements PgChannelObservationReader, PgChannelObservationStore {
  constructor(private readonly o: { readonly database: Database }) {}

  async readAll(budget?: CallBudget): Promise<ReadonlyMap<string, string>> {
    const startedAt = performance.now();
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, PG_CHANNEL_OBSERVED_READ_TIMEOUT_MS, budget, startedAt);
      return tx.execute(sql`select channel_key, pg_provider from payment_pg_channel_observed`);
    });
    return new Map((r.rows as { channel_key: string; pg_provider: string }[]).map((row) => [row.channel_key, row.pg_provider]));
  }

  /** 값이 같으면 0행이다(같은 값을 다시 쓰지 않는다, docs/data.md §5) */
  async upsert(channelKey: string, pgProvider: string, atMs: number): Promise<boolean> {
    const startedAt = performance.now();
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, PG_CHANNEL_LIMIT_WRITE_TIMEOUT_MS, undefined, startedAt);
      return tx.execute(sql`
        insert into payment_pg_channel_observed (channel_key, pg_provider, observed_at) values (${channelKey}, ${pgProvider}, ${new Date(atMs)}::timestamptz)
        on conflict (channel_key) do update set pg_provider = excluded.pg_provider, observed_at = excluded.observed_at
        where payment_pg_channel_observed.pg_provider is distinct from excluded.pg_provider`);
    });
    return (r.rowCount ?? 0) > 0;
  }
}
