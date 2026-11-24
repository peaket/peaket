// 운영 입장 기록 마감 저장소(Drizzle, offline-gate §7.3 'GAT-180 마감 규칙', 마이그레이션 0019).
// 마감은 회차 단위 잠금(배타)을 잡은 트랜잭션에서 마감 행과 미보고 건 행을 함께 쓴다. 스캔 올리기·큐 보고는 같은 잠금을 공유로 잡는다
// (DrizzleScannerGateStore·putQueueReport). 그래서 업로드는 마감 커밋 전이면 마감 전 기록으로, 커밋 뒤면 '마감 뒤 도착'으로 받는다.
// 후보의 차례 열쇠는 마감해도 지워지지 않는 회차 목록(ticket_event_start.starts_at)에서 읽는다. 그 회차가 그 판단에서
// 마감돼도 다음 판단이 자리를 잇는다. 목록은 ticket 발권 트리거가 유지한다(마이그레이션 0020, IR-03).
import type { Database } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import { decideEntryClose, scannerUnreportedEventKey, type EntryCloseReason } from '../../domain/entry-close.js';
import type { EntryCloseStore } from '../../domain/ports.js';
import { entryClose, scannerQueueReport, scannerUnreportedCase } from './schema.js';

/** 회차 잠금 열쇠(스캔 올리기·큐 보고와 같은 키). 열쇠 글에는 다른 잠금과 섞이지 않게 접두사를 붙인다 */
const lockKey = (eventId: string): string => `ticket-entry-close:${eventId}`;

interface ReportRow {
  scanner_device_id: string;
  pending_uploads: number;
  reported_at: Date | string;
}

interface StartsRow {
  starts_at: Date | string;
}

const msOf = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));

/**
 * 마감 후보 고르기 SQL(IR-03). 회차 목록(ticket_event_start)을 (시작, 회차 ID) 차례로 읽고,
 * 마감 행이 없고 아직 시작 시각이 있는 티켓 행이 있는 회차만 준다. int 시험이 EXPLAIN으로 계획을 본다.
 */
export function entryCloseCandidatesQuery(i: { nowMs: number; limit: number; after?: { startsAtMs: number; eventId: string } }): SQL {
  const now = new Date(i.nowMs);
  const after = i.after;
  return sql`
    select s.event_id::text as event_id
    from ticket_event_start s
    where s.starts_at <= ${now}
      and not exists (select 1 from entry_close c where c.event_id = s.event_id)
      and exists (select 1 from ticket t where t.event_id = s.event_id and t.event_starts_at is not null)
      ${
        after !== undefined
          ? sql`and (s.starts_at > ${new Date(after.startsAtMs)} or (s.starts_at = ${new Date(after.startsAtMs)} and s.event_id > ${after.eventId}))`
          : sql``
      }
    order by s.starts_at asc, s.event_id asc
    limit ${i.limit}
  `;
}

export class DrizzleEntryCloseStore implements EntryCloseStore {
  constructor(private readonly database: Database) {}

  /** 배치가 없으면 저장하지 않는다. 받은 시각은 nowMs(서버 시각) */
  async putQueueReport(i: { eventId: string; deviceId: string; pendingUploads: number; nowMs: number }): Promise<'stored' | 'no_placement'> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${lockKey(i.eventId)}, 0))`);
      const placed = (await tx.execute(sql`select 1 from scanner_placement where event_id = ${i.eventId} and scanner_device_id = ${i.deviceId} limit 1`)).rows;
      if (placed.length === 0) return 'no_placement';
      await tx
        .insert(scannerQueueReport)
        .values({ eventId: i.eventId, scannerDeviceId: i.deviceId, pendingUploads: i.pendingUploads, reportedAt: new Date(i.nowMs) })
        .onConflictDoUpdate({
          target: [scannerQueueReport.eventId, scannerQueueReport.scannerDeviceId],
          set: { pendingUploads: i.pendingUploads, reportedAt: new Date(i.nowMs) },
        });
      return 'stored';
    });
  }

  async candidates(i: { nowMs: number; limit: number; afterEventId?: string }): Promise<string[]> {
    let after: { startsAtMs: number; eventId: string } | undefined;
    if (i.afterEventId !== undefined) {
      const rows = (await this.database.db.execute(sql`select starts_at from ticket_event_start where event_id = ${i.afterEventId} limit 1`)).rows as unknown as StartsRow[];
      const v = rows[0]?.starts_at;
      if (v !== undefined && v !== null) after = { startsAtMs: msOf(v), eventId: i.afterEventId };
    }
    const rows = (await this.database.db.execute(entryCloseCandidatesQuery({ nowMs: i.nowMs, limit: i.limit, ...(after !== undefined ? { after } : {}) }))).rows as unknown as {
      event_id: string;
    }[];
    return rows.map((r) => r.event_id);
  }

  async close(i: { eventId: string; nowMs: number; endsAtMs: number; clockNow: () => number }): Promise<{ closed: boolean; reason?: EntryCloseReason; closedAtMs?: number; unreported: number }> {
    return this.database.transaction(async (tx) => {
      // 여러 파드가 같은 회차를 함께 판단해도 한 번만 쓴다. 업로드·큐 보고(공유)가 끝난 뒤에 잡는다
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(i.eventId)}, 0))`);
      const existing = (await tx.execute(sql`select 1 from entry_close where event_id = ${i.eventId} limit 1`)).rows;
      if (existing.length > 0) return { closed: false, unreported: 0 };
      const deviceRows = (await tx.execute(sql`select distinct scanner_device_id from scanner_readiness where event_id = ${i.eventId}`)).rows as unknown as { scanner_device_id: string }[];
      const reportRows = (
        await tx.execute(sql`select scanner_device_id, pending_uploads, reported_at from scanner_queue_report where event_id = ${i.eventId}`)
      ).rows as unknown as ReportRow[];
      const reports = new Map(reportRows.map((r) => [r.scanner_device_id, { pendingUploads: Number(r.pending_uploads), reportedAtMs: msOf(r.reported_at) }]));
      const decision = decideEntryClose({
        nowMs: i.nowMs,
        endsAtMs: i.endsAtMs,
        devices: deviceRows.map((d) => ({ deviceId: d.scanner_device_id, ...(reports.has(d.scanner_device_id) ? { report: reports.get(d.scanner_device_id)! } : {}) })),
      });
      if (!decision.close) return { closed: false, unreported: 0 };
      // 마감 시각은 잠금을 잡은 뒤에 읽는다. 잠금 전에 커밋된 업로드의 받은 시각은 모두 마감 시각 이하가 된다
      const closedAtMs = i.clockNow();
      const inserted = await tx
        .insert(entryClose)
        .values({ eventId: i.eventId, closedAt: new Date(closedAtMs), reason: decision.reason, roleEndsAt: new Date(decision.roleEndsAtMs) })
        .onConflictDoNothing()
        .returning({ eventId: entryClose.eventId });
      if (inserted.length === 0) return { closed: false, unreported: 0 };
      for (const deviceId of decision.unreportedDeviceIds) {
        await tx
          .insert(scannerUnreportedCase)
          .values({ eventId: i.eventId, scannerDeviceId: deviceId, eventKey: scannerUnreportedEventKey(i.eventId, deviceId), createdAt: new Date(closedAtMs) })
          .onConflictDoNothing();
      }
      return { closed: true, reason: decision.reason, closedAtMs, unreported: decision.unreportedDeviceIds.length };
    });
  }

  async closedAt(eventId: string): Promise<number | undefined> {
    const rows = (await this.database.db.execute(sql`select closed_at from entry_close where event_id = ${eventId} limit 1`)).rows as unknown as { closed_at: Date | string }[];
    return rows[0] ? msOf(rows[0].closed_at) : undefined;
  }

  async pendingCoreSync(limit: number): Promise<{ eventId: string; closedAtMs: number }[]> {
    const rows = (
      await this.database.db.execute(sql`
        select event_id::text as event_id, closed_at from entry_close
        where core_synced_at is null
        order by closed_at asc, event_id::text asc
        limit ${limit}
      `)
    ).rows as unknown as { event_id: string; closed_at: Date | string }[];
    return rows.map((r) => ({ eventId: r.event_id, closedAtMs: msOf(r.closed_at) }));
  }

  async markCoreSynced(eventId: string, nowMs: number): Promise<void> {
    await this.database.db.execute(sql`update entry_close set core_synced_at = ${new Date(nowMs)} where event_id = ${eventId}`);
  }

  async pendingCases(limit: number): Promise<{ eventId: string; deviceId: string; eventKey: string; createdAtMs: number }[]> {
    const rows = (
      await this.database.db.execute(sql`
        select event_id::text as event_id, scanner_device_id::text as device_id, event_key::text as event_key, created_at
        from scanner_unreported_case
        where opened_at is null
        order by created_at asc, event_id::text asc, scanner_device_id::text asc
        limit ${limit}
      `)
    ).rows as unknown as { event_id: string; device_id: string; event_key: string; created_at: Date | string }[];
    return rows.map((r) => ({ eventId: r.event_id, deviceId: r.device_id, eventKey: r.event_key, createdAtMs: msOf(r.created_at) }));
  }

  async markCaseOpened(eventId: string, deviceId: string, nowMs: number): Promise<void> {
    await this.database.db.execute(sql`update scanner_unreported_case set opened_at = ${new Date(nowMs)} where event_id = ${eventId} and scanner_device_id = ${deviceId}`);
  }
}
