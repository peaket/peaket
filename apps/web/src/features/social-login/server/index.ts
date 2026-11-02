// 소셜 로그인 서버 모듈의 공개 파일(앱 서버 전용. 화면 묶음에서 가져오지 않는다).
export { createSocialLogin, GENERIC_FAILURE, LOGIN_ROUTES, type SocialLogin, type SocialLoginDeps } from './handlers.ts';
export { loadSocialLoginConfig, type SocialLoginConfig } from './config.ts';
export { socialLogin } from './runtime.ts';
