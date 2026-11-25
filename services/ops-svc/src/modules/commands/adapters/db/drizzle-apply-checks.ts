// 적용 확인 행 저장소(ops DB command_apply_check, F-02-5 OPS-300, ADR-0365 결정 14, 마이그레이션 0026).
// due는 다음 볼 시각이 지난 활성 행을 오래된 순으로 준다. 파드 여럿이 겹치는 경합은 TR-06 정리 목록이다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { ApplyCheckRow, ApplyCheckStage, ApplyStatus } from '../../domain/apply-check.js';
import type { ApplyCheckStore } from '../../domain/ports.js';

interface Row {
  command_id: string;
  stage: string;
  version: number | string;
  message_key: string;
  outbox_id: string;
  service: string | null;
  status: string;
  written_at: Date | string;
  sent_at: Date | string | null;
  target_count: number;
  acked_count: number;
  pods: unknown;
  alert_open: boolean;
  reason: string | null;
  next_check_at: Date | string;
  updated_at: Date | string;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
const rowOf = (r: Row): ApplyCheckRow => ({
  commandId: r.command_id,
  stage: r.stage as ApplyCheckStage,
  version: Number(r.version),
  messageKey: r.message_key,
  outboxId: r.outbox_id,
  ...(r.service !== null ? { service: r.service } : {}),
  status: r.status as ApplyStatus,
  writtenAtMs: ms(r.written_at),
  ...(r.sent_at !== null ? { sentAtMs: ms(r.sent_at) } : {}),
  pods: Array.isArray(r.pods) ? (r.pods as { pod: string; version?: number }[]) : [],
  targetCount: r.target_count,
  ackedCount: r.acked_count,
  alertOpen: r.alert_open,
  ...(r.reason !== null ? { reason: r.reason } : {}),
  nextCheckAtMs: ms(r.next_check_at),
  updatedAtMs: ms(r.updated_at),
});

@Injectable()
export class DrizzleApplyChecks implements ApplyCheckStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async due(nowMs: number, limit: number): Promise<readonly ApplyCheckRow[]> {
    const rows = (
      await this.database.db.execute(sql`
        select command_id, stage, version, message_key, outbox_id, service, status, written_at, sent_at,
               target_count, acked_count, pods, alert_open, reason, next_check_at, updated_at
        from command_apply_check
        where status in ('OUTBOX_WAITING', 'CHECKING', 'UNCONFIRMED', 'UNKNOWN') and next_check_at <= ${new Date(nowMs)}::timestamptz
        order by next_check_at, command_id limit ${limit}`)
    ).rows as unknown as Row[];
    return rows.map(rowOf);
  }

  async save(row: ApplyCheckRow): Promise<void> {
    await this.database.db.execute(sql`
      insert into command_apply_check
        (command_id, stage, version, message_key, outbox_id, service, status, written_at, sent_at,
         target_count, acked_count, pods, alert_open, reason, next_check_at, updated_at)
      values (${row.commandId}::uuid, ${row.stage}, ${row.version}::bigint, ${row.messageKey}, ${row.outboxId}::uuid,
        ${row.service ?? null}, ${row.status}, ${new Date(row.writtenAtMs)}::timestamptz,
        ${row.sentAtMs !== undefined ? new Date(row.sentAtMs) : null}::timestamptz,
        ${row.targetCount}::int, ${row.ackedCount}::int, ${JSON.stringify(row.pods)}::jsonb, ${row.alertOpen},
        ${row.reason ?? null}, ${new Date(row.nextCheckAtMs)}::timestamptz, ${new Date(row.updatedAtMs)}::timestamptz)
      on conflict (command_id, stage, version) do update set
        status = excluded.status, sent_at = excluded.sent_at, target_count = excluded.target_count,
        acked_count = excluded.acked_count, pods = excluded.pods, alert_open = excluded.alert_open,
        reason = excluded.reason, next_check_at = excluded.next_check_at, updated_at = excluded.updated_at`);
  }

  async latestOf(commandId: string): Promise<ApplyCheckRow | undefined> {
    const [r] = (
      await this.database.db.execute(sql`
        select command_id, stage, version, message_key, outbox_id, service, status, written_at, sent_at,
               target_count, acked_count, pods, alert_open, reason, next_check_at, updated_at
        from command_apply_check where command_id = ${commandId}::uuid order by version desc limit 1`)
    ).rows as unknown as Row[];
    return r ? rowOf(r) : undefined;
  }

  async outboxOf(outboxId: string): Promise<{ exists: boolean; sentAtMs?: number }> {
    const [r] = (
      await this.database.db.execute(sql`select id, sent_at from outbox where id = ${outboxId}::uuid`)
    ).rows as { id: string; sent_at: Date | string | null }[];
    if (!r) return { exists: false };
    return { exists: true, ...(r.sent_at !== null ? { sentAtMs: ms(r.sent_at) } : {}) };
  }
}
