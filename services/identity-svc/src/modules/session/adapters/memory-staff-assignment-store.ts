// 시험·로컬용 배정·스캐너 세션 저장소. 운영은 DrizzleStaffAssignmentStore를 쓴다.
import type { ScannerSessionRecord, StaffAssignmentStore } from '../domain/staff.js';

export interface MemoryStaffAssignmentRow {
  id: string;
  accountId: string | null;
  status: 'INVITED' | 'ASSIGNED' | 'REVOKED' | 'ENDED' | 'EXPIRED';
}

export class MemoryStaffAssignmentStore implements StaffAssignmentStore {
  readonly assignments = new Map<string, MemoryStaffAssignmentRow>();
  readonly sessions = new Map<string, ScannerSessionRecord>();

  async hasAssigned(accountId: string): Promise<boolean> {
    for (const a of this.assignments.values()) if (a.accountId === accountId && a.status === 'ASSIGNED') return true;
    return false;
  }

  async findScannerSession(scannerSessionId: string): Promise<ScannerSessionRecord | null> {
    return this.sessions.get(scannerSessionId) ?? null;
  }
}
