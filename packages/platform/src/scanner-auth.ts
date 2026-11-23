// 스캐너 기기 증명(DPoP, RFC 9449)과 기기·세션 판정의 공용 조각(BUILD_ORDER GAT-170, ADR-0051 결정 1·4, ADR-0065 결정 10).
// - 스태프 토큰은 게이트웨이가 검증하고 `X-User-Jkt`(토큰의 cnf.jkt)·`X-User-Ath`(토큰 해시)를 내부 머리로 넘긴다.
// - 가드는 요청마다 DPoP 증명의 서명·typ·htm·htu·iat·ath·jti를 보고, 키 지문이 등록 기기와 같은지·기기가 ACTIVE인지,
//   스태프 세션이 지금 유효한지(5초 [가정] 캐시)를 본다. 판정에 닿지 못하면 통과시키지 않고 503으로 닫는다.
// - 기기 원장(ticket-svc)과 스태프 세션(identity-svc)은 포트 뒤에 있다. 이 파일은 저장소를 모른다.
import { SetMetadata } from '@nestjs/common';
import { calculateJwkThumbprint, decodeProtectedHeader, errors, importJWK, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import type { Clock } from './clock.js';
import { requestContext } from './context.js';
import { ProblemError } from './problem.js';

/** 처리기(또는 컨트롤러)에 스캐너 기기 증명이 필요하다고 적는 표지 */
export const SCANNER_AUTH_METADATA = 'peaket:scanner-auth';
/** 증명의 iat 허용 창 [가정](offline-gate §6.1, RFC 9449 §4.3) */
export const SCANNER_DPOP_IAT_WINDOW_MS = 5 * 60_000;
/** 한 번 쓴 jti를 기억하는 시간 [가정](offline-gate §6.1) */
export const SCANNER_DPOP_JTI_TTL_MS = 10 * 60_000;
/** 스캐너 세션 판정 캐시 [가정](ADR-0051 결정 4) */
export const SCANNER_SESSION_CACHE_MS = 5_000;
/** CheckScannerSession 호출 기한 [가정]. 남은 처리 시간이 더 짧으면 그쪽이다(offline-gate §6.2 '스캐너 세션 확인') */
export const SCANNER_SESSION_CHECK_TIMEOUT_MS = 1_000;

export type ScannerStaffRole = 'gate_staff' | 'gate_lead';
export type ScannerDeviceStatus = 'ACTIVE' | 'REVOKED' | 'RETIRED';

/** ticket-svc 기기 원장의 판정에 필요한 값만 */
export interface ScannerDeviceRecord {
  deviceId: string;
  status: ScannerDeviceStatus;
  /** 기기가 묶인 파트너. 스태프 배정의 파트너와 대조하는 것은 identity-svc 몫이다 */
  promoterId: string;
  /** 기기 키(DPoP)인지 인증서(mTLS)인지. 없으면 예전 어댑터처럼 종류를 보지 않는다 */
  credentialType?: 'DEVICE_KEY' | 'MTLS_CERT';
}

/** 키 지문(jkt)으로 등록 기기를 찾는다(ticket-svc ScannerDeviceLookupService) */
export interface ScannerDeviceLookup {
  byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null>;
  /** 마지막 연락 시각. 실패해도 요청을 막지 않는다(관측용) */
  touch?(deviceId: string, atMs: number): Promise<void>;
}

/** identity-svc CheckScannerSession의 답 */
export interface ScannerSessionAnswer {
  valid: boolean;
  role?: ScannerStaffRole;
  eventId?: string;
  /** 배정 ID·역할 유효 창·대리 승인 여부(근무 준비 응답, GAT-170 잔여) */
  assignmentId?: string;
  validFromMs?: number;
  validUntilMs?: number;
  proxy?: boolean;
  /** 배정된 스태프 계정. 기기 단독 업로드의 scan_event.staff_account_id를 세션으로 정할 때 쓴다(C1-11) */
  accountId?: string;
}

/** 스캐너 세션의 지금 유효성(identity-svc ScannerSessionCheckService) */
export interface ScannerSessionCheck {
  /** opts.timeoutMs는 이 호출에 쓸 수 있는 시간(gRPC 기한으로 넘긴다), signal은 그 시간이 지나면 끊긴다 */
  check(q: { scannerSessionId: string; deviceId: string }, opts?: { timeoutMs: number; signal: AbortSignal }): Promise<ScannerSessionAnswer>;
}

/** 한 번 쓴 DPoP jti를 기억한다(Redis `scanner:dpop:{jti}`, offline-gate §6.1). true면 처음 쓴 것이다 */
export interface DpopReplayStore {
  claim(jti: string, ttlMs: number): Promise<boolean>;
}

/** 게이트웨이가 클라이언트 인증서를 검증한 뒤 넣는 머리 이름(기본값). 클라이언트가 보낸 값은 게이트웨이가 지운다 */
export const SCANNER_MTLS_AUTH_HEADER = 'x-peaket-mtls-authenticated';
export const SCANNER_MTLS_CERT_HEADER = 'x-peaket-client-cert-sha256';
export const SCANNER_MTLS_CNF_HEADER = 'x-user-x5t';

/**
 * mTLS 선택지의 게이트웨이 신뢰 경계(offline-gate §6.1, RFC 8705).
 * `secret`은 게이트웨이만 아는 값이고, `x-peaket-mtls-authenticated`에 이 값이 있을 때만 mTLS로 본다.
 * 게이트웨이는 클라이언트가 보낸 같은 이름의 머리를 지우고, TLS 계층에서 인증서를 검증한 뒤에만 넣어야 한다.
 */
export interface ScannerMtlsOptions {
  secret: string;
  authenticatedHeader?: string;
  certThumbprintHeader?: string;
  tokenConfirmationHeader?: string;
}

/** createService에 넘기는 스캐너 인증 포트 묶음 */
export interface ScannerAuthWiring {
  devices: ScannerDeviceLookup;
  sessions: ScannerSessionCheck;
  replay: DpopReplayStore;
  /** 없으면 mTLS 머리를 믿지 않는다(기본 기기 키+DPoP만) */
  mtls?: ScannerMtlsOptions;
  /** 게이트웨이 공개 출처(PEAKET_PUBLIC_ORIGIN). 있으면 DPoP htu를 이 값으로 만들고 forwarded 머리를 보지 않는다(C2-09) */
  publicOrigin?: string;
  /**
   * 가드가 거절(401·403)하거나 판정에 닿지 못해(503) 닫을 때마다 그 이유로 한 번 부른다. 통과는 부르지 않는다.
   * 서비스는 여기에 `scanner_auth_rejections_total{service, reason}`을 잇는다(offline-gate §6.1 'GAT-170 마감 규칙', O-T37 ⑨).
   * 던져도 응답은 바뀌지 않는다.
   */
  onRejected?: (reason: ScannerAuthRejection) => void;
}

/** 이번 배치는 스태프 토큰이 붙은 스캐너 경로만 다룬다(기기 등록·업로드의 기기 인증만 경로는 ticket-svc 단계) */
export interface ScannerAuthOptions {
  /**
   * required: 스태프 토큰과 그 세션을 함께 본다(근무 준비·목록·이상 표시).
   * none: 기기 키 증명만 본다(기기 승인 코드·토큰, device-only).
   * optional: 토큰이 붙으면 세션까지 보고, 없으면 기기 증명만 본다(스캔 업로드).
   */
  token: 'required' | 'none' | 'optional';
  device: 'registered';
  /** mTLS 머리를 받아들일지. 기본 true지만 wiring.mtls가 없으면 아무 효과가 없다 */
  mtls?: boolean;
}

/** 스캐너 경로의 기기 증명·세션 판정을 요구한다 */
export function ScannerAuth(options: ScannerAuthOptions = { token: 'required', device: 'registered' }): MethodDecorator & ClassDecorator {
  return SetMetadata(SCANNER_AUTH_METADATA, options);
}

export type DpopRejectReason = 'format' | 'typ' | 'alg' | 'jwk' | 'signature' | 'htm' | 'htu' | 'iat' | 'ath' | 'jti' | 'cnf';

/** 스캐너 가드의 거절 이유 이름표(offline-gate §6.1 'GAT-170 마감 규칙'). 지표 `scanner_auth_rejections_total`의 reason 값이다 */
export type ScannerAuthRejection =
  | DpopRejectReason
  | 'proof_missing'
  | 'token'
  | 'session'
  | 'role'
  | 'device_unregistered'
  | 'device_revoked'
  | 'unavailable';

/** 이름표 전부(정본 차례). 지표를 0으로 미리 만들 때 쓴다 */
export const SCANNER_AUTH_REJECTIONS: readonly ScannerAuthRejection[] = Object.freeze([
  'format', 'typ', 'alg', 'jwk', 'signature', 'htm', 'htu', 'iat', 'ath', 'jti', 'cnf',
  'proof_missing', 'token', 'session', 'role', 'device_unregistered', 'device_revoked', 'unavailable',
] as const);

/** 스캐너 PWA 출처를 주는 환경 변수(offline-gate §6.1 'GAT-170 마감 규칙', ADR-0065 결정 10) */
export const SCANNER_PWA_ORIGIN_ENV = 'PEAKET_SCANNER_PWA_ORIGIN';
const DEFAULT_SCANNER_PWA_ORIGIN = 'https://scanner.peaket.example';

/** 허용 출처. 없거나 빈 값이면 운영 기본 출처다 */
export function scannerPwaOriginFromEnv(env: Record<string, string | undefined> = process.env): string {
  const v = env[SCANNER_PWA_ORIGIN_ENV];
  return v === undefined || v === '' ? DEFAULT_SCANNER_PWA_ORIGIN : v;
}

/**
 * 스캐너 쓰기 경로(기기 등록·승인·업로드)의 `Origin` 확인(O-T35). 기대 출처와 정확히 같은 문자열만 통과한다
 * (끝 슬래시·대소문자·기본 포트 표기도 다르면 거절). 아니면 403 `scanner-origin-forbidden`.
 */
export function assertScannerOrigin(origin: unknown, expected: string): void {
  if (typeof origin !== 'string' || origin === '' || origin !== expected) {
    throw new ProblemError({ type: 'scanner-origin-forbidden', status: 403, title: '스캐너 앱 출처가 아닙니다' });
  }
}

/** 증명이 틀렸다. 가드는 이 이유를 응답에 싣지 않고 `invalid_dpop_proof` 하나로 답한다(offline-gate O-T37) */
export class DpopRejected extends Error {
  constructor(readonly reason: DpopRejectReason) {
    super(`DPoP 증명 거절: ${reason}`);
    this.name = 'DpopRejected';
  }
}

export interface VerifiedDpopProof {
  /** 증명 헤더 jwk의 RFC 7638 SHA-256 지문(base64url) */
  jkt: string;
  jti: string;
}

/** 토큰의 SHA-256(base64url). DPoP `ath`와 게이트웨이 내부 머리 `X-User-Ath`가 같은 값이다 */
export function athOf(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

const isPublicEcJwk = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object') return false;
  const jwk = v as Record<string, unknown>;
  return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string' && typeof jwk.d !== 'string';
};

const withoutQuery = (url: string): string => {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
};

/**
 * DPoP 증명 하나를 확인한다(RFC 9449 §4.2·§4.3).
 * - 헤더: typ `dpop+jwt`, alg ES256, 공개키 jwk(개인키 d가 있으면 거절)
 * - 내용: jti·htm·htu·iat, 스태프 토큰이 있으면 ath
 * - htu는 질의 문자열을 뺀 절대 주소로 견준다. iat는 서버 시각 ±5분 [가정], jti는 10분 [가정] 안에서 처음이어야 한다.
 */
export async function verifyDpopProof(o: {
  proof: string;
  method: string;
  /** 질의 문자열을 포함해도 된다. 비교할 때 뺀다 */
  url: string;
  /** 게이트웨이가 넘긴 토큰 해시. 없으면 accessToken으로 계산한다 */
  expectedAth?: string;
  /** 가드가 직접 받은 스태프 토큰(시험·로컬). 있으면 ath를 계산해 expectedAth와 함께 본다 */
  accessToken?: string;
  /** 토큰의 cnf.jkt. 주면 증명의 jkt와 같아야 한다(기기 등록처럼 토큰이 없는 경로는 생략) */
  expectedJkt?: string;
  /** 스태프 토큰이 붙은 경로는 ath를 요구한다. 기기 등록 증명은 토큰이 없어 false */
  requireAth?: boolean;
  clock: Clock;
  replay: DpopReplayStore;
}): Promise<VerifiedDpopProof> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(o.proof);
  } catch {
    throw new DpopRejected('format');
  }
  if (header.typ !== 'dpop+jwt') throw new DpopRejected('typ');
  if (header.alg !== 'ES256') throw new DpopRejected('alg');
  if (!isPublicEcJwk(header.jwk)) throw new DpopRejected('jwk');
  const jkt = await calculateJwkThumbprint(header.jwk, 'sha256');

  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(header.jwk as never, 'ES256');
    const result = await jwtVerify(o.proof, key, { typ: 'dpop+jwt', algorithms: ['ES256'], currentDate: new Date(o.clock.now()) });
    payload = result.payload as Record<string, unknown>;
  } catch (e) {
    if (e instanceof errors.JWTExpired) throw new DpopRejected('iat');
    if (e instanceof errors.JWTClaimValidationFailed) throw new DpopRejected('typ');
    if (e instanceof errors.JWSSignatureVerificationFailed) throw new DpopRejected('signature');
    if (e instanceof errors.JOSEAlgNotAllowed) throw new DpopRejected('alg');
    if (e instanceof errors.JWSInvalid || e instanceof errors.JWTInvalid) throw new DpopRejected('format');
    throw e;
  }

  if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(payload.jti)) throw new DpopRejected('format');
  if (payload.htm !== o.method.toUpperCase()) throw new DpopRejected('htm');
  if (typeof payload.htu !== 'string' || withoutQuery(payload.htu) !== withoutQuery(o.url)) throw new DpopRejected('htu');
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) throw new DpopRejected('iat');
  if (Math.abs(o.clock.now() - payload.iat * 1000) > SCANNER_DPOP_IAT_WINDOW_MS) throw new DpopRejected('iat');

  if (o.requireAth !== false) {
    const computedAth = o.accessToken === undefined ? undefined : athOf(o.accessToken);
    const expectedAth = o.expectedAth ?? computedAth;
    if (expectedAth === undefined) throw new DpopRejected('ath');
    if (computedAth !== undefined && computedAth !== expectedAth) throw new DpopRejected('ath');
    if (payload.ath !== expectedAth) throw new DpopRejected('ath');
  }

  if (o.expectedJkt !== undefined && o.expectedJkt !== jkt) throw new DpopRejected('cnf');

  let first: boolean;
  try {
    first = await o.replay.claim(payload.jti, SCANNER_DPOP_JTI_TTL_MS);
  } catch (e) {
    throw scannerAuthUnavailable(e);
  }
  if (!first) throw new DpopRejected('jti');
  return { jkt, jti: payload.jti };
}

/** 로컬·시험용 jti 저장소. 파드가 여럿인 운영은 Redis 어댑터를 쓴다 */
export class MemoryDpopReplayStore implements DpopReplayStore {
  readonly #until = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async claim(jti: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    this.sweep(now);
    const until = this.#until.get(jti);
    if (until !== undefined && until > now) return false;
    this.#until.set(jti, now + ttlMs);
    return true;
  }

  private sweep(now: number): void {
    if (this.#until.size < 10_000) return;
    for (const [jti, until] of this.#until) if (until <= now) this.#until.delete(jti);
  }
}

/** 스캐너 인증 상태: 포트 호출과 5초 세션 캐시를 한곳에 모은다. 기기 상태는 캐시하지 않는다(폐기는 다음 요청부터 403, offline-gate §6.2) */
export class ScannerAuthState {
  readonly #sessions = new Map<string, { answer: ScannerSessionAnswer; at: number }>();

  constructor(
    readonly wiring: ScannerAuthWiring,
    private readonly clock: Clock,
  ) {}

  async deviceByThumbprint(jkt: string): Promise<ScannerDeviceRecord | null> {
    try {
      return await this.wiring.devices.byThumbprint(jkt);
    } catch (e) {
      throw scannerAuthUnavailable(e);
    }
  }

  /** 세션·기기 쌍마다 5초 [가정]. 유효·무효 답을 모두 캐시한다(해제 반영은 늦어도 5초) */
  async sessionOf(scannerSessionId: string, deviceId: string, o: { refresh?: boolean } = {}): Promise<ScannerSessionAnswer> {
    const key = `${scannerSessionId}/${deviceId}`;
    const hit = o.refresh === true ? undefined : this.#sessions.get(key);
    if (hit && this.clock.now() - hit.at < SCANNER_SESSION_CACHE_MS) return hit.answer;
    // 1초 [가정]와 남은 처리 시간 가운데 짧은 쪽에서 끊는다. 답이 없으면 통과시키지 않고 503으로 닫는다
    const remaining = requestContext()?.deadline.remainingMs() ?? SCANNER_SESSION_CHECK_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(SCANNER_SESSION_CHECK_TIMEOUT_MS, remaining));
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`스캐너 세션 확인이 ${timeoutMs}ms 안에 끝나지 않았다`));
      }, timeoutMs);
    });
    let answer: ScannerSessionAnswer;
    try {
      answer = await Promise.race([this.wiring.sessions.check({ scannerSessionId, deviceId }, { timeoutMs, signal: abort.signal }), expired]);
    } catch (e) {
      throw scannerAuthUnavailable(e);
    } finally {
      clearTimeout(timer);
    }
    this.#sessions.set(key, { answer, at: this.clock.now() });
    if (this.#sessions.size > 10_000) this.sweep();
    return answer;
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [key, e] of this.#sessions) if (now - e.at >= SCANNER_SESSION_CACHE_MS) this.#sessions.delete(key);
  }
}

/** 기기·세션 판정에 닿지 못했다. 통과시키지 않고 503으로 닫는다(ADR-0172와 같은 닫힌 쪽) */
export function scannerAuthUnavailable(cause?: unknown): ProblemError {
  return new ProblemError({ type: 'scanner-auth-unavailable', status: 503, title: '스캐너 기기·세션을 확인하지 못했습니다', retryAfterSeconds: 1, cause });
}
