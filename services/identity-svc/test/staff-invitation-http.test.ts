// 스태프 초대 수락의 HTTP 계약(C2-02, identity §6.1): 휴대폰 본인확인 미완료는 403 identity-verification-required,
// 확인 저장소·기관을 쓸 수 없으면 503 provider-down이다. 서비스 오류 코드가 Problem으로 새지 않는지 본다.
// I-T91 ⑤(BUILD_ORDER F-05-7, ADR-0362 결정 1·4): 메모리 조립(AppModule memory)과 http.inject로 조회의 eventId와 수락 403의 type 둘을 본다.
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { CreateSession, JoseTokenSigner, STAFF_ASSIGNMENT_STORE, TokenKeyRing } from '../src/modules/session/index.js';
import { fanKey, ISSUER, newKey, recordingSignals, testDeviceRefs } from './support.js';
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

describe('초대 조회·수락의 HTTP 답(I-T91 ⑤, ADR-0362 결정 1·4)', () => {
  let svc: Awaited<ReturnType<typeof createService>>;
  let staff: MemoryStaffAssignmentStore;
  const clock = fakeClock({ now: Date.parse('2026-11-23T06:00:00.000Z') });
  const HOUR = 3_600_000;
  const EVENT = '0190f3a1-7c2e-7a00-8000-00000000e091';
  const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  beforeAll(async () => {
    const fan = await fanKey();
    const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
    svc = await createService({
      name: 'identity-svc',
      module: AppModule.register({ memory: true, session: { signer: new JoseTokenSigner(keys, ISSUER), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example' } } as never),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
    });
    staff = svc.app.get<MemoryStaffAssignmentStore>(STAFF_ASSIGNMENT_STORE);
  });
  afterAll(async () => {
    await svc?.close();
  });

  const login = (sub: string) => svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'naver', providerUserId: sub, email: null, emailVerified: false, deviceId: 'dev-p' });
  const headers = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '', 'content-type': 'application/json' });
  const post = (url: string, s: { accountId: string; sessionId: string }, body: unknown) => svc.http.inject({ method: 'POST', url, headers: headers(s), payload: JSON.stringify(body) });
  const invite = (id: string, token: string) =>
    staff.assignments.set(id, {
      id,
      accountId: null,
      status: 'INVITED',
      eventId: EVENT,
      role: 'gate_lead',
      inviteEmail: 'gate.lead@example.org',
      inviteTokenHash: hash(token),
      inviteExpiresAtMs: clock.now() + HOUR,
      invitedBy: '0190f3a1-7c2e-7a00-8000-00000000a091',
      promoterId: '0190f3a1-7c2e-7a00-8000-00000000b091',
      validFromMs: clock.now() + HOUR,
      validUntilMs: clock.now() + 9 * HOUR,
    });

  test('I-T91 ⑤ 조회 200에 eventId가 있고 판은 staff-2026-11-23이며 no-store다', async () => {
    invite('inv-h-1', 'tok-h-1');
    const s = await login('h-lookup');
    const r = await post('/v1/staff-invitation-lookups', s, { inviteToken: 'tok-h-1' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const b = JSON.parse(r.body) as { eventId: string; role: string; invitedEmailMasked: string; consents: { consentVersion: string } };
    expect(b).toMatchObject({ eventId: EVENT, role: 'gate_lead', consents: { consentVersion: 'staff-2026-11-23' } });
    expect(r.body).not.toContain('gate.lead@example.org');
    expect(r.body).not.toContain('tok-h-1');
  });

  test('I-T91 ⑤ 검증 이메일 없는 계정은 403 staff-invitation-email-unverified, 다른 이메일은 403 staff-invitation-email-mismatch이고 배정은 INVITED로 남는다', async () => {
    invite('inv-h-2', 'tok-h-2');
    const body = { inviteToken: 'tok-h-2', consentCollection: true, consentProvision: true, consentVersion: 'staff-2026-11-23' };
    const naver = await login('h-naver');
    staff.accounts.set(naver.accountId, { email: 'gate.lead@example.org', verified: false });
    const unverified = await post('/v1/staff-invitation-acceptances', naver, body);
    expect(unverified.statusCode).toBe(403);
    expect((JSON.parse(unverified.body) as { type: string }).type.split('/').pop()).toBe('staff-invitation-email-unverified');
    expect(staff.assignments.get('inv-h-2')).toMatchObject({ status: 'INVITED', accountId: null, inviteEmail: 'gate.lead@example.org' });
    // 다른 이메일 계정의 403 mismatch는 휴대폰 본인확인 뒤에 갈린다(메모리 조립엔 본인확인 기록이 없다). 실제 저장소·본인확인 기록으로는
    // test-int/staff-invitations.int.test.ts의 I-T91 ⑤, 받는 층의 오류 이름 바꾸기는 아래 시험이 본다
    const mismatch = await accept(
      controller(async () => {
        throw new StaffInvitationError('EMAIL_MISMATCH');
      }),
    ).catch((e: unknown) => e);
    expect(mismatch).toMatchObject({ slug: 'staff-invitation-email-mismatch', status: 403 });
    const unverifiedCode = await accept(
      controller(async () => {
        throw new StaffInvitationError('EMAIL_UNVERIFIED');
      }),
    ).catch((e: unknown) => e);
    expect(unverifiedCode).toMatchObject({ slug: 'staff-invitation-email-unverified', status: 403 });
  });
});
