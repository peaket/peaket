// 받는 층: 찜(openapi putProductionWish·deleteProductionWish, ADR-0198 결정 5, BUILD_ORDER HOT-171).
// 로그인 팬. 같은 요청을 다시 보내도 결과가 같아 멱등 키가 없다(오프라인 대기열이 다시 보낸다, FE-T37). 자기 상태라 If-Match 없이 마지막 저장이 이긴다.
import { Controller, Delete, HttpCode, Put } from '@nestjs/common';
import { ContractParams, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Wishes } from '../application/wish.js';

export const WishParams = z.object({ productionId: z.string() }).strict();

@Controller('v1/productions/:productionId/wish')
export class WishController {
  constructor(private readonly wishes: Wishes) {}

  @Put()
  @HttpCode(204)
  @Roles(['fan'])
  async put(@ContractParams(WishParams) params: z.output<typeof WishParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    await this.wishes.put(me.accountId, params.productionId.toLowerCase());
  }

  @Delete()
  @HttpCode(204)
  @Roles(['fan'])
  async delete(@ContractParams(WishParams) params: z.output<typeof WishParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    await this.wishes.delete(me.accountId, params.productionId.toLowerCase());
  }
}
