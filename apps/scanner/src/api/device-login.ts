// SCR-036 기기 승인 로그인(RFC 8628)과 기기 등록의 실제 API 연결(offline-gate §6.1, GAT-220).
// - 기기 키(DPoP, IndexedDB)로만 시작한다. 사람 토큰은 없다.
// - 승인 뒤 받은 스태프 토큰은 만료 시각과 함께 key-store가 저장한다(재로그인·만료 처리).
// - 교차 출처라 자격 증명(쿠키·인증서)을 싣지 않는다(credentials: 'omit', ADR-0065 결정 10).
import { dpopProof, type DpopKey } from './dpop.ts';

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface ScannerTokenGrant {
  accessToken: string;
  expiresIn: number;
}

export type DeviceLoginErrorCode = 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'rate_limited' | 'device_revoked' | 'device_unregistered' | 'unavailable' | 'invalid_response' | 'http';

export class DeviceLoginError extends Error {
  readonly code: DeviceLoginErrorCode;
  readonly status: number;
  readonly type: string;
  readonly title: string;
  /** slow_down이면 서버가 알려 준 새 간격(초) */
  readonly intervalSec?: number;

  constructor(code: DeviceLoginErrorCode, status = 0, type = '', title = '', intervalSec?: number) {
    super(title || code);
    this.name = 'DeviceLoginError';
    this.code = code;
    this.status = status;
    this.type = type;
    this.title = title;
    this.intervalSec = intervalSec;
  }
}

export interface DeviceLoginOptions {
  origin: string;
  key: DpopKey;
  fetch?: typeof fetch;
  now?: () => number;
}

async function problemOf(res: Response): Promise<{ type: string; title: string }> {
  try {
    const p = (await res.json()) as { type?: unknown; title?: unknown };
    return {
      type: typeof p.type === 'string' ? p.type.replace(/^https:\/\/peaket\.example\/problems\//, '') : '',
      title: typeof p.title === 'string' ? p.title : '',
    };
  } catch {
    return { type: '', title: '' };
  }
}

function errorOf(res: Response, p: { type: string; title: string }): DeviceLoginError {
  if (res.status === 429 || p.type === 'scanner-login-rate-limited') return new DeviceLoginError('rate_limited', res.status, p.type, p.title || '승인 요청이 너무 잦습니다');
  if (p.type === 'device-revoked') return new DeviceLoginError('device_revoked', res.status, p.type, p.title || '폐기된 스캐너 기기입니다');
  if (p.type === 'device-unregistered') return new DeviceLoginError('device_unregistered', res.status, p.type, p.title || '등록되지 않은 스캐너 기기입니다');
  if (res.status === 503) return new DeviceLoginError('unavailable', res.status, p.type, p.title || '스캐너 기기·세션을 확인하지 못했습니다');
  return new DeviceLoginError('http', res.status, p.type, p.title || `스캐너 로그인 오류 ${res.status}`);
}

function base(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/** RFC 8628 §3.1 기기 승인 시작. 확인 코드·QR 주소·5분 만료를 받는다 */
export async function startDeviceAuthorization(o: DeviceLoginOptions): Promise<DeviceAuthorization> {
  const url = `${base(o.origin)}/v1/scanner/device-authorizations`;
  const proof = await dpopProof({ key: o.key, method: 'POST', url, nowMs: (o.now ?? Date.now)() });
  const res = await (o.fetch ?? globalThis.fetch.bind(globalThis))(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', dpop: proof, accept: 'application/json' },
    body: '{}',
    credentials: 'omit',
  });
  if (!res.ok) throw errorOf(res, await problemOf(res));
  const v = (await res.json()) as Record<string, unknown>;
  if (typeof v.deviceCode !== 'string' || typeof v.userCode !== 'string' || typeof v.verificationUriComplete !== 'string') {
    throw new DeviceLoginError('invalid_response', res.status, '', '기기 승인 응답에 필요한 값이 없습니다');
  }
  return {
    deviceCode: v.deviceCode,
    userCode: v.userCode,
    verificationUriComplete: v.verificationUriComplete,
    expiresIn: typeof v.expiresIn === 'number' && Number.isFinite(v.expiresIn) ? v.expiresIn : 300,
    interval: typeof v.interval === 'number' && Number.isFinite(v.interval) && v.interval > 0 ? v.interval : 5,
  };
}

/** RFC 8628 §3.4 토큰 폴링. authorization_pending·slow_down은 기다리는 중, 나머지는 끝난다 */
export async function pollDeviceToken(o: DeviceLoginOptions & { deviceCode: string }): Promise<ScannerTokenGrant> {
  const url = `${base(o.origin)}/v1/scanner/token`;
  const proof = await dpopProof({ key: o.key, method: 'POST', url, nowMs: (o.now ?? Date.now)() });
  const res = await (o.fetch ?? globalThis.fetch.bind(globalThis))(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', dpop: proof, accept: 'application/json' },
    body: JSON.stringify({ deviceCode: o.deviceCode }),
    credentials: 'omit',
  });
  if (res.status === 200) {
    const v = (await res.json()) as Record<string, unknown>;
    if (typeof v.access_token !== 'string' || v.access_token === '' || typeof v.expires_in !== 'number' || !Number.isFinite(v.expires_in)) {
      throw new DeviceLoginError('invalid_response', res.status, '', '스태프 토큰 응답이 올바르지 않습니다');
    }
    return { accessToken: v.access_token, expiresIn: v.expires_in };
  }
  if (res.status === 400) {
    const v = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const code = typeof v.error === 'string' ? v.error : '';
    if (code === 'authorization_pending' || code === 'slow_down' || code === 'access_denied' || code === 'expired_token') {
      return Promise.reject(new DeviceLoginError(code, res.status, '', '', typeof v.interval === 'number' ? v.interval : undefined));
    }
    return Promise.reject(new DeviceLoginError('invalid_response', res.status, '', '토큰 오류 응답이 올바르지 않습니다'));
  }
  throw errorOf(res, await problemOf(res));
}

/** 기기 등록(POST /v1/scanner/device-enrollments). 등록 코드를 한 번 쓰고 기기 키 지문(jkt)을 묶는다 */
export async function enrollDevice(o: DeviceLoginOptions & { code: string }): Promise<{ deviceId: string }> {
  const url = `${base(o.origin)}/v1/scanner/device-enrollments`;
  const proof = await dpopProof({ key: o.key, method: 'POST', url, nowMs: (o.now ?? Date.now)() });
  const res = await (o.fetch ?? globalThis.fetch.bind(globalThis))(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', dpop: proof, accept: 'application/json' },
    body: JSON.stringify({ code: o.code }),
    credentials: 'omit',
  });
  if (!res.ok) {
    const p = await problemOf(res);
    if (res.status === 410) throw new DeviceLoginError('expired_token', res.status, p.type, p.title || '등록 코드가 만료·사용됐습니다');
    if (res.status === 429) throw new DeviceLoginError('rate_limited', res.status, p.type, p.title || '등록 시도가 너무 많습니다');
    throw errorOf(res, p);
  }
  const v = (await res.json()) as Record<string, unknown>;
  if (typeof v.deviceId !== 'string' || v.deviceId === '') throw new DeviceLoginError('invalid_response', res.status, '', '기기 등록 응답이 올바르지 않습니다');
  return { deviceId: v.deviceId };
}
