// RB-35 시험의 공용 도구: 운영자 키를 만들고 묶음에 서명한다(KMS 대신 같은 ES256 서명, ADR-0239 결정 7).
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { bundleBytes, type CommanderKey, type Rb35Bundle, type Rb35Params, type SignedBundle } from '../src/modules/rb35/index.js';

export interface Op {
  id: string;
  role: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function operator(id: string, role = 'commander'): Op {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { id, role, privateKey, publicKey };
}

export const keysOf = (...ops: Op[]): Map<string, CommanderKey> => new Map(ops.map((o) => [o.id, { id: o.id, role: o.role, key: o.publicKey }]));

/** 공개키 목록 설정값(PEAKET_RUNBOOK_COMMANDER_KEYS) */
export const keysEnv = (...ops: Op[]): string => JSON.stringify(ops.map((o) => ({ id: o.id, role: o.role, publicKey: o.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })));

export const signAs = (o: Op, b: Rb35Bundle): { signer: string; sig: string } => ({ signer: o.id, sig: sign('sha256', bundleBytes(b), { key: o.privateKey, dsaEncoding: 'der' }).toString('base64') });

export const signedBy = (b: Rb35Bundle, ...ops: Op[]): SignedBundle => ({ bundle: b, signatures: ops.map((o) => signAs(o, b)) });

export const NOW = 1_762_000_000_000;
export const CMD_ID = '01957f5a-0000-7000-8000-000000000001';

export function bundleOf(o: Partial<Omit<Rb35Bundle, 'params'>> & { params?: Partial<Rb35Params> } = {}): Rb35Bundle {
  const { params, ...rest } = o;
  return {
    v: 1,
    commandId: CMD_ID,
    command: 'rb35.emergency-shuffle',
    target: { eventId: 'evt-rb35', group: 'lobby' },
    issuedAt: NOW,
    expiresAt: NOW + 300_000,
    ...rest,
    params: { reason: '공개 중계가 모두 응답하지 않음', stop: `${NOW - 1_000}:beacon`, commit: 'a'.repeat(64), round: 8_000_000, ...params },
  };
}

/** 서명한 비상 표시(공시 기록 emergency:{구간}이 읽히는 모양, ADR-0239 결정 15) */
export function emergencyMark(i: { eventId: string; group: 'lobby' | 1; commit: string; round: number; stop: 'beacon' | 'stale_round' | 'late_commit' | 'late_root'; atMs?: number; ops: Op[] }) {
  const reason = '공개 중계가 모두 응답하지 않음';
  const bundle = bundleOf({ command: 'rb35.emergency-shuffle', target: { eventId: i.eventId, group: i.group }, params: { reason, stop: `${NOW}:${i.stop}`, commit: i.commit, round: i.round } });
  return { atMs: i.atMs ?? 5, stopReason: i.stop, reason, signed: signedBy(bundle, ...i.ops) };
}

/** 서명한 다시 공시 이력 한 줄 */
export function recommitMark(i: { eventId: string; group: 'lobby' | 1; commit: string; prev: number; round: number; atMs: number; ops: Op[] }) {
  const reason = '오픈 시각 변경';
  const bundle = bundleOf({ command: 'rb35.recommit', target: { eventId: i.eventId, group: i.group }, params: { reason, stop: null, commit: i.commit, round: i.prev, newRound: i.round } });
  return { atMs: i.atMs, prev: i.prev, round: i.round, reason, signed: signedBy(bundle, ...i.ops) };
}
