// 현장 스태프 초대 조회·수락·거절과 내 배정 목록(BUILD_ORDER GAT-210, identity §6.1, FR-046·POL-031).
// 초대 토큰 원문은 저장하지 않고 SHA-256만 대조한다. 역할은 초대가 정하고 본문으로 받지 않는다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { createHash } from 'node:crypto';
import { STAFF_ASSIGNMENT_STORE, STAFF_PHONE_VERIFICATION, type StaffAssignmentRecord, type StaffAssignmentSelfView, type StaffAssignmentStore, type StaffPhoneVerification, type StaffRole } from '../domain/staff.js';

// 두 동의 고지 문안과 그 판(ADR-0089, ADR-0362 결정 2). 줄마다 `이름: 내용`이고 줄바꿈으로 나눈다.
// 줄의 이름과 내용의 정본은 docs/planning/04-ia-flows-screens.md §3 SCR-050 ③④다. 문안을 바꾸면 판도 올린다(옛 판의 수락은 422 consent-version-outdated).
export const STAFF_CONSENT_VERSION = 'staff-2026-11-23';
export const STAFF_COLLECTION_NOTICE = [
  '목적: 현장 검표 배정과 스캔 기록',
  '항목: 계정 ID·닉네임·역할·스캔 기록',
  '보유: 회차 종료 뒤 1년',
  '거부권과 불이익: 배정 불가',
].join('\n');
export const STAFF_PROVISION_NOTICE = [
  '받는 자: 그 회차의 파트너',
  '목적: 현장 인력 관리',
  '항목: 닉네임·역할·수락 여부·스캔·예외 통과 건수',
  '보유: 회차가 끝나고 1년까지(배정 원장과 같다)',
  '거부권과 불이익: 배정 불가',
].join('\n');

export class StaffInvitationError extends Error {
  constructor(readonly code: 'INVITATION_INVALID' | 'EMAIL_MISMATCH' | 'EMAIL_UNVERIFIED' | 'PHONE_UNVERIFIED' | 'PHONE_UNAVAILABLE' | 'ASSIGNMENT_EXISTS' | 'CONSENT_REQUIRED' | 'CONSENT_OUTDATED' | 'LIMIT') {
    super(`스태프 초대 오류: ${code}`);
    this.name = 'StaffInvitationError';
  }
}

export interface StaffInvitationView {
  /** 초대 회차. 화면이 회차 공개 요약으로 판매자 상호·공연명·회차 시작을 읽는다(ADR-0362 결정 1). partnerName·eventTitle·eventStartsAt은 채우지 않는다 */
  eventId: string;
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
    /** 휴대폰 본인확인 포트(없으면 수락을 503으로 닫는다) */
    @Optional() @Inject(STAFF_PHONE_VERIFICATION) private readonly phone?: StaffPhoneVerification,
  ) {}

  async lookup(inviteToken: string): Promise<StaffInvitationView> {
    const a = await this.store.findInvitationByTokenHash(tokenHash(inviteToken));
    if (!a || a.status !== 'INVITED' || a.inviteExpiresAtMs <= this.clock.now() || a.validUntilMs < this.clock.now()) throw new StaffInvitationError('INVITATION_INVALID');
    return {
      eventId: a.eventId,
      role: a.role,
      validFrom: new Date(a.validFromMs).toISOString(),
      validUntil: new Date(a.validUntilMs).toISOString(),
      ...(maskEmail(a.inviteEmail) !== undefined ? { invitedEmailMasked: maskEmail(a.inviteEmail)! } : {}),
      consents: { collection: STAFF_COLLECTION_NOTICE, provision: STAFF_PROVISION_NOTICE, consentVersion: STAFF_CONSENT_VERSION },
    };
  }

  async accept(i: { inviteToken: string; accountId: string; consentCollection?: boolean; consentProvision?: boolean; consentVersion?: string }): Promise<StaffAssignmentView> {
    const invitation = await this.store.findInvitationByTokenHash(tokenHash(i.inviteToken));
    if (!invitation || invitation.status !== 'INVITED' || invitation.inviteExpiresAtMs <= this.clock.now() || invitation.validUntilMs < this.clock.now()) throw new StaffInvitationError('INVITATION_INVALID');
    if (!invitation.inviteEmail) throw new StaffInvitationError('EMAIL_MISMATCH');
    const me = await this.store.accountEmailOf(i.accountId);
    // 검증된 이메일이 없는 계정(네이버만 연결, 제공자가 검증 표시를 주지 않음)은 불일치와 따로 알린다(ADR-0362 결정 4)
    if (!me.verified || !me.email) throw new StaffInvitationError('EMAIL_UNVERIFIED');
    // 이메일만 확인된 계정이 현장 배정을 받지 않게 휴대폰 본인확인을 함께 본다(C2-02).
    if (!this.phone) throw new StaffInvitationError('PHONE_UNAVAILABLE');
    let phone: 'VERIFIED' | 'UNVERIFIED' | 'UNAVAILABLE';
    try {
      phone = await this.phone.statusOf(i.accountId);
    } catch {
      throw new StaffInvitationError('PHONE_UNAVAILABLE');
    }
    if (phone === 'UNAVAILABLE') throw new StaffInvitationError('PHONE_UNAVAILABLE');
    if (phone !== 'VERIFIED') throw new StaffInvitationError('PHONE_UNVERIFIED');
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
    return this.store.listSelf({ accountId: i.accountId, ...(i.cursor !== undefined && i.cursor !== '' ? { cursor: i.cursor } : {}), limit, nowMs: this.clock.now() });
  }
}
