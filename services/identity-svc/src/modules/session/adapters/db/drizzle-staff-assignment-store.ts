// PostgreSQL 저장소(Drizzle): staff_assignment·scanner_session(identity §6.1, docs/data.md).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, CONTROL_TOPICS, DATABASE, type Database, writeOutbox } from '@peaket/platform';
import { and, desc, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import type {
  AcceptInvitationResult,
  ScannerSessionRecord,
  StaffAssignmentRecord,
  StaffAssignmentSelfView,
  StaffAssignmentStatus,
  StaffAssignmentStore,
  StaffRole,
} from '../../domain/staff.js';
import { account, scannerSession, staffAssignment } from './schema.js';

type StaffAssignmentRow = typeof staffAssignment.$inferSelect;

const recordOf = (r: StaffAssignmentRow): StaffAssignmentRecord => ({
  assignmentId: r.id,
  accountId: r.accountId,
  eventId: r.eventId,
  role: r.role as StaffRole,
  ...(r.promoterId !== null ? { promoterId: r.promoterId } : {}),
  ...(r.inviteEmail !== null ? { inviteEmail: r.inviteEmail } : {}),
  ...(r.inviteTokenHash !== null ? { inviteTokenHash: Buffer.from(r.inviteTokenHash).toString('hex') } : {}),
  inviteExpiresAtMs: r.inviteExpiresAt.getTime(),
  invitedBy: r.invitedBy,
  validFromMs: r.validFrom.getTime(),
  validUntilMs: r.validUntil.getTime(),
  status: r.status as StaffAssignmentStatus,
  ...(r.acceptedAt !== null ? { acceptedAtMs: r.acceptedAt.getTime() } : {}),
  ...(r.consentVersion !== null ? { consentVersion: r.consentVersion } : {}),
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

@Injectable()
export class DrizzleStaffAssignmentStore implements StaffAssignmentStore {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async hasAssigned(accountId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: staffAssignment.id })
      .from(staffAssignment)
      .where(and(eq(staffAssignment.accountId, accountId), eq(staffAssignment.status, 'ASSIGNED')))
      .limit(1);
    return row !== undefined;
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<StaffAssignmentRecord | null> {
    const [row] = await this.database.db.select().from(staffAssignment).where(eq(staffAssignment.inviteTokenHash, Buffer.from(tokenHash, 'hex'))).limit(1);
    return row ? recordOf(row) : null;
  }

  async accountEmailOf(accountId: string): Promise<{ email?: string; verified: boolean }> {
    const [row] = await this.database.db.select({ email: account.email, verified: account.emailVerified }).from(account).where(eq(account.id, accountId)).limit(1);
    return row ? { ...(row.email ? { email: row.email } : {}), verified: row.verified } : { verified: false };
  }

  async acceptInvitation(i: { tokenHash: string; accountId: string; email: string; consentVersion: string; nowMs: number }): Promise<AcceptInvitationResult> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx.select().from(staffAssignment).where(eq(staffAssignment.inviteTokenHash, Buffer.from(i.tokenHash, 'hex'))).limit(1).for('update');
      if (!row || row.status !== 'INVITED' || row.inviteExpiresAt.getTime() <= i.nowMs) return { result: 'INVITATION_INVALID' };
      if (row.inviteEmail === null || row.inviteEmail.toLowerCase() !== i.email.toLowerCase()) return { result: 'EMAIL_MISMATCH' };
      try {
        const [updated] = await tx
          .update(staffAssignment)
          .set({ accountId: i.accountId, status: 'ASSIGNED', acceptedAt: new Date(i.nowMs), consentVersion: i.consentVersion, inviteEmail: null, inviteTokenHash: null })
          .where(eq(staffAssignment.id, row.id))
          .returning();
        return updated ? { result: 'OK', assignment: recordOf(updated) } : { result: 'INVITATION_INVALID' };
      } catch (e) {
        if ((e as { cause?: { code?: string } }).cause?.code === '23505') return { result: 'ASSIGNMENT_EXISTS' };
        throw e;
      }
    });
  }

  async rejectInvitation(i: { tokenHash: string; nowMs: number }): Promise<void> {
    await this.database.db
      .update(staffAssignment)
      .set({ status: 'EXPIRED', inviteEmail: null, inviteTokenHash: null })
      .where(and(eq(staffAssignment.inviteTokenHash, Buffer.from(i.tokenHash, 'hex')), eq(staffAssignment.status, 'INVITED')));
  }

  async listSelf(i: { accountId: string; cursor?: string; limit: number }): Promise<{ items: StaffAssignmentSelfView[]; nextCursor?: string }> {
    const cursor = i.cursor ? parseCursor(i.cursor) : undefined;
    const statuses = ['ASSIGNED', 'ENDED', 'REVOKED'] as const;
    const where = cursor
      ? and(
          eq(staffAssignment.accountId, i.accountId),
          inArray(staffAssignment.status, statuses),
          or(
            lt(staffAssignment.validFrom, new Date(cursor.validFromMs)),
            and(eq(staffAssignment.validFrom, new Date(cursor.validFromMs)), lt(staffAssignment.id, cursor.assignmentId)),
          ),
        )
      : and(eq(staffAssignment.accountId, i.accountId), inArray(staffAssignment.status, statuses));
    const rows = await this.database.db.select().from(staffAssignment).where(where).orderBy(desc(staffAssignment.validFrom), desc(staffAssignment.id)).limit(i.limit + 1);
    const page = rows.slice(0, i.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        assignmentId: r.id,
        eventId: r.eventId,
        role: r.role as StaffRole,
        status: r.status as 'ASSIGNED' | 'REVOKED' | 'ENDED',
        validFrom: r.validFrom.toISOString(),
        validUntil: r.validUntil.toISOString(),
        activeScannerDeviceName: null,
      })),
      ...(rows.length > i.limit && last ? { nextCursor: cursorOf(last.validFrom.getTime(), last.id) } : {}),
    };
  }

  async findScannerSession(scannerSessionId: string): Promise<ScannerSessionRecord | null> {
    const [row] = await this.database.db
      .select({
        scannerSessionId: scannerSession.id,
        assignmentId: scannerSession.staffAssignmentId,
        deviceId: scannerSession.scannerDeviceId,
        role: scannerSession.role,
        proxy: scannerSession.proxy,
        expiresAt: scannerSession.expiresAt,
        lastSeenAt: scannerSession.lastSeenAt,
        terminatedAt: scannerSession.terminatedAt,
        assignmentStatus: staffAssignment.status,
        validFrom: staffAssignment.validFrom,
        validUntil: staffAssignment.validUntil,
        eventId: staffAssignment.eventId,
      })
      .from(scannerSession)
      .innerJoin(staffAssignment, eq(scannerSession.staffAssignmentId, staffAssignment.id))
      .where(eq(scannerSession.id, scannerSessionId))
      .limit(1);
    if (!row) return null;
    return {
      scannerSessionId: row.scannerSessionId,
      assignmentId: row.assignmentId,
      deviceId: row.deviceId,
      role: row.role as StaffRole,
      proxy: row.proxy,
      expiresAt: row.expiresAt.getTime(),
      ...(row.lastSeenAt !== null ? { lastSeenAtMs: row.lastSeenAt.getTime() } : {}),
      terminatedAt: row.terminatedAt === null ? null : row.terminatedAt.getTime(),
      assignmentStatus: row.assignmentStatus as StaffAssignmentStatus,
      validFrom: row.validFrom.getTime(),
      validUntil: row.validUntil.getTime(),
      eventId: row.eventId,
    };
  }

  async listAssignedByAccount(i: { accountId: string; nowMs: number }): Promise<StaffAssignmentRecord[]> {
    void i.nowMs;
    const rows = await this.database.db
      .select()
      .from(staffAssignment)
      .where(and(eq(staffAssignment.accountId, i.accountId), eq(staffAssignment.status, 'ASSIGNED')))
      .orderBy(desc(staffAssignment.validFrom));
    return rows.map(recordOf);
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
    await this.database.transaction(async (tx) => {
      const [assignment] = await tx.select({ id: staffAssignment.id }).from(staffAssignment).where(eq(staffAssignment.id, i.assignmentId)).limit(1).for('update');
      if (!assignment) throw new Error('배정을 찾을 수 없다');
      const mine = await tx.select({ id: staffAssignment.id }).from(staffAssignment).where(eq(staffAssignment.accountId, i.accountId));
      const assignmentIds = mine.map((r) => r.id);
      await tx
        .update(scannerSession)
        .set({ terminatedAt: new Date(i.approvedAtMs) })
        .where(
          and(
            isNull(scannerSession.terminatedAt),
            or(eq(scannerSession.scannerDeviceId, i.deviceId), assignmentIds.length > 0 ? inArray(scannerSession.staffAssignmentId, assignmentIds) : undefined),
          ),
        );
      await tx.insert(scannerSession).values({
        id: i.scannerSessionId,
        staffAssignmentId: i.assignmentId,
        scannerDeviceId: i.deviceId,
        approvedBySession: i.approvedBySession,
        role: i.role,
        proxy: i.proxy,
        approvedAt: new Date(i.approvedAtMs),
        expiresAt: new Date(i.expiresAtMs),
      });
    });
  }

  async touchScannerSession(scannerSessionId: string, atMs: number): Promise<void> {
    await this.database.db
      .update(scannerSession)
      .set({ lastSeenAt: new Date(atMs) })
      .where(and(eq(scannerSession.id, scannerSessionId), isNull(scannerSession.terminatedAt)));
  }

  async endScannerSession(scannerSessionId: string, atMs: number): Promise<void> {
    await this.database.db
      .update(scannerSession)
      .set({ terminatedAt: new Date(atMs) })
      .where(and(eq(scannerSession.id, scannerSessionId), isNull(scannerSession.terminatedAt)));
  }

  async terminateScannerSessionsByDevice(i: { deviceId: string; reason: 'DEVICE_REVOKED'; nowMs: number }): Promise<number> {
    return this.database.transaction(async (tx) => {
      const sessions = await tx
        .select({ id: scannerSession.id, assignmentId: scannerSession.staffAssignmentId })
        .from(scannerSession)
        .where(and(eq(scannerSession.scannerDeviceId, i.deviceId), isNull(scannerSession.terminatedAt)))
        .for('update');
      if (sessions.length === 0) return 0;
      const at = new Date(i.nowMs);
      await tx
        .update(scannerSession)
        .set({ terminatedAt: at })
        .where(and(eq(scannerSession.scannerDeviceId, i.deviceId), isNull(scannerSession.terminatedAt)));
      const assignmentIds = [...new Set(sessions.map((s) => s.assignmentId))];
      const owners = await tx
        .select({ id: staffAssignment.id, accountId: staffAssignment.accountId })
        .from(staffAssignment)
        .where(inArray(staffAssignment.id, assignmentIds));
      const accountOf = new Map(owners.map((o) => [o.id, o.accountId]));
      const terminatedAt = at.toISOString();
      const messages = sessions
        .flatMap((s) => {
          const accountId = accountOf.get(s.assignmentId);
          return accountId === null || accountId === undefined
            ? []
            : [
                {
                  topic: CONTROL_TOPICS.sessionsTerminated,
                  key: accountId,
                  payload: Buffer.from(JSON.stringify({ accountId, sessionId: s.id, reason: i.reason, terminatedAt })),
                },
              ];
        })
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (messages.length > 0) await writeOutbox(tx, this.clock, messages);
      return sessions.length;
    });
  }
}
