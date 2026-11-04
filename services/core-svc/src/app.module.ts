// 뿌리 모듈: 컨텍스트 모듈과 공용 설정(DB)을 모은다. 지금은 catalog뿐이다(notify·shop·review·support는 뒤 단계, docs/architecture.md §3.1).
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { CatalogModule, type MemoryCatalogRepository } from './modules/catalog/index.js';

@Module({})
export class AppModule {
  /** 운영은 database, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  static register(o: { database: Database } | { memory: true; catalog?: MemoryCatalogRepository }): DynamicModule {
    if ('database' in o) return { module: AppModule, imports: [databaseModule(o.database), CatalogModule.register({ storage: 'database' })] };
    return { module: AppModule, imports: [CatalogModule.register({ storage: 'memory', ...(o.catalog ? { repository: o.catalog } : {}) })] };
  }
}
