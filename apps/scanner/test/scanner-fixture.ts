// F-05-4 스캐너 판정 시험의 도우미(시험 파일이 아니다. node --test 목록에 넣지 않는다).
// QR v1은 정본 offline-gate §3의 바이트 형식대로 이 파일이 직접 만든다(월렛 apps/web의 qr-v1.ts를 읽지 않는다, 계획 §6).
// - 형식 버전(1) ‖ 티켓 ID(16) ‖ keyId(8, SPKI SHA-256 앞 8바이트) ‖ 시각(4, 부호 없는 32비트 빅엔디언 초) ‖ 서명(64, P-256 IEEE P1363)
// - 서명 대상: "PEAKET-QR-v1" ‖ 티켓 ID ‖ keyId ‖ 시각. 글자는 base45(RFC 9285)
// 목록 상태(PackageState)는 계획 §4의 모양을 시험이 직접 만든다(판정 시험이 package-state 구현에 기대지 않게).
import type { ScannerChangesResponse, ScannerPackageResponse, ScannerVersionVector } from '../src/api/client.ts';
import type { EntryState, PackageState, Placement, StoredTicket } from '../src/storage/package-state.ts';

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** RFC 9285 base45 인코딩(두 바이트 → 세 글자, 남은 한 바이트 → 두 글자) */
export function base45(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const n = bytes[i]! * 256 + bytes[i + 1]!;
    out += B45[n % 45]! + B45[Math.floor(n / 45) % 45]! + B45[Math.floor(n / 2025)]!;
  }
  if (bytes.length % 2 === 1) {
    const n = bytes[bytes.length - 1]!;
    out += B45[n % 45]! + B45[Math.floor(n / 45)]!;
  }
  return out;
}

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
export const fromB64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));
export const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
export const uuidBytes = (uuid: string): Uint8Array => fromHex(uuid.replace(/-/g, ''));

export interface WalletKey {
  privateKey: CryptoKey;
  /** 압축 공개키(0x02/0x03 ‖ x) base64url, 목록 keys[].publicKey 꼴 */
  publicKey: string;
  keyIdBytes: Uint8Array;
  /** 8바이트 base64url(11자) */
  keyId: string;
  /** y가 홀수(접두 0x03)인가 */
  yOdd: boolean;
  publicJwk: JsonWebKey;
}

/** 월렛 기기 키를 흉내 낸 시험 키(WebCrypto P-256). 개인키로 시험이 QR을 서명한다 */
export async function walletKey(): Promise<WalletKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const yOdd = (raw[64]! & 1) === 1;
  const compressed = new Uint8Array(33);
  compressed[0] = yOdd ? 0x03 : 0x02;
  compressed.set(raw.slice(1, 33), 1);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const keyIdBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', spki)).slice(0, 8);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64u(compressed), keyIdBytes, keyId: b64u(keyIdBytes), yOdd, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

const HEADER = new TextEncoder().encode('PEAKET-QR-v1');

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

/** QR v1 바이트(93). version·keyIdBytes를 바꾸면 그 값을 싣되 서명은 늘 정본 서명 대상으로 한다 */
export async function qrPayload(key: Pick<WalletKey, 'privateKey' | 'keyIdBytes'>, o: { ticketId: string; timestampSec: number; version?: number; keyIdBytes?: Uint8Array }): Promise<Uint8Array> {
  const keyId = o.keyIdBytes ?? key.keyIdBytes;
  const message = concat(HEADER, uuidBytes(o.ticketId), keyId, u32be(o.timestampSec));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, message));
  return concat(new Uint8Array([o.version ?? 1]), uuidBytes(o.ticketId), keyId, u32be(o.timestampSec), signature);
}

/** QR v1 글자(base45 140자) */
export async function qrText(key: Pick<WalletKey, 'privateKey' | 'keyIdBytes'>, o: { ticketId: string; timestampSec: number; version?: number; keyIdBytes?: Uint8Array }): Promise<string> {
  return base45(await qrPayload(key, o));
}

/** 서명 한 바이트를 바꾼 QR 글자 */
export async function tamperedQrText(key: Pick<WalletKey, 'privateKey' | 'keyIdBytes'>, o: { ticketId: string; timestampSec: number }): Promise<string> {
  const p = await qrPayload(key, o);
  p[p.length - 1] = p[p.length - 1]! ^ 0x01;
  return base45(p);
}

// ---- 목록 상태 ----
export const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f0541';
export const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f0542';
export const OTHER_DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f0543';
export const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f0544';
/** 판정 시험의 기준 QR 시각(초). 2026-11-23T10:00:00Z = 19:00 KST */
export const QR_SEC = Date.parse('2026-11-23T10:00:00.000Z') / 1000;
export const QR_MS = QR_SEC * 1000;

export function vectorOf(over: Partial<ScannerVersionVector> = {}): ScannerVersionVector {
  return { eventId: EVENT, seq: 40, ticketSeq: 11, keySeq: 22, policySeq: 3, placementSeq: 30, flagSeq: 0, issuedAt: '2026-11-23T09:30:00.000Z', maxOfflineMs: 86_400_000, ...over };
}

export function ticketOf(ticketId: string, key: Pick<WalletKey, 'keyId' | 'publicKey'> | undefined, over: Partial<StoredTicket> = {}): StoredTicket {
  return { ticketId, gateZone: '동문', seatLabel: 'R구역 12열 8번', status: 'ACTIVE', statusVersion: 1, keys: key ? [{ keyId: key.keyId, publicKey: key.publicKey }] : [], ...over };
}

/** 계획 §4 PackageState를 직접 만든다 */
export function stateOf(o: {
  tickets: StoredTicket[];
  revoked?: string[];
  entries?: [string, EntryState][];
  reentryAllowed?: boolean;
  placement?: Placement;
  lastSeq?: number;
  versionVector?: ScannerVersionVector;
}): PackageState {
  return {
    eventId: EVENT,
    reentryAllowed: o.reentryAllowed ?? false,
    gateZones: ['동문', '서문'],
    tickets: new Map(o.tickets.map((t) => [t.ticketId, t])),
    revoked: new Set(o.revoked ?? []),
    entries: new Map(o.entries ?? []),
    lastSeq: o.lastSeq ?? 40,
    versionVector: o.versionVector ?? vectorOf(),
    placement: o.placement ?? { gateZone: '동문', mode: 'IN', version: 1 },
    resyncRequired: false,
  };
}

/** openapi ScannerPackage 모양의 목록 응답 */
export function packageOf(o: { tickets: ScannerPackageResponse['tickets']; revokedKeyIds?: string[]; reentryAllowed?: boolean; lastSeq?: number; versionVector?: ScannerVersionVector }): ScannerPackageResponse {
  return {
    eventId: EVENT,
    reentryAllowed: o.reentryAllowed ?? false,
    gateZones: ['동문', '서문'],
    serverTime: '2026-11-23T09:30:00.000Z',
    tickets: o.tickets,
    revokedKeyIds: o.revokedKeyIds ?? [],
    lastSeq: o.lastSeq ?? 40,
    versionVector: o.versionVector ?? vectorOf({ seq: o.lastSeq ?? 40 }),
  };
}

/** openapi ScannerChanges 모양의 한 쪽. lastSeq는 마지막 변경 번호(없으면 after) */
export function pageOf(changes: { seq: number; kind: string; payload: Record<string, unknown> }[], after = 40): ScannerChangesResponse {
  const lastSeq = changes.length ? Math.max(...changes.map((c) => c.seq)) : after;
  return { changes, lastSeq, hasMore: false, versionVector: vectorOf({ seq: lastSeq }) };
}

/** 조건이 될 때까지 차례를 넘긴다(시간을 기다리지 않는다: setImmediate로 대기 중인 약속을 돌린다) */
export async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** 손으로 풀어 주는 약속 */
export function deferred<T = void>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
