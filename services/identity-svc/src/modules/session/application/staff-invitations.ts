// 현장 스태프 초대 조회·수락·거절과 내 배정 목록(BUILD_ORDER GAT-210, identity §6.1, FR-046·POL-031).
// 초대 토큰 원문은 저장하지 않고 SHA-256만 대조한다. 역할은 초대가 정하고 본문으로 받지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { createHash } from 'node:crypto';
import { STAFF_ASSIGNMENT_STORE, type StaffAssignmentRecord, type StaffAssignmentSelfView, type StaffAssignmentStore, type StaffRole } from '../domain/staff.js';

export const STAFF_CONSENT_VERSION = 'staff-2026-11-13';
export const STAFF_COLLECTION_NOTICE =
  '현장 스태프 배정을 위해 이메일·이름·역할·근무 회차를 수집·이용합니다. 보유 기간은 배정 종료 뒤 1년입니다. 동의를 거부하면 배정할 수 없습니다.';
export const STAFF_PROVISION_NOTICE =
  '배정 파트너에게 위 항목을 제공합니다. 목적은 현장 입장 운영이며 보유 기간은 배정 종료 뒤 1년입니다. 동의를 거부하면 배정할 수 없습니다.';

export class StaffInvitationError extends Error {
  constructor(readonly code: 'INVITATION_INVALID' | 'EMAIL_MISMATCH' | 'ASSIGNMENT_EXISTS' | 'CONSENT_REQUIRED' | 'CONSENT_OUTDATED' | 'LIMIT') {
    super(`스태프 초대 오류: ${code}`);
    this.name = 'StaffInvitationError';
  }
}

export interface StaffInvitationView {
  role: StaffRole;
  validFrom: string;
  validUntil: string;
  invitedEmailMasked?: string;
  consents: { collection: string; provision: string; consentVersion: string };
}

export interface StaffAssignmentView {
  assignmentId: string;
  eventId: string;
  role: StaffRole;
  status: 'INVITED' | 'ASSIGNED' | 'REVOKED' | 'ENDED' | 'EXPIRED';
  inviteExpiresAt: string;
  validFrom: string;
  validUntil: string;
}

const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const maskEmail = (email: string | undefined): string | undefined => {
  if (!email) return undefined;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}***${email.slice(at)}`;
};

const assignmentView = (a: StaffAssignmentRecord): StaffAssignmentView => ({
  assignmentId: a.assignmentId,
  eventId: a.eventId,
  role: a.role,
  status: a.status,
  inviteExpiresAt: new Date(a.inviteExpiresAtMs).toISOString(),
  validFrom: new Date(a.validFromMs).toISOString(),
  validUntil: new Date(a.validUntilMs).toISOString(),
});

@Injectable()
export class StaffInvitations {
  constructor(
    @Inject(STAFF_ASSIGNMENT_STORE) private readonly store: StaffAssignmentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async lookup(inviteToken: string): Promise<StaffInvitationView> {
    const a = await this.store.findInvitationByTokenHash(tokenHash(inviteToken));
    if (!a || a.status !== 'INVITED' || a.inviteExpiresAtMs <= this.clock.now()) throw new StaffInvitationError('INVITATION_INVALID');
    return {
      role: a.role,
      validFrom: new Date(a.validFromMs).toISOString(),
      validUntil: new Date(a.validUntilMs).toISOString(),
      ...(maskEmail(a.inviteEmail) !== undefined ? { invitedEmailMasked: maskEmail(a.inviteEmail)! } : {}),
      consents: { collection: STAFF_COLLECTION_NOTICE, provision: STAFF_PROVISION_NOTICE, consentVersion: STAFF_CONSENT_VERSION },
    };
  }

  async accept(i: { inviteToken: string; accountId: string; consentCollection?: boolean; consentProvision?: boolean; consentVersion?: string }): Promise<StaffAssignmentView> {
    const invitation = await this.store.findInvitationByTokenHash(tokenHash(i.inviteToken));
    if (!invitation || invitation.status !== 'INVITED' || invitation.inviteExpiresAtMs <= this.clock.now()) throw new StaffInvitationError('INVITATION_INVALID');
    if (!invitation.inviteEmail) throw new StaffInvitationError('EMAIL_MISMATCH');
    const me = await this.store.accountEmailOf(i.accountId);
    if (!me.verified || !me.email) throw new StaffInvitationError('EMAIL_MISMATCH');
    if (i.consentCollection !== true || i.consentProvision !== true) throw new StaffInvitationError('CONSENT_REQUIRED');
    if (i.consentVersion !== STAFF_CONSENT_VERSION) throw new StaffInvitationError('CONSENT_OUTDATED');
    const r = await this.store.acceptInvitation({
      tokenHash: tokenHash(i.inviteToken),
      accountId: i.accountId,
      email: me.email,
      consentVersion: STAFF_CONSENT_VERSION,
      nowMs: this.clock.now(),
    });
    if (r.result === 'INVITATION_INVALID') throw new StaffInvitationError('INVITATION_INVALID');
    if (r.result === 'EMAIL_MISMATCH') throw new StaffInvitationError('EMAIL_MISMATCH');
    if (r.result === 'ASSIGNMENT_EXISTS') throw new StaffInvitationError('ASSIGNMENT_EXISTS');
    return assignmentView(r.assignment);
  }

  async reject(inviteToken: string): Promise<void> {
    await this.store.rejectInvitation({ tokenHash: tokenHash(inviteToken), nowMs: this.clock.now() });
  }

  async listSelf(i: { accountId: string; cursor?: string; limit?: number }): Promise<{ items: StaffAssignmentSelfView[]; nextCursor?: string }> {
    const limit = i.limit === undefined ? 20 : i.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StaffInvitationError('LIMIT');
    return this.store.listSelf({ accountId: i.accountId, ...(i.cursor !== undefined && i.cursor !== '' ? { cursor: i.cursor } : {}), limit });
  }
}
