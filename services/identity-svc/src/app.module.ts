// 뿌리 모듈: 컨텍스트 모듈과 공용 설정(DB)을 모은다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { AdminModule, type AdminModuleOptions } from './modules/admin/index.js';
import { SessionModule, type SessionModuleOptions } from './modules/session/index.js';
import { VerificationModule, type VerificationModuleOptions } from './modules/verification/index.js';

type Session = Omit<SessionModuleOptions, 'storage'>;
type Verification = Omit<VerificationModuleOptions, 'storage'>;
type Admin = Omit<AdminModuleOptions, 'storage'>;

@Module({})
export class AppModule {
  /** 운영은 database, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  // 본인확인 모듈이 세션 모듈이 쓰는 계정 값(ACCOUNT_CLAIMS)을 전역으로 내주므로 먼저 둔다
  // 관리 계정 컨텍스트(admin)는 페퍼 설정이 있을 때만 싣는다(없으면 관리 계정 로그인 경로가 없다. local·ci 밖은 main.ts가 페퍼를 필수로 본다)
  static register(o: ({ database: Database } | { memory: true }) & { session: Session; verification: Verification; admin?: Admin }): DynamicModule {
    const storage = 'database' in o ? ('database' as const) : ('memory' as const);
    const admin = o.admin ? [AdminModule.register({ storage, ...o.admin })] : [];
    if ('database' in o) {
      return {
        module: AppModule,
        imports: [databaseModule(o.database), VerificationModule.register({ storage: 'database', ...o.verification }), SessionModule.register({ storage: 'database', ...o.session }), ...admin],
      };
    }
    return { module: AppModule, imports: [VerificationModule.register({ storage: 'memory', ...o.verification }), SessionModule.register({ storage: 'memory', ...o.session }), ...admin] };
  }
}
