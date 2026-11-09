export { LoginPage as default, metadata } from '@/_pages/login';

// 주소 값(searchParams)을 Suspense 밖에서 읽는 요청 화면이라 즉시 이동 셸을 두지 않는다고 표시한다(BUILD_ORDER HOT-323, 개발 서버 'URL data during prerendering')
export const instant = false;
