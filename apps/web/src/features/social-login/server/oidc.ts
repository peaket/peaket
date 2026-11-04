// 얇은 OIDC 클라이언트(openid-client 6, ADR-0119 결정 3, PoC I-T51의 C1). 제공자마다 발견 문서를 한 번 읽어 두고,
// TLS로 받은 ID 토큰도 서명을 확인한다(enableNonRepudiationChecks, asvs/auth.md 6.8.2. 라이브러리 기본은 보지 않는다).
import * as client from 'openid-client';
import type { ProviderSettings } from './config.ts';
import type { Provider } from './providers.ts';

export interface VerifiedLogin {
  claims: client.IDToken;
  /** 네이버 사용자 정보 API를 부를 때만 쓴다. 로그인 처리 뒤 버린다(identity에 보내지 않는다) */
  accessToken: string;
}

export class OidcProviders {
  readonly #configs = new Map<Provider, Promise<client.Configuration>>();
  readonly #providers: Partial<Record<Provider, ProviderSettings>>;
  /** 로컬·CI의 모의 제공자는 http다(운영 제공자는 모두 https) */
  readonly #allowHttp: boolean;

  constructor(providers: Partial<Record<Provider, ProviderSettings>>, allowHttp: boolean) {
    this.#providers = providers;
    this.#allowHttp = allowHttp;
  }

  has(p: Provider): boolean {
    return Boolean(this.#providers[p]);
  }

  config(p: Provider): Promise<client.Configuration> {
    let c = this.#configs.get(p);
    if (!c) {
      const s = this.#providers[p];
      if (!s) return Promise.reject(new Error(`설정하지 않은 제공자: ${p}`));
      c = (async () => {
        // discovery가 발견 문서의 issuer를 설정한 issuer와 대조한다(asvs 10.5.3)
        const conf = await client.discovery(new URL(s.issuer), s.clientId, s.clientSecret, undefined, this.#allowHttp ? { execute: [client.allowInsecureRequests] } : undefined);
        client.enableNonRepudiationChecks(conf);
        return conf;
      })();
      this.#configs.set(p, c);
      // 실패한 발견 문서 읽기는 기억하지 않는다(일시 장애 한 번으로 그 제공자 로그인이 계속 막히지 않게)
      c.catch(() => this.#configs.delete(p));
    }
    return c;
  }

  async authorizationUrl(p: Provider, o: { redirectUri: string; state: string; nonce: string; verifier: string; extra?: Record<string, string> }): Promise<string> {
    const c = await this.config(p);
    const url = client.buildAuthorizationUrl(c, {
      redirect_uri: o.redirectUri,
      scope: 'openid email',
      state: o.state,
      nonce: o.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(o.verifier),
      code_challenge_method: 'S256',
      ...o.extra,
    });
    return url.toString();
  }

  /** 코드를 교환하고 state·nonce·PKCE와 ID 토큰(서명·iss·aud·exp·nonce)을 확인한다 */
  async callback(p: Provider, here: URL, o: { state: string; nonce: string; verifier: string }): Promise<VerifiedLogin> {
    const c = await this.config(p);
    const tokens = await client.authorizationCodeGrant(c, here, { pkceCodeVerifier: o.verifier, expectedState: o.state, expectedNonce: o.nonce, idTokenExpected: true });
    const claims = tokens.claims();
    if (!claims) throw new Error('ID 토큰이 없다');
    return { claims, accessToken: tokens.access_token };
  }

  /**
   * 카카오: ID 토큰에 이메일 검증 여부가 없어 OIDC 사용자 정보로 받는다(정본의 카카오 `is_email_verified`, identity §2.1 '가입 때 연결 제안의 첫 구현',
   * 실제 응답 칸은 제공자 앱을 등록해야 볼 수 있다 [확인 필요]). 응답의 sub가 ID 토큰 sub와 다르면 막는다
   */
  async userInfoEmail(p: Provider, login: VerifiedLogin): Promise<{ email: string | null; emailVerified: boolean }> {
    const c = await this.config(p);
    const endpoint = c.serverMetadata().userinfo_endpoint;
    if (!endpoint) throw new Error(`${p} 사용자 정보 주소가 없다`);
    const r = await client.fetchProtectedResource(c, login.accessToken, new URL(endpoint), 'GET');
    const body = (await r.json()) as { sub?: unknown; email?: unknown; email_verified?: unknown; is_email_verified?: unknown };
    if (body.sub !== login.claims.sub) throw new Error(`${p} 사용자 정보 sub가 ID 토큰 sub와 다르다`);
    return { email: typeof body.email === 'string' ? body.email : null, emailVerified: body.email_verified === true || body.is_email_verified === true };
  }

  /** 네이버: ID 토큰에 이메일이 없어 사용자 정보 API로 받는다. 응답의 id가 ID 토큰 sub와 다르면 막는다(identity §2, [확인 필요]) */
  async naverProfile(login: VerifiedLogin): Promise<{ email: string | null }> {
    const c = await this.config('naver');
    const endpoint = c.serverMetadata().userinfo_endpoint;
    if (!endpoint) throw new Error('네이버 사용자 정보 주소가 없다');
    const r = await client.fetchProtectedResource(c, login.accessToken, new URL(endpoint), 'GET');
    const body = (await r.json()) as { resultcode?: string; response?: { id?: string; email?: string } };
    if (body.resultcode !== '00' || !body.response) throw new Error('네이버 사용자 정보 응답이 아니다');
    if (body.response.id !== login.claims.sub) throw new Error('네이버 사용자 정보 id가 ID 토큰 sub와 다르다');
    return { email: body.response.email ?? null };
  }
}
