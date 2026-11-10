// @peaket/validation(docs/frontend.md §2.2). 요청·응답 Zod는 계약에서 만든 @peaket/contracts의 생성 스키마를 태그별로 다시 내보내고,
// 손으로는 계약에 적을 수 없는 규칙만 둔다. 판매 정책 규칙의 읽기·평가 함수 넷(서버와 같이 씀)은 하위 경로 @peaket/validation/sale-policy다
// (src/sale-policy, BUILD_ORDER HOT-250, ADR-0261 결정 3·11). 그 하위 경로는 zod와 safe-json만 가져오고 이 파일(계약 생성 스키마)을 가져오지 않는다.
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
