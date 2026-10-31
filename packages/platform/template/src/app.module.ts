// 뿌리 모듈: 컨텍스트 모듈과 공용 설정(DB)을 모은다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { ExampleModule } from './modules/example/index.js';

@Module({})
export class AppModule {
  /** 운영은 database, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  static register(o: { database: Database } | { memory: true }): DynamicModule {
    if ('database' in o) return { module: AppModule, imports: [databaseModule(o.database), ExampleModule.register({ storage: 'database' })] };
    return { module: AppModule, imports: [ExampleModule.register({ storage: 'memory' })] };
  }
}
