// 예매 제한 메모리 저장소(단위 시험·개발). 표 없이 행을 그대로 둔다.
import type { AuditRecord } from '../../audit/audit.js';
import type { RestrictionRow } from '../domain/booking-restriction.js';
import type { BookingRestrictionStore } from '../domain/ports.js';

export class MemoryBookingRestrictionStore implements BookingRestrictionStore {
  readonly rowsById = new Map<string, RestrictionRow>();

  async rows(): Promise<RestrictionRow[]> {
    return [...this.rowsById.values()].map((r) => ({ ...r }));
  }

  async find(restrictionId: string): Promise<RestrictionRow | undefined> {
    const r = this.rowsById.get(restrictionId);
    return r ? { ...r } : undefined;
  }

  async findByApproval(approvalId: string): Promise<RestrictionRow | undefined> {
    const r = [...this.rowsById.values()].find((x) => x.approvalId === approvalId);
    return r ? { ...r } : undefined;
  }

  async insert(row: RestrictionRow, _audit?: AuditRecord): Promise<void> {
    this.rowsById.set(row.restrictionId, { ...row });
  }

  async update(row: RestrictionRow, _audit?: AuditRecord): Promise<void> {
    this.rowsById.set(row.restrictionId, { ...row });
  }

  async seed(row: RestrictionRow): Promise<void> {
    this.rowsById.set(row.restrictionId, { ...row });
  }
}
