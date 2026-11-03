// 앱 서버 프로세스에 하나만 두는 로그인 처리기(설정은 처음 부를 때 환경 변수에서 읽는다). 개발 서버의 다시 읽기에도 하나로 남게 전역에 둔다.
import { loadSocialLoginConfig } from './config.ts';
import { createSocialLogin, type SocialLogin } from './handlers.ts';

const KEY = Symbol.for('peaket.web.socialLogin');

export function socialLogin(): SocialLogin {
  const g = globalThis as unknown as Record<symbol, SocialLogin | undefined>;
  g[KEY] ??= createSocialLogin(loadSocialLoginConfig(process.env));
  return g[KEY];
}
