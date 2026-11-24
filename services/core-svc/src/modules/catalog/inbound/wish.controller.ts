// 받는 층: 찜(openapi putProductionWish·deleteProductionWish·listWishes, ADR-0198 결정 5, BUILD_ORDER HOT-171·F-05-8).
// 로그인 팬. 같은 요청을 다시 보내도 결과가 같아 멱등 키가 없다(오프라인 대기열이 다시 보낸다, FE-T37). 자기 상태라 If-Match 없이 마지막 저장이 이긴다.
import { Controller, Delete, Get, Header, HttpCode, Put } from '@nestjs/common';
import { ListWishesQueryParams, ListWishesResponse } from '@peaket/contracts/openapi/identity';
import { ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, Roles, type Principal } from '@peaket/platform';
import { z } from 'zod';
import { Wishes, type WishPage } from '../application/wish.js';

export const WishParams = z.object({ productionId: z.string() }).strict();

@Controller('v1')
export class WishController {
  constructor(private readonly wishes: Wishes) {}

  /** 내 찜 목록(홈 찜한 공연 줄, SCR-054, 공연 상세의 찜 상태). productionIds가 있으면 그 가운데 찜한 것만 */
  @Get('wishes')
  @ContractRouteSchema({ responses: { 200: ListWishesResponse } })
  @Roles(['fan'])
  @Header('Cache-Control', 'private, no-store')
  async list(@ContractQuery(ListWishesQueryParams) q: z.output<typeof ListWishesQueryParams>, @CurrentPrincipal() me: Principal): Promise<WishPage> {
    const productionIds = q.productionIds
      ? q.productionIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    return this.wishes.list(me.accountId, { ...(productionIds ? { productionIds } : {}), cursor: q.cursor ?? null, limit: q.limit ?? 20 });
  }

  @Put('productions/:productionId/wish')
  @HttpCode(204)
  @Roles(['fan'])
  async put(@ContractParams(WishParams) params: z.output<typeof WishParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    await this.wishes.put(me.accountId, params.productionId.toLowerCase());
  }

  @Delete('productions/:productionId/wish')
  @HttpCode(204)
  @Roles(['fan'])
  async delete(@ContractParams(WishParams) params: z.output<typeof WishParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    await this.wishes.delete(me.accountId, params.productionId.toLowerCase());
  }
}
