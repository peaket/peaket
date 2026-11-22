// ticket-svc 기기 공개키 등록 한 번(FR-012, offline-gate §2 '서버 등록 잇기', openapi POST /v1/tickets/{ticketId}/device-keys, ADR-0336).
// - 팬 API 주소(ORIGINS.api)가 있으면 늘 보낸다. 따로 켜고 끄는 빌드 값은 두지 않는다(docs/frontend.md §4.2.4 '입장용 휴대폰 등록 세부' 언제 부르나).
// - 결과는 같은 절의 여섯에 ADR-0363 결정 2·3의 넷을 더해 나눈다: 등록됨(201이고 응답 keyId가 이 기기 keyId와 같음) · 주소 없음 ·
//   다시 보내기(끊김·시간 초과·5xx·429·keyId 다름) · 다시 확인(403 reauth-required) · 다시 받기(403 reissue-required) · 부스(403 reissue-at-booth) ·
//   재발급 한도(재인증 토큰을 실은 요청의 429) · 재인증 확인 못 함(재인증 토큰을 실은 요청의 503 reauth-unavailable) · 로그인(토큰 갱신 뒤에도 401) ·
//   거절(404·422·400과 그 밖의 403). 저장소를 바꾸는 일은 enrollment.ts가 한다. 결과 → d5 §5.13 상태 이름은 walletScreenStateOf다.
// - 출처·fetch는 주입할 수 있다(연결 시험이 실제 ticket-svc 앞 게이트웨이 대역으로 부른다). 없으면 ORIGINS.api·globalThis.fetch다.
// - api-client를 거치지 않는 손 호출이다(docs/frontend.md §4.1 'api-client 밖의 호출'): 쓰기 시간 한도 15초를 본문을 다 읽을 때까지 두고(timed-fetch),
//   401이면 창끼리 하나씩(Web Locks `peaket.refresh`) 토큰을 한 번 갱신한 뒤 한 번 더 보낸다. 그래서 node 시험이 globalThis.fetch로 본다.
// - 본문의 공개키 JWK에는 계약(openapi createTicketDeviceKey publicKeyJwk)이 받는 칸만 싣는다. 개인키 칸(d)은 싣지 않는다.
import type { CreateTicketDeviceKeyBody } from '@peaket/api-client/model';
import { ORIGINS } from '../../shared/config/origins.ts';
import { refreshLock } from '../../shared/lib/refresh-lock.ts';
import { fetchOnce } from '../../shared/lib/timed-fetch.ts';
import { refreshOnce, type RefreshResult } from '../../shared/lib/token-refresh.ts';

/** 다시 보낼 까닭: 끊김·시간 초과(network), 5xx와 정의 밖 응답(server), 429(rate-limited), 201인데 응답 keyId가 다름(key-mismatch) */
export type DeviceKeyRetryReason = 'network' | 'server' | 'rate-limited' | 'key-mismatch';

export type DeviceKeyRegistrationResult =
  | { kind: 'registered'; keyId: string }
  | { kind: 'unavailable' }
  | { kind: 'retry'; reason: DeviceKeyRetryReason; status?: number }
  /** 403 reauth-required: 입장 시작 뒤 첫 등록에 재인증이 필요하다(재인증 토큰을 실었으면 그 토큰이 만료·재사용이다) */
  | { kind: 'needs-reauth'; withToken: boolean }
  /** 403 reissue-required: 다른 기기에 키가 있어 재인증 뒤 REISSUE로 다시 받는다(입장 시작 전) */
  | { kind: 'reissue-required'; withToken: boolean }
  /** 403 reissue-at-booth: 입장이 시작되어 현장 부스에서만 다시 받는다 */
  | { kind: 'reissue-at-booth' }
  /** 재인증 토큰을 실은 요청의 429: 24시간 재발급 한도 */
  | { kind: 'reissue-limit' }
  /** 재인증 토큰을 실은 요청의 503 reauth-unavailable: 같은 토큰으로 다시 보내지 않고 새 재인증을 받는다 */
  | { kind: 'reauth-unavailable' }
  | { kind: 'needs-login' }
  | { kind: 'rejected'; status: number; type: string };

/** d5 §5.13 SCR-013 상태 이름(문구는 d5가 정본, 이 이름은 화면·시험이 가른다) */
export type WalletScreenState =
  | '등록됨'
  | '이 기기에만 등록됨'
  | '등록 확인 전'
  | '다시 확인 필요'
  | '저장소 유실, 입장 시작 전'
  | '저장소 유실, 입장 시작 뒤'
  | '재발급 한도'
  | '등록 거절'
  | '로그인';

/** 등록 결과 → d5 §5.13 상태 이름(ADR-0363 결정 2·3). 재인증 확인 못 함은 재인증을 다시 받는 '저장소 유실, 입장 시작 전'·'다시 확인 필요' 쪽이라 부르는 쪽이 이유로 정한다 */
export function walletScreenStateOf(r: DeviceKeyRegistrationResult, o: { reason?: RegisterDeviceKeyInput['reason'] } = {}): WalletScreenState {
  switch (r.kind) {
    case 'registered':
      return '등록됨';
    case 'unavailable':
      return '이 기기에만 등록됨';
    case 'retry':
      return '등록 확인 전';
    case 'needs-reauth':
      return '다시 확인 필요';
    case 'reissue-required':
      return '저장소 유실, 입장 시작 전';
    case 'reissue-at-booth':
      return '저장소 유실, 입장 시작 뒤';
    case 'reissue-limit':
      return '재발급 한도';
    case 'reauth-unavailable':
      return o.reason === 'ISSUE' ? '다시 확인 필요' : '저장소 유실, 입장 시작 전';
    case 'needs-login':
      return '로그인';
    case 'rejected':
      return '등록 거절';
  }
}

export interface RegisterDeviceKeyInput {
  /** 티켓 UUIDv7 */
  ticketId: string;
  publicKeyJwk: JsonWebKey;
  /** 이 기기 keyId(QR v1 keyId 8바이트의 base64url 11자). 응답 keyId와 견준다 */
  keyId: string;
  reason: 'ISSUE' | 'REISSUE' | 'TRANSFER' | 'BOOTH';
  reauthToken?: string;
  boothRequestId?: string;
  /** 팬 API 출처. 없으면 ORIGINS.api(연결 시험이 게이트웨이 대역 주소를 넣는다) */
  origin?: string;
  /** fetch. 없으면 globalThis.fetch(연결 시험이 팬 쿠키를 실은 fetch를 넣는다) */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** 서버 등록을 부르는 빌드인가: 팬 API 주소가 비지 않음(주소가 없는 로컬 화면 개발만 부르지 않는다). 부를 때마다 읽는다 */
export function deviceKeyRegistrationAvailable(): boolean {
  return ORIGINS.api !== '';
}

/** 계약이 받는 공개키 JWK 칸(openapi createTicketDeviceKey publicKeyJwk.properties) */
const CONTRACT_JWK_FIELDS = ['kty', 'crv', 'x', 'y', 'ext', 'key_ops', 'alg'] as const;

/** 내보낸 JWK에서 계약이 받는 칸만 고른다. 개인키 칸(d)과 그 밖의 칸은 버린다 */
export function contractPublicKeyJwk(jwk: JsonWebKey): CreateTicketDeviceKeyBody['publicKeyJwk'] {
  const source = jwk as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CONTRACT_JWK_FIELDS) if (source[k] !== undefined) out[k] = source[k];
  return out as CreateTicketDeviceKeyBody['publicKeyJwk'];
}

/** 문제 상세 type의 끝 경로(api-client ApiError.type과 같은 규칙). 본문이 없거나 JSON이 아니면 `http-<상태>` */
async function problemType(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown } | null;
    if (b && typeof b.type === 'string') return b.type.split('/').filter(Boolean).pop() ?? 'about:blank';
  } catch {
    // 본문이 JSON이 아니다
  }
  return `http-${r.status}`;
}

async function responseKeyId(r: Response): Promise<string | undefined> {
  try {
    const b = (await r.json()) as { keyId?: unknown } | null;
    return b && typeof b.keyId === 'string' ? b.keyId : undefined;
  } catch {
    return undefined;
  }
}

/** 401이 아닌 응답을 결과로 나눈다. withToken은 재인증 토큰(X-Reauth-Token)을 실었는가 */
async function classify(r: Response, keyId: string, withToken: boolean): Promise<DeviceKeyRegistrationResult> {
  if (r.status === 201) {
    const got = await responseKeyId(r);
    return got === keyId ? { kind: 'registered', keyId: got } : { kind: 'retry', reason: 'key-mismatch', status: 201 };
  }
  // 재인증 뒤 보낸 교체의 429는 24시간 재발급 한도다('재발급 한도', d5 §5.13). 재인증 없는 첫 등록의 429는 지금처럼 다시 보낸다
  if (r.status === 429) return withToken ? { kind: 'reissue-limit' } : { kind: 'retry', reason: 'rate-limited', status: 429 };
  if (r.status === 503 && withToken && (await problemType(r)) === 'reauth-unavailable') return { kind: 'reauth-unavailable' };
  if (r.status >= 500) return { kind: 'retry', reason: 'server', status: r.status };
  if (r.status === 403) {
    const type = await problemType(r);
    if (type === 'reauth-required') return { kind: 'needs-reauth', withToken };
    if (type === 'reissue-required') return { kind: 'reissue-required', withToken };
    if (type === 'reissue-at-booth') return { kind: 'reissue-at-booth' };
    return { kind: 'rejected', status: 403, type };
  }
  if (r.status === 404 || r.status === 422 || r.status === 400) return { kind: 'rejected', status: r.status, type: await problemType(r) };
  // 계약 밖 응답(201이 아닌 2xx, 409 등)은 키를 지우지 않고 다시 보낼 수 있게 둔다(지우기는 정본이 정한 거절에만)
  return { kind: 'retry', reason: 'server', status: r.status };
}

/**
 * 공개키를 ticket-svc에 한 번 등록한다. 저장소는 건드리지 않는다(enrollment.ts가 결과로 저장·삭제한다).
 * 주소가 없는 빌드는 부르지 않고 unavailable이다
 */
export async function registerDeviceKey(input: RegisterDeviceKeyInput): Promise<DeviceKeyRegistrationResult> {
  const origin = input.origin ?? ORIGINS.api;
  if (origin === '') return { kind: 'unavailable' };
  const payload: CreateTicketDeviceKeyBody = {
    publicKeyJwk: contractPublicKeyJwk(input.publicKeyJwk),
    reason: input.reason,
    ...(input.boothRequestId ? { boothRequestId: input.boothRequestId } : null),
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (input.reauthToken) headers['x-reauth-token'] = input.reauthToken;
  const url = `${origin}/v1/tickets/${encodeURIComponent(input.ticketId)}/device-keys`;
  const call = input.fetch ?? ((u: string, init?: RequestInit) => fetch(u, init));
  const withToken = Boolean(input.reauthToken);
  const UNAUTHORIZED = Symbol('401');
  const send = () =>
    fetchOnce(call, url, { method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error', headers, body }, async (r) =>
      r.status === 401 ? UNAUTHORIZED : classify(r, input.keyId, withToken),
    );
  try {
    const first = await send();
    if (first !== UNAUTHORIZED) return first;
    const refreshed: RefreshResult = await refreshLock(() => refreshOnce(call, `${origin}/v1/identity/access-tokens`));
    if (refreshed === 'rejected') return { kind: 'needs-login' };
    // 갱신이 일시 장애(끊김·5xx)면 세션이 끝난 것으로 보지 않는다(docs/frontend.md §4.1 '401'). 키를 두고 다시 보낼 수 있게 한다
    if (refreshed !== 'ok') return { kind: 'retry', reason: 'network' };
    const second = await send();
    return second === UNAUTHORIZED ? { kind: 'needs-login' } : second;
  } catch {
    // 연결 실패(TypeError)·시간 초과(TimeoutError)·이동 응답(redirect: 'error')
    return { kind: 'retry', reason: 'network' };
  }
}
