// 모듈 조립 파일: 관리 계정 컨텍스트의 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다, BUILD_ORDER BOT-110·BOT-111).
import { type DynamicModule, Module } from '@nestjs/common';
import { DrizzleAdminAccountStore } from './adapters/db/drizzle-admin-account-store.js';
import { MemoryAdminAccountStore } from './adapters/memory-admin-account-store.js';
import { MemoryLoginCounters } from './adapters/memory-login-counters.js';
import { Pbkdf2AdminPasswords, RECOVERY_CODE_ITERATIONS } from './adapters/pbkdf2-admin-passwords.js';
import { LoginPasswordStep } from './application/login-password-step.js';
import { CONSOLE_ORIGINS, type ConsoleOrigins, DispatchAdminNotices } from './application/dispatch-admin-notices.js';
import { ChangeAdminPassword } from './application/change-admin-password.js';
import { CheckPasswordOnlyLogins } from './application/check-password-only-logins.js';
import { GetAdminAuthz } from './application/get-admin-authz.js';
import { LoginSecondStep } from './application/login-second-step.js';
import { RequestUnlockLink, UnlockWithLink } from './application/unlock-account.js';
import { RecordAdminLoginSuccess } from './application/record-login-success.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from './application/totp-enrollment.js';
import { ADMIN_AUTH_CONFIG, POLICY_LISTS, SetAdminPassword } from './application/set-admin-password.js';
import type { AdminAuthConfig } from './domain/auth-config.js';
import type { PolicyLists } from './domain/password-policy.js';
import {
  ADMIN_ACCOUNT_STORE,
  ADMIN_LOGIN_SIGNALS,
  ADMIN_LOGIN_STORE,
  ADMIN_PASSWORDS,
  ADMIN_MAILER,
  ADMIN_SECOND_STEP_STORE,
  ADMIN_SESSION_STORE,
  ADMIN_TOKEN_SIGNER,
  ADMIN_UNLOCK_STORE,
  type AdminMailer,
  type AdminLoginSignals,
  type AdminTokenSigner,
  RECOVERY_CODE_HASHER,
  TOTP_SEED_CIPHER,
  type TotpSeedCipher,
  TotpKeyUnavailable,
  type AdminPepper,
  BREACH_LIST,
  type BreachList,
  HUMAN_CHECK,
  type HumanCheck,
  LOGIN_COUNTERS,
  type LoginCounters,
} from './domain/ports.js';
import { ADMIN_COOKIE_DOMAIN } from './inbound/admin-cookies.js';
import { AdminLoginController } from './inbound/admin-login.controller.js';
import { AdminPasswordChangeController } from './inbound/admin-password-change.controller.js';
import { AdminUnlockController } from './inbound/admin-unlock.controller.js';

export interface AdminModuleOptions {
  storage: 'database' | 'memory';
  config: AdminAuthConfig;
  lists: PolicyLists;
  pepper: AdminPepper;
  breaches: BreachList;
  humanCheck: HumanCheck;
  signals: AdminLoginSignals;
  /** 세션·캐시 Redis의 셈(id:alf:*). 없으면 메모리(local·ci만, 파드가 여럿이면 셈이 나뉜다) */
  counters?: LoginCounters;
  /** 시험용 PBKDF2 반복 횟수(운영은 600,000) */
  iterations?: number;
  /** TOTP 시드 봉투 암호화. 없으면 2단계는 503(키가 없다) */
  totpCipher: TotpSeedCipher | null;
  /** 관리 액세스 토큰 서명. 없으면 2단계는 503 */
  signer: AdminTokenSigner | null;
  /** 파트너 쿠키의 Domain(운영 peaket.example). 없으면 그 호스트만 */
  cookieDomain?: string;
  /** 계정 주인 메일. 없으면 발송 고리를 돌리지 않는다(알림 행은 쌓인다, BOT-121) */
  mailer?: AdminMailer | null;
  /** 해제 링크의 콘솔 출처 */
  consoleOrigins?: ConsoleOrigins;
}

const noMailer: AdminMailer = {
  send: async () => {
    throw new Error('관리 계정 메일 포트가 없다');
  },
};

const unavailableCipher: TotpSeedCipher = {
  encrypt: async () => {
    throw new TotpKeyUnavailable('not-configured');
  },
  decrypt: async () => {
    throw new TotpKeyUnavailable('not-configured');
  },
};
const unavailableSigner: AdminTokenSigner = {
  access: async () => {
    throw new TotpKeyUnavailable('admin-token-key-not-configured');
  },
};

@Module({})
export class AdminModule {
  static register(o: AdminModuleOptions): DynamicModule {
    const store = o.storage === 'database' ? { provide: DrizzleAdminAccountStore, useClass: DrizzleAdminAccountStore } : { provide: DrizzleAdminAccountStore, useValue: new MemoryAdminAccountStore() };
    return {
      module: AdminModule,
      controllers: [AdminLoginController, AdminUnlockController, AdminPasswordChangeController],
      providers: [
        store,
        { provide: ADMIN_ACCOUNT_STORE, useExisting: DrizzleAdminAccountStore },
        { provide: ADMIN_LOGIN_STORE, useExisting: DrizzleAdminAccountStore },
        { provide: ADMIN_SECOND_STEP_STORE, useExisting: DrizzleAdminAccountStore },
        { provide: ADMIN_UNLOCK_STORE, useExisting: DrizzleAdminAccountStore },
        { provide: ADMIN_SESSION_STORE, useExisting: DrizzleAdminAccountStore },
        { provide: ADMIN_MAILER, useValue: o.mailer ?? noMailer },
        { provide: CONSOLE_ORIGINS, useValue: o.consoleOrigins ?? { partner: 'https://partner.peaket.example', ops: 'https://console.peaket.example' } },
        { provide: TOTP_SEED_CIPHER, useValue: o.totpCipher ?? unavailableCipher },
        { provide: ADMIN_TOKEN_SIGNER, useValue: o.signer ?? unavailableSigner },
        { provide: ADMIN_COOKIE_DOMAIN, useValue: o.cookieDomain },
        { provide: RECOVERY_CODE_HASHER, useValue: new Pbkdf2AdminPasswords(o.pepper, { iterations: RECOVERY_CODE_ITERATIONS, context: 'admin-rc-v1' }) },
        { provide: ADMIN_PASSWORDS, useValue: new Pbkdf2AdminPasswords(o.pepper, o.iterations ? { iterations: o.iterations } : {}) },
        { provide: BREACH_LIST, useValue: o.breaches },
        { provide: HUMAN_CHECK, useValue: o.humanCheck },
        { provide: ADMIN_LOGIN_SIGNALS, useValue: o.signals },
        { provide: LOGIN_COUNTERS, useValue: o.counters ?? new MemoryLoginCounters() },
        { provide: ADMIN_AUTH_CONFIG, useValue: o.config },
        { provide: POLICY_LISTS, useValue: o.lists },
        SetAdminPassword,
        LoginPasswordStep,
        RecordAdminLoginSuccess,
        LoginSecondStep,
        BeginTotpEnrollment,
        ConfirmTotpEnrollment,
        UnlockWithLink,
        RequestUnlockLink,
        DispatchAdminNotices,
        CheckPasswordOnlyLogins,
        ChangeAdminPassword,
        GetAdminAuthz,
      ],
      exports: [SetAdminPassword, LoginPasswordStep, RecordAdminLoginSuccess, LoginSecondStep, BeginTotpEnrollment, ConfirmTotpEnrollment, UnlockWithLink, RequestUnlockLink, DispatchAdminNotices, CheckPasswordOnlyLogins, ChangeAdminPassword, GetAdminAuthz, ADMIN_ACCOUNT_STORE, ADMIN_LOGIN_STORE],
    };
  }
}
