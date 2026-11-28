// CLI가 읽는 운영자 공개키 목록. rb35의 CommanderKey(id·role·publicKey)를 platform의 RunbookOperatorKey로 맞춘다.
import type { KeyObject } from 'node:crypto';
import type { RunbookOperatorKey } from '@peaket/platform';

/** rb35의 CommanderKey와 모양이 같다(순환 import를 피하려고 최소 모양만 둔다) */
export interface CommanderKeyLike {
  readonly id?: string;
  readonly operatorId?: string;
  readonly role: string;
  readonly key?: KeyObject;
  readonly publicKey?: KeyObject;
}

export function operatorKeysOf(keys: ReadonlyMap<string, CommanderKeyLike> | null | undefined): Map<string, RunbookOperatorKey> | null {
  if (!keys) return null;
  const out = new Map<string, RunbookOperatorKey>();
  for (const [id, k] of keys) {
    const publicKey = k.key ?? k.publicKey;
    if (!publicKey) continue;
    const operatorId = k.operatorId ?? k.id ?? id;
    out.set(id, { keyId: k.id ?? id, operatorId, role: k.role === 'commander' ? 'commander' : 'operator', key: publicKey });
  }
  return out;
}

export function keyForSigner(keys: ReadonlyMap<string, CommanderKeyLike> | null | undefined, signer: string): { mapKey: string; key: CommanderKeyLike; operatorId: string } | null {
  if (!keys) return null;
  for (const [mapKey, key] of keys) {
    const operatorId = key.operatorId ?? key.id ?? mapKey;
    if (key.id === signer || operatorId === signer || mapKey === signer) return { mapKey, key, operatorId };
  }
  return null;
}
