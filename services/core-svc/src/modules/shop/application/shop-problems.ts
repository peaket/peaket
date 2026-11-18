// 도메인 거절(ShopProblem) → 플랫폼 Problem 응답. 400은 이름 없는 요청 오류(about:blank)다(티켓 결제 접수와 같다).
import { ProblemError, RequestValidationError } from '@peaket/platform';
import { ShopProblem } from '../domain/merch-order.js';

export function toPlatformProblem(e: unknown): unknown {
  if (!(e instanceof ShopProblem)) return e;
  if (e.status === 400) return new RequestValidationError(e.type);
  return new ProblemError({ type: e.type, status: e.status, title: e.title, ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) });
}

/** 받는 층이 유스케이스를 이것으로 감싼다 */
export async function shopGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toPlatformProblem(e);
  }
}
