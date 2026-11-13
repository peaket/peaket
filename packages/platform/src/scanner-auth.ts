// 스캐너 기기 증명(DPoP, RFC 9449)과 기기·세션 판정의 공용 조각(BUILD_ORDER GAT-170, ADR-0051 결정 1·4, ADR-0065 결정 10).
// - 스태프 토큰은 게이트웨이가 검증하고 `X-User-Jkt`(토큰의 cnf.jkt)·`X-User-Ath`(토큰 해시)를 내부 머리로 넘긴다.
// - 가드는 요청마다 DPoP 증명의 서명·typ·htm·htu·iat·ath·jti를 보고, 키 지문이 등록 기기와 같은지·기기가 ACTIVE인지,
//   스태프 세션이 지금 유효한지(5초 [가정] 캐시)를 본다. 판정에 닿지 못하면 통과시키지 않고 503으로 닫는다.
// - 기기 원장(ticket-svc)과 스태프 세션(identity-svc)은 포트 뒤에 있다. 이 파일은 저장소를 모른다.
import { SetMetadata } from '@nestjs/common';
import { calculateJwkThumbprint, decodeProtectedHeader, errors, importJWK, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import type { Clock } from './clock.js';
import { ProblemError } from './problem.js';

/** 처리기(또는 컨트롤러)에 스캐너 기기 증명이 필요하다고 적는 표지 */
export const SCANNER_AUTH_METADATA = 'peaket:scanner-auth';
/** 증명의 iat 허용 창 [가정](offline-gate §6.1, RFC 9449 §4.3) */
export const SCANNER_DPOP_IAT_WINDOW_MS = 5 * 60_000;
/** 한 번 쓴 jti를 기억하는 시간 [가정](offline-gate §6.1) */
export const SCANNER_DPOP_JTI_TTL_MS = 10 * 60_000;
/** 스캐너 세션 판정 캐시 [가정](ADR-0051 결정 4) */
export const SCANNER_SESSION_CACHE_MS = 5_000;

export type ScannerStaffRole = 'gate_staff' | 'gate_lead';
export type ScannerDeviceStatus = 'ACTIVE' | 'REVOKED' | 'RETIRED';

/** ticket-svc 기기 원장의 판정에 필요한 값만 */
export interface ScannerDeviceRecord {
  deviceId: string;
  status: ScannerDeviceStatus;
  /** 기기가 묶인 파트너. 스태프 배정의 파트너와 대조하는 것은 identity-svc 몫이다 */
  promoterId: string;
}

/** 키 지문(jkt)으로 등록 기기를 찾는다(ticket-svc ScannerDeviceLookupService) */
export interface ScannerDeviceLookup {
  byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null>;
}

/** identity-svc CheckScannerSession의 답 */
export interface ScannerSessionAnswer {
  valid: boolean;
  role?: ScannerStaffRole;
  eventId?: string;
}

/** 스캐너 세션의 지금 유효성(identity-svc ScannerSessionCheckService) */
export interface ScannerSessionCheck {
  check(q: { scannerSessionId: string; deviceId: string }): Promise<ScannerSessionAnswer>;
}

/** 한 번 쓴 DPoP jti를 기억한다(Redis `scanner:dpop:{jti}`, offline-gate §6.1). true면 처음 쓴 것이다 */
export interface DpopReplayStore {
  claim(jti: string, ttlMs: number): Promise<boolean>;
}

/** createService에 넘기는 스캐너 인증 포트 묶음 */
export interface ScannerAuthWiring {
  devices: ScannerDeviceLookup;
  sessions: ScannerSessionCheck;
  replay: DpopReplayStore;
}

/** 이번 배치는 스태프 토큰이 붙은 스캐너 경로만 다룬다(기기 등록·업로드의 기기 인증만 경로는 ticket-svc 단계) */
export interface ScannerAuthOptions {
  token: 'required';
  device: 'registered';
}

/** 스캐너 경로의 기기 증명·세션 판정을 요구한다 */
export function ScannerAuth(options: ScannerAuthOptions = { token: 'required', device: 'registered' }): MethodDecorator & ClassDecorator {
  return SetMetadata(SCANNER_AUTH_METADATA, options);
}

export type DpopRejectReason = 'format' | 'typ' | 'alg' | 'jwk' | 'signature' | 'htm' | 'htu' | 'iat' | 'ath' | 'jti' | 'cnf';

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

/** 스캐너 인증 상태: 포트 호출과 5초 세션 캐시를 한곳에 모은다 */
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
  async sessionOf(scannerSessionId: string, deviceId: string): Promise<ScannerSessionAnswer> {
    const key = `${scannerSessionId}/${deviceId}`;
    const hit = this.#sessions.get(key);
    if (hit && this.clock.now() - hit.at < SCANNER_SESSION_CACHE_MS) return hit.answer;
    let answer: ScannerSessionAnswer;
    try {
      answer = await this.wiring.sessions.check({ scannerSessionId, deviceId });
    } catch (e) {
      throw scannerAuthUnavailable(e);
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
