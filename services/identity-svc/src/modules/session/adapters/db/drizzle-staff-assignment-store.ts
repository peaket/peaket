// PostgreSQL 저장소(Drizzle): staff_assignment·scanner_session(identity §6.1, docs/data.md).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { and, eq } from 'drizzle-orm';
import type { ScannerSessionRecord, StaffAssignmentStore, StaffAssignmentStatus, StaffRole } from '../../domain/staff.js';
import { scannerSession, staffAssignment } from './schema.js';

@Injectable()
export class DrizzleStaffAssignmentStore implements StaffAssignmentStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async hasAssigned(accountId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: staffAssignment.id })
      .from(staffAssignment)
      .where(and(eq(staffAssignment.accountId, accountId), eq(staffAssignment.status, 'ASSIGNED')))
      .limit(1);
    return row !== undefined;
  }

  async findScannerSession(scannerSessionId: string): Promise<ScannerSessionRecord | null> {
    const [row] = await this.database.db
      .select({
        scannerSessionId: scannerSession.id,
        deviceId: scannerSession.scannerDeviceId,
        role: scannerSession.role,
        proxy: scannerSession.proxy,
        expiresAt: scannerSession.expiresAt,
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
      deviceId: row.deviceId,
      role: row.role as StaffRole,
      proxy: row.proxy,
      expiresAt: row.expiresAt.getTime(),
      terminatedAt: row.terminatedAt === null ? null : row.terminatedAt.getTime(),
      assignmentStatus: row.assignmentStatus as StaffAssignmentStatus,
      validFrom: row.validFrom.getTime(),
      validUntil: row.validUntil.getTime(),
      eventId: row.eventId,
    };
  }
}
