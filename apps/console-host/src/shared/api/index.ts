// 관제 콘솔의 API 클라이언트(docs/frontend.md §2.2·§4.1). 화면은 생성 호출 함수(@peaket/api-client/endpoints/ops)를 늦게 가져온다.
// setOrvalClient는 이 파일만 부른다(린트가 막는다). 한 실행 환경에 클라이언트는 하나이고, 관제 호스트는 ops-api 하나를 쓴다.
// 주소는 빌드 때 __OPS_API_ORIGIN__(PEAKET_OPS_API_ORIGIN)으로 바뀐다. 값이 비면 화면이 설정 안내를 보인다.
import { createApiClient, setOrvalClient, type ApiClient } from '@peaket/api-client';

let client: ApiClient | null = null;

/** 관제 API를 부를 수 있는가(빌드 설정이 비면 false) */
export const opsApiAvailable = (): boolean => __OPS_API_ORIGIN__.length > 0;

/** 관제 API 클라이언트를 한 번 꽂는다. 주소가 없으면 false */
export function ensureConsoleApi(): boolean {
  if (!opsApiAvailable()) return false;
  client ??= createApiClient({ baseUrls: { 'ops-api': __OPS_API_ORIGIN__ } });
  setOrvalClient(client);
  return true;
}
