// 기기 승인 화면 조회와 승인·거부(SCR-051, RFC 8628 §5.4, identity §6.1, I-T22).
// 배정은 그 기기의 배정 파트너 회차의 것만 보인다. 파트너가 다르면 other-partner-device, 유효 시간 밖이면 outside-staff-hours다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { normalizeUserCode, type ApprovedScannerSession } from '../domain/device-approval.js';
import { DEVICE_APPROVAL_LIMITS, DEVICE_AUTHORIZATIONS, type DeviceApprovalLimits, type DeviceAuthorizationStore } from '../domain/ports.js';
import { STAFF_ASSIGNMENT_STORE, type StaffAssignmentRecord, type StaffAssignmentStore, type StaffRole } from '../domain/staff.js';
import { defaultScannerSessionId, NEW_SCANNER_SESSION_ID, type NewScannerSessionId } from './start-device-authorization.js';

export class DeviceApprovalError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'STAFF_ASSIGNMENT_MISSING'
      | 'OTHER_PARTNER_DEVICE'
      | 'OUTSIDE_STAFF_HOURS'
      | 'ASSIGNMENT_REQUIRED'
      | 'ASSIGNMENT_NOT_ALLOWED'
      | 'PROXY_NOT_ALLOWED'
      | 'RATE_LIMITED'
      | 'ALREADY_HANDLED',
    readonly retryAfterMs?: number,
  ) {
    super(`기기 승인 오류: ${code}`);
    this.name = 'DeviceApprovalError';
  }
}

export interface DeviceApprovalAssignmentView {
  assignmentId: string;
  eventId: string;
  role: StaffRole;
  status: 'ASSIGNED';
  validFrom: string;
  validUntil: string;
}

export interface DeviceApprovalView {
  deviceName: string;
  userCode: string;
  assignments: DeviceApprovalAssignmentView[];
  canProxy: boolean;
}

const viewOf = (a: StaffAssignmentRecord): DeviceApprovalAssignmentView => ({
  assignmentId: a.assignmentId,
  eventId: a.eventId,
  role: a.role,
  status: 'ASSIGNED',
  validFrom: new Date(a.validFromMs).toISOString(),
  validUntil: new Date(a.validUntilMs).toISOString(),
});

const inWindow = (a: StaffAssignmentRecord, now: number): boolean => a.validFromMs <= now && a.validUntilMs >= now;

@Injectable()
export class DeviceApprovals {
  constructor(
    @Inject(DEVICE_AUTHORIZATIONS) private readonly store: DeviceAuthorizationStore,
    @Inject(STAFF_ASSIGNMENT_STORE) private readonly assignments: StaffAssignmentStore,
    @Inject(DEVICE_APPROVAL_LIMITS) private readonly limits: DeviceApprovalLimits,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(NEW_SCANNER_SESSION_ID) private readonly newId: NewScannerSessionId,
  ) {}

  /** 승인 화면에 보일 기기 이름·확인 코드·이 기기 파트너 회차의 내 배정. 하나도 없으면 403이다 */
  async lookup(i: { userCode: unknown; accountId: string }): Promise<DeviceApprovalView> {
    const now = this.clock.now();
    const allowed = await this.limits.allowApproval(i.accountId, now);
    if (!allowed.allowed) throw new DeviceApprovalError('RATE_LIMITED', allowed.retryAfterMs);
    const code = normalizeUserCode(i.userCode);
    if (!code) throw new DeviceApprovalError('NOT_FOUND');
    const auth = await this.store.findByUserCode(code);
    if (!auth) throw new DeviceApprovalError('NOT_FOUND');

    const assigned = await this.assignments.listAssignedByAccount({ accountId: i.accountId, nowMs: now });
    const byPartner = assigned.filter((a) => a.promoterId !== undefined && a.promoterId === auth.promoterId);
    if (assigned.length === 0) throw new DeviceApprovalError('STAFF_ASSIGNMENT_MISSING');
    if (byPartner.length === 0) throw new DeviceApprovalError('OTHER_PARTNER_DEVICE');
    const active = byPartner.filter((a) => inWindow(a, now));
    if (active.length === 0) throw new DeviceApprovalError('OUTSIDE_STAFF_HOURS');
    return {
      deviceName: auth.deviceName,
      userCode: auth.userCode,
      assignments: active.map(viewOf),
      canProxy: active.some((a) => a.role === 'gate_lead'),
    };
  }

  /** 승인·거부. 승인하면 같은 기기·같은 계정의 이전 세션을 끝내고 새 스캐너 세션을 만든다 */
  async decide(i: {
    userCode: unknown;
    accountId: string;
    sessionId: string;
    decision: 'APPROVE' | 'DENY';
    assignmentId?: string;
    proxy?: boolean;
  }): Promise<void> {
    const now = this.clock.now();
    const allowed = await this.limits.allowApproval(i.accountId, now);
    if (!allowed.allowed) throw new DeviceApprovalError('RATE_LIMITED', allowed.retryAfterMs);
    const code = normalizeUserCode(i.userCode);
    if (!code) throw new DeviceApprovalError('NOT_FOUND');
    const auth = await this.store.findByUserCode(code);
    if (!auth) throw new DeviceApprovalError('NOT_FOUND');
    if (auth.status !== 'PENDING') throw new DeviceApprovalError('ALREADY_HANDLED');

    if (i.decision === 'DENY') {
      const denied = await this.store.deny(auth.deviceCodeHash, now);
      if (!denied) throw new DeviceApprovalError('ALREADY_HANDLED');
      return;
    }

    const assigned = await this.assignments.listAssignedByAccount({ accountId: i.accountId, nowMs: now });
    const byPartner = assigned.filter((a) => a.promoterId !== undefined && a.promoterId === auth.promoterId);
    if (assigned.length === 0) throw new DeviceApprovalError('STAFF_ASSIGNMENT_MISSING');
    if (byPartner.length === 0) throw new DeviceApprovalError('OTHER_PARTNER_DEVICE');
    const active = byPartner.filter((a) => inWindow(a, now));
    if (active.length === 0) throw new DeviceApprovalError('OUTSIDE_STAFF_HOURS');

    let chosen: StaffAssignmentRecord | undefined;
    if (i.assignmentId !== undefined) {
      chosen = active.find((a) => a.assignmentId === i.assignmentId);
      if (!chosen) throw new DeviceApprovalError('ASSIGNMENT_NOT_ALLOWED');
    } else if (active.length === 1) {
      chosen = active[0];
    } else {
      throw new DeviceApprovalError('ASSIGNMENT_REQUIRED');
    }
    if (!chosen) throw new DeviceApprovalError('ASSIGNMENT_REQUIRED');

    const proxy = i.proxy === true;
    if (proxy && chosen.role !== 'gate_lead') throw new DeviceApprovalError('PROXY_NOT_ALLOWED');
    const role: StaffRole = proxy ? 'gate_staff' : chosen.role;
    const approved: ApprovedScannerSession = {
      scannerSessionId: this.newId(),
      assignmentId: chosen.assignmentId,
      accountId: i.accountId,
      eventId: chosen.eventId,
      role,
      proxy,
      approvedBySession: i.sessionId,
      expiresAtMs: chosen.validUntilMs,
    };
    await this.assignments.createScannerSession({
      scannerSessionId: approved.scannerSessionId,
      assignmentId: chosen.assignmentId,
      deviceId: auth.deviceId,
      accountId: i.accountId,
      approvedBySession: i.sessionId,
      role,
      proxy,
      approvedAtMs: now,
      expiresAtMs: chosen.validUntilMs,
    });
    const ok = await this.store.approve({ deviceCodeHash: auth.deviceCodeHash, approved, nowMs: now });
    if (!ok) {
      await this.assignments.endScannerSession(approved.scannerSessionId, now);
      throw new DeviceApprovalError('ALREADY_HANDLED');
    }
  }
}
