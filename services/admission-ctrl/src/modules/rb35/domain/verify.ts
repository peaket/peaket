// RB-35 묶음의 서명 확인(ADR-0239 결정 7). 받는 쪽(리더)과 CLI가 같은 코드로 본다.
import { type KeyObject, verify } from 'node:crypto';
import { BUNDLE_VALID_MS, bundleBytes, ISSUED_AT_SKEW_MS, type SignedBundle } from './bundle.js';

export interface CommanderKey {
  id: string;
  role: string;
  key: KeyObject;
}

export type VerifyRejection = 'window' | 'expired' | 'not_yet_valid' | 'unknown_signer' | 'not_commander' | 'bad_signature' | 'two_commanders';
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyRejection };

const COMMANDER = 'commander';
const MIN_COMMANDERS = 2;

/** 적용 때의 확인: 유효 시간과 서명 */
export function verifySigned(s: SignedBundle, keys: ReadonlyMap<string, CommanderKey>, nowMs: number): VerifyResult {
  const b = s.bundle;
  if (b.expiresAt <= b.issuedAt || b.expiresAt - b.issuedAt > BUNDLE_VALID_MS) return { ok: false, reason: 'window' };
  if (nowMs > b.expiresAt) return { ok: false, reason: 'expired' };
  if (b.issuedAt > nowMs + ISSUED_AT_SKEW_MS) return { ok: false, reason: 'not_yet_valid' };
  return verifySignatures(s, keys);
}

/** 서명만 본다(저장한 묶음을 게시 직전에 다시 볼 때. 만료는 적용 때만 본다, ADR-0239 결정 15) */
export function verifySignatures(s: SignedBundle, keys: ReadonlyMap<string, CommanderKey>): VerifyResult {
  const bytes = bundleBytes(s.bundle);
  const commanders = new Set<string>();
  // 하나라도 틀리거나 commander가 아니면 묶음 전체를 거절한다
  for (const entry of s.signatures) {
    const key = keys.get(entry.signer);
    if (!key) return { ok: false, reason: 'unknown_signer' };
    if (key.role !== COMMANDER) return { ok: false, reason: 'not_commander' };
    let good = false;
    try {
      good = verify('sha256', bytes, { key: key.key, dsaEncoding: 'der' }, Buffer.from(entry.sig, 'base64'));
    } catch {
      good = false;
    }
    if (!good) return { ok: false, reason: 'bad_signature' };
    commanders.add(entry.signer);
  }
  if (commanders.size < MIN_COMMANDERS) return { ok: false, reason: 'two_commanders' };
  return { ok: true };
}
