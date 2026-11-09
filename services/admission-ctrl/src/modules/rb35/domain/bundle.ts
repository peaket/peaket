// RB-35 명령 묶음(ADR-0239 결정 6·7, ADR-0053 결정 11의 서명 묶음 형식).
// 서명 대상은 RFC 8785로 정규화한 바이트다. 묶음에는 숫자로 안전한 정수만 쓰므로 정수·문자열·참거짓·null·배열·객체만 받는다.
import { createHash } from 'node:crypto';
import type { ShuffleGroup } from '../../batch/index.js';

export const RB35_COMMANDS = ['rb35.wait', 'rb35.emergency-shuffle', 'rb35.recommit'] as const;
export type Rb35Command = (typeof RB35_COMMANDS)[number];

/** 묶음의 유효 시간 5분(ADR-0053 결정 11) */
export const BUNDLE_VALID_MS = 5 * 60_000;
/** issuedAt이 지금보다 앞서도 받는 시계 차이 30초 [가정] */
export const ISSUED_AT_SKEW_MS = 30_000;
/** 더 기다리기의 길이(초) [가정] */
export const EXTEND_MIN_SEC = 30;
export const EXTEND_MAX_SEC = 600;
/** 공개 사유 길이 [가정] */
export const REASON_MAX = 200;
/** 다시 공시한 라운드는 적용 때 30초 [가정] 넘게 남아 있어야 한다(머클 루트 공시 여유) */
export const RECOMMIT_MIN_LEAD_MS = 30_000;
/** 멈추기 전 다시 공시에서 지금 라운드를 '이미 공개됨'으로 보는 여유 3초 [가정](시계 차이) */
export const ROUND_PUBLIC_MARGIN_MS = 3_000;

export interface Rb35Params {
  reason: string;
  /** 서명 때의 stop:{구간} 값 그대로. 멈추지 않았으면 null */
  stop: string | null;
  commit: string;
  round: number;
  extendSec?: number;
  newRound?: number;
}

export interface Rb35Bundle {
  v: 1;
  commandId: string;
  command: Rb35Command;
  params: Rb35Params;
  target: { eventId: string; group: ShuffleGroup };
  issuedAt: number;
  expiresAt: number;
}

export interface SignatureEntry {
  signer: string;
  sig: string;
}

export interface SignedBundle {
  bundle: Rb35Bundle;
  signatures: SignatureEntry[];
}

/** RFC 8785(JCS)의 정규화. 키는 UTF-16 코드 단위 순서, 문자열·수는 ES 직렬화 규칙(JSON.stringify와 같다) */
export function canonicalize(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError(`묶음의 수는 안전한 정수만 쓴다: ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`묶음에 쓸 수 없는 값이다: ${typeof v}`);
}

export const bundleBytes = (b: Rb35Bundle): Buffer => Buffer.from(canonicalize(b), 'utf8');
export const bundleDigest = (b: Rb35Bundle): Buffer => createHash('sha256').update(bundleBytes(b)).digest();

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMMIT = /^[0-9a-f]{64}$/;
const SIGNER = /^[A-Za-z0-9._@-]{1,128}$/;
const STOP = /^\d{1,16}:[a-z_]{1,32}$/;
/** 한 줄 문자만 받는다(제어 문자·줄 구분자는 공개 사유에 쓸 수 없다) */
const hasControl = (t: string): boolean => {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function parseParams(command: Rb35Command, v: unknown): Rb35Params | null {
  if (!isObject(v)) return null;
  const { reason, stop, commit, round, extendSec, newRound, ...rest } = v;
  if (Object.keys(rest).length > 0) return null;
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > REASON_MAX || hasControl(reason)) return null;
  if (stop !== null && (typeof stop !== 'string' || !STOP.test(stop))) return null;
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return null;
  if (!isInt(round) || round < 1) return null;
  const out: Rb35Params = { reason, stop: stop as string | null, commit, round };
  if (command === 'rb35.wait') {
    if (!isInt(extendSec) || extendSec < EXTEND_MIN_SEC || extendSec > EXTEND_MAX_SEC || newRound !== undefined) return null;
    return { ...out, extendSec };
  }
  if (command === 'rb35.recommit') {
    if (!isInt(newRound) || newRound < 1 || extendSec !== undefined) return null;
    return { ...out, newRound };
  }
  if (extendSec !== undefined || newRound !== undefined) return null;
  return out;
}

/** 정해진 칸만 있는가(모르는 칸은 서명 대상이 아니거나 해석이 갈릴 수 있어 받지 않는다) */
const onlyKeys = (o: Record<string, unknown>, ...allowed: string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

/** 전달받은 값의 모양을 본다. 틀리면 null */
export function parseSigned(v: unknown): SignedBundle | null {
  if (!isObject(v) || !onlyKeys(v, 'bundle', 'signatures') || !isObject(v.bundle) || !Array.isArray(v.signatures)) return null;
  const b = v.bundle;
  if (!onlyKeys(b, 'v', 'commandId', 'command', 'params', 'target', 'issuedAt', 'expiresAt')) return null;
  if (b.v !== 1 || typeof b.commandId !== 'string' || !UUID7.test(b.commandId)) return null;
  if (typeof b.command !== 'string' || !(RB35_COMMANDS as readonly string[]).includes(b.command)) return null;
  const command = b.command as Rb35Command;
  const params = parseParams(command, b.params);
  if (!params) return null;
  if (!isObject(b.target) || !onlyKeys(b.target, 'eventId', 'group') || typeof b.target.eventId !== 'string' || !EVENT_ID.test(b.target.eventId)) return null;
  const group = b.target.group;
  if (group !== 'lobby' && group !== 1) return null;
  if (!isInt(b.issuedAt) || !isInt(b.expiresAt)) return null;
  const signatures: SignatureEntry[] = [];
  for (const s of v.signatures as unknown[]) {
    if (!isObject(s) || !onlyKeys(s, 'signer', 'sig') || typeof s.signer !== 'string' || !SIGNER.test(s.signer) || typeof s.sig !== 'string') return null;
    signatures.push({ signer: s.signer, sig: s.sig });
  }
  return { bundle: { v: 1, commandId: b.commandId, command, params, target: { eventId: b.target.eventId, group }, issuedAt: b.issuedAt, expiresAt: b.expiresAt }, signatures };
}
