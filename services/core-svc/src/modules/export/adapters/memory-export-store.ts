// export 메모리 저장소(단위 시험·개발).
import type { AttendeeExportStore, AttendeeViewRecord } from '../domain/ports.js';
import type { AttendeeExportRecord } from '../domain/export.js';

export class MemoryAttendeeExportStore implements AttendeeExportStore {
  /** 내려받기 이력 */
  readonly rows: AttendeeExportRecord[] = [];
  /** DOWNLOAD 접속기록 */
  readonly audits: AttendeeExportRecord[] = [];
  /** 명단 보기 LIST 접속기록(W7-audit A2-19) */
  readonly views: AttendeeViewRecord[] = [];

  async insert(record: AttendeeExportRecord): Promise<void> {
    this.rows.push({ ...record });
  }

  async audit(record: AttendeeExportRecord): Promise<void> {
    this.audits.push({ ...record });
  }

  /** 뼈대(W7-audit 시험 단계). 구현 담당이 채운다(A2-19) */
  async recordExport(_record: AttendeeExportRecord): Promise<void> {
    throw new Error('아직 없음');
  }

  /** 뼈대(W7-audit 시험 단계). 구현 담당이 채운다(A2-19) */
  async recordView(_view: AttendeeViewRecord): Promise<void> {
    throw new Error('아직 없음');
  }

  async list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]> {
    return this.rows
      .filter((r) => r.promoterId === promoterId && r.eventId === eventId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
