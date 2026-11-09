// 운영자 공개키 목록(ADR-0239 결정 7, secrets-and-keys '비상 런북 운영자 서명 키'). 배포에 든다(비밀이 아니다).
// 형식: [{ "id": "commander-a", "role": "commander", "publicKey": "<SPKI DER base64>" }, ...]. KMS GetPublicKey의 값을 그대로 쓴다.
import { createPublicKey, type KeyObject } from 'node:crypto';
import type { CommanderKey } from '../domain/verify.js';

export const COMMANDER_KEYS_ENV = 'PEAKET_RUNBOOK_COMMANDER_KEYS';

function publicKeyOf(id: string, b64: unknown): KeyObject {
  if (typeof b64 !== 'string') throw new Error(`${COMMANDER_KEYS_ENV}의 ${id}: publicKey가 없다`);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error(`${COMMANDER_KEYS_ENV}의 ${id}: 공개키를 읽지 못했다`);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error(`${COMMANDER_KEYS_ENV}의 ${id}: P-256 공개키가 아니다`);
  return key;
}

export function commanderKeysFromEnv(raw: string): Map<string, CommanderKey> {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error(`${COMMANDER_KEYS_ENV}가 JSON이 아니다`);
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${COMMANDER_KEYS_ENV}는 비어 있지 않은 배열이다`);
  const out = new Map<string, CommanderKey>();
  const seen = new Map<string, string>();
  for (const e of list as { id?: unknown; role?: unknown; publicKey?: unknown }[]) {
    if (typeof e?.id !== 'string' || e.id === '' || typeof e.role !== 'string' || e.role === '') throw new Error(`${COMMANDER_KEYS_ENV}의 항목에 id·role이 없다`);
    if (out.has(e.id)) throw new Error(`${COMMANDER_KEYS_ENV}에 같은 id가 있다: ${e.id}`);
    const key = publicKeyOf(e.id, e.publicKey);
    // 압축·비압축 SPKI는 바이트가 달라도 같은 점이다. 좌표로 견준다
    const jwk = key.export({ format: 'jwk' });
    const fp = `${jwk.x}.${jwk.y}`;
    const dup = seen.get(fp);
    if (dup) throw new Error(`${COMMANDER_KEYS_ENV}에 같은 공개키가 있다(${dup}·${e.id})`);
    seen.set(fp, e.id);
    out.set(e.id, { id: e.id, role: e.role, key });
  }
  return out;
}

const TEST_ENVS = ['local', 'ci', 'demo'];

/** 시작 파일: local·ci·demo는 없어도 되고(일꾼을 켜지 않는다), 그 밖은 없으면 시작하지 않는다 */
export function commanderKeysFromProcess(env: Record<string, string | undefined>): Map<string, CommanderKey> | null {
  const raw = env[COMMANDER_KEYS_ENV];
  const testEnv = TEST_ENVS.includes(env.PEAKET_ENV ?? 'prod');
  if (!raw) {
    if (testEnv) return null;
    throw new Error(`${COMMANDER_KEYS_ENV}가 없다(RB-35 commander 공개키 목록)`);
  }
  const keys = commanderKeysFromEnv(raw);
  // 운영에서 commander가 두 명 미만이면 어떤 묶음도 통과하지 못한다. 시작에서 알린다
  if (!testEnv && [...keys.values()].filter((k) => k.role === 'commander').length < 2) throw new Error(`${COMMANDER_KEYS_ENV}에 commander가 두 명 이상이어야 한다`);
  return keys;
}
