// pg_switch의 제어 받는 쪽 읽기·쓰기(F-02-2 OPS-310, ADR-0366 결정 2·3). 쓰기는 기존 DrizzlePgSelection.applySwitch(판이 클 때만 UPSERT)를 그대로 쓰고,
// 쓴 뒤 그 범위 행을 다시 읽어 판을 답한다. 시작 때는 모든 행을 한 번 읽어야 준비 상태가 된다. 일반 풀(쓰기 인스턴스)을 넘긴다.
import type { Database } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import type { PgName } from '../../domain/payment-gateway.js';
import type { PgSwitchRow } from '../../domain/pg-selection.js';
import type { PgSwitchControlStore } from '../../domain/pg-switch-control.js';
import { DrizzlePgSelection } from './drizzle-pg-selection.js';
import { pgSwitch } from './schema.js';

type Row = typeof pgSwitch.$inferSelect;

const rowOf = (r: Row): PgSwitchRow => ({
  scope: r.scope,
  active: r.active,
  ...(r.fromPg === null ? {} : { fromPg: r.fromPg as PgName }),
  ...(r.toPg === null ? {} : { toPg: r.toPg as PgName }),
  version: Number(r.version),
  changedAtMs: new Date(r.changedAt).getTime(),
});

export class DrizzlePgSwitchControl implements PgSwitchControlStore {
  readonly #writer: DrizzlePgSelection;

  constructor(private readonly o: { readonly database: Database }) {
    this.#writer = new DrizzlePgSelection({ database: o.database });
  }

  applySwitch(row: PgSwitchRow): Promise<boolean> {
    return this.#writer.applySwitch(row);
  }

  async readSwitch(scope: string): Promise<PgSwitchRow | undefined> {
    const rows = await this.o.database.transaction((tx) => tx.select().from(pgSwitch).where(eq(pgSwitch.scope, scope)));
    return rows[0] ? rowOf(rows[0]) : undefined;
  }

  async readAll(): Promise<readonly PgSwitchRow[]> {
    const rows = await this.o.database.transaction((tx) => tx.select().from(pgSwitch));
    return rows.map(rowOf);
  }
}
