// sale_control의 Drizzle 저장소(BAT-465 R-584, docs/data.md sale_control, ADR-0123).
// 판 번호는 조건부 upsert 하나로 올린다: 같은 명령이 같은 상태를 다시 쓰면 WHERE가 거짓이라 행이 돌아오지 않고, 그때는 지금 행을 읽어 changed 거짓을 준다.
import { type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { SaleControlStore } from '../../domain/ports.js';
import type { SaleControl, SaleSuspensionApplied, SaleSuspensionWrite } from '../../domain/sale-control.js';

interface Row {
  event_id: string;
  paused: boolean;
  suspended: boolean;
  revision: number | string;
  command_id: string | null;
  suspension_ref: string | null;
  reason: string | null;
  updated_at: Date | string;
}

const COLUMNS = sql`event_id, paused, suspended, revision, command_id, suspension_ref, reason, updated_at`;

const controlOf = (r: Row): SaleControl => ({
  eventId: r.event_id,
  paused: r.paused === true,
  suspended: r.suspended === true,
  revision: Number(r.revision),
  ...(r.command_id !== null ? { commandId: r.command_id } : {}),
  ...(r.suspension_ref !== null ? { suspensionRef: r.suspension_ref } : {}),
  ...(r.reason !== null ? { reason: r.reason } : {}),
  updatedAtMs: new Date(r.updated_at).getTime(),
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
}
