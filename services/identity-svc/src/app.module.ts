// 뿌리 모듈: 컨텍스트 모듈과 공용 설정(DB)을 모은다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { SessionModule, type SessionModuleOptions } from './modules/session/index.js';

type Session = Omit<SessionModuleOptions, 'storage'>;

@Module({})
export class AppModule {
  /** 운영은 database, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  static register(o: ({ database: Database } | { memory: true }) & { session: Session }): DynamicModule {
    if ('database' in o) return { module: AppModule, imports: [databaseModule(o.database), SessionModule.register({ storage: 'database', ...o.session })] };
    return { module: AppModule, imports: [SessionModule.register({ storage: 'memory', ...o.session })] };
  }
}
