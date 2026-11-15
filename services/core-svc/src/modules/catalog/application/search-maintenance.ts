// 유스케이스: 검색 읽기 모델을 고치는 트랜잭션과 커밋 뒤 일(ADR-0271 결정 2·3·7·8, docs/features/search.md §2.3·§10).
// BAT-165 웨이브 7 시험 담당이 둔 빈 뼈대다. 구현 담당이 채운다(1분 정리·1시간 관심도·사전 갱신 주기도 이 파일에 둔다, 계획 §4).
import type { Database, DbTransaction, PlatformLogger } from '@peaket/platform';
import type { CdnInvalidation } from '../domain/media-ports.js';
import type { SearchReadModelSync } from '../domain/search.js';

/**
 * work가 카탈로그를 고치고 바뀐 공연 ID를 돌려주면, 같은 트랜잭션에서 sync.sync를 부른다.
 * 커밋 뒤 빠진 공연이 있으면 검색 경로 무효화를 부르고 빠진 공연마다 `search_removed` 줄을 남긴다.
 * 무효화가 실패하면 `cdn_invalidation_failed` 경고 줄을 남기고 처리는 성공이다. 트랜잭션이 되돌려지면 아무것도 하지 않는다.
 */
export async function withSearchSync<T>(
  _o: { database: Pick<Database, 'transaction'>; sync: SearchReadModelSync; cdn: CdnInvalidation; logger: Pick<PlatformLogger, 'info' | 'warn'>; reason: string; at: Date },
  _work: (tx: DbTransaction) => Promise<{ result: T; productionIds: readonly string[] }>,
): Promise<T> {
  throw new Error('아직 없음');
}
