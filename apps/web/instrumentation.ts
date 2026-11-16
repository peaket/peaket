// 서버가 뜰 때 한 번 부르는 Next.js 계측 진입점(instrumentation). next start와 운영 이미지의 standalone server.js 모두 부른다.
// 1. 서버 액션 암호화 키가 있고 32바이트인지 보고, 틀리면 서버를 띄우지 않는다(모든 파드가 같은 키, docs/devops.md §6.6,
//    docs/security/secrets-and-keys.md, BUILD_ORDER BAS-220).
// 2. 소비자 웹 앱 서버의 텔레메트리를 앱 서버 모드(PEAKET_TRACE_INBOUND=untrusted)로 시작한다. 브라우저 추적 값은 부모로 잇지 않고
//    링크로만 남긴다(docs/observability.md §6 '신뢰 경계의 추적 문맥', BUILD_ORDER HOT-400). untrusted가 아닌 값이 적혀 있으면 던진다.
// 빌드 작업자·개발 서버·Edge 실행기는 둘 다 건너뛴다. SDK는 Node 실행기에서만 불러 화면 묶음에 들지 않고, 자동 계측 없이 시작한다(Next.js가 요청 span을 만든다).
import { assertServerActionsKey, isProductionNodeServer } from '@peaket/config/next/server-actions-key.mjs';

export async function register(): Promise<void> {
  // Edge 실행기는 둘 다 하지 않는다. 이 비교를 이 자리에 그대로 둬야 Edge 묶음이 아래(SDK)를 읽지 않는다(Next.js가 빌드 때 가지를 지운다)
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Next.js는 묶을 때 `process.env.NEXT_RUNTIME`을 글자 값으로 바꾸고, 운영 standalone 서버의 환경에는 이 값이 없다.
  // 그래서 환경 객체에 그 글자 값을 다시 넣어 넘긴다(넣지 않으면 standalone에서 키 확인·텔레메트리가 조용히 건너뛰어진다, 2026-11-16 확인)
  const env = { ...process.env, NEXT_RUNTIME: process.env.NEXT_RUNTIME };
  try {
    assertServerActionsKey(env);
    if (!isProductionNodeServer(env)) return;
    const { startAppServerTelemetry } = await import('@peaket/platform/telemetry/app-server');
    startAppServerTelemetry({ defaultServiceName: 'web' });
  } catch (e) {
    // Next.js 16은 register가 던져도 프로세스를 끝내지 않는다. Next.js 서버 안이면 오류 줄을 쓰고 그 자리에서 끝낸다(리뷰 RV-08·검증 VF-11).
    // 그 밖(계측 진입점을 바로 부르는 단위 시험)에서는 돌아오고 오류를 그대로 다시 던진다
    const { exitAfterStartupFailure } = await import('@peaket/platform/telemetry/app-server');
    exitAfterStartupFailure(e);
    throw e;
  }
}
