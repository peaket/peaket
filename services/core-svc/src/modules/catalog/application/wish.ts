// 유스케이스: 찜(openapi PUT·DELETE /v1/productions/{productionId}/wish, GET /v1/wishes, ADR-0198 결정 5, BUILD_ORDER F-05-8).
// 공개 공연(isPublic)에만 찜하고, 그 밖과 없는 공연은 404다. 계정마다 1,000개 [가정]를 넘으면 422 wish-limit. 해제는 없어도 된다(204).
// 목록은 최근 찜한 순이고 카드는 검색 인덱스가 지금 값으로 만든다(판매 승인 취소·중지는 빠진다). 커서는 (찜한 시각, 공연 ID)다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SEARCH_INDEX, type SearchCard, type SearchIndex } from '../domain/search.js';
import { CATALOG_REPOSITORY, type CatalogRepository, type WishCursor } from '../domain/ports.js';
import { WISH_LIMIT } from '../domain/registration.js';
import { invalidWishCursor, notFound, wishLimit } from './problems.js';

/** 찜 목록 쪽 크기(openapi Limit 기본값과 같은 20) */
export const WISH_PAGE_DEFAULT = 20;
export const WISH_PAGE_MAX = 100;
export const WISH_PRODUCTION_IDS_MAX = 50;

export interface WishListQuery {
  productionIds?: readonly string[];
  cursor: string | null;
  limit: number;
}

export interface WishPage {
  items: SearchCard[];
  nextCursor: string | null;
}

/** 커서는 base64url `v1:<찜한 epoch ms>:<productionId>`. 해석할 수 없으면 undefined */
export function decodeWishCursor(cursor: string): WishCursor | undefined {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const m = /^v1:(\d{1,15}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
  if (!m) return undefined;
  const ms = Number(m[1]);
  if (!Number.isSafeInteger(ms)) return undefined;
  return { createdAt: new Date(ms), productionId: m[2]!.toLowerCase() };
}

export function encodeWishCursor(row: WishCursor): string {
  return Buffer.from(`v1:${row.createdAt.getTime()}:${row.productionId}`, 'utf8').toString('base64url');
}

@Injectable()
export class Wishes {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository,
    @Inject(SEARCH_INDEX) private readonly search: SearchIndex,
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

  /**
   * 내 찜 목록. productionIds가 있으면 그 가운데 찜한 것만(최대 50개, 커서 없음) — 공연 상세의 찜 토글 상태.
   * 없으면 최근 찜한 순으로 limit만큼 주고 다음 커서를 준다. 카드가 없는(공개가 아니게 된) 줄은 건너뛴다.
   */
  async list(accountId: string, q: WishListQuery): Promise<WishPage> {
    const limit = Math.max(1, Math.min(WISH_PAGE_MAX, q.limit || WISH_PAGE_DEFAULT));
    const productionIds = q.productionIds?.map((id) => id.toLowerCase());

    if (productionIds) {
      if (productionIds.length > WISH_PRODUCTION_IDS_MAX) throw invalidWishCursor('productionIds는 50개까지입니다');
      const rows = await this.repo.listWishRows(accountId, { productionIds, limit: WISH_PRODUCTION_IDS_MAX });
      return { items: await this.cardsInOrder(rows.map((r) => r.productionId)), nextCursor: null };
    }

    const after = q.cursor === null ? null : decodeWishCursor(q.cursor);
    if (q.cursor !== null && !after) throw invalidWishCursor('커서를 해석할 수 없습니다');
    const rows = await this.repo.listWishRows(accountId, { after, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last ? encodeWishCursor(last) : null;
    return { items: await this.cardsInOrder(page.map((r) => r.productionId)), nextCursor };
  }

  /** 찜 줄 차례대로 카드를 잇는다. 공개가 아니게 되어 카드가 없는 줄은 뺀다 */
  private async cardsInOrder(productionIds: readonly string[]): Promise<SearchCard[]> {
    if (productionIds.length === 0) return [];
    const cards = await this.search.cardsByIds(productionIds);
    const byId = new Map(cards.map((c) => [c.productionId, c]));
    return productionIds.flatMap((id) => {
      const c = byId.get(id);
      return c ? [c] : [];
    });
  }
}
