// export 메모리 저장소(단위 시험·개발).
import type { AttendeeExportStore } from '../domain/ports.js';
import type { AttendeeExportRecord } from '../domain/export.js';

export class MemoryAttendeeExportStore implements AttendeeExportStore {
  readonly rows: AttendeeExportRecord[] = [];
  readonly audits: AttendeeExportRecord[] = [];

  async insert(record: AttendeeExportRecord): Promise<void> {
    this.rows.push({ ...record });
  }

  async audit(record: AttendeeExportRecord): Promise<void> {
    this.audits.push({ ...record });
  }

  async list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]> {
    return this.rows
      .filter((r) => r.promoterId === promoterId && r.eventId === eventId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
