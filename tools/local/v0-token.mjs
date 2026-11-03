#!/usr/bin/env node
// v0 입구 시험 토큰(docs/infra.md §3 'v0 배포' 3). 의존성 없는 Node 스크립트다.
// - 시험 키 쌍(EC P-256)을 이 PC에 만들고, 개인키는 .cache/peaket-tools/v0-token-key.json에만 둔다(클러스터에는 공개키 목록만 넣는다)
// - 시험과 부하 발생기가 팬 액세스 토큰(ES256, typ at+jwt, aud fan)을 만든다
// 쓰는 법: node tools/local/v0-token.mjs jwks            공개키 목록(JSON)을 찍는다(없으면 키를 만든다)
//          node tools/local/v0-token.mjs sign <sub> [pid]  토큰 하나를 찍는다(sid는 s-<sub>, scope는 ticket:buy, 15분)
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 시험 토큰의 발급자. 입구 설정 PEAKET_V0_TOKEN_ISSUER와 같아야 한다 */
export const V0_TOKEN_ISSUER = 'https://identity.peaket.local';
/** 토큰 수명(초). 운영 액세스 토큰과 같은 15분 */
export const V0_TOKEN_TTL_SECONDS = 900;

/**
 * @typedef {{ kty: 'EC', crv: 'P-256', x: string, y: string, d: string, kid: string }} V0PrivateJwk
 * @typedef {{ keys: Array<{ kty: 'EC', crv: 'P-256', x: string, y: string, kid: string, alg: 'ES256', use: 'sig' }> }} V0Jwks
 */

/**
 * RFC 7638 JWK 지문(EC: crv·kty·x·y를 사전 순으로 이은 JSON의 SHA-256, base64url)
 * @param {{ crv: string, kty: string, x: string, y: string }} jwk
 */
function thumbprint(jwk) {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}

/**
 * 새 시험 키 쌍. kid는 공개키 지문(RFC 7638 JWK 지문의 앞 16자)이다
 * @returns {{ privateJwk: V0PrivateJwk, jwks: V0Jwks }}
 */
export function generateV0TokenKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = /** @type {{ x: string, y: string, d: string }} */ (privateKey.export({ format: 'jwk' }));
  /** @type {V0PrivateJwk} */
  const privateJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid: thumbprint({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }).slice(0, 16) };
  return { privateJwk, jwks: publicJwksOf(privateJwk) };
}

/**
 * 개인키 JWK에서 공개키 목록(개인키 칸 d를 뺀 것)
 * @param {V0PrivateJwk} privateJwk
 * @returns {V0Jwks}
 */
export function publicJwksOf(privateJwk) {
  return { keys: [{ kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y, kid: privateJwk.kid, alg: 'ES256', use: 'sig' }] };
}

/**
 * 키 파일 내용이 시험 개인키인지 본다(칸과 키 자체)
 * @param {unknown} v
 * @returns {V0PrivateJwk}
 */
function asPrivateJwk(v) {
  const o = /** @type {Record<string, unknown>} */ (v);
  if (!o || typeof o !== 'object' || o.kty !== 'EC' || o.crv !== 'P-256' || ['x', 'y', 'd', 'kid'].some((k) => typeof o[k] !== 'string' || o[k] === '')) {
    throw new Error('시험 토큰 키 파일이 깨졌다(EC P-256 개인키 JWK가 아니다). 지우고 다시 만들려면 파일을 직접 지운다');
  }
  const jwk = /** @type {V0PrivateJwk} */ (o);
  try {
    createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, format: 'jwk' });
  } catch {
    throw new Error('시험 토큰 키 파일의 키를 읽지 못했다');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid: jwk.kid };
}

/**
 * 키 파일이 있으면 읽고 없으면 만들어 쓴다(파일 권한 0600). 파일이 깨졌으면 던진다(덮어쓰지 않는다)
 * @param {string} file
 * @returns {{ privateJwk: V0PrivateJwk, jwks: V0Jwks }}
 */
export function loadOrCreateV0TokenKey(file) {
  if (existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error('시험 토큰 키 파일이 JSON이 아니다. 지우고 다시 만들려면 파일을 직접 지운다');
    }
    const privateJwk = asPrivateJwk(parsed);
    return { privateJwk, jwks: publicJwksOf(privateJwk) };
  }
  const key = generateV0TokenKey();
  mkdirSync(dirname(file), { recursive: true });
  // wx: 그 사이 다른 실행이 만들었으면 덮어쓰지 않고 실패한다
  writeFileSync(file, `${JSON.stringify(key.privateJwk)}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

/**
 * 팬 액세스 토큰(JWT)을 만든다. 머리는 { alg: 'ES256', typ: 'at+jwt', kid }이고 서명은 ES256(IEEE P1363 r||s)이다.
 * 머리와 본문 칸은 덮어쓸 수 있다(시험이 틀린 토큰을 만들 때). 본문 기본값: iss V0_TOKEN_ISSUER, aud fan, iat 지금, exp 지금 + 15분
 * @param {V0PrivateJwk} privateJwk
 * @param {{ sub: string, sid: string, scope?: string, pid?: string, [k: string]: unknown }} claims
 * @param {{ nowMs?: number, header?: Record<string, unknown> }} [options]
 * @returns {string}
 */
export function signV0Token(privateJwk, claims, options = {}) {
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const header = { alg: 'ES256', typ: 'at+jwt', kid: privateJwk.kid, ...(options.header ?? {}) };
  const payload = { iss: V0_TOKEN_ISSUER, aud: 'fan', iat, exp: iat + V0_TOKEN_TTL_SECONDS, ...claims };
  /** @param {unknown} o */
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${part(header)}.${part(payload)}`;
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y, d: privateJwk.d }, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { DEFAULT_ROOT } = await import('./tools.mjs');
  const file = join(DEFAULT_ROOT, 'v0-token-key.json');
  const [cmd, sub, pid] = process.argv.slice(2);
  if (!(cmd === 'jwks' || (cmd === 'sign' && sub))) {
    console.error('쓰는 법: node tools/local/v0-token.mjs jwks | sign <sub> [pid]');
    process.exit(2);
  }
  const { privateJwk, jwks } = loadOrCreateV0TokenKey(file);
  if (cmd === 'jwks') console.log(JSON.stringify(jwks));
  else console.log(signV0Token(privateJwk, { sub, sid: `s-${sub}`, scope: 'ticket:buy', ...(pid ? { pid } : {}) }));
}
