// 유스케이스: 찜(openapi PUT·DELETE /v1/productions/{productionId}/wish, ADR-0198 결정 5, BUILD_ORDER HOT-171).
// 공개 공연(isPublic)에만 찜하고, 그 밖과 없는 공연은 404다. 계정마다 1,000개 [가정]를 넘으면 422 wish-limit. 해제는 없어도 된다(204).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../domain/ports.js';
import { WISH_LIMIT } from '../domain/registration.js';
import { notFound, wishLimit } from './problems.js';

@Injectable()
export class Wishes {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async put(accountId: string, productionId: string): Promise<void> {
    const r = await this.repo.putWish(accountId, productionId, new Date(this.clock.now()), WISH_LIMIT);
    if (r === 'not-found') throw notFound();
    if (r === 'limit') throw wishLimit();
  }

  async delete(accountId: string, productionId: string): Promise<void> {
    await this.repo.deleteWish(accountId, productionId);
  }
}
