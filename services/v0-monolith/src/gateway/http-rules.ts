// v0 입구의 머리 규칙(docs/infra.md §3 'v0 배포' 2·4·5·6, ASVS v5.0.0-4.1.3·3.5.1·3.4.1·3.4.4).
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { isIP, isIPv4 } from 'node:net';
import type { FanIdentity } from './token.js';

/** 모든 응답에 붙이는 HSTS(1년, 하위 도메인 포함) */
export const HSTS = 'max-age=31536000; includeSubDomains';
/** 들어온 요청에서 지우는 추적 머리(입구가 새 추적을 시작한다, docs/api/guidelines.md §9) */
export const STRIPPED_TRACE_HEADERS: readonly string[] = ['traceparent', 'tracestate', 'baggage'];
/** 다음 홉으로 넘기지 않는 연결 머리(RFC 9110 §7.6.1). 업그레이드 요청의 connection·upgrade는 따로 다시 쓴다 */
export const HOP_BY_HOP_HEADERS: readonly string[] = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
/** 출처를 확인하는 쓰기 메서드 */
export const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** 앞단 주소 머리(입구만 x-forwarded-for를 다시 쓴다). x-forwarded-로 시작하는 머리 전부도 지운다 */
const FORWARDED_ADDRESS_HEADERS: readonly string[] = ['forwarded', 'x-real-ip'];
const STATUS_TITLES = { 400: 'Bad Request', 403: 'Forbidden', 429: 'Too Many Requests', 502: 'Bad Gateway', 504: 'Gateway Timeout' } as const;

/** 내부 신원 머리인가(x-user-로 시작하는 머리 전부와 x-session-id, 대소문자 무시. 밑줄로 쓴 이름(x_user_id)도 같게 본다: 앞단이 밑줄을 붙임표로 바꿀 수 있다) */
export function isIdentityHeader(name: string): boolean {
  const n = name.toLowerCase().replace(/_/g, '-');
  return n.startsWith('x-user-') || n === 'x-session-id';
}

/** IP 하나로 읽는다. IPv4를 담은 IPv6(::ffff:a.b.c.d)는 IPv4로 쓴다. IP가 아니면 undefined */
function normalizeIp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  const mapped = /^::ffff:(.+)$/i.exec(v);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  return isIP(v) ? v : undefined;
}

/**
 * 클라이언트 IP. trustedHops가 0이면 연결의 상대 주소, n이면 X-Forwarded-For(여러 머리면 쉼표로 이음)의 오른쪽에서 n번째 값.
 * 값이 모자라거나 IP가 아니면 연결의 상대 주소다. IPv4를 담은 IPv6(::ffff:a.b.c.d)는 IPv4로 쓴다. 상대 주소도 없으면 'unknown'
 */
export function clientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, trustedHops: number): string {
  const remote = normalizeIp(remoteAddress) ?? 'unknown';
  if (!(trustedHops > 0)) return remote;
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (chain.length < trustedHops) return remote;
  return normalizeIp(chain[chain.length - trustedHops]) ?? remote;
}

/** 이 요청에 출처 확인이 필요한가: 쓰기 메서드이고 액세스 쿠키를 실었다 */
export function needsOriginCheck(method: string | undefined, hasAccessCookie: boolean): boolean {
  return hasAccessCookie && method !== undefined && WRITE_METHODS.includes(method.toUpperCase());
}

/** Origin이 허용 출처 목록에 정확히 있는가(없거나 'null'이면 거절) */
export function originAllowed(origin: string | string[] | undefined, allowedOrigins: readonly string[]): boolean {
  if (Array.isArray(origin)) {
    if (origin.length !== 1) return false;
    origin = origin[0];
  }
  if (origin === undefined || origin === '' || origin === 'null') return false;
  return allowedOrigins.includes(origin);
}

export interface UpstreamHeaderOptions {
  /** 앱 주소의 host(host 머리를 이 값으로 바꾼다) */
  upstreamHost: string;
  /** 검증을 통과한 신원(없으면 신원 머리 없이 넘긴다) */
  identity: FanIdentity | undefined;
  /** 입구가 정한 클라이언트 IP(x-forwarded-for를 이 값 하나로 바꾼다) */
  clientIp: string;
  /** WebSocket 업그레이드 요청이면 connection·upgrade 머리를 'Upgrade'·원래 값으로 남긴다 */
  upgrade?: boolean;
}

/** Connection 머리에 적힌 머리 이름(그 홉에만 쓰는 머리, RFC 9110 §7.6.1) */
function connectionListed(headers: IncomingHttpHeaders): Set<string> {
  const raw = headers.connection;
  const text = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  return new Set(
    text
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * 앱으로 넘길 머리: 신원 머리·추적 머리·Cookie·연결 머리를 지우고 host·x-forwarded-for를 다시 쓴 뒤 신원 머리를 넣는다
 * (x-user-id=sub, x-session-id=sid, x-user-aud=fan, x-user-scope=scope, pid가 있으면 x-user-pid)
 */
export function upstreamRequestHeaders(incoming: IncomingHttpHeaders, options: UpstreamHeaderOptions): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const n = name.toLowerCase();
    // 밑줄로 쓴 이름도 같은 머리로 본다(x_forwarded_for 등)
    const hyphened = n.replace(/_/g, '-');
    if (
      isIdentityHeader(n) ||
      STRIPPED_TRACE_HEADERS.includes(hyphened) ||
      HOP_BY_HOP_HEADERS.includes(n) ||
      FORWARDED_ADDRESS_HEADERS.includes(hyphened) ||
      hyphened.startsWith('x-forwarded-') ||
      listed.has(n) ||
      n === 'cookie' ||
      n === 'host'
    ) {
      continue;
    }
    out[n] = value;
  }
  out.host = options.upstreamHost;
  out['x-forwarded-for'] = options.clientIp;
  // 본문 길이 표시는 지우지 않는다. 지우면 앱이 본문 안에 숨긴 두 번째 요청을 따로 읽는다(요청 밀반입, 2026-11-03 코드 리뷰).
  // 받은 Content-Length는 Connection에 적혀 있어도 그대로 달고, 없이 chunked로 받았으면(Node가 이미 풀었다) 다시 chunked로 보낸다.
  // 둘이 함께 온 요청은 Node 파서가 400으로 막아 여기 오지 않는다
  if (incoming['content-length'] !== undefined) out['content-length'] = incoming['content-length'];
  else if (incoming['transfer-encoding'] !== undefined) out['transfer-encoding'] = 'chunked';
  if (options.upgrade) {
    out.connection = 'Upgrade';
    if (incoming.upgrade !== undefined) out.upgrade = incoming.upgrade;
  }
  const id = options.identity;
  if (id) {
    out['x-user-id'] = id.sub;
    out['x-session-id'] = id.sid;
    out['x-user-aud'] = 'fan';
    out['x-user-scope'] = id.scope;
    if (id.pid !== undefined) out['x-user-pid'] = id.pid;
  }
  return out;
}

/** 모든 응답에 붙이는 보안 머리 */
function securityHeaders(): OutgoingHttpHeaders {
  return { 'strict-transport-security': HSTS, 'x-content-type-options': 'nosniff' };
}

/** 앱 응답 머리에 보안 머리를 더한 것: HSTS·nosniff는 늘 덮어쓰고, Cache-Control이 없으면 no-store. 연결 머리는 뺀다 */
export function downstreamResponseHeaders(upstream: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = connectionListed(upstream);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value === undefined) continue;
    const n = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.includes(n) || listed.has(n)) continue;
    out[n] = value;
  }
  if (out['cache-control'] === undefined) out['cache-control'] = 'no-store';
  return { ...out, ...securityHeaders() };
}

export interface GatewayProblem {
  status: number;
  headers: OutgoingHttpHeaders;
  body: string;
}

/**
 * 입구가 직접 내는 오류(400 본문을 실은 업그레이드, 403 출처, 429 레이트 리밋, 502·504 앱): application/problem+json의 about:blank Problem(title은 HTTP 상태 문구, status, traceId)과 보안 머리.
 * 429면 Retry-After를 단다
 */
export function gatewayProblem(status: 400 | 403 | 429 | 502 | 504, traceId: string, retryAfterSeconds?: number): GatewayProblem {
  const body = JSON.stringify({ type: 'about:blank', title: STATUS_TITLES[status], status, traceId });
  const headers: OutgoingHttpHeaders = {
    'content-type': 'application/problem+json',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    ...securityHeaders(),
  };
  if (status === 429) headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSeconds ?? 1)));
  return { status, headers, body };
}
