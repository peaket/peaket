// 알림 표 ops_push_event의 PostgreSQL 읽기(마이그레이션 0028). 행은 트리거가 원래 기록과 같은 트랜잭션에 쓴다(ADR-0360 결정 1).
// 창 판정과 지우기는 DB 시계(now())로 한다: 쓰는 쪽(트리거의 created_at 기본값)과 같은 시계라 파드 시계가 어긋나도 맞다.
import { DATABASE, type Database } from '@peaket/platform';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { rolesOf, type PushEventRow, type PushKind } from '../../domain/live.js';
import type { PushEventSource } from '../../domain/ports.js';

interface Row {
  seq: string | number;
  kind: string;
  event_id: string | null;
  roles: string;
  body: Record<string, unknown> | string;
  created_at: Date | string;
}

/** 트리거가 jsonb로 쓴 시각(timestamptz 글)을 ISO 글로 맞춘다 */
function normalizeTimes(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k.endsWith('At') && typeof v === 'string') {
      const ms = Date.parse(v);
      out[k] = Number.isFinite(ms) ? new Date(ms).toISOString() : v;
    } else out[k] = v;
  }
  return out;
}

export const pushRowOf = (r: Row): PushEventRow => ({
  seq: Number(r.seq),
  kind: r.kind as PushKind,
  eventId: r.event_id,
  roles: rolesOf(r.roles),
  body: normalizeTimes(typeof r.body === 'string' ? (JSON.parse(r.body) as Record<string, unknown>) : r.body),
  createdAtMs: new Date(r.created_at).getTime(),
});

@Injectable()
export class DrizzlePushEvents implements PushEventSource {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async after(seq: number, limit: number): Promise<readonly PushEventRow[]> {
    const rows = (await this.database.db.execute(sql`select seq, kind, event_id, roles, body, created_at from ops_push_event where seq > ${seq} order by seq limit ${limit}`)).rows as unknown as Row[];
    return rows.map(pushRowOf);
  }

  /** seq 뒤 행과 건너뛴 번호(seqs)의 행을 한 문장(한 스냅숏)으로. 번호 목록은 허브가 가진 정수뿐이라 배열 글 하나로 넘긴다 */
  async afterOrAt(seq: number, seqs: readonly number[], limit: number): Promise<readonly PushEventRow[]> {
    if (seqs.length === 0) return this.after(seq, limit);
    const list = `{${seqs.filter((s) => Number.isSafeInteger(s)).join(',')}}`;
    const rows = (
      await this.database.db.execute(
        sql`select seq, kind, event_id, roles, body, created_at from ops_push_event where seq > ${seq} or seq = any(${list}::bigint[]) order by seq limit ${limit}`,
      )
    ).rows as unknown as Row[];
    return rows.map(pushRowOf);
  }

  async latest(): Promise<number> {
    const rows = (await this.database.db.execute(sql`select last_value, is_called from ops_push_event_seq`)).rows as unknown as { last_value: string | number; is_called: boolean }[];
    const r = rows[0];
    return r && r.is_called ? Number(r.last_value) : 0;
  }

  async committedMax(): Promise<number> {
    const rows = (await this.database.db.execute(sql`select coalesce(max(seq), 0) as seq from ops_push_event`)).rows as unknown as { seq: string | number }[];
    return Number(rows[0]?.seq ?? 0);
  }

  async oldestWithin(windowMs: number): Promise<number | undefined> {
    const rows = (await this.database.db.execute(sql`select min(seq) as seq from ops_push_event where created_at >= now() - make_interval(secs => ${windowMs / 1000})`)).rows as unknown as { seq: string | number | null }[];
    const v = rows[0]?.seq;
    return v === null || v === undefined ? undefined : Number(v);
  }

  async deleteOlderThan(windowMs: number): Promise<number> {
    const r = await this.database.db.execute(sql`delete from ops_push_event where created_at < now() - make_interval(secs => ${windowMs / 1000})`);
    return r.rowCount ?? 0;
  }
}
