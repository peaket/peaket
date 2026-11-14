// 스캐너 앱이 부르는 API 주소와 실제 연결 스위치(docs/frontend.md §2.3, offline-gate §6.1).
// - 기본은 퍼블리싱 모드(고정 데이터)다. `VITE_SCANNER_API_ORIGIN`과 스태프 토큰이 있거나 주소에 `?live=1`이 있으면 실제 API를 부른다.
// - 운영 빌드에는 개발 주소가 남지 않는다(import.meta.env.DEV가 글자로 바뀐다).
const env = import.meta.env as Record<string, string | boolean | undefined>;

export const SCANNER_API_ORIGIN: string =
  typeof env.VITE_SCANNER_API_ORIGIN === 'string' && env.VITE_SCANNER_API_ORIGIN
    ? env.VITE_SCANNER_API_ORIGIN
    : import.meta.env.DEV
      ? 'http://localhost:3001'
      : 'https://scanner-api.peaket.example';

/** 주소에 `?live=1`이 있거나 빌드가 `VITE_SCANNER_LIVE=1`이면 실제 연결을 시도한다 */
export function liveRequested(search: string): boolean {
  if (env.VITE_SCANNER_LIVE === '1') return true;
  try {
    return new URLSearchParams(search).get('live') === '1';
  } catch {
    return false;
  }
}
