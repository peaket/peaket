// 스캐너 API 클라이언트(SCR-033·SCR-035, offline-gate §6.1·§6.2·§6.5).
// - 스태프 토큰은 `Authorization: DPoP <토큰>`, 증명은 `DPoP` 헤더다(RFC 9449). 토큰이 없으면 기기 증명만 보낸다(ath 없음).
// - 교차 출처라 자격 증명(쿠키·인증서)을 싣지 않는다(`credentials: 'omit'`, ADR-0065 결정 10).
// - 서버 Problem(type·title)을 ScannerApiError로 옮기고, 401의 WWW-Authenticate error를 authError로 싣는다.
// - Node 시험(node --test)이 그대로 읽는 파일이다: 매개변수 속성 없이, 상대 가져오기는 .ts 확장자로 쓴다.
import { dpopProof, type DpopKey } from './dpop.ts';

export interface ScannerShiftResponse {
  serverTime: string;
  eventId: string;
  reentryAllowed: boolean;
  placement: { gateZone: string; mode: 'IN' | 'OUT'; version?: number };
  packageSeq: number;
  role: 'gate_staff' | 'gate_lead';
  proxy: boolean;
  device: { deviceId: string; name: string; status: 'ACTIVE' | 'REVOKED' | 'RETIRED'; credentialType: 'DEVICE_KEY' | 'MTLS_CERT'; enrolled: boolean; lastSeenAt?: string; mtls: boolean };
  assignment: { assignmentId: string; role: 'gate_staff' | 'gate_lead'; validFrom: string; validUntil: string; proxy: boolean };
  eventWindows?: { salesOpensAt?: string; salesEndsAt?: string; entryOpensAt?: string; entryClosesAt?: string; endsAt?: string };
  package: { seq: number; issuedAt: string; maxOfflineMs: number; reportedAt?: string; ageMs?: number; reportedPackageSeq?: number; clockOffsetMs?: number; pendingUploads?: number; stale: boolean };
  versionVector: ScannerVersionVector;
  auth: { deviceProof: 'DPOP' | 'MTLS'; staffSession: boolean; confirmation: 'jkt' | 'x5t#S256' };
}

export interface ScannerVersionVector {
  eventId: string;
  seq: number;
  ticketSeq: number;
  keySeq: number;
  policySeq: number;
  placementSeq: number;
  flagSeq: number;
  issuedAt: string;
  maxOfflineMs: number;
}

export interface ScannerPackageTicket {
  ticketId: string;
  gateZone: string;
  seatLabel: string;
  status: string;
  keys: { keyId: string; publicKey: string }[];
  scanState?: { lastDirection: 'IN' | 'OUT'; lastAt: string; lastDeviceName?: string; lastGateZone?: string };
}

export interface ScannerPackageResponse {
  eventId: string;
  reentryAllowed: boolean;
  gateZones: string[];
  serverTime: string;
  tickets: ScannerPackageTicket[];
  revokedKeyIds: string[];
  lastSeq: number;
  versionVector: ScannerVersionVector;
  minAppVersion?: string;
}

export interface ScannerChangesResponse {
  changes: { seq: number; kind: string; payload: Record<string, unknown> }[];
  lastSeq: number;
  hasMore: boolean;
  versionVector: ScannerVersionVector;
  minAppVersion?: string;
}

export interface GateFlagView {
  flagId: string;
  ticketId: string;
  seatLabel: string;
  gateZone: string;
  kind: string;
  awareness: string;
  status: string;
  createdAt: string;
}

export interface GateStatusDeviceView {
  deviceId: string;
  name: string;
  placement?: { gateZone: string; mode: 'IN' | 'OUT'; version?: number };
  ready: boolean;
  packageSeq?: number;
  lastSyncAt?: string;
  pendingUploads: number;
  staffLoggedIn?: boolean;
}
export interface GateStatusView {
  devices: GateStatusDeviceView[];
  entriesByZone: Record<string, number>;
  rejectsByReason: Record<string, number>;
  openFlags: number;
  boothCount: number;
  overrideCount: number;
  entryClosedAt?: string;
}
export interface OverridePassView {
  scanId: string;
  at: string;
  ticketId: string;
  seatLabel: string;
  reason: string;
  note?: string;
  reviewStatus: 'WAITING' | 'OK' | 'SUSPECT' | 'UNDETERMINED';
}

/** openapi ScanEvent와 같은 모양(업로드 본문). 스캐너 앱이 큐에 싣는 값이다 */
export interface ScanEventBody {
  id: string;
  eventId: string;
  ticketId: string;
  scannerSessionId: string;
  direction: 'IN' | 'OUT';
  method: 'QR' | 'OVERRIDE' | 'VERIFY';
  result: 'PASS' | 'REJECT' | 'CHECK';
  reason?: string;
  overrideNote?: string;
  gateZone?: string;
  keyId?: string;
  qrTimestamp?: string;
  scannedAtDevice: string;
  clockOffsetMs?: number;
  knownSeq: number;
  deviceSeq: number;
  versionVector?: ScannerVersionVector;
}

export type ScannerAuthError = 'invalid_token' | 'invalid_dpop_proof';

export class ScannerApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  /** 401의 WWW-Authenticate(DPoP) error. 없으면 undefined */
  readonly authError?: ScannerAuthError;

  constructor(status: number, type: string, title: string, authError?: ScannerAuthError) {
    super(title || `스캐너 API 오류 ${status}`);
    this.name = 'ScannerApiError';
    this.status = status;
    this.type = type;
    this.title = title;
    if (authError !== undefined) this.authError = authError;
  }
}

function authErrorOf(header: string | null): ScannerAuthError | undefined {
  if (!header) return undefined;
  const m = /\berror="([^"]*)"/.exec(header);
  if (!m) return undefined;
  return m[1] === 'invalid_token' || m[1] === 'invalid_dpop_proof' ? m[1] : undefined;
}

export interface ScannerApiOptions {
  origin: string;
  key: DpopKey;
  /** 없으면 Authorization 머리를 싣지 않고 증명에 ath도 넣지 않는다(해제·만료 뒤 업로드) */
  token?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ScannerApi {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #token: string | undefined;
  readonly #key: DpopKey;

  constructor(o: ScannerApiOptions) {
    this.#origin = o.origin.replace(/\/+$/, '');
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = o.now ?? Date.now;
    this.#token = o.token;
    this.#key = o.key;
  }

  shift(): Promise<ScannerShiftResponse> {
    return this.#json<ScannerShiftResponse>('GET', '/v1/scanner/shift');
  }

  async readiness(body: { packageSeq: number; clockOffsetMs: number; pendingUploads: number }): Promise<void> {
    await this.#send('PUT', '/v1/scanner/shift/readiness', body);
  }

  package(eventId: string): Promise<ScannerPackageResponse> {
    return this.#json<ScannerPackageResponse>('GET', `/v1/scanner/events/${encodeURIComponent(eventId)}/package`);
  }

  changes(eventId: string, after: number, limit?: number): Promise<ScannerChangesResponse> {
    const q = new URLSearchParams({ after: String(after) });
    if (limit !== undefined) q.set('limit', String(limit));
    return this.#json<ScannerChangesResponse>('GET', `/v1/scanner/events/${encodeURIComponent(eventId)}/changes?${q.toString()}`);
  }

  async flags(eventId: string): Promise<GateFlagView[]> {
    const page = await this.#json<{ items?: GateFlagView[] }>('GET', `/v1/scanner/events/${encodeURIComponent(eventId)}/flags`);
    return page.items ?? [];
  }

  async uploadScans(scans: readonly Record<string, unknown>[]): Promise<{ acceptedIds: string[]; resyncRequired: boolean; staleIds: string[] }> {
    return this.#json('POST', '/v1/scanner/scans', scans);
  }

  /** 큐 비움 보고(openapi putScannerEventQueueReport). 서버는 204 빈 본문이라 JSON을 읽지 않는다 */
  async queueReport(eventId: string, pendingUploads: number): Promise<void> {
    await this.#send('PUT', `/v1/scanner/queue-reports/${encodeURIComponent(eventId)}`, { pendingUploads });
  }

  devices(eventId: string): Promise<GateStatusView> {
    return this.#json<GateStatusView>('GET', `/v1/scanner/events/${encodeURIComponent(eventId)}/devices`);
  }

  async resolveFlag(flagId: string, status: 'OK' | 'SUSPECT' | 'UNDETERMINED', note?: string): Promise<void> {
    await this.#send('POST', `/v1/scanner/flags/${encodeURIComponent(flagId)}/resolution`, { status, ...(note !== undefined ? { note } : {}) });
  }

  boothAuthorization(boothCode: string): Promise<{ ticketId: string; seatLabel: string; allowUntil: string }> {
    return this.#json('POST', '/v1/scanner/booth-authorizations', { boothCode });
  }

  overridePasses(eventId: string): Promise<{ items: OverridePassView[] }> {
    return this.#json('GET', `/v1/scanner/events/${encodeURIComponent(eventId)}/override-passes`);
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#send(method, path, body);
    return (await res.json()) as T;
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.#origin}${path}`;
    const token = this.#token;
    const proof = await dpopProof({ key: this.#key, method, url, ...(token !== undefined ? { token } : {}), nowMs: this.#now() });
    const headers: Record<string, string> = {
      dpop: proof,
      accept: 'application/json',
    };
    if (token !== undefined) headers.authorization = `DPoP ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.#fetch(url, {
      method,
      headers,
      credentials: 'omit',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok) return res;
    let type = 'about:blank';
    let title = `스캐너 API 오류 ${res.status}`;
    try {
      const p = (await res.json()) as { type?: string; title?: string };
      if (typeof p.type === 'string') type = p.type.replace(/^https:\/\/peaket\.example\/problems\//, '');
      if (typeof p.title === 'string') title = p.title;
    } catch {
      // 본문이 Problem이 아니면 상태만 남긴다
    }
    const auth = authErrorOf(res.headers.get('www-authenticate'));
    throw new ScannerApiError(res.status, type, title, auth);
  }
}
