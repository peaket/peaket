// v0 입구 설정(환경 값, docs/infra.md §3 'v0 배포'). 비밀(TLS 키)과 주소는 환경 값으로만 받는다(ASVS v5.0.0-13.3.1).
// v0는 로컬 kind에서만 돌므로 PEAKET_ENV가 local·ci가 아니면 시작하지 않는다.
import { DEFAULT_MAX_DEADLINE_MS } from '@peaket/platform';
import { type FanJwks, parseFanJwks } from './token.js';

export const GATEWAY_ENVS = ['local', 'ci'] as const;
export const GATEWAY_DEFAULTS = {
  port: 8443,
  managementPort: 9464,
  trustedProxyHops: 0,
  ratePerSecond: 10,
  burst: 20,
  maxKeys: 100_000,
  upstreamTimeoutMs: 20_000,
} as const;
/** 믿을 수 있는 앞단 프록시 수의 상한 */
export const MAX_TRUSTED_PROXY_HOPS = 5;

export interface GatewayConfig {
  env: (typeof GATEWAY_ENVS)[number];
  /** HTTPS 포트(PEAKET_V0_GATEWAY_PORT, 기본 8443) */
  port: number;
  /** 관리 포트(PEAKET_MANAGEMENT_PORT, 기본 9464) */
  managementPort: number;
  /** 앱 주소(PEAKET_V0_UPSTREAM, http://만) */
  upstream: URL;
  /** TLS 인증서·키 PEM(PEAKET_V0_TLS_CERT·PEAKET_V0_TLS_KEY) */
  tlsCert: string;
  tlsKey: string;
  /** 공개키 목록(PEAKET_V0_GATEWAY_JWKS) */
  jwks: FanJwks;
  /** 받는 발급자(PEAKET_V0_TOKEN_ISSUER) */
  issuer: string;
  /** 쓰기 요청의 허용 출처(PEAKET_V0_ALLOWED_ORIGINS, 쉼표로 나눔, 하나 이상) */
  allowedOrigins: string[];
  /** X-Forwarded-For에서 믿는 앞단 프록시 수(PEAKET_V0_TRUSTED_PROXY_HOPS, 0~5 정수, 기본 0) */
  trustedProxyHops: number;
  /** 레이트 리밋(PEAKET_V0_RATE_PER_SECOND 양수, PEAKET_V0_RATE_BURST 1 이상 정수) */
  ratePerSecond: number;
  burst: number;
  /** 버킷 표 상한(바꾸지 않는다, 시험만 줄인다) */
  maxKeys: number;
  /** 앱 응답 머리를 기다리는 시간(PEAKET_V0_UPSTREAM_TIMEOUT_MS, 기본 20초, 요청 마감 15초보다 길어야 한다) */
  upstreamTimeoutMs: number;
}

export class GatewayConfigError extends Error {
  override name = 'GatewayConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

const fail = (msg: string): never => {
  throw new GatewayConfigError(msg);
};

function required(env: Env, name: string): string {
  const v = env[name];
  return v === undefined || v.trim() === '' ? fail(`${name}이 없다`) : v;
}

/** 10진 정수 글자만(앞뒤 공백·부호·소수점 없음) */
function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return fail(`${name}가 정수가 아니다`);
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fail(`${name}가 ${min}~${max} 밖이다`);
}

function port(env: Env, name: string, fallback: number): number {
  return integer(env, name, fallback, 0, 65_535);
}

/** 환경 값을 읽는다. 없거나 틀린 값이면 GatewayConfigError(값 자체는 문구에 싣지 않는다: 키·주소가 로그에 남지 않게) */
export function loadGatewayConfig(env: Env): GatewayConfig {
  const peaketEnv = env.PEAKET_ENV;
  const gatewayEnv = (GATEWAY_ENVS as readonly string[]).includes(peaketEnv ?? '')
    ? (peaketEnv as GatewayConfig['env'])
    : fail(`PEAKET_ENV가 ${GATEWAY_ENVS.join('·')}일 때만 시작한다(v0는 로컬 kind에서만 돈다)`);

  let upstream: URL;
  try {
    upstream = new URL(required(env, 'PEAKET_V0_UPSTREAM'));
  } catch (err) {
    if (err instanceof GatewayConfigError) throw err;
    return fail('PEAKET_V0_UPSTREAM이 주소가 아니다');
  }
  if (upstream.protocol !== 'http:' || upstream.hostname === '' || upstream.username !== '' || upstream.password !== '') {
    fail('PEAKET_V0_UPSTREAM은 사용자 정보 없는 http:// 주소여야 한다(클러스터 안 앱)');
  }

  const tlsCert = required(env, 'PEAKET_V0_TLS_CERT');
  const tlsKey = required(env, 'PEAKET_V0_TLS_KEY');
  if (!tlsCert.includes('-----BEGIN CERTIFICATE-----')) fail('PEAKET_V0_TLS_CERT가 PEM 인증서가 아니다');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(tlsKey)) fail('PEAKET_V0_TLS_KEY가 PEM 개인키가 아니다');

  let jwks: FanJwks;
  try {
    jwks = parseFanJwks(required(env, 'PEAKET_V0_GATEWAY_JWKS'));
  } catch (err) {
    if (err instanceof GatewayConfigError) throw err;
    return fail(`PEAKET_V0_GATEWAY_JWKS가 틀렸다(${err instanceof Error ? err.message : '알 수 없음'})`);
  }

  const issuer = required(env, 'PEAKET_V0_TOKEN_ISSUER');
  const allowedOrigins = required(env, 'PEAKET_V0_ALLOWED_ORIGINS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) fail('PEAKET_V0_ALLOWED_ORIGINS에 허용 출처가 없다');
  for (const origin of allowedOrigins) {
    let u: URL | undefined;
    try {
      u = new URL(origin);
    } catch {
      u = undefined;
    }
    // 출처는 스킴·호스트·포트뿐이다(경로·끝 빗금이 붙으면 브라우저의 Origin과 같아질 수 없다)
    if (!u || u.origin !== origin) fail('PEAKET_V0_ALLOWED_ORIGINS의 값이 출처(스킴://호스트[:포트])가 아니다');
  }

  const rateRaw = env.PEAKET_V0_RATE_PER_SECOND;
  let ratePerSecond: number = GATEWAY_DEFAULTS.ratePerSecond;
  if (rateRaw !== undefined) {
    ratePerSecond = /^\d+(\.\d+)?$/.test(rateRaw) ? Number(rateRaw) : NaN;
    if (!(Number.isFinite(ratePerSecond) && ratePerSecond > 0)) fail('PEAKET_V0_RATE_PER_SECOND는 양수여야 한다');
  }
  const upstreamTimeoutMs = integer(env, 'PEAKET_V0_UPSTREAM_TIMEOUT_MS', GATEWAY_DEFAULTS.upstreamTimeoutMs, 1, 600_000);
  // 요청 마감(기본 15초)보다 길어야 동기 결제 체인이 입구에서 먼저 끊기지 않는다(docs/features/payment.md §13)
  if (upstreamTimeoutMs <= DEFAULT_MAX_DEADLINE_MS) fail(`PEAKET_V0_UPSTREAM_TIMEOUT_MS는 요청 마감 ${DEFAULT_MAX_DEADLINE_MS}ms보다 길어야 한다`);

  return {
    env: gatewayEnv,
    port: port(env, 'PEAKET_V0_GATEWAY_PORT', GATEWAY_DEFAULTS.port),
    managementPort: port(env, 'PEAKET_MANAGEMENT_PORT', GATEWAY_DEFAULTS.managementPort),
    upstream,
    tlsCert,
    tlsKey,
    jwks,
    issuer,
    allowedOrigins,
    trustedProxyHops: integer(env, 'PEAKET_V0_TRUSTED_PROXY_HOPS', GATEWAY_DEFAULTS.trustedProxyHops, 0, MAX_TRUSTED_PROXY_HOPS),
    ratePerSecond,
    burst: integer(env, 'PEAKET_V0_RATE_BURST', GATEWAY_DEFAULTS.burst, 1, 1_000_000),
    maxKeys: GATEWAY_DEFAULTS.maxKeys,
    upstreamTimeoutMs,
  };
}
