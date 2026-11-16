// export Drizzle 저장소. 파트너 경로는 core_partner(RLS)로 읽고 쓴다.
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { AttendeeExportStore, AttendeeViewRecord } from '../../domain/ports.js';
import { accessLogRetainUntil, type AttendeeExportRecord, type ExportFormat, type ExportResult } from '../../domain/export.js';
import { attendeeExport, attendeeExportAudit } from './schema.js';

const toRecord = (row: typeof attendeeExport.$inferSelect): AttendeeExportRecord => ({
  exportId: row.id,
  promoterId: row.promoterId,
  eventId: row.eventId,
  actorAccountId: row.actorAccountId,
  actorDisplayName: row.actorDisplayName,
  actorRole: row.actorRole,
  reason: row.reason,
  format: row.format as ExportFormat,
  count: row.count,
  result: row.result as ExportResult,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

export class DrizzleAttendeeExportStore implements AttendeeExportStore {
  constructor(private readonly db: Database) {}

  /** 내려받기 이력과 DOWNLOAD 접속기록을 한 트랜잭션에 넣는다. 하나라도 실패하면 둘 다 되돌리고 오류를 던진다(W7-audit A2-19) */
  async recordExport(record: AttendeeExportRecord): Promise<void> {
    await this.db.transaction(
      async (tx) => {
        await tx.insert(attendeeExport).values({
          id: record.exportId,
          promoterId: record.promoterId,
          eventId: record.eventId,
          actorAccountId: record.actorAccountId,
          actorDisplayName: record.actorDisplayName,
          actorRole: record.actorRole,
          reason: record.reason,
          format: record.format,
          count: record.count,
          result: record.result,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        });
        await tx.insert(attendeeExportAudit).values({
          id: record.exportId,
          action: 'DOWNLOAD',
          exportId: record.exportId,
          promoterId: record.promoterId,
          eventId: record.eventId,
          actorAccountId: record.actorAccountId,
          actorDisplayName: record.actorDisplayName,
          actorRole: record.actorRole,
          reason: record.reason,
          format: record.format,
          count: record.count,
          filter: {},
          createdAt: record.createdAt,
          retainUntil: accessLogRetainUntil(record.createdAt),
        });
      },
      { tenantId: record.promoterId, accessMode: 'read write' },
    );
  }

  /** 명단 보기 LIST 접속기록. export_id·reason·format은 없다(0021 CHECK, W7-audit A2-19) */
  async recordView(view: AttendeeViewRecord): Promise<void> {
    await this.db.transaction(
      async (tx) => {
        await tx.insert(attendeeExportAudit).values({
          id: view.auditId,
          action: 'LIST',
          exportId: null,
          promoterId: view.promoterId,
          eventId: view.eventId,
          actorAccountId: view.actorAccountId,
          actorDisplayName: view.actorDisplayName,
          actorRole: view.actorRole,
          reason: null,
          format: null,
          count: view.count,
          filter: view.filter,
          createdAt: view.createdAt,
          retainUntil: accessLogRetainUntil(view.createdAt),
        });
      },
      { tenantId: view.promoterId, accessMode: 'read write' },
    );
  }

  async list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]> {
    return this.db.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(attendeeExport)
          .where(and(eq(attendeeExport.promoterId, promoterId), eq(attendeeExport.eventId, eventId)))
          .orderBy(desc(attendeeExport.createdAt), desc(attendeeExport.id))
          .limit(limit);
        return rows.map(toRecord);
      },
      { tenantId: promoterId, accessMode: 'read only' },
    );
  }
}
