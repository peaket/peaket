// 현장 스태프 배정과 스캐너 세션(identity §6.1, offline-gate §6.1, BUILD_ORDER GAT-210·GAT-170).
// 배정·세션의 원본은 identity DB이고, 기기 상태(scanner_device)는 ticket 데이터라 여기 두지 않는다.
export type StaffRole = 'gate_staff' | 'gate_lead';
export type StaffAssignmentStatus = 'INVITED' | 'ASSIGNED' | 'REVOKED' | 'ENDED' | 'EXPIRED';

/** CheckScannerSession이 보는 한 줄. 시각은 밀리초 */
export interface ScannerSessionRecord {
  scannerSessionId: string;
  assignmentId: string;
  deviceId: string;
  role: StaffRole;
  proxy: boolean;
  expiresAt: number;
  lastSeenAtMs?: number;
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

/** staff_assignment 한 행(초대·배정). 초대 이메일과 토큰 해시는 수락·거절 때 지운다. */
export interface StaffAssignmentRecord {
  assignmentId: string;
  accountId: string | null;
  eventId: string;
  role: StaffRole;
  /** 배정 파트너(기기 승인 때 기기의 배정 파트너와 대조한다, I-T22). 파트너 초대 생성이 채운다 */
  promoterId?: string;
  inviteEmail?: string;
  inviteTokenHash?: string;
  inviteExpiresAtMs: number;
  invitedBy: string;
  validFromMs: number;
  validUntilMs: number;
  status: StaffAssignmentStatus;
  acceptedAtMs?: number;
  consentVersion?: string;
}

/** 내 배정 목록 한 줄(SCR-061). 기기 이름은 ticket-svc 데이터라 지금은 null이다. */
export interface StaffAssignmentSelfView {
  assignmentId: string;
  eventId: string;
  role: StaffRole;
  status: 'ASSIGNED' | 'REVOKED' | 'ENDED';
  validFrom: string;
  validUntil: string;
  activeScannerDeviceName: string | null;
}

export type AcceptInvitationResult =
  | { result: 'OK'; assignment: StaffAssignmentRecord }
  | { result: 'INVITATION_INVALID' }
  | { result: 'EMAIL_MISMATCH' }
  | { result: 'ASSIGNMENT_EXISTS' };

/** 배정·세션 저장소. 계정 요약의 hasStaffAssignment도 같은 저장소를 쓴다 */
export interface StaffAssignmentStore {
  hasAssigned(accountId: string): Promise<boolean>;
  findScannerSession(scannerSessionId: string): Promise<ScannerSessionRecord | null>;
  /** 초대 토큰 SHA-256(hex)으로 배정 찾기 */
  findInvitationByTokenHash(tokenHash: string): Promise<StaffAssignmentRecord | null>;
  /** 계정의 이메일과 검증 여부. 초대 수락의 이메일 일치 확인에 쓴다 */
  accountEmailOf(accountId: string): Promise<{ email?: string; verified: boolean }>;
  /** 초대를 수락해 ASSIGNED로 바꾼다. 만료·사용됨·이메일 불일치·중복 배정을 구분한다 */
  acceptInvitation(i: { tokenHash: string; accountId: string; email: string; consentVersion: string; nowMs: number }): Promise<AcceptInvitationResult>;
  /** 초대를 거절해 EXPIRED로 끝낸다. 같은 토큰을 다시 보내도 결과가 같다 */
  rejectInvitation(i: { tokenHash: string; nowMs: number }): Promise<void>;
  /** 내 배정 목록(ASSIGNED·ENDED·REVOKED만). 유효 시작이 늦은 순 */
  listSelf(i: { accountId: string; cursor?: string; limit: number }): Promise<{ items: StaffAssignmentSelfView[]; nextCursor?: string }>;
  /** 계정의 ASSIGNED 배정(역할 유효 시간 밖도 포함). 기기 승인 화면·승인 판정이 시간 창을 따로 본다 */
  listAssignedByAccount(i: { accountId: string; nowMs: number }): Promise<StaffAssignmentRecord[]>;
  /** 기기 승인으로 스캐너 세션을 만든다. 같은 기기·같은 계정의 이전 활성 세션을 먼저 끝낸다(교대) */
  createScannerSession(i: {
    scannerSessionId: string;
    assignmentId: string;
    deviceId: string;
    accountId: string;
    approvedBySession: string;
    role: StaffRole;
    proxy: boolean;
    approvedAtMs: number;
    expiresAtMs: number;
  }): Promise<void>;
  /** 세션의 마지막 연락 시각. 끝난 세션이면 아무것도 하지 않는다 */
  touchScannerSession(scannerSessionId: string, atMs: number): Promise<void>;
  /** 승인 저장소가 승인을 거절했을 때 만든 세션을 되돌린다(끝난 시각을 남긴다) */
  endScannerSession(scannerSessionId: string, atMs: number): Promise<void>;
}

export const STAFF_ASSIGNMENT_STORE = Symbol('identity.StaffAssignmentStore');
