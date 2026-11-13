// 시험·로컬용 배정·스캐너 세션 저장소. 운영은 DrizzleStaffAssignmentStore를 쓴다.
import type {
  AcceptInvitationResult,
  ScannerSessionRecord,
  StaffAssignmentRecord,
  StaffAssignmentSelfView,
  StaffAssignmentStatus,
  StaffAssignmentStore,
  StaffRole,
} from '../domain/staff.js';

export interface MemoryStaffAssignmentRow {
  id: string;
  accountId: string | null;
  status: 'INVITED' | 'ASSIGNED' | 'REVOKED' | 'ENDED' | 'EXPIRED';
  eventId?: string;
  role?: StaffRole;
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
  readonly accounts = new Map<string, { email?: string; verified: boolean }>();

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

  async accountEmailOf(accountId: string): Promise<{ email?: string; verified: boolean }> {
    return this.accounts.get(accountId) ?? { verified: false };
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
}
