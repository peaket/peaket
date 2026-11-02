// 소셜 로그인 설정(docs/features/identity.md §2 '웹 앱 서버 경로', docs/security/secrets-and-keys.md).
// 비밀(앱 서버 비밀, OAuth 클라이언트 시크릿)은 비밀 관리에서 환경 변수로 받는다. 운영의 제공자 issuer는 고정값이고(asvs/auth.md 10.5.3),
// 로컬·CI만 모의 제공자 주소(http)로 바꿀 수 있다.
import type { JSONWebKeySet } from 'jose';
import { PROVIDER_ISSUER, PROVIDERS, type Provider } from './providers.ts';

export interface ProviderSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface SocialLoginConfig {
  /** PEAKET_ENV. local·ci만 모의 제공자와 http를 허용한다 */
  env: string;
  /** 소비자 웹의 공개 출처(https://www.peaket.example). Origin 대조와 콜백 주소에 쓴다 */
  origin: string;
  /** 앱 서버 비밀(32바이트). 용도별 키는 HKDF로 나눈다(keys.ts) */
  secret: Uint8Array;
  /** 바꾸기 전 비밀. 쿠키 수명(10분) 동안 옛 쿠키를 여는 데만 쓴다(secrets-and-keys) */
  previousSecret?: Uint8Array;
  /** 팬 액세스·리프레시 쿠키의 Domain(운영 peaket.example). 없으면 이 호스트만 */
  cookieDomain: string | undefined;
  /** 설정한 제공자만 로그인할 수 있다 */
  providers: Partial<Record<Provider, ProviderSettings>>;
  /** identity-svc 업무 gRPC 주소(host:port) */
  identityAddress: string;
  /** 팬 토큰 공개키 묶음 주소(identity-svc GET /internal/jwks/fan.json, identity §3 '공개키 배포'). 시험·로컬은 fanJwks 값으로 대신할 수 있다 */
  fanJwksUrl?: string;
  /** 팬 토큰 공개키 묶음 값(fanJwksUrl이 없을 때) */
  fanJwks?: JSONWebKeySet;
  /** 팬 토큰 발급자(iss) */
  tokenIssuer: string;
}

export const TEST_ENVS = ['local', 'ci'] as const;
export const allowsMockProviders = (env: string): boolean => (TEST_ENVS as readonly string[]).includes(env);

const need = (env: Record<string, string | undefined>, name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`${name}이(가) 없다`);
  return v;
};

export function loadSocialLoginConfig(env: Record<string, string | undefined>): SocialLoginConfig {
  const peaketEnv = env.PEAKET_ENV || 'prod';
  const testing = allowsMockProviders(peaketEnv);
  const origin = new URL(need(env, 'PEAKET_WEB_ORIGIN')).origin;
  if (!testing && !origin.startsWith('https://')) throw new Error('PEAKET_WEB_ORIGIN은 https여야 한다');
  const secret = Buffer.from(need(env, 'PEAKET_WEB_AUTH_SECRET'), 'base64');
  if (secret.length !== 32) throw new Error('PEAKET_WEB_AUTH_SECRET은 base64로 적은 32바이트다');
  const previous = env.PEAKET_WEB_AUTH_SECRET_PREVIOUS ? Buffer.from(env.PEAKET_WEB_AUTH_SECRET_PREVIOUS, 'base64') : undefined;
  if (previous && previous.length !== 32) throw new Error('PEAKET_WEB_AUTH_SECRET_PREVIOUS는 base64로 적은 32바이트다');
  const providers: Partial<Record<Provider, ProviderSettings>> = {};
  for (const p of PROVIDERS) {
    const id = env[`PEAKET_OIDC_${p.toUpperCase()}_CLIENT_ID`];
    if (!id) continue;
    const override = env[`PEAKET_OIDC_${p.toUpperCase()}_ISSUER`];
    if (override && !testing) throw new Error(`PEAKET_OIDC_${p.toUpperCase()}_ISSUER는 local·ci에서만 바꿀 수 있다(제공자 issuer는 고정값, asvs 10.5.3)`);
    providers[p] = { issuer: override || PROVIDER_ISSUER[p], clientId: id, clientSecret: need(env, `PEAKET_OIDC_${p.toUpperCase()}_CLIENT_SECRET`) };
  }
  const fanJwksUrl = env.PEAKET_FAN_TOKEN_JWKS_URL || undefined;
  let fanJwks: JSONWebKeySet | undefined;
  if (!fanJwksUrl) {
    try {
      fanJwks = JSON.parse(need(env, 'PEAKET_FAN_TOKEN_JWKS')) as JSONWebKeySet;
    } catch (e) {
      throw new Error(`PEAKET_FAN_TOKEN_JWKS_URL이나 PEAKET_FAN_TOKEN_JWKS(JWKS JSON)가 있어야 한다: ${(e as Error).message}`);
    }
    if (!Array.isArray(fanJwks.keys) || fanJwks.keys.length === 0) throw new Error('PEAKET_FAN_TOKEN_JWKS에 키가 없다');
  }
  return {
    env: peaketEnv,
    origin,
    secret,
    previousSecret: previous,
    cookieDomain: env.PEAKET_COOKIE_DOMAIN || undefined,
    providers,
    identityAddress: need(env, 'PEAKET_IDENTITY_GRPC'),
    fanJwksUrl,
    fanJwks,
    tokenIssuer: need(env, 'PEAKET_TOKEN_ISSUER'),
  };
}
