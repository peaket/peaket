// 찜의 계정 수명주기(탈퇴·병합, F-05-8 GAT-260). 쓰기 유스케이스만 모아 소비자 처리기가 검색 인덱스 없이 쓴다.
// - 탈퇴: identity.accounts-withdrawn을 받아 그 계정의 찜을 지운다(다시 받아도 같다).
// - 병합: identity.accounts-merged를 받아 흡수 계정 찜을 대표 계정으로 옮긴다(mergeId가 아니라 행이 사라지는 것으로 멱등).
// - 사전 확인: core CheckAccountMerge의 absorbed_wishes 수(proto core.proto).
import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../domain/ports.js';

@Injectable()
export class WishLifecycle {
  constructor(@Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository) {}

  /** 탈퇴 계정의 찜을 지운다. 지운 수를 돌려준다(로그에는 계정 ID 없이 수만) */
  async purgeWithdrawn(accountId: string): Promise<number> {
    return this.repo.purgeWishes(accountId.toLowerCase());
  }

  /** 흡수 계정의 찜을 대표 계정으로 옮긴다. 대표 계정에 같은 찜이 있으면 하나만 남긴다 */
  async moveMerged(primaryAccountId: string, absorbedAccountId: string): Promise<number> {
    const primary = primaryAccountId.toLowerCase();
    const absorbed = absorbedAccountId.toLowerCase();
    if (primary === absorbed) return 0;
    return this.repo.moveWishes(primary, absorbed);
  }

  /** 계정 병합 요약의 `absorbed_wishes`(대표 계정으로 옮겨질 찜 수) */
  async absorbedWishes(accountId: string): Promise<number> {
    return this.repo.countWishes(accountId.toLowerCase());
  }
}
