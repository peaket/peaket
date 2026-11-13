// 현장 스태프 배정과 스캐너 세션(identity §6.1, offline-gate §6.1, BUILD_ORDER GAT-210·GAT-170).
// 배정·세션의 원본은 identity DB이고, 기기 상태(scanner_device)는 ticket 데이터라 여기 두지 않는다.
export type StaffRole = 'gate_staff' | 'gate_lead';
export type StaffAssignmentStatus = 'INVITED' | 'ASSIGNED' | 'REVOKED' | 'ENDED' | 'EXPIRED';

/** CheckScannerSession이 보는 한 줄. 시각은 밀리초 */
export interface ScannerSessionRecord {
  scannerSessionId: string;
  deviceId: string;
  role: StaffRole;
  proxy: boolean;
  expiresAt: number;
  terminatedAt: number | null;
  assignmentStatus: StaffAssignmentStatus;
  validFrom: number;
  validUntil: number;
  eventId: string;
}

/** gRPC CheckScannerSessionResponse로 옮기는 답 */
export interface ScannerSessionAnswer {
  valid: boolean;
  role?: StaffRole;
  eventId?: string;
}

/** 배정·세션 저장소. 계정 요약의 hasStaffAssignment도 같은 저장소를 쓴다 */
export interface StaffAssignmentStore {
  hasAssigned(accountId: string): Promise<boolean>;
  findScannerSession(scannerSessionId: string): Promise<ScannerSessionRecord | null>;
}

export const STAFF_ASSIGNMENT_STORE = Symbol('identity.StaffAssignmentStore');
