// 팬 액세스 토큰 쿠키 확인(docs/features/identity.md §2 '웹 앱 서버 경로'): 로그아웃과 재인증 시작이 sid·sub를 얻는다.
// 서명(팬 토큰 공개키)·typ at+jwt·aud fan·iss를 본다. 로그아웃만 만료된 토큰을 받는다(자기 세션을 끝내는 일).
import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';

export interface FanSession {
  accountId: string;
  sessionId: string;
}

export class FanTokenVerifier {
  readonly #keys: ReturnType<typeof createLocalJWKSet>;
  readonly #issuer: string;

  constructor(jwks: JSONWebKeySet, issuer: string) {
    this.#keys = createLocalJWKSet(jwks);
    this.#issuer = issuer;
  }

  /** 맞지 않으면 undefined */
  async verify(token: string | undefined, now: number, o: { allowExpired: boolean }): Promise<FanSession | undefined> {
    if (!token) return undefined;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#keys, { issuer: this.#issuer, audience: 'fan', typ: 'at+jwt', algorithms: ['ES256'], currentDate: new Date(now) }));
    } catch (e) {
      // 만료 검사는 서명·typ·iss·aud 검사가 지난 뒤에 한다. 그래서 만료 오류의 payload는 서명을 확인한 값이다
      if (!(o.allowExpired && e instanceof errors.JWTExpired)) return undefined;
      payload = e.payload;
    }
    const sid = payload.sid;
    if (typeof payload.sub !== 'string' || typeof sid !== 'string') return undefined;
    return { accountId: payload.sub, sessionId: sid };
  }
}
