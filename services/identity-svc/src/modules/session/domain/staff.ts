// 현장 스태프 배정과 스캐너 세션(identity §6.1, offline-gate §6.1, BUILD_ORDER GAT-210·GAT-170).
// 배정·세션의 원본은 identity DB이고, 기기 상태(scanner_device)는 ticket 데이터라 여기 두지 않는다.
export type StaffRole = 'gate_staff' | 'gate_lead';
export type StaffAssignmentStatus = 'INVITED' | 'ASSIGNED' | 'REVOKED' | 'ENDED' | 'EXPIRED';

/** CheckScannerSession이 보는 한 줄. 시각은 밀리초 */
export interface ScannerSessionRecord {
  scannerSessionId: string;
  assignmentId: string;
  /** 배정된 스태프 계정. 계정 상태(ACTIVE)를 함께 보고, 기기 단독 업로드가 기록의 계정을 정할 때도 쓴다(C1-11) */
  accountId: string;
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
  assignmentId?: string;
  validFromMs?: number;
  validUntilMs?: number;
  proxy?: boolean;
  accountId?: string;
}

/**
 * 초대 수락 전에 보는 휴대폰 본인확인 상태(C2-02). 본인확인 저장소·기관을 쓸 수 없으면 UNAVAILABLE이다.
 * 외부 본인확인기관이 붙기 전에는 저장된 본인확인 기록만 본다(기록이 없으면 UNVERIFIED).
 */
export const STAFF_PHONE_VERIFICATION = Symbol.for('peaket.identity.staff-phone-verification');
export interface StaffPhoneVerification {
  statusOf(accountId: string): Promise<'VERIFIED' | 'UNVERIFIED' | 'UNAVAILABLE'>;
}

/** 승인 시점에 계정이 ACTIVE가 아니다(탈퇴·병합과 경합). 유령 스캐너 세션을 만들지 않는다 */
export class StaffAccountInactive extends Error {
  constructor() {
    super('활성 계정이 아니다');
    this.name = 'StaffAccountInactive';
  }
}

/** 같은 기기·계정에 다른 승인이 먼저 세션을 만들었다(동시 승인 경합). 500 대신 409로 닫는다 */
export class ScannerSessionConflict extends Error {
  constructor() {
    super('다른 승인이 먼저 처리되었다');
    this.name = 'ScannerSessionConflict';
  }
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

/** 초대 토큰 수명(24시간)과 한 번에 초대하는 최대 인원(200명 [가정], openapi) */
export const STAFF_INVITE_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const STAFF_INVITE_MAX = 200;
/** 초대 링크 앞부분(기본값 [가정]). 조각(#token=)은 부르는 쪽이 붙인다 */
export const DEFAULT_STAFF_INVITATION_URL = 'https://peaket.example/staff/invitations';
/** 역할 유효 시작은 입장 시작 3시간 전, 끝은 공연 종료 2시간 뒤 [가정](docs/data.md staff_assignment) */
export const STAFF_VALID_BEFORE_MS = 3 * 60 * 60_000;
export const STAFF_VALID_AFTER_MS = 2 * 60 * 60_000;

/** core-svc 판매 설정에서 identity가 읽는 값(회차 소유 확인과 유효 시간, ADR-0353) */
export interface CoreEventOwner {
  promoterId: string;
  startsAtMs: number;
  endsAtMs: number;
  /** 입장 시작 시각. 옛 사본에는 없다 */
  entryOpensAtMs?: number;
}

/** core-svc 내부 판매 설정 읽기(ADR-0353). 없으면 초대 만들기·명단·해제·재발송이 503이다 */
export interface CoreEventOwners {
  find(eventId: string): Promise<CoreEventOwner | undefined>;
}
export const CORE_EVENT_OWNERS = Symbol('identity.CoreEventOwners');

/** 현장 스태프 초대 메일 포트(운영 대행사는 GAT-250/BAT-455). local·ci는 파일 대역만 있다 */
export interface StaffInviteMail {
  to: string;
  link: string;
  expiresAt: number;
  eventId: string;
  role: StaffRole;
  at: number;
}
export interface StaffInviteMailer {
  send(m: StaffInviteMail): Promise<void>;
}
export const STAFF_INVITE_MAILER = Symbol('identity.StaffInviteMailer');

/** 파트너가 만든 초대 한 행. 토큰 원문은 저장소에 넣지 않는다(SHA-256 hex만) */
export interface NewStaffInvitationRow {
  assignmentId: string;
  eventId: string;
  promoterId: string;
  role: StaffRole;
  email: string;
  tokenHash: string;
  expiresAtMs: number;
  invitedBy: string;
  validFromMs: number;
  validUntilMs: number;
}

export type CreateStaffInvitationsResult =
  | { result: 'OK'; created: StaffAssignmentRecord[] }
  | { result: 'DUPLICATE_EMAIL'; emails: string[] };

/** 파트너 명단 한 줄. 이메일·계정 ID는 넣지 않는다(openapi StaffAssignment) */
export interface StaffAssignmentPartnerView {
  assignmentId: string;
  eventId: string;
  nickname?: string;
  role: StaffRole;
  status: StaffAssignmentStatus;
  inviteExpiresAt: string;
  validFrom: string;
  validUntil: string;
}

export type ReissueInvitationResult =
  | { result: 'OK'; assignment: StaffAssignmentRecord }
  | { result: 'NOT_FOUND' }
  | { result: 'ALREADY_ACCEPTED' };

/** 해제 결과. found=false면 없는 배정, changed=false면 이미 끝난 배정(멱등 204) */
export interface RevokeAssignmentResult {
  found: boolean;
  changed: boolean;
  sessions: number;
}

/** 배정·세션 저장소. 계정 요약의 hasStaffAssignment도 같은 저장소를 쓴다 */
export interface StaffAssignmentStore {
  /** 지금(nowMs) 역할 창 안의 ASSIGNED가 있는가(OnDuty, data.md). 미래·지난·취소 배정은 세지 않는다 */
  hasAssigned(accountId: string, nowMs: number): Promise<boolean>;
  findScannerSession(scannerSessionId: string): Promise<ScannerSessionRecord | null>;
  /** 초대 토큰 SHA-256(hex)으로 배정 찾기 */
  findInvitationByTokenHash(tokenHash: string): Promise<StaffAssignmentRecord | null>;
  /** 같은 회차에 이미 INVITED인 이메일(소문자)들. 보내기 전에 중복을 걸러 메일을 헛되이 보내지 않는다 */
  findInvitedEmails(eventId: string, emails: readonly string[]): Promise<string[]>;
  /** 초대 여러 행을 한 트랜잭션으로 만든다. 같은 회차·이메일 INVITED가 있으면 DUPLICATE_EMAIL */
  createInvitations(rows: readonly NewStaffInvitationRow[]): Promise<CreateStaffInvitationsResult>;
  /** 배정 ID로 찾기(파트너 명단·해제·재발송) */
  findAssignmentById(assignmentId: string): Promise<StaffAssignmentRecord | null>;
  /** 회차의 배정 목록(파트너 명단). 이메일·계정 ID 없이 닉네임·역할·상태·시간만. 지난 ASSIGNED는 nowMs 기준 ENDED로 보인다 */
  listByEvent(i: { eventId: string; cursor?: string; limit: number; nowMs: number }): Promise<{ items: StaffAssignmentPartnerView[]; nextCursor?: string }>;
  /** 배정을 REVOKED로 끝내고 초대 이메일·토큰을 지우며 살아 있는 스캐너 세션을 종료한다(control.sessions-terminated) */
  revokeAssignment(i: { assignmentId: string; nowMs: number }): Promise<RevokeAssignmentResult>;
  /** INVITED 배정의 토큰 해시·만료·이메일을 새 값으로 바꾼다. 이미 수락·종료면 ALREADY_ACCEPTED */
  reissueInvitation(i: { assignmentId: string; tokenHash: string; expiresAtMs: number }): Promise<ReissueInvitationResult>;
  /** 계정의 이메일과 검증 여부. 초대 수락의 이메일 일치 확인에 쓴다 */
  accountEmailOf(accountId: string): Promise<{ email?: string; verified: boolean }>;
  /** 계정 상태. 없으면 null. 스캐너 세션 확인이 ACTIVE가 아닌 계정을 거절한다 */
  accountStatusOf(accountId: string): Promise<'ACTIVE' | 'WITHDRAWAL_PENDING' | 'MERGED' | 'DELETED' | null>;
  /** 초대를 수락해 ASSIGNED로 바꾼다. 만료·사용됨·역할 유효 끝 지남·이메일 불일치·중복 배정을 구분한다 */
  acceptInvitation(i: { tokenHash: string; accountId: string; email: string; consentVersion: string; nowMs: number }): Promise<AcceptInvitationResult>;
  /** 초대를 거절해 EXPIRED로 끝낸다. 같은 토큰을 다시 보내도 결과가 같다 */
  rejectInvitation(i: { tokenHash: string; nowMs: number }): Promise<void>;
  /** 내 배정 목록(ASSIGNED·ENDED·REVOKED만). 유효 시작이 늦은 순. 지난 ASSIGNED는 nowMs 기준 ENDED로 보인다 */
  listSelf(i: { accountId: string; cursor?: string; limit: number; nowMs: number }): Promise<{ items: StaffAssignmentSelfView[]; nextCursor?: string }>;
  /** 계정의 ASSIGNED 배정(역할 유효 시간 밖도 포함). 기기 승인 화면·승인 판정이 시간 창을 따로 본다 */
  listAssignedByAccount(i: { accountId: string; nowMs: number }): Promise<StaffAssignmentRecord[]>;
  /** 만료된 INVITED(24시간 또는 역할 유효 끝)와 지난 ASSIGNED를 끝내고 이메일·토큰을 파기한다(하루 한 번, 멱등) */
  expireDueAssignments(nowMs: number): Promise<{ invitations: number; assignments: number }>;
  /** promoter_id가 없는 옛 INVITED·ASSIGNED를 끝낸다(C2-10). identity는 회차 판매자를 갖지 않아 백필할 수 없다 */
  closeLegacyAssignments(): Promise<{ invitations: number; assignments: number }>;
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
  /**
   * 기기 폐기 때 그 기기의 살아 있는 스캐너 세션을 모두 끝내고, 같은 트랜잭션에
   * control.sessions-terminated(reason DEVICE_REVOKED)를 세션마다 적는다(GAT-170 잔여, O-T27).
   * 이미 끝난 세션은 세지 않는다(멱등). 끝낸 수를 돌려준다.
   */
  terminateScannerSessionsByDevice(i: { deviceId: string; reason: 'DEVICE_REVOKED'; nowMs: number }): Promise<number>;
  /**
   * 탈퇴·병합된 계정의 배정을 REVOKED로 끝내고, 그 계정의 살아 있는 스캐너 세션을 모두 끝낸 뒤
   * control.sessions-terminated(reason STAFF_REVOKED)를 세션마다 적는다. 끝낸 배정·세션 수를 돌려준다.
   */
  terminateByAccount(i: { accountId: string; reason: 'STAFF_REVOKED'; nowMs: number }): Promise<{ assignments: number; sessions: number }>;
  /** 탈퇴·병합됐지만 아직 배정·세션이 남은 계정(정비 재시도용). 최대 limit개 */
  inactiveAccountIdsWithStaff(limit: number): Promise<string[]>;
}

export const STAFF_ASSIGNMENT_STORE = Symbol('identity.StaffAssignmentStore');
