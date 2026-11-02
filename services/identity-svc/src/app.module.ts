// 뿌리 모듈: 컨텍스트 모듈과 공용 설정(DB)을 모은다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { SessionModule, type SessionModuleOptions } from './modules/session/index.js';
import { VerificationModule, type VerificationModuleOptions } from './modules/verification/index.js';

type Session = Omit<SessionModuleOptions, 'storage'>;
type Verification = Omit<VerificationModuleOptions, 'storage'>;

@Module({})
export class AppModule {
  /** 운영은 database, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  // 본인확인 모듈이 세션 모듈이 쓰는 계정 값(ACCOUNT_CLAIMS)을 전역으로 내주므로 먼저 둔다
  static register(o: ({ database: Database } | { memory: true }) & { session: Session; verification: Verification }): DynamicModule {
    if ('database' in o) {
      return {
        module: AppModule,
        imports: [databaseModule(o.database), VerificationModule.register({ storage: 'database', ...o.verification }), SessionModule.register({ storage: 'database', ...o.session })],
      };
    }
    return { module: AppModule, imports: [VerificationModule.register({ storage: 'memory', ...o.verification }), SessionModule.register({ storage: 'memory', ...o.session })] };
  }
}
