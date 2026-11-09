// 파트너 API 출처(docs/frontend.md §2.1 `partner-api`). 값은 공개 환경값으로 받고, 없으면 정본 호스트 이름을 쓴다.
// 개발 서버에서 값이 없으면 비워 둔다(가짜 API·게이트웨이 대역 주소를 NEXT_PUBLIC_PARTNER_API_ORIGIN으로 넣는다).
const DEV = process.env.NODE_ENV === 'development';

export const PARTNER_API_ORIGIN = process.env.NEXT_PUBLIC_PARTNER_API_ORIGIN || (DEV ? '' : 'https://partner-api.peaket.example');

/** CSP connect-src에 넣을 출처. 위저드가 부르는 주소와 늘 같게 한다(개발 서버에서 값이 없으면 기본값을 쓴다) */
export const partnerCspOrigins = PARTNER_API_ORIGIN ? { partnerApi: PARTNER_API_ORIGIN } : undefined;
