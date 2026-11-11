// 인증 훅이 이미 읽은 구매 세션 정보를 받는 매개변수 장식자(BAT-028, HOT-463).
// StoredPurchaseSessions.resolve가 요청에 붙인 값을 읽는다. @PurchaseSigned()를 지난 요청에만 값이 있고, 없으면 undefined다.
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PURCHASE_SESSION_INFO, type ResolvedPurchaseSessionInfo } from '../domain/ports.js';

export function purchaseSessionInfoOf(request: FastifyRequest): ResolvedPurchaseSessionInfo | undefined {
  return (request as unknown as Record<symbol, ResolvedPurchaseSessionInfo | undefined>)[PURCHASE_SESSION_INFO];
}

export const CurrentPurchaseSessionInfo = createParamDecorator((_data: unknown, ctx: ExecutionContext): ResolvedPurchaseSessionInfo | undefined => {
  return purchaseSessionInfoOf(ctx.switchToHttp().getRequest<FastifyRequest>());
});
