// 결제사 선택 재료 읽기와 전환 쓰기(docs/data.md §4 '결제사 선택 표'·§5.1, ADR-0143, BUILD_ORDER PRF-190). 읽기는 핫패스 풀이고 쓰기 인스턴스를 본다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { PgName } from '../../domain/payment-gateway.js';
import type { PgSelectionState, PgSwitchRow } from '../../domain/pg-selection.js';
import type { CallBudget, PgSelectionReader, PgSwitchStore } from '../../domain/ports.js';
import { armStatementLimit } from './drizzle-payment-store.js';
import { pgSwitch } from './schema.js';

const PLATFORM_SCOPE = 'PLATFORM';

/** 선택 읽기 문장 시간 한도 상한 150ms [가정](데드라인 300ms 안, docs/data.md §5.1) */
export const PG_SELECTION_STATEMENT_TIMEOUT_MS = 150;

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

export class DrizzlePgSelection implements PgSelectionReader, PgSwitchStore {
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
    return {
      ...(eventSwitch === undefined ? {} : { eventSwitch }),
      ...(platformSwitch === undefined ? {} : { platformSwitch }),
      ...(row.pg_primary === null ? {} : { assignment: { primary: row.pg_primary as PgName, ...(row.pg_fallback === null ? {} : { fallback: row.pg_fallback as PgName }) } }),
    };
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
}
