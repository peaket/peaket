// 모듈 조립 파일: 본인확인 포트에 어댑터를 묶는다. 세션 컨텍스트가 토큰에 실을 계정 값(ACCOUNT_CLAIMS)을 전역으로 내준다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ACCOUNT_CLAIMS, ACCOUNT_CLOSURE, ACCOUNT_ERASER, type AccountClosure, FRAUD_HOLDS, REVERIFICATIONS } from '../session/index.js';
import { DrizzleVerificationStore } from './adapters/db/drizzle-verification-store.js';
import { MemoryVerificationStore } from './adapters/memory-verification-store.js';
import { VerificationClaims } from './adapters/verification-claims.js';
import { VerificationEraser } from './adapters/verification-eraser.js';
import { VerificationHolds } from './adapters/verification-holds.js';
import { SetRestrictedCiHold } from './application/set-restricted-ci-hold.js';
import { CheckReverification } from './application/check-reverification.js';
import { ConfirmVerification } from './application/confirm-verification.js';
import { GetVerificationResult } from './application/get-verification-result.js';
import { StartVerification } from './application/start-verification.js';
import { IDENTITY_HASHERS, type IdentityHashers, PHONE_REFS, type PhoneRefs, VERIFICATION_PROVIDER, VERIFICATION_STORE, type VerificationProvider, type VerificationStore } from './domain/ports.js';
import { VerificationController } from './inbound/verification.controller.js';

export interface VerificationModuleOptions {
  storage: 'database' | 'memory';
  provider: VerificationProvider;
  hashers: IdentityHashers;
  /** 본인확인 번호의 연락처 가명(identity §9.1). 없으면 쓰지 않는다 */
  phoneRefs?: PhoneRefs;
}

@Module({})
export class VerificationModule {
  static register(o: VerificationModuleOptions): DynamicModule {
    return {
      module: VerificationModule,
      global: true,
      controllers: [VerificationController],
      providers: [
        StartVerification,
        ConfirmVerification,
        GetVerificationResult,
        o.storage === 'database' ? { provide: VERIFICATION_STORE, useClass: DrizzleVerificationStore } : { provide: VERIFICATION_STORE, useValue: new MemoryVerificationStore() },
        { provide: VERIFICATION_PROVIDER, useValue: o.provider },
        { provide: IDENTITY_HASHERS, useValue: o.hashers },
        ...(o.phoneRefs ? [{ provide: PHONE_REFS, useValue: o.phoneRefs }] : []),
        SetRestrictedCiHold,
        // 추가 검증 제출의 본인확인 재통과 확인(gRPC, queue-svc만, BOT-090)
        CheckReverification,
        { provide: ACCOUNT_CLAIMS, useFactory: (store: VerificationStore, closure: AccountClosure, clock: Clock) => new VerificationClaims(store, closure, clock), inject: [VERIFICATION_STORE, ACCOUNT_CLOSURE, CLOCK] },
        { provide: FRAUD_HOLDS, useFactory: (store: VerificationStore) => new VerificationHolds(store), inject: [VERIFICATION_STORE] },
        { provide: ACCOUNT_ERASER, useFactory: (store: VerificationStore) => new VerificationEraser(store), inject: [VERIFICATION_STORE] },
        { provide: REVERIFICATIONS, useExisting: ACCOUNT_CLAIMS },
      ],
      exports: [ACCOUNT_CLAIMS, REVERIFICATIONS, ACCOUNT_ERASER, FRAUD_HOLDS, SetRestrictedCiHold, CheckReverification],
    };
  }
}
