// 운영 경보의 PostgreSQL 구현. (event_key, kind) 하나를 유일 인덱스로 지킨다.
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
});

@Injectable()
export class DrizzleOpsAlertStore implements OpsAlertStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async open(input: Parameters<OpsAlertStore['open']>[0]): Promise<OpsAlert> {
    await this.database.db.execute(sql`
      insert into ops_alert (id, event_key, kind, severity, source, reason, detail, created_at)
      values (${input.alertId}::uuid, ${input.eventKey}, ${input.kind}, ${input.severity}, ${input.source}, ${input.reason}, ${JSON.stringify(input.detail)}::jsonb, ${new Date(input.nowMs)}::timestamptz)
      on conflict (event_key, kind) do nothing`);
    const rows = (await this.database.db.execute(sql`select * from ops_alert where event_key = ${input.eventKey} and kind = ${input.kind}`)).rows as unknown as Row[];
    return toAlert(rows[0]!);
  }
}
