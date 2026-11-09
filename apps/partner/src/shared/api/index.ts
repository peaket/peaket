// 파트너 콘솔의 API 클라이언트(docs/frontend.md §4.1, ADR-0196, ADR-0245).
// 화면 부품은 이 파일을 늦게 가져온다(await import). 첫 화면 JS에 실행부와 작업 서술 표가 들지 않게 한다.
// 토큰 갱신은 게이트웨이 경로(BOT-132) 뒤 로그인 연결 단계가 더한다.
import { createApiClient, type ApiClient } from '@peaket/api-client';
import { PARTNER_API_ORIGIN } from '@/shared/config/origins';

export { OPERATIONS } from '@peaket/api-client';

let client: ApiClient | null = null;

/** 브라우저 쪽 클라이언트 하나 */
export function partnerApi(): ApiClient {
  client ??= createApiClient({ baseUrls: { 'partner-api': PARTNER_API_ORIGIN } });
  return client;
}
