// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, type DpopReplayStore, MemoryDpopReplayStore } from '@peaket/platform';
import { BackfillContactRefs } from './application/backfill-contact-refs.js';
import { ComputeContactRef, CONTACT_REF_RPS, DEFAULT_CONTACT_REF_RPS } from './application/compute-contact-ref.js';
import { GetInvestigationRefs } from './application/get-investigation-refs.js';
import { DrizzleSessionStore } from './adapters/db/drizzle-session-store.js';
import { JoseReauthVerifier } from './adapters/jose-reauth-verifier.js';
import { MemorySessionStore } from './adapters/memory-session-store.js';
import { CreateSession } from './application/create-session.js';
import { GetLinkProposal } from './application/get-link-proposal.js';
import { SeparateAccount } from './application/separate-account.js';
import { MemoryLinkProposals } from './adapters/memory-link-proposals.js';
import { EndSession } from './application/end-session.js';
import { CloseAccount } from './application/close-account.js';
import { FinishWithdrawals } from './application/finish-withdrawals.js';
import { GetVerificationStatus } from './application/get-verification-status.js';
import { IssueReauthToken } from './application/issue-reauth-token.js';
import { RefreshSession } from './application/refresh-session.js';
import { WithdrawAccount } from './application/withdraw-account.js';
import { RetryPendingWithdrawals } from './application/retry-pending-withdrawals.js';
import { WITHDRAWAL_PARTICIPANTS, WITHDRAWAL_SIGNALS, type WithdrawalParticipant, type WithdrawalSignals } from './domain/withdrawal.js';
import { LOGIN_RISK, type LoginRisk, ACCOUNT_CLOSURE, DEVICE_REFS, type DeviceRefs, INV_REFS, type InvRefs, LINK_PROPOSALS, type LinkProposals, MERGE_CHECKERS, MERGE_PROPOSALS, type MergeChecker, type MergeProposals, PUBLIC_KEYS, type PublicKeys, REAUTH_VERIFIER, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, TOKEN_SIGNER, type TokenSigner } from './domain/ports.js';
import { AccountController, ProvidersController } from './inbound/account.controller.js';
import { ListProviders } from './application/list-providers.js';
import { GetRecipients } from './application/get-recipients.js';
import { AddProvider } from './application/add-provider.js';
import { UnlinkProvider } from './application/unlink-provider.js';
import { ConfirmMerge } from './application/confirm-merge.js';
import { GetMergeProposal } from './application/get-merge-proposal.js';
import { MergePlanner } from './application/plan-merge.js';
import { SetAccountHold } from './application/set-account-hold.js';
import { MemoryMergeProposals } from './adapters/memory-merge-proposals.js';
import { noBlockChecker } from './adapters/grpc-merge-checkers.js';
import { MergeProposalsController } from './inbound/merge.controller.js';
import { SessionsController } from './inbound/sessions.controller.js';
import { EndDeviceSession } from './application/end-device-session.js';
import { ListSessions } from './application/list-sessions.js';
import { COOKIE_DOMAIN, TokenController } from './inbound/token.controller.js';
import { AccountSummaryController } from './inbound/account-summary.controller.js';
import { GetAccountSummary } from './application/get-account-summary.js';
import { CompleteSignup } from './application/complete-signup.js';
import { CheckNickname } from './application/check-nickname.js';
import { CancelSignup } from './application/cancel-signup.js';
import { MemoryNicknameCheckLimits } from './adapters/memory-nickname-check-limits.js';
import { NICKNAME_CHECK_LIMITS, type NicknameCheckLimits, STAFF_ASSIGNMENTS, type StaffAssignments } from './domain/ports.js';
import { CORE_EVENT_OWNERS, type CoreEventOwners, DEFAULT_STAFF_INVITATION_URL, STAFF_ASSIGNMENT_STORE, STAFF_INVITE_MAILER, type StaffAssignmentStore, type StaffInviteMailer } from './domain/staff.js';
import { CheckScannerSession } from './application/check-scanner-session.js';
import { TerminateScannerSessions } from './application/terminate-scanner-sessions.js';
import { StaffInvitations } from './application/staff-invitations.js';
import { StaffInvitationController } from './inbound/staff-invitation.controller.js';
import { NEW_STAFF_INVITE_TOKEN, PartnerStaffInvitations, STAFF_INVITATION_URL, newStaffInviteToken } from './application/partner-staff-invitations.js';
import { PartnerStaffController } from './inbound/partner-staff.controller.js';
import { DrizzleStaffAssignmentStore } from './adapters/db/drizzle-staff-assignment-store.js';
import { MemoryStaffAssignmentStore } from './adapters/memory-staff-assignment-store.js';
import { StartDeviceAuthorization, NEW_SCANNER_SESSION_ID, NEW_USER_CODE, defaultScannerSessionId } from './application/start-device-authorization.js';
import { newUserCode } from './domain/device-approval.js';
import { DeviceApprovals } from './application/device-approvals.js';
import { PollScannerToken } from './application/poll-scanner-token.js';
import { ScannerAuthorizationController } from './inbound/scanner-authorization.controller.js';
import { DeviceApprovalController } from './inbound/device-approval.controller.js';
import { MemoryDeviceAuthorizations, MemoryDeviceApprovalLimits } from './adapters/memory-device-authorizations.js';
import { DEVICE_APPROVAL_LIMITS, DEVICE_AUTHORIZATIONS, SCANNER_DEVICE_REGISTRY, SCANNER_DPOP_REPLAY, type DeviceApprovalLimits, type DeviceAuthorizationStore, type ScannerDeviceRegistry } from './domain/ports.js';

export interface SessionModuleOptions {
  /** 닉네임 확인의 요청 수 저장소(세션·캐시 Redis id:nick, ADR-0235). 없으면 메모리(로컬·시험) */
  nicknameCheckLimits?: NicknameCheckLimits;
  /** 현장 스태프 배정 조회(BUILD_ORDER GAT-210이 채운다). 없으면 늘 없음 */
  staffAssignments?: StaffAssignments;
  storage: 'database' | 'memory';
  signer: TokenSigner;
  /** 공개키 묶음(키 셋 셋) */
  keys: PublicKeys;
  /** 팬 쿠키의 Domain(운영 peaket.example). 없으면 이 호스트만 */
  cookieDomain?: string;
  deviceRefs: DeviceRefs;
  signals: SessionSignals;
  /** 가입 때 연결 제안 저장소(세션·캐시 Redis, identity §2.1). 없으면 메모리(로컬·시험) */
  linkProposals?: LinkProposals;
  /** 병합 제안 저장소(세션·캐시 Redis id:merge). 없으면 메모리 */
  mergeProposals?: MergeProposals;
  /** 세 서비스의 CheckAccountMerge. 없으면 막는 것이 없다고 보는 대역(시험) */
  mergeCheckers?: MergeChecker[];
  /** 조사용 가명(라벨 키 링, identity §9.1). 없으면 늘 비운다(시험) */
  invRefs?: InvRefs;
  /** 로그인 판정(trust-svc, identity §7). 없으면 세션의 판정이 UNKNOWN이다 */
  loginRisk?: LoginRisk;
  /** ComputeContactRef의 파드마다 초당 상한. 없으면 기본값 */
  contactRefRps?: number;
  /** 기기 승인 요청 저장소(세션·캐시 Redis id:devauth). 없으면 메모리(로컬·시험) */
  deviceAuthorizations?: DeviceAuthorizationStore;
  /** 기기 승인 코드 발급·승인 시도 한도. 없으면 메모리(로컬·시험) */
  deviceApprovalLimits?: DeviceApprovalLimits;
  /** ticket-svc 기기 원장(gRPC). 없으면 기기 승인 로그인이 503이다 */
  scannerDevices?: ScannerDeviceRegistry;
  /** 기기 DPoP jti 저장소. 없으면 메모리(로컬·시험) */
  scannerDpopReplay?: DpopReplayStore;
  /** 시험에서 스캐너 세션 ID를 고정한다 */
  newScannerSessionId?: () => string;
  /** 시험에서 사용자 확인 코드를 고정한다 */
  newUserCode?: () => string;
  /** 탈퇴 참여자(identity §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현'). 없으면 참여자 없이 바로 끝낸다(시험) */
  withdrawalParticipants?: WithdrawalParticipant[];
  /** 탈퇴 미룸 지표. 없으면 내지 않는다(시험) */
  withdrawalSignals?: WithdrawalSignals;
  /** core-svc 회차 판매자·시각 조회(파트너 초대, ADR-0353). 없으면 초대 만들기·명단·해제·재발송이 503이다 */
  coreEventOwners?: CoreEventOwners;
  /** 현장 스태프 초대 메일 포트. 없으면 만들기·재발송이 503 staff-invite-mail-unavailable이다 */
  staffInviteMailer?: StaffInviteMailer;
  /** 초대 링크 앞부분(조각은 서비스가 붙인다). 없으면 기본값 */
  staffInvitationUrl?: string;
  /** 시험에서 토큰을 고정한다. 없으면 32바이트 난수 base64url */
  newStaffInviteToken?: () => string;
  /** 파트너 콘솔 초대 경로를 싣는다. 관리 역할 판정(adminAuthz)이 있는 조립에서만 true다(파트너 로그인도 그때만 있다) */
  partnerStaff?: boolean;
}

@Module({})
export class SessionModule {
  /** 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 한다 */
  static register(o: SessionModuleOptions): DynamicModule {
    // memory 조립에서도 스태프 저장소가 세션 저장소의 계정 상태를 읽어 비ACTIVE 계정을 닫게 한다.
    const memorySessions = o.storage === 'memory' ? new MemorySessionStore() : undefined;
    const memoryStaff = memorySessions ? new MemoryStaffAssignmentStore((accountId) => memorySessions.accountOf(accountId)?.status) : undefined;
    return {
      module: SessionModule,
      // 본인확인 컨텍스트가 계정 정리(ACCOUNT_CLOSURE)를 쓰므로 전역으로 내준다
      global: true,
      controllers: [
        TokenController,
        AccountController,
        ProvidersController,
        MergeProposalsController,
        SessionsController,
        AccountSummaryController,
        StaffInvitationController,
        // 파트너 초대는 관리 역할 판정(adminAuthz)이 있어야 뜬다. 없으면 플랫폼 시작 확인이 막으므로 조립에서 뺀다
        ...(o.partnerStaff ? [PartnerStaffController] : []),
        ScannerAuthorizationController,
        DeviceApprovalController,
      ],
      providers: [
        GetAccountSummary,
        CompleteSignup,
        CheckNickname,
        CancelSignup,
        o.nicknameCheckLimits ? { provide: NICKNAME_CHECK_LIMITS, useValue: o.nicknameCheckLimits } : { provide: NICKNAME_CHECK_LIMITS, useFactory: (clock: Clock) => new MemoryNicknameCheckLimits(clock), inject: [CLOCK] },
        o.storage === 'database' ? { provide: STAFF_ASSIGNMENT_STORE, useClass: DrizzleStaffAssignmentStore } : { provide: STAFF_ASSIGNMENT_STORE, useValue: memoryStaff },
        { provide: STAFF_ASSIGNMENTS, useFactory: (store: StaffAssignmentStore) => o.staffAssignments ?? store, inject: [STAFF_ASSIGNMENT_STORE] },
        CheckScannerSession,
        TerminateScannerSessions,
        StaffInvitations,
        PartnerStaffInvitations,
        ...(o.coreEventOwners ? [{ provide: CORE_EVENT_OWNERS, useValue: o.coreEventOwners }] : []),
        ...(o.staffInviteMailer ? [{ provide: STAFF_INVITE_MAILER, useValue: o.staffInviteMailer }] : []),
        { provide: STAFF_INVITATION_URL, useValue: o.staffInvitationUrl ?? DEFAULT_STAFF_INVITATION_URL },
        { provide: NEW_STAFF_INVITE_TOKEN, useValue: o.newStaffInviteToken ?? newStaffInviteToken },
        StartDeviceAuthorization,
        DeviceApprovals,
        PollScannerToken,
        { provide: NEW_SCANNER_SESSION_ID, useValue: o.newScannerSessionId ?? defaultScannerSessionId },
        { provide: NEW_USER_CODE, useValue: o.newUserCode ?? newUserCode },
        o.deviceAuthorizations ? { provide: DEVICE_AUTHORIZATIONS, useValue: o.deviceAuthorizations } : { provide: DEVICE_AUTHORIZATIONS, useFactory: (clock: Clock) => new MemoryDeviceAuthorizations(() => clock.now()), inject: [CLOCK] },
        o.deviceApprovalLimits ? { provide: DEVICE_APPROVAL_LIMITS, useValue: o.deviceApprovalLimits } : { provide: DEVICE_APPROVAL_LIMITS, useValue: new MemoryDeviceApprovalLimits() },
        {
          provide: SCANNER_DEVICE_REGISTRY,
          useValue: o.scannerDevices ?? {
            byThumbprint: async () => {
              throw new Error('PEAKET_TICKET_GRPC_URL이 없어 스캐너 기기 원장을 확인하지 못한다');
            },
          },
        },
        o.scannerDpopReplay ? { provide: SCANNER_DPOP_REPLAY, useValue: o.scannerDpopReplay } : { provide: SCANNER_DPOP_REPLAY, useFactory: (clock: Clock) => new MemoryDpopReplayStore(clock), inject: [CLOCK] },
        CloseAccount,
        { provide: ACCOUNT_CLOSURE, useExisting: CloseAccount },
        CreateSession,
        GetLinkProposal,
        SeparateAccount,
        EndSession,
        IssueReauthToken,
        GetVerificationStatus,
        GetRecipients,
        RefreshSession,
        WithdrawAccount,
        RetryPendingWithdrawals,
        { provide: WITHDRAWAL_PARTICIPANTS, useValue: o.withdrawalParticipants ?? [] },
        ...(o.withdrawalSignals ? [{ provide: WITHDRAWAL_SIGNALS, useValue: o.withdrawalSignals }] : []),
        ListProviders,
        ListSessions,
        EndDeviceSession,
        AddProvider,
        UnlinkProvider,
        MergePlanner,
        GetMergeProposal,
        ConfirmMerge,
        SetAccountHold,
        FinishWithdrawals,
        ComputeContactRef,
        GetInvestigationRefs,
        BackfillContactRefs,
        { provide: INV_REFS, useValue: o.invRefs ?? { ref: () => undefined } },
        { provide: CONTACT_REF_RPS, useValue: o.contactRefRps ?? DEFAULT_CONTACT_REF_RPS },
        // 재인증 토큰은 이 서비스의 팬 공개키 묶음과 발급자로 확인한다(identity §8 '탈퇴의 첫 구현')
        { provide: REAUTH_VERIFIER, useFactory: (clock: Clock) => new JoseReauthVerifier(o.keys, o.signer.issuer, clock), inject: [CLOCK] },
        o.storage === 'database' ? { provide: SESSION_STORE, useClass: DrizzleSessionStore } : { provide: SESSION_STORE, useValue: memorySessions },
        o.linkProposals ? { provide: LINK_PROPOSALS, useValue: o.linkProposals } : { provide: LINK_PROPOSALS, useFactory: (clock: Clock) => new MemoryLinkProposals(clock), inject: [CLOCK] },
        o.mergeProposals ? { provide: MERGE_PROPOSALS, useValue: o.mergeProposals } : { provide: MERGE_PROPOSALS, useFactory: (clock: Clock) => new MemoryMergeProposals(clock), inject: [CLOCK] },
        { provide: MERGE_CHECKERS, useValue: o.mergeCheckers ?? (['purchase', 'ticket', 'core'] as const).map(noBlockChecker) },
        { provide: TOKEN_SIGNER, useValue: o.signer },
        { provide: DEVICE_REFS, useValue: o.deviceRefs },
        { provide: SESSION_SIGNALS, useValue: o.signals },
        ...(o.loginRisk ? [{ provide: LOGIN_RISK, useValue: o.loginRisk }] : []),
        { provide: PUBLIC_KEYS, useValue: o.keys },
        { provide: COOKIE_DOMAIN, useValue: o.cookieDomain },
      ],
      exports: [CreateSession, GetLinkProposal, SeparateAccount, AddProvider, UnlinkProvider, SetAccountHold, ComputeContactRef, GetInvestigationRefs, BackfillContactRefs, EndSession, IssueReauthToken, GetVerificationStatus, GetRecipients, RefreshSession, WithdrawAccount, RetryPendingWithdrawals, FinishWithdrawals, CheckScannerSession, TerminateScannerSessions, ACCOUNT_CLOSURE],
    };
  }
}
