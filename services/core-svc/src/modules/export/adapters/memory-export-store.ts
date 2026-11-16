// export 메모리 저장소(단위 시험·개발).
import type { AttendeeExportStore, AttendeeViewRecord } from '../domain/ports.js';
import type { AttendeeExportRecord } from '../domain/export.js';

export class MemoryAttendeeExportStore implements AttendeeExportStore {
  /** 내려받기 이력 */
  readonly rows: AttendeeExportRecord[] = [];
  /** DOWNLOAD 접속기록(받은 접속지를 붙인다, 리뷰 R2. 뼈대: 구현 담당이 clientIp를 채운다) */
  readonly audits: (AttendeeExportRecord & { clientIp?: string })[] = [];
  /** 명단 보기 LIST 접속기록(W7-audit A2-19) */
  readonly views: AttendeeViewRecord[] = [];

  /** 이력과 DOWNLOAD 접속기록을 함께 남긴다(Drizzle은 한 트랜잭션) */
  async recordExport(record: AttendeeExportRecord, _access?: { clientIp: string }): Promise<void> {
    this.rows.push({ ...record });
    this.audits.push({ ...record });
  }

  async recordView(view: AttendeeViewRecord): Promise<void> {
    this.views.push({ ...view, filter: { ...view.filter } });
  }

  async list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]> {
    return this.rows
      .filter((r) => r.promoterId === promoterId && r.eventId === eventId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
