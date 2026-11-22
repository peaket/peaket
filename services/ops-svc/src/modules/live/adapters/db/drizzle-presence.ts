// 접속자 표 ops_presence의 PostgreSQL 구현(마이그레이션 0028). 기본 키 (account_ref, event_id)라 같은 사람이 두 회차를 보면 두 행이다.
import { DATABASE, type Database } from '@peaket/platform';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PresenceEntry, PresenceStore } from '../../domain/ports.js';

interface Row {
  account_ref: string;
  event_id: string;
  role: string;
  screen: string;
}

@Injectable()
export class DrizzlePresence implements PresenceStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async touch(e: PresenceEntry & { eventId: string; nowMs: number }): Promise<void> {
    await this.database.db.execute(sql`
      insert into ops_presence (account_ref, event_id, role, screen, last_seen_at)
      values (${e.accountRef}::uuid, ${e.eventId}::uuid, ${e.role}, ${e.screen}, ${new Date(e.nowMs)}::timestamptz)
      on conflict (account_ref, event_id) do update set role = excluded.role, screen = excluded.screen, last_seen_at = greatest(ops_presence.last_seen_at, excluded.last_seen_at)`);
  }

  async activeByEvent(eventIds: readonly string[], windowMs: number, nowMs: number): Promise<ReadonlyMap<string, readonly PresenceEntry[]>> {
    const out = new Map<string, PresenceEntry[]>();
    if (eventIds.length === 0) return out;
    const since = new Date(nowMs - windowMs);
    const list = sql.join(
      eventIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const rows = (
      await this.database.db.execute(sql`
        select account_ref, event_id, role, screen from ops_presence
        where event_id in (${list}) and last_seen_at > ${since}::timestamptz
        order by event_id, account_ref`)
    ).rows as unknown as Row[];
    for (const r of rows) {
      const arr = out.get(r.event_id) ?? [];
      arr.push({ accountRef: r.account_ref, role: r.role, screen: r.screen });
      out.set(r.event_id, arr);
    }
    return out;
  }

  async deleteOlderThan(windowMs: number, nowMs: number): Promise<number> {
    const r = await this.database.db.execute(sql`delete from ops_presence where last_seen_at <= ${new Date(nowMs - windowMs)}::timestamptz`);
    return r.rowCount ?? 0;
  }
}
