// 예매 제한 메모리 저장소(단위 시험·개발). 표 없이 행을 그대로 둔다.
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import type { RestrictionRow } from '../domain/booking-restriction.js';
import type { BookingRestrictionStore } from '../domain/ports.js';

export class MemoryBookingRestrictionStore implements BookingRestrictionStore {
  readonly rowsById = new Map<string, RestrictionRow>();
  #audit?: AuditChain;

  constructor(audit?: AuditChain) {
    this.#audit = audit;
  }

  /** AppModule이 메모리 조립의 감사 체인을 늦게 꽂는다 */
  useAudit(audit: AuditChain): void {
    this.#audit = audit;
  }

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

  async insert(row: RestrictionRow, audit?: AuditRecord): Promise<void> {
    this.rowsById.set(row.restrictionId, { ...row });
    if (audit) await this.#audit?.append(audit);
  }

  async update(row: RestrictionRow, audit?: AuditRecord): Promise<void> {
    this.rowsById.set(row.restrictionId, { ...row });
    if (audit) await this.#audit?.append(audit);
  }

  async seed(row: RestrictionRow): Promise<void> {
    this.rowsById.set(row.restrictionId, { ...row });
  }
}
