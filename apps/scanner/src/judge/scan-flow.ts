// 판정 → 기기 일련번호 → 스캔 큐 → 입장 상태 → 저장의 차례(offline-gate §6.4 '쓰는 차례', 계획 §3).
// 큐 쓰기는 strict다(ScanQueue.put이 트랜잭션 complete 뒤에 끝난다). 판정 중 예외는 다시 찍기다.
import type { EntryState, PackageState } from '../storage/package-state.ts';
import { withLocalEntry } from '../storage/package-state.ts';
import type { PackageStore } from '../storage/package-store.ts';
import type { ScanQueue, ScanQueueRecord } from '../storage/scan-queue.ts';
import { judgeScan, type JudgeOutcome } from './judge.ts';
import { verifyQrSignature } from './qr-v1.ts';

/** openapi ScanEvent와 같은 칸(필요한 것만). versionVector는 판정 때의 저장 벡터다 */
export interface ScanEventBody {
  id: string;
  eventId: string;
  ticketId: string;
  scannerSessionId: string;
  direction: 'IN' | 'OUT';
  method: 'QR';
  result: 'PASS' | 'REJECT' | 'CHECK';
  reason?: string;
  gateZone: string;
  keyId?: string;
  qrTimestamp?: string;
  scannedAtDevice: string;
  clockOffsetMs: number;
  knownSeq: number;
  deviceSeq: number;
  versionVector: PackageState['versionVector'];
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** UUIDv7: 시각 48비트 + 판 7 + 변형 10 + 난수 62비트 */
export function uuidV7(nowMs: number, random: (n: number) => Uint8Array = randomBytes): string {
  const b = new Uint8Array(16);
  b.set(random(16).slice(0, 16));
  let t = Math.floor(nowMs);
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function fromB64u(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** 스태프 토큰 내용의 sid. 서명은 보지 않는다(서버가 본다). 없거나 깨지면 undefined */
export function scannerSessionIdOf(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]!))) as Record<string, unknown>;
    return typeof payload.sid === 'string' ? payload.sid : undefined;
  } catch {
    return undefined;
  }
}

/** 판정 결과 하나를 openapi ScanEvent 본문으로 만든다. 1단계 거부에는 부르지 않는다 */
export function scanEventOf(i: {
  id: string;
  outcome: Exclude<JudgeOutcome, { result: 'RETRY' }>;
  state: PackageState;
  deviceSeq: number;
  scannerSessionId: string;
  nowMs: number;
  clockOffsetMs: number;
}): ScanEventBody {
  const o = i.outcome;
  return {
    id: i.id,
    eventId: i.state.eventId,
    ticketId: o.ticketId ?? '',
    scannerSessionId: i.scannerSessionId,
    direction: o.direction,
    method: 'QR',
    result: o.result,
    ...('reason' in o && o.reason !== undefined ? { reason: o.reason } : {}),
    gateZone: i.state.placement.gateZone,
    ...(o.keyId !== undefined ? { keyId: o.keyId } : {}),
    ...(o.qrTimestampMs !== undefined ? { qrTimestamp: new Date(o.qrTimestampMs).toISOString() } : {}),
    scannedAtDevice: new Date(i.nowMs + i.clockOffsetMs).toISOString(),
    clockOffsetMs: i.clockOffsetMs,
    knownSeq: i.state.lastSeq,
    deviceSeq: i.deviceSeq,
    versionVector: i.state.versionVector,
  };
}

/** 1단계 거부는 큐에 쓰지 않는다(티켓 ID가 없다). 판정 화면만 보인다 */
function firstStage(o: JudgeOutcome): boolean {
  return o.result === 'REJECT' && (o.reason === 'INVALID_QR' || o.reason === 'UNSUPPORTED_VERSION');
}

/**
 * 한 번의 스캔. 던지지 않는다.
 * - 다시 찍기·1단계 거부: recorded 거짓, 큐에 쓰지 않고 상태 그대로
 * - deviceSeq를 올리지 못하면 다시 찍기
 * - 큐 쓰기가 실패하면 다시 찍기
 * - 통과면 입장 상태를 바꾸고 저장한다. 저장이 실패해도 기록은 큐에 있으므로 판정 화면은 그대로다(persisted 거짓)
 */
export async function runScan(d: {
  raw: string;
  state: PackageState;
  store: PackageStore;
  queue: ScanQueue;
  nowMs: number;
  clockOffsetMs: number;
  scannerSessionId: string;
  id?: () => string;
  verify?: typeof verifyQrSignature;
}): Promise<{ outcome: JudgeOutcome; state: PackageState; recorded: boolean; persisted: boolean }> {
  let outcome: JudgeOutcome;
  try {
    outcome = await judgeScan({
      raw: d.raw,
      state: d.state,
      nowMs: d.nowMs,
      clockOffsetMs: d.clockOffsetMs,
      ...(d.verify ? { verify: d.verify } : {}),
    });
  } catch {
    return { outcome: { result: 'RETRY' }, state: d.state, recorded: false, persisted: false };
  }
  if (outcome.result === 'RETRY' || firstStage(outcome)) return { outcome, state: d.state, recorded: false, persisted: false };

  let deviceSeq: number;
  try {
    deviceSeq = await d.store.nextDeviceSeq();
  } catch {
    return { outcome: { result: 'RETRY' }, state: d.state, recorded: false, persisted: false };
  }
  const id = d.id?.() ?? uuidV7(d.nowMs);
  const body = scanEventOf({ id, outcome, state: d.state, deviceSeq, scannerSessionId: d.scannerSessionId, nowMs: d.nowMs, clockOffsetMs: d.clockOffsetMs });
  const record: ScanQueueRecord = {
    id,
    eventId: body.eventId,
    ticketId: body.ticketId,
    keyId: body.keyId ?? '',
    scannedAtMs: d.nowMs + d.clockOffsetMs,
    payload: JSON.stringify(body),
    attempts: 0,
    nextAttemptAtMs: d.nowMs,
  };
  try {
    await d.queue.put(record);
  } catch {
    return { outcome: { result: 'RETRY' }, state: d.state, recorded: false, persisted: false };
  }

  let nextState = d.state;
  let persisted = true;
  if (outcome.result === 'PASS') {
    const entry: EntryState = {
      lastDirection: outcome.direction,
      lastAtMs: d.nowMs + d.clockOffsetMs,
      gateZone: d.state.placement.gateZone,
      source: 'LOCAL',
    };
    nextState = withLocalEntry(d.state, outcome.ticketId, entry);
    try {
      await d.store.save(nextState);
    } catch {
      persisted = false;
    }
  }
  return { outcome, state: nextState, recorded: true, persisted };
}

/**
 * 같은 QR 글자가 판정 뒤 windowMs 안에 다시 읽히면 버린다(카메라가 같은 화면을 여러 번 읽는다).
 * 버릴 것이면 true. 다른 글자는 바로 판정한다.
 */
export function createSameQrFilter(windowMs = 3_000): (raw: string, nowMs: number) => boolean {
  let lastRaw: string | undefined;
  let lastAtMs = 0;
  return (raw: string, nowMs: number) => {
    if (lastRaw === raw && nowMs - lastAtMs < windowMs) return true;
    lastRaw = raw;
    lastAtMs = nowMs;
    return false;
  };
}
