// sale_control의 Drizzle 저장소(BAT-465 R-584, F-02-1 OPS-300, docs/data.md sale_control, ADR-0123·0365).
// 판 번호는 조건부 upsert 하나로 올린다: 같은 명령이 같은 상태를 다시 쓰면 WHERE가 거짓이라 행이 돌아오지 않고, 그때는 지금 행을 읽어 changed 거짓을 준다.
// 판매 중지(suspended·revision·command_id)와 명령 3(paused·paused_revision·paused_command_id·paused_changed_at)은 서로의 칸을 건드리지 않는다(ADR-0365 결정 6).
import { type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { SaleControlStore } from '../../domain/ports.js';
import type { PlatformSalePause, SaleControl, SaleControlSnapshot, SalePauseApplied, SalePauseWrite, SaleSuspensionApplied, SaleSuspensionWrite } from '../../domain/sale-control.js';

interface Row {
  scope: string;
  event_id: string | null;
  paused: boolean;
  suspended: boolean;
  revision: number | string;
  command_id: string | null;
  suspension_ref: string | null;
  reason: string | null;
  updated_at: Date | string;
  paused_revision: number | string;
  paused_command_id: string | null;
  paused_changed_at: Date | string | null;
}

const COLUMNS = sql`scope, event_id, paused, suspended, revision, command_id, suspension_ref, reason, updated_at, paused_revision, paused_command_id, paused_changed_at`;

const msOf = (v: Date | string): number => new Date(v).getTime();

const controlOf = (r: Row): SaleControl => ({
  eventId: r.event_id ?? '',
  paused: r.paused === true,
  suspended: r.suspended === true,
  revision: Number(r.revision),
  ...(r.command_id !== null ? { commandId: r.command_id } : {}),
  ...(r.suspension_ref !== null ? { suspensionRef: r.suspension_ref } : {}),
  ...(r.reason !== null ? { reason: r.reason } : {}),
  updatedAtMs: msOf(r.updated_at),
  pausedRevision: Number(r.paused_revision),
  ...(r.paused_command_id !== null ? { pausedCommandId: r.paused_command_id } : {}),
  ...(r.paused_changed_at !== null ? { pausedChangedAtMs: msOf(r.paused_changed_at) } : {}),
});

const platformOf = (r: Row): PlatformSalePause => ({
  paused: r.paused === true,
  pausedRevision: Number(r.paused_revision),
  ...(r.paused_command_id !== null ? { pausedCommandId: r.paused_command_id } : {}),
  ...(r.paused_changed_at !== null ? { pausedChangedAtMs: msOf(r.paused_changed_at) } : {}),
});

const pauseAppliedOf = (r: Row, changed: boolean): SalePauseApplied => ({
  paused: r.paused === true,
  appliedVersion: Number(r.paused_revision),
  ...(r.paused_command_id !== null ? { commandId: r.paused_command_id } : {}),
  ...(r.paused_changed_at !== null ? { changedAtMs: msOf(r.paused_changed_at) } : {}),
  changed,
});

export class DrizzleSaleControlStore implements SaleControlStore {
  constructor(private readonly database: Database) {}

  async find(eventId: string): Promise<SaleControl | undefined> {
    const r = await this.database.db.execute(sql`select ${COLUMNS} from sale_control where scope = 'EVENT' and event_id = ${eventId}::uuid`);
    const row = r.rows[0] as unknown as Row | undefined;
    return row ? controlOf(row) : undefined;
  }

  async apply(write: SaleSuspensionWrite): Promise<SaleSuspensionApplied> {
    const version = write.version ?? 0;
    const updated = await this.database.db.execute(sql`
      insert into sale_control (scope, event_id, paused, suspended, revision, command_id, suspension_ref, reason, updated_at)
      values ('EVENT', ${write.eventId}::uuid, false, ${write.suspended}::boolean, greatest(1, ${version}::bigint), ${write.commandId}::uuid, ${write.suspensionRef ?? null}, ${write.reason},
              ${new Date(write.nowMs)}::timestamptz)
      on conflict (event_id) where scope = 'EVENT' do update set
        suspended = excluded.suspended,
        revision = greatest(sale_control.revision + 1, ${version}::bigint),
        command_id = excluded.command_id,
        suspension_ref = coalesce(excluded.suspension_ref, sale_control.suspension_ref),
        reason = excluded.reason,
        updated_at = excluded.updated_at
      where (${version}::bigint = 0 or ${version}::bigint > sale_control.revision)
        and (sale_control.command_id is distinct from excluded.command_id or sale_control.suspended is distinct from excluded.suspended)
      returning ${COLUMNS}`);
    const row = updated.rows[0] as unknown as Row | undefined;
    if (row) return { control: controlOf(row), changed: true };
    const current = await this.find(write.eventId);
    if (!current) throw new Error('sale_control 행을 쓰지 못했고 기존 행도 없다');
    return { control: current, changed: false };
  }

  /**
   * 명령 3 조건부 upsert 하나. 판(paused_revision)이 지금보다 클 때만 쓰고, 바뀐 시각은 paused 값이 실제로 바뀔 때만 옮긴다(풀린 시각, ADR-0365 결정 8).
   * 새 회차 행의 판매 중지 칸은 기본값(suspended 거짓, revision 1)이다
   */
  async applyPause(write: SalePauseWrite): Promise<SalePauseApplied> {
    const now = new Date(write.nowMs);
    const eventId = write.scope.kind === 'EVENT' ? write.scope.eventId : null;
    const scope = eventId !== null ? 'EVENT' : 'PLATFORM';
    const conflict = eventId !== null ? sql`on conflict (event_id) where scope = 'EVENT'` : sql`on conflict (scope) where scope = 'PLATFORM'`;
    const updated = await this.database.db.execute(sql`
      insert into sale_control (scope, event_id, paused, suspended, revision, updated_at, paused_revision, paused_command_id, paused_changed_at)
      values (${scope}, ${eventId}::uuid, ${write.paused}::boolean, false, 1, ${now}::timestamptz, ${write.version}::bigint, ${write.commandId}::uuid, ${now}::timestamptz)
      ${conflict} do update set
        paused = excluded.paused,
        paused_revision = excluded.paused_revision,
        paused_command_id = excluded.paused_command_id,
        paused_changed_at = case when sale_control.paused is distinct from excluded.paused then excluded.paused_changed_at else sale_control.paused_changed_at end,
        updated_at = excluded.updated_at
      where excluded.paused_revision > sale_control.paused_revision
      returning ${COLUMNS}`);
    const row = updated.rows[0] as unknown as Row | undefined;
    if (row) return pauseAppliedOf(row, true);
    const current = await this.database.db.execute(
      eventId !== null ? sql`select ${COLUMNS} from sale_control where scope = 'EVENT' and event_id = ${eventId}::uuid` : sql`select ${COLUMNS} from sale_control where scope = 'PLATFORM'`,
    );
    const cur = current.rows[0] as unknown as Row | undefined;
    if (!cur) throw new Error('sale_control 명령 3 행을 쓰지 못했고 기존 행도 없다');
    return pauseAppliedOf(cur, false);
  }

  async snapshot(): Promise<SaleControlSnapshot> {
    const r = await this.database.db.execute(sql`select ${COLUMNS} from sale_control`);
    const rows = r.rows as unknown as Row[];
    const platform = rows.find((x) => x.scope === 'PLATFORM');
    return { events: rows.filter((x) => x.scope === 'EVENT' && x.event_id !== null).map(controlOf), ...(platform ? { platform: platformOf(platform) } : {}) };
  }
}
