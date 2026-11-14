// 운영 경보의 PostgreSQL 구현. (event_key, kind) 하나를 유일 인덱스로 지킨다.
// 풀린 경보도 행을 지우지 않고 resolved_at·resolved_reason을 남긴다. 다시 나빠지면 open이 같은 행을 다시 연다(O-T20).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { OpsAlert, OpsAlertSeverity, OpsAlertStore } from '../../domain/ops-alert.js';

interface Row {
  id: string;
  event_key: string;
  kind: string;
  severity: string;
  source: string;
  reason: string;
  detail: Record<string, unknown> | string;
  created_at: Date | string;
  resolved_at: Date | string | null;
  resolved_reason: string | null;
}

const toAlert = (r: Row): OpsAlert => ({
  alertId: r.id,
  eventKey: r.event_key,
  kind: r.kind,
  severity: r.severity as OpsAlertSeverity,
  source: r.source,
  reason: r.reason,
  detail: typeof r.detail === 'string' ? (JSON.parse(r.detail) as Record<string, unknown>) : r.detail,
  createdAtMs: new Date(r.created_at).getTime(),
  ...(r.resolved_at !== null ? { resolvedAtMs: new Date(r.resolved_at).getTime() } : {}),
  ...(r.resolved_reason !== null ? { resolvedReason: r.resolved_reason } : {}),
});

@Injectable()
export class DrizzleOpsAlertStore implements OpsAlertStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async open(input: Parameters<OpsAlertStore['open']>[0]): Promise<OpsAlert> {
    await this.database.db.execute(sql`
      insert into ops_alert (id, event_key, kind, severity, source, reason, detail, created_at)
      values (${input.alertId}::uuid, ${input.eventKey}, ${input.kind}, ${input.severity}, ${input.source}, ${input.reason}, ${JSON.stringify(input.detail)}::jsonb, ${new Date(input.nowMs)}::timestamptz)
      on conflict (event_key, kind) do update set
        severity = excluded.severity,
        source = excluded.source,
        reason = excluded.reason,
        detail = excluded.detail,
        created_at = excluded.created_at,
        resolved_at = null,
        resolved_reason = null
      where ops_alert.resolved_at is not null`);
    const rows = (await this.database.db.execute(sql`select * from ops_alert where event_key = ${input.eventKey} and kind = ${input.kind}`)).rows as unknown as Row[];
    return toAlert(rows[0]!);
  }

  async resolve(input: Parameters<OpsAlertStore['resolve']>[0]): Promise<OpsAlert | undefined> {
    const rows = (
      await this.database.db.execute(sql`
        update ops_alert set resolved_at = coalesce(resolved_at, ${new Date(input.nowMs)}::timestamptz), resolved_reason = coalesce(resolved_reason, ${input.reason})
        where event_key = ${input.eventKey} and kind = ${input.kind}
        returning *`)
    ).rows as unknown as Row[];
    return rows[0] ? toAlert(rows[0]) : undefined;
  }
}
