// 서버가 뜰 때 한 번 부르는 Next.js 계측 진입점(instrumentation). next start와 운영 이미지의 standalone server.js 모두 부른다.
// 서버 액션 암호화 키가 있고 32바이트인지 보고, 틀리면 서버를 띄우지 않는다(모든 파드가 같은 키, docs/devops.md §6.6,
// docs/security/secrets-and-keys.md, BUILD_ORDER BAS-220). 빌드 작업자와 개발 서버는 건너뛴다.
import { assertServerActionsKey } from '@peaket/config/next/server-actions-key.mjs';

export function register(): void {
  assertServerActionsKey();
}
