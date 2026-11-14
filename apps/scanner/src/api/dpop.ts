// DPoP 증명(RFC 9449)과 기기 키(ECDSA P-256) 조각(offline-gate §6.1, GAT-170).
// - 기기 키는 WebCrypto로 만들고 extractable=false다. 공개키 JWK만 서버에 보낸다.
// - 증명은 `typ dpop+jwt`, 헤더 jwk, 내용 jti·htm·htu·iat(+스태프 토큰이 있으면 ath)이다.
// - jkt는 RFC 7638 JWK 지문(SHA-256 base64url)이다.
export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlOfText(text: string): string {
  return base64url(new TextEncoder().encode(text));
}

async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64url(new Uint8Array(digest));
}

/** RFC 7638 JWK 지문(EC P-256). 서버의 scanner_device.credential_thumbprint(jkt)와 같은 값이다 */
export async function jktOf(jwk: JsonWebKey): Promise<string> {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('기기 키는 EC P-256 공개키여야 합니다');
  return sha256Base64url(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y }));
}

export interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  jkt: string;
}

/** 기기 키쌍을 만든다. 개인키는 extractable=false다 */
export async function generateDpopKey(): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  if (pair.privateKey.extractable) throw new Error('기기 개인키가 꺼낼 수 있는 상태로 만들어졌습니다');
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk: JsonWebKey = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  return { privateKey: pair.privateKey, publicJwk, jkt: await jktOf(publicJwk) };
}

/** DPoP 증명 하나. 같은 jti를 다시 쓰면 서버가 401로 거절한다 */
export async function dpopProof(i: {
  key: DpopKey;
  method: string;
  url: string;
  token?: string;
  nowMs?: number;
  jti?: string;
}): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: i.key.publicJwk };
  const payload: Record<string, unknown> = {
    jti: i.jti ?? crypto.randomUUID(),
    htm: i.method.toUpperCase(),
    htu: i.url.split(/[?#]/)[0],
    iat: Math.floor((i.nowMs ?? Date.now()) / 1000),
  };
  if (i.token) payload.ath = await sha256Base64url(i.token);
  const signingInput = `${base64urlOfText(JSON.stringify(header))}.${base64urlOfText(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, i.key.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
