// payment-svc 종료 차례(BUILD_ORDER PRF-180·HOT-150 코드 리뷰). start.ts의 close(시작 파일은 SIGTERM에 부른다)가 부른다.
// 차례(멈추기 → 받는 쪽 멈추기 → 서비스 닫기 → 연결 닫기, 앞 단계가 실패해도 다음 단계)는 공용 shutdownInOrder로 옮겼다(packages/platform, BUILD_ORDER BAS-080).
export { shutdownInOrder, type ShutdownSteps } from '@peaket/platform';
