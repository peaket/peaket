// 시험·로컬용 배정·스캐너 세션 저장소. 운영은 DrizzleStaffAssignmentStore를 쓴다.
import {
  type AcceptInvitationResult,
  type CreateStaffInvitationsResult,
  type NewStaffInvitationRow,
  type ReissueInvitationResult,
  type RevokeAssignmentResult,
  type ScannerSessionRecord,
  StaffAccountInactive,
  type StaffAssignmentPartnerView,
  type StaffAssignmentRecord,
  type StaffAssignmentSelfView,
  type StaffAssignmentStatus,
  type StaffAssignmentStore,
  type StaffRole,
} from '../domain/staff.js';

export interface MemoryStaffAssignmentRow {
  id: string;
  accountId: string | null;
  status: 'INVITED' | 'ASSIGNED' | 'REVOKED' | 'ENDED' | 'EXPIRED';
  eventId?: string;
  role?: StaffRole;
  promoterId?: string;
  inviteEmail?: string;
  inviteTokenHash?: string;
  inviteExpiresAtMs?: number;
  invitedBy?: string;
  validFromMs?: number;
  validUntilMs?: number;
  acceptedAtMs?: number;
  consentVersion?: string;
}

const recordOf = (a: MemoryStaffAssignmentRow): StaffAssignmentRecord => ({
  assignmentId: a.id,
  accountId: a.accountId,
  eventId: a.eventId ?? '',
  role: a.role ?? 'gate_staff',
  ...(a.promoterId !== undefined ? { promoterId: a.promoterId } : {}),
  ...(a.inviteEmail !== undefined ? { inviteEmail: a.inviteEmail } : {}),
  ...(a.inviteTokenHash !== undefined ? { inviteTokenHash: a.inviteTokenHash } : {}),
  inviteExpiresAtMs: a.inviteExpiresAtMs ?? 0,
  invitedBy: a.invitedBy ?? '',
  validFromMs: a.validFromMs ?? 0,
  validUntilMs: a.validUntilMs ?? 0,
  status: a.status as StaffAssignmentStatus,
  ...(a.acceptedAtMs !== undefined ? { acceptedAtMs: a.acceptedAtMs } : {}),
  ...(a.consentVersion !== undefined ? { consentVersion: a.consentVersion } : {}),
});

const cursorOf = (validFromMs: number, assignmentId: string): string => Buffer.from(JSON.stringify([validFromMs, assignmentId]), 'utf8').toString('base64url');
const parseCursor = (raw: string): { validFromMs: number; assignmentId: string } | undefined => {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'string') return undefined;
    return { validFromMs: v[0], assignmentId: v[1] };
  } catch {
    return undefined;
  }
};

export class MemoryStaffAssignmentStore implements StaffAssignmentStore {
  readonly assignments = new Map<string, MemoryStaffAssignmentRow>();
  readonly sessions = new Map<string, ScannerSessionRecord>();
  readonly accounts = new Map<string, { email?: string; verified: boolean; status?: 'ACTIVE' | 'WITHDRAWAL_PENDING' | 'MERGED' | 'DELETED'; nickname?: string }>();
  /** 기기 폐기로 끝낸 세션의 control.sessions-terminated 값(시험 확인용) */
  readonly terminatedEvents: { accountId: string; sessionId: string; reason: string; terminatedAt: string }[] = [];

  /** local·memory 조립에서 세션 저장소의 계정 상태를 읽는다. 없으면 null(비ACTIVE)로 닫는다 */
  constructor(private readonly accountStatus?: (accountId: string) => 'ACTIVE' | 'WITHDRAWAL_PENDING' | 'MERGED' | 'DELETED' | undefined) {}

  #statusOf(accountId: string): 'ACTIVE' | 'WITHDRAWAL_PENDING' | 'MERGED' | 'DELETED' | null {
    return this.accounts.get(accountId)?.status ?? this.accountStatus?.(accountId) ?? null;
  }

  async hasAssigned(accountId: string): Promise<boolean> {
    for (const a of this.assignments.values()) if (a.accountId === accountId && a.status === 'ASSIGNED') return true;
    return false;
  }

  async findScannerSession(scannerSessionId: string): Promise<ScannerSessionRecord | null> {
    return this.sessions.get(scannerSessionId) ?? null;
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<StaffAssignmentRecord | null> {
    for (const a of this.assignments.values()) if (a.inviteTokenHash === tokenHash) return recordOf(a);
    return null;
  }

  async findInvitedEmails(eventId: string, emails: readonly string[]): Promise<string[]> {
    const want = new Set(emails.map((e) => e.toLowerCase()));
    const out = new Set<string>();
    for (const a of this.assignments.values()) {
      if (a.eventId === eventId && a.status === 'INVITED' && a.inviteEmail !== undefined && want.has(a.inviteEmail.toLowerCase())) out.add(a.inviteEmail.toLowerCase());
    }
    return [...out];
  }

  async createInvitations(rows: readonly NewStaffInvitationRow[]): Promise<CreateStaffInvitationsResult> {
    const eventId = rows[0]?.eventId;
    if (eventId === undefined) return { result: 'OK', created: [] };
    const duplicate = await this.findInvitedEmails(eventId, rows.map((r) => r.email));
    if (duplicate.length > 0) return { result: 'DUPLICATE_EMAIL', emails: duplicate };
    const created: StaffAssignmentRecord[] = [];
    for (const r of rows) {
      const row: MemoryStaffAssignmentRow = {
        id: r.assignmentId,
        accountId: null,
        status: 'INVITED',
        eventId: r.eventId,
        role: r.role,
        promoterId: r.promoterId,
        inviteEmail: r.email,
        inviteTokenHash: r.tokenHash,
        inviteExpiresAtMs: r.expiresAtMs,
        invitedBy: r.invitedBy,
        validFromMs: r.validFromMs,
        validUntilMs: r.validUntilMs,
      };
      this.assignments.set(row.id, row);
      created.push(recordOf(row));
    }
    return { result: 'OK', created };
  }

  async findAssignmentById(assignmentId: string): Promise<StaffAssignmentRecord | null> {
    const row = this.assignments.get(assignmentId);
    return row ? recordOf(row) : null;
  }

  async listByEvent(i: { eventId: string; cursor?: string; limit: number }): Promise<{ items: StaffAssignmentPartnerView[]; nextCursor?: string }> {
    const cursor = i.cursor ? parseCursor(i.cursor) : undefined;
    const all = [...this.assignments.values()]
      .filter((a) => a.eventId === i.eventId)
      .sort((a, b) => (b.validFromMs ?? 0) - (a.validFromMs ?? 0) || b.id.localeCompare(a.id));
    const filtered = cursor ? all.filter((a) => (a.validFromMs ?? 0) < cursor.validFromMs || ((a.validFromMs ?? 0) === cursor.validFromMs && a.id < cursor.assignmentId)) : all;
    const page = filtered.slice(0, i.limit);
    const last = page.at(-1);
    return {
      items: page.map((a) => {
        const nickname = a.accountId === null ? undefined : this.accounts.get(a.accountId)?.nickname;
        return {
          assignmentId: a.id,
          eventId: a.eventId ?? '',
          ...(nickname !== undefined ? { nickname } : {}),
          role: a.role ?? 'gate_staff',
          status: a.status,
          inviteExpiresAt: new Date(a.inviteExpiresAtMs ?? 0).toISOString(),
          validFrom: new Date(a.validFromMs ?? 0).toISOString(),
          validUntil: new Date(a.validUntilMs ?? 0).toISOString(),
        };
      }),
      ...(filtered.length > i.limit && last ? { nextCursor: cursorOf(last.validFromMs ?? 0, last.id) } : {}),
    };
  }

  async revokeAssignment(i: { assignmentId: string; nowMs: number }): Promise<RevokeAssignmentResult> {
    const row = this.assignments.get(i.assignmentId);
    if (!row) return { found: false, changed: false, sessions: 0 };
    if (row.status !== 'INVITED' && row.status !== 'ASSIGNED') return { found: true, changed: false, sessions: 0 };
    this.assignments.set(i.assignmentId, { ...row, status: 'REVOKED', inviteEmail: undefined, inviteTokenHash: undefined });
    let sessions = 0;
    for (const [id, s] of this.sessions) {
      if (s.assignmentId !== i.assignmentId || s.terminatedAt !== null) continue;
      this.sessions.set(id, { ...s, terminatedAt: i.nowMs });
      if (row.accountId) this.terminatedEvents.push({ accountId: row.accountId, sessionId: id, reason: 'STAFF_REVOKED', terminatedAt: new Date(i.nowMs).toISOString() });
      sessions++;
    }
    return { found: true, changed: true, sessions };
  }

  async reissueInvitation(i: { assignmentId: string; tokenHash: string; expiresAtMs: number }): Promise<ReissueInvitationResult> {
    const row = this.assignments.get(i.assignmentId);
    if (!row) return { result: 'NOT_FOUND' };
    if (row.status !== 'INVITED' || row.inviteEmail === undefined) return { result: 'ALREADY_ACCEPTED' };
    const next: MemoryStaffAssignmentRow = { ...row, inviteTokenHash: i.tokenHash, inviteExpiresAtMs: i.expiresAtMs };
    this.assignments.set(i.assignmentId, next);
    return { result: 'OK', assignment: recordOf(next) };
  }

  async accountEmailOf(accountId: string): Promise<{ email?: string; verified: boolean }> {
    return this.accounts.get(accountId) ?? { verified: false };
  }

  async accountStatusOf(accountId: string): Promise<'ACTIVE' | 'WITHDRAWAL_PENDING' | 'MERGED' | 'DELETED' | null> {
    return this.#statusOf(accountId);
  }

  async acceptInvitation(i: { tokenHash: string; accountId: string; email: string; consentVersion: string; nowMs: number }): Promise<AcceptInvitationResult> {
    const row = [...this.assignments.values()].find((a) => a.inviteTokenHash === i.tokenHash);
    if (!row || row.status !== 'INVITED' || (row.inviteExpiresAtMs ?? 0) <= i.nowMs) return { result: 'INVITATION_INVALID' };
    if (row.inviteEmail === undefined || row.inviteEmail.toLowerCase() !== i.email.toLowerCase()) return { result: 'EMAIL_MISMATCH' };
    for (const a of this.assignments.values()) {
      if (a.id !== row.id && a.eventId === row.eventId && a.accountId === i.accountId && a.status === 'ASSIGNED') return { result: 'ASSIGNMENT_EXISTS' };
    }
    const next: MemoryStaffAssignmentRow = {
      ...row,
      accountId: i.accountId,
      status: 'ASSIGNED',
      acceptedAtMs: i.nowMs,
      consentVersion: i.consentVersion,
      inviteEmail: undefined,
      inviteTokenHash: undefined,
    };
    this.assignments.set(row.id, next);
    return { result: 'OK', assignment: recordOf(next) };
  }

  async rejectInvitation(i: { tokenHash: string; nowMs: number }): Promise<void> {
    for (const [id, a] of this.assignments) {
      if (a.inviteTokenHash === i.tokenHash && a.status === 'INVITED') {
        this.assignments.set(id, { ...a, status: 'EXPIRED', inviteEmail: undefined, inviteTokenHash: undefined });
      }
    }
  }

  async listSelf(i: { accountId: string; cursor?: string; limit: number }): Promise<{ items: StaffAssignmentSelfView[]; nextCursor?: string }> {
    const cursor = i.cursor ? parseCursor(i.cursor) : undefined;
    const all = [...this.assignments.values()]
      .filter((a) => a.accountId === i.accountId && (a.status === 'ASSIGNED' || a.status === 'ENDED' || a.status === 'REVOKED'))
      .sort((a, b) => (b.validFromMs ?? 0) - (a.validFromMs ?? 0) || b.id.localeCompare(a.id));
    const filtered = cursor ? all.filter((a) => (a.validFromMs ?? 0) < cursor.validFromMs || ((a.validFromMs ?? 0) === cursor.validFromMs && a.id < cursor.assignmentId)) : all;
    const page = filtered.slice(0, i.limit);
    const last = page.at(-1);
    return {
      items: page.map((a) => ({
        assignmentId: a.id,
        eventId: a.eventId ?? '',
        role: a.role ?? 'gate_staff',
        status: a.status as 'ASSIGNED' | 'REVOKED' | 'ENDED',
        validFrom: new Date(a.validFromMs ?? 0).toISOString(),
        validUntil: new Date(a.validUntilMs ?? 0).toISOString(),
        activeScannerDeviceName: null,
      })),
      ...(filtered.length > i.limit && last ? { nextCursor: cursorOf(last.validFromMs ?? 0, last.id) } : {}),
    };
  }

  async listAssignedByAccount(i: { accountId: string; nowMs: number }): Promise<StaffAssignmentRecord[]> {
    void i.nowMs;
    return [...this.assignments.values()]
      .filter((a) => a.accountId === i.accountId && a.status === 'ASSIGNED')
      .map(recordOf);
  }

  async createScannerSession(i: {
    scannerSessionId: string;
    assignmentId: string;
    deviceId: string;
    accountId: string;
    approvedBySession: string;
    role: StaffRole;
    proxy: boolean;
    approvedAtMs: number;
    expiresAtMs: number;
  }): Promise<void> {
    if (this.#statusOf(i.accountId) !== 'ACTIVE') throw new StaffAccountInactive();
    for (const [id, s] of this.sessions) {
      if (s.terminatedAt !== null) continue;
      const a = this.assignments.get(s.assignmentId);
      if (s.deviceId === i.deviceId || a?.accountId === i.accountId) this.sessions.set(id, { ...s, terminatedAt: i.approvedAtMs });
    }
    const a = this.assignments.get(i.assignmentId);
    if (!a) throw new Error('배정을 찾을 수 없다');
    this.sessions.set(i.scannerSessionId, {
      scannerSessionId: i.scannerSessionId,
      assignmentId: i.assignmentId,
      accountId: i.accountId,
      deviceId: i.deviceId,
      role: i.role,
      proxy: i.proxy,
      expiresAt: i.expiresAtMs,
      terminatedAt: null,
      assignmentStatus: a.status,
      validFrom: a.validFromMs ?? 0,
      validUntil: a.validUntilMs ?? 0,
      eventId: a.eventId ?? '',
    });
  }

  async touchScannerSession(scannerSessionId: string, atMs: number): Promise<void> {
    const s = this.sessions.get(scannerSessionId);
    if (s && s.terminatedAt === null) this.sessions.set(scannerSessionId, { ...s, lastSeenAtMs: atMs });
  }

  async endScannerSession(scannerSessionId: string, atMs: number): Promise<void> {
    const s = this.sessions.get(scannerSessionId);
    if (s && s.terminatedAt === null) this.sessions.set(scannerSessionId, { ...s, terminatedAt: atMs });
  }

  async terminateScannerSessionsByDevice(i: { deviceId: string; reason: 'DEVICE_REVOKED'; nowMs: number }): Promise<number> {
    let terminated = 0;
    for (const [id, s] of this.sessions) {
      if (s.deviceId !== i.deviceId || s.terminatedAt !== null) continue;
      this.sessions.set(id, { ...s, terminatedAt: i.nowMs });
      const accountId = this.assignments.get(s.assignmentId)?.accountId;
      if (accountId) this.terminatedEvents.push({ accountId, sessionId: id, reason: i.reason, terminatedAt: new Date(i.nowMs).toISOString() });
      terminated++;
    }
    return terminated;
  }

  async terminateByAccount(i: { accountId: string; reason: 'STAFF_REVOKED'; nowMs: number }): Promise<{ assignments: number; sessions: number }> {
    let assignments = 0;
    for (const [id, a] of this.assignments) {
      if (a.accountId !== i.accountId || (a.status !== 'ASSIGNED' && a.status !== 'INVITED')) continue;
      this.assignments.set(id, { ...a, status: 'REVOKED' });
      assignments++;
    }
    let sessions = 0;
    for (const [id, s] of this.sessions) {
      if (s.terminatedAt !== null) continue;
      if (s.accountId !== i.accountId) continue;
      this.sessions.set(id, { ...s, terminatedAt: i.nowMs });
      this.terminatedEvents.push({ accountId: i.accountId, sessionId: id, reason: i.reason, terminatedAt: new Date(i.nowMs).toISOString() });
      sessions++;
    }
    return { assignments, sessions };
  }

  async inactiveAccountIdsWithStaff(limit: number): Promise<string[]> {
    const ids = new Set<string>();
    for (const a of this.assignments.values()) {
      if (a.accountId && (a.status === 'ASSIGNED' || a.status === 'INVITED') && this.#statusOf(a.accountId) !== 'ACTIVE') ids.add(a.accountId);
    }
    for (const s of this.sessions.values()) {
      if (s.terminatedAt === null && this.#statusOf(s.accountId) !== 'ACTIVE') ids.add(s.accountId);
    }
    return [...ids].slice(0, limit);
  }
}
