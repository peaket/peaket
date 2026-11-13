// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
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
import { LOGIN_RISK, type LoginRisk, ACCOUNT_CLOSURE, DEVICE_REFS, type DeviceRefs, INV_REFS, type InvRefs, LINK_PROPOSALS, type LinkProposals, MERGE_CHECKERS, MERGE_PROPOSALS, type MergeChecker, type MergeProposals, PUBLIC_KEYS, type PublicKeys, REAUTH_VERIFIER, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, TOKEN_SIGNER, type TokenSigner } from './domain/ports.js';
import { AccountController, ProvidersController } from './inbound/account.controller.js';
import { ListProviders } from './application/list-providers.js';
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
import { STAFF_ASSIGNMENT_STORE, type StaffAssignmentStore } from './domain/staff.js';
import { CheckScannerSession } from './application/check-scanner-session.js';
import { StaffInvitations } from './application/staff-invitations.js';
import { StaffInvitationController } from './inbound/staff-invitation.controller.js';
import { DrizzleStaffAssignmentStore } from './adapters/db/drizzle-staff-assignment-store.js';
import { MemoryStaffAssignmentStore } from './adapters/memory-staff-assignment-store.js';

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
}

@Module({})
export class SessionModule {
  /** 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 한다 */
  static register(o: SessionModuleOptions): DynamicModule {
    return {
      module: SessionModule,
      // 본인확인 컨텍스트가 계정 정리(ACCOUNT_CLOSURE)를 쓰므로 전역으로 내준다
      global: true,
      controllers: [TokenController, AccountController, ProvidersController, MergeProposalsController, SessionsController, AccountSummaryController, StaffInvitationController],
      providers: [
        GetAccountSummary,
        CompleteSignup,
        CheckNickname,
        CancelSignup,
        o.nicknameCheckLimits ? { provide: NICKNAME_CHECK_LIMITS, useValue: o.nicknameCheckLimits } : { provide: NICKNAME_CHECK_LIMITS, useFactory: (clock: Clock) => new MemoryNicknameCheckLimits(clock), inject: [CLOCK] },
        o.storage === 'database' ? { provide: STAFF_ASSIGNMENT_STORE, useClass: DrizzleStaffAssignmentStore } : { provide: STAFF_ASSIGNMENT_STORE, useValue: new MemoryStaffAssignmentStore() },
        { provide: STAFF_ASSIGNMENTS, useFactory: (store: StaffAssignmentStore) => o.staffAssignments ?? store, inject: [STAFF_ASSIGNMENT_STORE] },
        CheckScannerSession,
        StaffInvitations,
        CloseAccount,
        { provide: ACCOUNT_CLOSURE, useExisting: CloseAccount },
        CreateSession,
        GetLinkProposal,
        SeparateAccount,
        EndSession,
        IssueReauthToken,
        GetVerificationStatus,
        RefreshSession,
        WithdrawAccount,
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
        o.storage === 'database' ? { provide: SESSION_STORE, useClass: DrizzleSessionStore } : { provide: SESSION_STORE, useValue: new MemorySessionStore() },
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
      exports: [CreateSession, GetLinkProposal, SeparateAccount, AddProvider, UnlinkProvider, SetAccountHold, ComputeContactRef, GetInvestigationRefs, BackfillContactRefs, EndSession, IssueReauthToken, GetVerificationStatus, RefreshSession, WithdrawAccount, FinishWithdrawals, CheckScannerSession, ACCOUNT_CLOSURE],
    };
  }
}
