// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, Module } from '@nestjs/common';
import { DrizzleSessionStore } from './adapters/db/drizzle-session-store.js';
import { MemorySessionStore } from './adapters/memory-session-store.js';
import { CreateSession } from './application/create-session.js';
import { EndSession } from './application/end-session.js';
import { IssueReauthToken } from './application/issue-reauth-token.js';
import { DEVICE_REFS, type DeviceRefs, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, TOKEN_SIGNER, type TokenSigner } from './domain/ports.js';

export interface SessionModuleOptions {
  storage: 'database' | 'memory';
  signer: TokenSigner;
  deviceRefs: DeviceRefs;
  signals: SessionSignals;
}

@Module({})
export class SessionModule {
  /** 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 한다 */
  static register(o: SessionModuleOptions): DynamicModule {
    return {
      module: SessionModule,
      providers: [
        CreateSession,
        EndSession,
        IssueReauthToken,
        o.storage === 'database' ? { provide: SESSION_STORE, useClass: DrizzleSessionStore } : { provide: SESSION_STORE, useValue: new MemorySessionStore() },
        { provide: TOKEN_SIGNER, useValue: o.signer },
        { provide: DEVICE_REFS, useValue: o.deviceRefs },
        { provide: SESSION_SIGNALS, useValue: o.signals },
      ],
      exports: [CreateSession, EndSession, IssueReauthToken],
    };
  }
}
