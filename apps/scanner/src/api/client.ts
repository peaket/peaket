// 스캐너 API 클라이언트(SCR-033·SCR-035, offline-gate §6.1·§6.2).
// - 스태프 토큰은 `Authorization: DPoP <토큰>`, 증명은 `DPoP` 헤더다(RFC 9449).
// - 교차 출처라 자격 증명(쿠키·인증서)을 싣지 않는다(`credentials: 'omit'`, ADR-0065 결정 10).
// - 서버 Problem(type·title)을 ScannerApiError로 옮겨 화면이 상태를 가른다.
import { dpopProof, type DpopKey } from './dpop';

export interface ScannerShiftResponse {
  serverTime: string;
  eventId: string;
  reentryAllowed: boolean;
  placement: { gateZone: string; mode: 'IN' | 'OUT' };
  packageSeq: number;
  role: 'gate_staff' | 'gate_lead';
  proxy: boolean;
  device: { deviceId: string; name: string; status: 'ACTIVE' | 'REVOKED' | 'RETIRED'; credentialType: 'DEVICE_KEY' | 'MTLS_CERT'; enrolled: boolean; lastSeenAt?: string; mtls: boolean };
  assignment: { assignmentId: string; role: 'gate_staff' | 'gate_lead'; validFrom: string; validUntil: string; proxy: boolean };
  eventWindows?: { salesOpensAt?: string; salesEndsAt?: string; entryOpensAt?: string; entryClosesAt?: string; endsAt?: string };
  package: { seq: number; issuedAt: string; maxOfflineMs: number; reportedAt?: string; ageMs?: number; reportedPackageSeq?: number; clockOffsetMs?: number; pendingUploads?: number; stale: boolean };
  versionVector: ScannerVersionVector;
  auth: { deviceProof: 'DPOP' | 'MTLS'; staffSession: boolean };
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

export class ScannerApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
  ) {
    super(title || `스캐너 API 오류 ${status}`);
    this.name = 'ScannerApiError';
  }
}

export interface ScannerApiOptions {
  origin: string;
  key: DpopKey;
  token: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ScannerApi {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(private readonly o: ScannerApiOptions) {
    this.#origin = o.origin.replace(/\/+$/, '');
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = o.now ?? Date.now;
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

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#send(method, path, body);
    return (await res.json()) as T;
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.#origin}${path}`;
    const proof = await dpopProof({ key: this.o.key, method, url, token: this.o.token, nowMs: this.#now() });
    const headers: Record<string, string> = {
      authorization: `DPoP ${this.o.token}`,
      dpop: proof,
      accept: 'application/json',
    };
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
    throw new ScannerApiError(res.status, type, title);
  }
}
