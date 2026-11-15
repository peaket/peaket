// PostgreSQL 검색 읽기 모델 동기화·자동완성 사전 원천(ADR-0271 결정 1·2·3·6, docs/data.md search_document·search_term·search_removal·search_version).
// BAT-165 웨이브 7 시험 담당이 둔 빈 뼈대다. 구현 담당이 채운다.
// - 동기화(sync·syncTimed·recountInterest·purgeRemovals)는 쓰기 연결(주 DB)로 만든다.
// - 사전 원천(read·version)은 운영에서 읽기 전용 복제본 연결로 만든다(한 읽기 전용 REPEATABLE READ 트랜잭션에서 판을 먼저 읽는다).
import type { Database, DbTransaction } from '@peaket/platform';
import type { DictionarySnapshot, SearchDictionarySource, SearchReadModelSync } from '../../domain/search.js';

export class DrizzleSearchReadModel implements SearchReadModelSync, SearchDictionarySource {
  constructor(readonly db: Database) {}

  async sync(_tx: DbTransaction, _productionIds: readonly string[], _at: Date): Promise<{ version: number; removed: string[] }> {
    throw new Error('아직 없음');
  }

  async syncTimed(_at: Date, _since: Date): Promise<{ version: number | null; productions: number }> {
    throw new Error('아직 없음');
  }

  async recountInterest(_at: Date): Promise<number> {
    throw new Error('아직 없음');
  }

  async purgeRemovals(_at: Date): Promise<number> {
    throw new Error('아직 없음');
  }

  async read(_since: number | null): Promise<DictionarySnapshot> {
    throw new Error('아직 없음');
  }

  async version(): Promise<number> {
    throw new Error('아직 없음');
  }
}
