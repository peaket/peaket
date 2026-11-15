// 스태프 초대 수락의 HTTP 계약(C2-02, identity §6.1): 휴대폰 본인확인 미완료는 403 identity-verification-required,
// 확인 저장소·기관을 쓸 수 없으면 503 provider-down이다. 서비스 오류 코드가 Problem으로 새지 않는지 본다.
import { ProblemError } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { describe, expect, test } from 'vitest';
import type { StaffInvitations } from '../src/modules/session/application/staff-invitations.js';
import { StaffInvitationError } from '../src/modules/session/application/staff-invitations.js';
import { StaffInvitationController } from '../src/modules/session/inbound/staff-invitation.controller.js';

const reply = { header: () => reply } as unknown as FastifyReply;

const controller = (accept: () => Promise<never>): StaffInvitationController =>
  new StaffInvitationController({ accept } as unknown as StaffInvitations);

const accept = (c: StaffInvitationController) =>
  c.accept({ inviteToken: 'invite-token' } as never, { accountId: 'account-1' } as never, reply);

describe('StaffInvitationController 수락 오류 [C2-02]', () => {
  test('PHONE_UNVERIFIED는 403 identity-verification-required, PHONE_UNAVAILABLE은 503 provider-down이다', async () => {
    const unverified = await accept(
      controller(async () => {
        throw new StaffInvitationError('PHONE_UNVERIFIED');
      }),
    ).catch((e: unknown) => e);
    expect(unverified).toBeInstanceOf(ProblemError);
    expect(unverified).toMatchObject({ slug: 'identity-verification-required', status: 403 });

    const unavailable = await accept(
      controller(async () => {
        throw new StaffInvitationError('PHONE_UNAVAILABLE');
      }),
    ).catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(ProblemError);
    expect(unavailable).toMatchObject({ slug: 'provider-down', status: 503, retryAfterSeconds: 1 });
  });
});
