// 결제사 선택 재료 읽기와 전환 쓰기(docs/data.md §4 '결제사 선택 표'·§5.1, ADR-0143, BUILD_ORDER PRF-190). 읽기는 핫패스 풀이고 쓰기 인스턴스를 본다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { PgName } from '../../domain/payment-gateway.js';
import type { PgSelectionState, PgSwitchRow } from '../../domain/pg-selection.js';
import type { CallBudget, EventPgAssignmentStore, EventPgAssignmentWrite, PgSelectionBatchReader, PgSelectionReader, PgSwitchStore } from '../../domain/ports.js';
import { armStatementLimit } from './drizzle-payment-store.js';
import { pgSwitch } from './schema.js';

const PLATFORM_SCOPE = 'PLATFORM';

/** 선택 읽기 문장 시간 한도 상한 150ms [가정](데드라인 300ms 안, docs/data.md §5.1) */
export const PG_SELECTION_STATEMENT_TIMEOUT_MS = 150;
/** 회차 목록 읽기 문장 시간 한도 상한 400ms [가정](GetNewPaymentPause 데드라인 500ms 안) */
export const PG_SELECTION_BATCH_STATEMENT_TIMEOUT_MS = 400;

/** 선택 읽기의 한 행. 없는 행의 칸은 모두 null이다(e_ 회차 전환, p_ 플랫폼 전환) */
interface SelectionRow {
  pg_primary: string | null;
  pg_fallback: string | null;
  e_scope: string | null;
  e_active: boolean | null;
  e_from_pg: string | null;
  e_to_pg: string | null;
  e_version: number | string | null;
  e_changed_at: Date | string | null;
  p_scope: string | null;
  p_active: boolean | null;
  p_from_pg: string | null;
  p_to_pg: string | null;
  p_version: number | string | null;
  p_changed_at: Date | string | null;
}

/** 표의 칸 → 값. 빈 칸은 싣지 않고, 행이 없으면 undefined다 */
function switchOf(scope: string | null, active: boolean | null, fromPg: string | null, toPg: string | null, version: number | string | null, changedAt: Date | string | null): PgSwitchRow | undefined {
  if (scope === null) return undefined;
  return {
    scope,
    active: active === true,
    ...(fromPg === null ? {} : { fromPg: fromPg as PgName }),
    ...(toPg === null ? {} : { toPg: toPg as PgName }),
    version: Number(version),
    changedAtMs: new Date(changedAt!).getTime(),
  };
}

/** 읽은 칸 → 선택 재료. 없는 값은 싣지 않는다 */
function stateOf(primary: string | null, fallback: string | null, eventSwitch: PgSwitchRow | undefined, platformSwitch: PgSwitchRow | undefined): PgSelectionState {
  return {
    ...(eventSwitch === undefined ? {} : { eventSwitch }),
    ...(platformSwitch === undefined ? {} : { platformSwitch }),
    ...(primary === null ? {} : { assignment: { primary: primary as PgName, ...(fallback === null ? {} : { fallback: fallback as PgName }) } }),
  };
}

/** 회차 목록 읽기의 한 행. kind가 config면 key는 회차 ID이고 지정 칸이 차고, switch면 key는 scope이고 전환 칸이 찬다 */
interface SelectionBatchRow {
  kind: 'config' | 'switch';
  key: string;
  pg_primary: string | null;
  pg_fallback: string | null;
  scope: string | null;
  active: boolean | null;
  from_pg: string | null;
  to_pg: string | null;
  version: number | string | null;
  changed_at: Date | string | null;
}

/**
 * GetNewPaymentPause의 회차 목록 읽기(BUILD_ORDER PRF-201 코드 리뷰). 일반 풀이고 파드 캐시를 거치지 않는다.
 * 회차 200개 [가정]를 트랜잭션 하나의 한 문장으로 읽고 플랫폼 전환 행은 한 번만 읽는다(회차마다 트랜잭션을 열면 1초 주기 호출이 핫패스 풀을 먹는다).
 */
export class DrizzlePgSelectionBatch implements PgSelectionBatchReader {
  constructor(private readonly o: { readonly database: Database }) {}

  async readMany(eventIds: readonly string[], budget?: CallBudget): Promise<ReadonlyMap<string, PgSelectionState>> {
    const startedAt = performance.now();
    const rows = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, PG_SELECTION_BATCH_STATEMENT_TIMEOUT_MS, budget, startedAt);
      const r = await tx.execute(sql`
        select 'config' as kind, c.event_id::text as key, c.pg_primary, c.pg_fallback,
               null::text as scope, null::boolean as active, null::text as from_pg, null::text as to_pg, null::bigint as version, null::timestamptz as changed_at
        from event_pg_config c
        where c.event_id = any(${sql.param([...eventIds])}::uuid[])
        union all
        select 'switch', s.scope, null, null, s.scope, s.active, s.from_pg, s.to_pg, s.version, s.changed_at
        from pg_switch s
        where s.scope = any(${sql.param([...eventIds, PLATFORM_SCOPE])}::text[])`);
      return r.rows as unknown as SelectionBatchRow[];
    });
    const configs = new Map<string, SelectionBatchRow>();
    const switches = new Map<string, PgSwitchRow | undefined>();
    for (const row of rows) {
      if (row.kind === 'config') configs.set(row.key, row);
      else switches.set(row.key, switchOf(row.scope, row.active, row.from_pg, row.to_pg, row.version, row.changed_at));
    }
    const platformSwitch = switches.get(PLATFORM_SCOPE);
    return new Map(eventIds.map((eventId) => [eventId, stateOf(configs.get(eventId)?.pg_primary ?? null, configs.get(eventId)?.pg_fallback ?? null, switches.get(eventId), platformSwitch)]));
  }
}

export class DrizzlePgSelection implements PgSelectionReader, PgSwitchStore, EventPgAssignmentStore {
  constructor(private readonly o: { readonly database: Database }) {}

  /** 세 행을 한 문장으로 읽는다. 문장 시간 한도가 읽기 전체에 걸리고, 세 행이 같은 시점의 값이다(BUILD_ORDER PRF-190 코드 리뷰) */
  async read(eventId: string, budget?: CallBudget): Promise<PgSelectionState> {
    const startedAt = performance.now();
    const row = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, PG_SELECTION_STATEMENT_TIMEOUT_MS, budget, startedAt);
      const r = await tx.execute(sql`
        select c.pg_primary, c.pg_fallback,
               e.scope as e_scope, e.active as e_active, e.from_pg as e_from_pg, e.to_pg as e_to_pg, e.version as e_version, e.changed_at as e_changed_at,
               p.scope as p_scope, p.active as p_active, p.from_pg as p_from_pg, p.to_pg as p_to_pg, p.version as p_version, p.changed_at as p_changed_at
        from (select 1) as one
        left join event_pg_config c on c.event_id = ${eventId}::uuid
        left join pg_switch e on e.scope = ${eventId}
        left join pg_switch p on p.scope = ${PLATFORM_SCOPE}`);
      return r.rows[0] as unknown as SelectionRow;
    });
    const eventSwitch = switchOf(row.e_scope, row.e_active, row.e_from_pg, row.e_to_pg, row.e_version, row.e_changed_at);
    const platformSwitch = switchOf(row.p_scope, row.p_active, row.p_from_pg, row.p_to_pg, row.p_version, row.p_changed_at);
    return stateOf(row.pg_primary, row.pg_fallback, eventSwitch, platformSwitch);
  }

  async applySwitch(row: PgSwitchRow): Promise<boolean> {
    const values = { scope: row.scope, active: row.active, fromPg: row.fromPg ?? null, toPg: row.toPg ?? null, version: row.version, changedAt: new Date(row.changedAtMs) };
    const written = await this.o.database.transaction((tx) =>
      tx
        .insert(pgSwitch)
        .values(values)
        .onConflictDoUpdate({
          target: pgSwitch.scope,
          set: { active: values.active, fromPg: values.fromPg, toPg: values.toPg, version: values.version, changedAt: values.changedAt },
          setWhere: sql`${pgSwitch.version} < excluded.version`,
        })
        .returning({ scope: pgSwitch.scope }),
    );
    return written.length > 0;
  }

  /** 회차 지정 쓰기(쓰임새 AssignEventPg, BUILD_ORDER PRF-203). 지정 시각이 표의 값보다 늦을 때만 쓰는 UPSERT 한 문장이다(늦게 온 옛 지정이 새 지정을 덮지 않는다) */
  async assignEvent(w: EventPgAssignmentWrite): Promise<boolean> {
    const r = await this.o.database.transaction((tx) =>
      tx.execute(sql`
        insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values (${w.eventId}::uuid, ${w.primary}, ${w.fallback ?? null}, ${new Date(w.updatedAtMs)}::timestamptz)
        on conflict (event_id) do update set pg_primary = excluded.pg_primary, pg_fallback = excluded.pg_fallback, updated_at = excluded.updated_at
        where event_pg_config.updated_at < excluded.updated_at`),
    );
    return (r.rowCount ?? 0) > 0;
  }
}
