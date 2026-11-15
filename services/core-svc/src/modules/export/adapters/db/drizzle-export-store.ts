// export Drizzle 저장소. 파트너 경로는 core_partner(RLS)로 읽고 쓴다.
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { AttendeeExportStore } from '../../domain/ports.js';
import type { AttendeeExportRecord, ExportFormat, ExportResult } from '../../domain/export.js';
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

  async insert(record: AttendeeExportRecord): Promise<void> {
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
      },
      { tenantId: record.promoterId, accessMode: 'read write' },
    );
  }

  async audit(record: AttendeeExportRecord): Promise<void> {
    await this.db.transaction(
      async (tx) => {
        await tx.insert(attendeeExportAudit).values({
          id: record.exportId,
          exportId: record.exportId,
          promoterId: record.promoterId,
          eventId: record.eventId,
          actorAccountId: record.actorAccountId,
          actorDisplayName: record.actorDisplayName,
          actorRole: record.actorRole,
          reason: record.reason,
          format: record.format,
          count: record.count,
          createdAt: record.createdAt,
          retainUntil: new Date(record.createdAt.getTime() + 2 * 365 * 24 * 60 * 60 * 1000),
        });
      },
      { tenantId: record.promoterId, accessMode: 'read write' },
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
