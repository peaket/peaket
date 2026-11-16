// 로컬 게이트웨이 대역(local-fan-gateway.mjs)과 가짜 API(mock-api.mjs)가 쓰는 교차 출처 값(웨이브 끝 리뷰 W7-WIR-06, BUILD_ORDER HOT-400).
// 기준은 deploy/gateways/gw-fan.yaml·gw-partner.yaml의 API 호스트 SecurityPolicy cors다(그 목록은 docs/api/guidelines.md §9대로 openapi에서 채운다).
// 대역이 진짜 게이트웨이보다 넓으면 운영에서 막힐 요청이 로컬·CI에서 통과하므로 값을 같게 둔다. 같은지는 local-fan-gateway-parity.test.mjs가 본다.

/** gw-fan api 호스트 라우트의 cors(모든 api 라우트가 같은 값이다) */
export const GW_FAN_API_CORS = Object.freeze({
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowHeaders: ['Content-Type', 'Idempotency-Key', 'If-Match', 'X-Reauth-Token', 'X-Admission-Token', 'X-Client-Ephemeral-Key', 'X-Purchase-Mac', 'X-Purchase-Seq', 'X-Requested-With'],
  exposeHeaders: ['Date', 'X-Trace-Id', 'ETag', 'Location', 'Retry-After', 'WWW-Authenticate'],
  maxAgeSeconds: 7200,
});

/** gw-partner partner-api 호스트 라우트의 허용 머리(가짜 API가 파트너 콘솔 출처에도 답하므로 합쳐 쓴다) */
export const GW_PARTNER_API_ALLOW_HEADERS = Object.freeze(['Content-Type', 'Idempotency-Key', 'If-Match', 'X-Reauth-Token', 'X-Requested-With']);
