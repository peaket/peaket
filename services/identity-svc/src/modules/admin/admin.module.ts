// 모듈 조립 파일: 관리 계정 컨텍스트의 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다, BUILD_ORDER BOT-110·BOT-111).
import { type DynamicModule, Module } from '@nestjs/common';
import { DrizzleAdminAccountStore } from './adapters/db/drizzle-admin-account-store.js';
import { MemoryAdminAccountStore } from './adapters/memory-admin-account-store.js';
import { MemoryLoginCounters } from './adapters/memory-login-counters.js';
import { Pbkdf2AdminPasswords } from './adapters/pbkdf2-admin-passwords.js';
import { LoginPasswordStep } from './application/login-password-step.js';
import { RecordAdminLoginSuccess } from './application/record-login-success.js';
import { ADMIN_AUTH_CONFIG, POLICY_LISTS, SetAdminPassword } from './application/set-admin-password.js';
import type { AdminAuthConfig } from './domain/auth-config.js';
import type { PolicyLists } from './domain/password-policy.js';
import {
  ADMIN_ACCOUNT_STORE,
  ADMIN_LOGIN_SIGNALS,
  ADMIN_LOGIN_STORE,
  ADMIN_PASSWORDS,
  type AdminLoginSignals,
  type AdminPepper,
  BREACH_LIST,
  type BreachList,
  HUMAN_CHECK,
  type HumanCheck,
  LOGIN_COUNTERS,
  type LoginCounters,
} from './domain/ports.js';
import { AdminLoginController } from './inbound/admin-login.controller.js';

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
}

@Module({})
export class AdminModule {
  static register(o: AdminModuleOptions): DynamicModule {
    const store = o.storage === 'database' ? { provide: DrizzleAdminAccountStore, useClass: DrizzleAdminAccountStore } : { provide: DrizzleAdminAccountStore, useValue: new MemoryAdminAccountStore() };
    return {
      module: AdminModule,
      controllers: [AdminLoginController],
      providers: [
        store,
        { provide: ADMIN_ACCOUNT_STORE, useExisting: DrizzleAdminAccountStore },
        { provide: ADMIN_LOGIN_STORE, useExisting: DrizzleAdminAccountStore },
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
      ],
      exports: [SetAdminPassword, LoginPasswordStep, RecordAdminLoginSuccess, ADMIN_ACCOUNT_STORE, ADMIN_LOGIN_STORE],
    };
  }
}
