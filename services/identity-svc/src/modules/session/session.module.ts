// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { DrizzleSessionStore } from './adapters/db/drizzle-session-store.js';
import { JoseReauthVerifier } from './adapters/jose-reauth-verifier.js';
import { MemorySessionStore } from './adapters/memory-session-store.js';
import { CreateSession } from './application/create-session.js';
import { EndSession } from './application/end-session.js';
import { CloseAccount } from './application/close-account.js';
import { FinishWithdrawals } from './application/finish-withdrawals.js';
import { GetVerificationStatus } from './application/get-verification-status.js';
import { IssueReauthToken } from './application/issue-reauth-token.js';
import { RefreshSession } from './application/refresh-session.js';
import { WithdrawAccount } from './application/withdraw-account.js';
import { ACCOUNT_CLOSURE, DEVICE_REFS, type DeviceRefs, PUBLIC_KEYS, type PublicKeys, REAUTH_VERIFIER, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, TOKEN_SIGNER, type TokenSigner } from './domain/ports.js';
import { AccountController } from './inbound/account.controller.js';
import { COOKIE_DOMAIN, TokenController } from './inbound/token.controller.js';

export interface SessionModuleOptions {
  storage: 'database' | 'memory';
  signer: TokenSigner;
  /** 공개키 묶음(키 셋 셋) */
  keys: PublicKeys;
  /** 팬 쿠키의 Domain(운영 peaket.example). 없으면 이 호스트만 */
  cookieDomain?: string;
  deviceRefs: DeviceRefs;
  signals: SessionSignals;
}

@Module({})
export class SessionModule {
  /** 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 한다 */
  static register(o: SessionModuleOptions): DynamicModule {
    return {
      module: SessionModule,
      // 본인확인 컨텍스트가 계정 정리(ACCOUNT_CLOSURE)를 쓰므로 전역으로 내준다
      global: true,
      controllers: [TokenController, AccountController],
      providers: [
        CloseAccount,
        { provide: ACCOUNT_CLOSURE, useExisting: CloseAccount },
        CreateSession,
        EndSession,
        IssueReauthToken,
        GetVerificationStatus,
        RefreshSession,
        WithdrawAccount,
        FinishWithdrawals,
        // 재인증 토큰은 이 서비스의 팬 공개키 묶음과 발급자로 확인한다(identity §8 '탈퇴의 첫 구현')
        { provide: REAUTH_VERIFIER, useFactory: (clock: Clock) => new JoseReauthVerifier(o.keys, o.signer.issuer, clock), inject: [CLOCK] },
        o.storage === 'database' ? { provide: SESSION_STORE, useClass: DrizzleSessionStore } : { provide: SESSION_STORE, useValue: new MemorySessionStore() },
        { provide: TOKEN_SIGNER, useValue: o.signer },
        { provide: DEVICE_REFS, useValue: o.deviceRefs },
        { provide: SESSION_SIGNALS, useValue: o.signals },
        { provide: PUBLIC_KEYS, useValue: o.keys },
        { provide: COOKIE_DOMAIN, useValue: o.cookieDomain },
      ],
      exports: [CreateSession, EndSession, IssueReauthToken, GetVerificationStatus, RefreshSession, WithdrawAccount, FinishWithdrawals, ACCOUNT_CLOSURE],
    };
  }
}
