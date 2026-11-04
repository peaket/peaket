// @peaket/validation(docs/frontend.md §2.2). 요청·응답 Zod는 계약에서 만든 @peaket/contracts의 생성 스키마를 태그별로 다시 내보내고,
// 손으로는 계약에 적을 수 없는 규칙만 둔다. 판매 정책 DSL 평가기(서버와 같이 씀)는 판매 정책 단계(BUILD_ORDER HOT-250)에서 더한다.
export * as catalog from '@peaket/contracts/openapi/catalog';
export * as identity from '@peaket/contracts/openapi/identity';
export * as investigations from '@peaket/contracts/openapi/investigations';
export * as ops from '@peaket/contracts/openapi/ops';
export * as orders from '@peaket/contracts/openapi/orders';
export * as partner from '@peaket/contracts/openapi/partner';
export * as queue from '@peaket/contracts/openapi/queue';
export * as reviews from '@peaket/contracts/openapi/reviews';
export * as scanner from '@peaket/contracts/openapi/scanner';
export * as seats from '@peaket/contracts/openapi/seats';
export * as shop from '@peaket/contracts/openapi/shop';
export * as support from '@peaket/contracts/openapi/support';
export * as tickets from '@peaket/contracts/openapi/tickets';
export * as webhooks from '@peaket/contracts/openapi/webhooks';
export { parseJsonSafe, UnsafeKeyError } from './safe-json';
