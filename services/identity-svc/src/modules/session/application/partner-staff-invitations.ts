// 파트너 현장 스태프 초대 만들기·명단·해제·재발송(BUILD_ORDER BAT-450B, GAT-210, identity §6.1, FR-046·POL-031, ADR-0353).
// 회차 소유는 core-svc 내부 판매 설정(ADR-0353)으로만 확인하고, 테넌트는 요청 본문이 아니라 세션의 tenantId만 쓴다.
// 초대 토큰은 32바이트 CSPRNG이고 SHA-256만 저장한다. 링크는 URL 조각에만 토큰을 싣고 응답·로그에는 원문을 내지 않는다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { createHash, randomBytes } from 'node:crypto';
import {
  CORE_EVENT_OWNERS,
  type CoreEventOwner,
  type CoreEventOwners,
  DEFAULT_STAFF_INVITATION_URL,
  STAFF_ASSIGNMENT_STORE,
  STAFF_INVITE_MAILER,
  STAFF_INVITE_MAX,
  STAFF_INVITE_TOKEN_TTL_MS,
  STAFF_VALID_AFTER_MS,
  STAFF_VALID_BEFORE_MS,
  type StaffAssignmentPartnerView,
  type StaffAssignmentRecord,
  type StaffAssignmentStore,
  type StaffInviteMailer,
  type StaffRole,
} from '../domain/staff.js';

export const STAFF_INVITATION_URL = Symbol('identity.StaffInvitationUrl');
export const NEW_STAFF_INVITE_TOKEN = Symbol('identity.NewStaffInviteToken');
export type NewStaffInviteToken = () => string;

/** 시험·로컬에서 토큰을 고정한다. 없으면 32바이트 난수 base64url */
export const newStaffInviteToken = (): string => randomBytes(32).toString('base64url');
export const staffInviteTokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export class PartnerStaffInvitationError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'DEPENDENCY_UNAVAILABLE'
      | 'MAIL_UNAVAILABLE'
      | 'DUPLICATE_EMAIL'
      | 'ALREADY_ACCEPTED'
      | 'LIMIT',
  ) {
    super(`파트너 스태프 초대 오류: ${code}`);
    this.name = 'PartnerStaffInvitationError';
  }
}

export interface PartnerStaffInvitationView {
  assignmentId: string;
  eventId: string;
  role: StaffRole;
  status: 'INVITED' | 'ASSIGNED' | 'REVOKED' | 'ENDED' | 'EXPIRED';
  inviteExpiresAt: string;
  validFrom: string;
  validUntil: string;
}

const viewOf = (a: StaffAssignmentRecord): PartnerStaffInvitationView => ({
  assignmentId: a.assignmentId,
  eventId: a.eventId,
  role: a.role,
  status: a.status,
  inviteExpiresAt: new Date(a.inviteExpiresAtMs).toISOString(),
  validFrom: new Date(a.validFromMs).toISOString(),
  validUntil: new Date(a.validUntilMs).toISOString(),
});

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

@Injectable()
export class PartnerStaffInvitations {
  constructor(
    @Inject(STAFF_ASSIGNMENT_STORE) private readonly store: StaffAssignmentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(CORE_EVENT_OWNERS) private readonly owners?: CoreEventOwners,
    @Optional() @Inject(STAFF_INVITE_MAILER) private readonly mailer?: StaffInviteMailer,
    @Optional() @Inject(STAFF_INVITATION_URL) private readonly invitationUrl: string = DEFAULT_STAFF_INVITATION_URL,
    @Optional() @Inject(NEW_STAFF_INVITE_TOKEN) private readonly tokenOf: NewStaffInviteToken = newStaffInviteToken,
  ) {}

  /**
   * 회차 소유 확인. 없는 회차·판매 승인 전·다른 파트너 회차는 모두 같은 NOT_FOUND다(AZ-T2·T3).
   * core가 답하지 못하면 DEPENDENCY_UNAVAILABLE(503)이고 아무것도 만들지 않는다.
   */
  async #ownerOf(eventId: string, tenantId: string): Promise<{ owner: CoreEventOwner; validFromMs: number; validUntilMs: number }> {
    if (!this.owners) throw new PartnerStaffInvitationError('DEPENDENCY_UNAVAILABLE');
    let owner: CoreEventOwner | undefined;
    try {
      owner = await this.owners.find(eventId);
    } catch {
      throw new PartnerStaffInvitationError('DEPENDENCY_UNAVAILABLE');
    }
    if (!owner || owner.promoterId !== tenantId) throw new PartnerStaffInvitationError('NOT_FOUND');
    if (!Number.isFinite(owner.startsAtMs) || !Number.isFinite(owner.endsAtMs)) throw new PartnerStaffInvitationError('DEPENDENCY_UNAVAILABLE');
    const validFromMs = (owner.entryOpensAtMs ?? owner.startsAtMs) - STAFF_VALID_BEFORE_MS;
    const validUntilMs = owner.endsAtMs + STAFF_VALID_AFTER_MS;
    if (!(validFromMs < validUntilMs)) throw new PartnerStaffInvitationError('DEPENDENCY_UNAVAILABLE');
    return { owner, validFromMs, validUntilMs };
  }

  async create(i: {
    eventId: string;
    tenantId: string;
    accountId: string;
    invitations: readonly { email: string; role: StaffRole }[];
  }): Promise<PartnerStaffInvitationView[]> {
    if (!Number.isInteger(i.invitations.length) || i.invitations.length < 1 || i.invitations.length > STAFF_INVITE_MAX) {
      throw new PartnerStaffInvitationError('LIMIT');
    }
    const window = await this.#ownerOf(i.eventId, i.tenantId);
    if (!this.mailer) throw new PartnerStaffInvitationError('MAIL_UNAVAILABLE');

    const emails = i.invitations.map((x) => normalizeEmail(x.email));
    const seen = new Set<string>();
    for (const email of emails) {
      if (email === '' || seen.has(email)) throw new PartnerStaffInvitationError('DUPLICATE_EMAIL');
      seen.add(email);
    }
    if ((await this.store.findInvitedEmails(i.eventId, emails)).length > 0) throw new PartnerStaffInvitationError('DUPLICATE_EMAIL');

    const now = this.clock.now();
    const expiresAtMs = now + STAFF_INVITE_TOKEN_TTL_MS;
    const rows = i.invitations.map((x, k) => {
      const token = this.tokenOf();
      return {
        row: {
          assignmentId: uuidv7(this.clock),
          eventId: i.eventId,
          promoterId: window.owner.promoterId,
          role: x.role,
          email: emails[k]!,
          tokenHash: staffInviteTokenHash(token),
          expiresAtMs,
          invitedBy: i.accountId,
          validFromMs: window.validFromMs,
          validUntilMs: window.validUntilMs,
        },
        token,
      };
    });

    // 메일을 먼저 보낸다. 보내지 못하면 배정 행을 만들지 않는다(보내지 못한 초대를 만든 척하지 않는다).
    // 저장이 경합으로 실패하면 이미 보낸 링크는 저장된 토큰이 없어 410이 된다(받는 사람에게 해가 없는 죽은 링크).
    try {
      for (const { row, token } of rows) {
        await this.mailer.send({
          to: row.email,
          link: `${this.invitationUrl}#token=${token}`,
          expiresAt: expiresAtMs,
          eventId: i.eventId,
          role: row.role,
          at: now,
        });
      }
    } catch {
      throw new PartnerStaffInvitationError('MAIL_UNAVAILABLE');
    }

    const made = await this.store.createInvitations(rows.map((x) => x.row));
    if (made.result === 'DUPLICATE_EMAIL') throw new PartnerStaffInvitationError('DUPLICATE_EMAIL');
    return made.created.map(viewOf);
  }

  async list(i: { eventId: string; tenantId: string; cursor?: string; limit?: number }): Promise<{ items: StaffAssignmentPartnerView[]; nextCursor?: string }> {
    const limit = i.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PartnerStaffInvitationError('LIMIT');
    await this.#ownerOf(i.eventId, i.tenantId);
    return this.store.listByEvent({ eventId: i.eventId, ...(i.cursor !== undefined && i.cursor !== '' ? { cursor: i.cursor } : {}), limit, nowMs: this.clock.now() });
  }

  async revoke(i: { assignmentId: string; tenantId: string }): Promise<void> {
    const assignment = await this.store.findAssignmentById(i.assignmentId);
    if (!assignment) throw new PartnerStaffInvitationError('NOT_FOUND');
    await this.#ownerOf(assignment.eventId, i.tenantId);
    await this.store.revokeAssignment({ assignmentId: i.assignmentId, nowMs: this.clock.now() });
  }

  async reissue(i: { assignmentId: string; tenantId: string }): Promise<PartnerStaffInvitationView> {
    const assignment = await this.store.findAssignmentById(i.assignmentId);
    if (!assignment) throw new PartnerStaffInvitationError('NOT_FOUND');
    await this.#ownerOf(assignment.eventId, i.tenantId);
    const now = this.clock.now();
    // 역할 유효 끝이 지난 초대는 수락이 410이므로 재발송도 닫는다. 받는 사람에게 죽은 링크를 보내지 않는다(RV-02).
    if (assignment.status !== 'INVITED' || !assignment.inviteEmail || assignment.validUntilMs < now) throw new PartnerStaffInvitationError('ALREADY_ACCEPTED');
    if (!this.mailer) throw new PartnerStaffInvitationError('MAIL_UNAVAILABLE');

    const token = this.tokenOf();
    try {
      await this.mailer.send({
        to: assignment.inviteEmail,
        link: `${this.invitationUrl}#token=${token}`,
        expiresAt: now + STAFF_INVITE_TOKEN_TTL_MS,
        eventId: assignment.eventId,
        role: assignment.role,
        at: now,
      });
    } catch {
      throw new PartnerStaffInvitationError('MAIL_UNAVAILABLE');
    }
    const r = await this.store.reissueInvitation({ assignmentId: i.assignmentId, tokenHash: staffInviteTokenHash(token), expiresAtMs: now + STAFF_INVITE_TOKEN_TTL_MS });
    if (r.result === 'NOT_FOUND') throw new PartnerStaffInvitationError('NOT_FOUND');
    if (r.result === 'ALREADY_ACCEPTED') throw new PartnerStaffInvitationError('ALREADY_ACCEPTED');
    return viewOf(r.assignment);
  }
}
