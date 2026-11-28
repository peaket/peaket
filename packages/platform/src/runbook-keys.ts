// 런북 운영자 공개키 목록(F-02-7, 계획 6.5). 배포에 드는 공개 값이다.
// 형식: [{ "id": "commander-a", "operatorId": "commander-a", "role": "commander", "publicKey": "<SPKI DER base64>" }]
import { createPublicKey, type KeyObject } from 'node:crypto';
import { isProductionLikeEnv } from './config.js';
import { type RunbookOperatorKey, type RunbookOperatorRole, type RunbookService } from './runbook-bundle.js';
import { MemoryRunbookReplayGuard } from './runbook-replay.js';
import type { RunbookGateConfig, RunbookSecurityEvent } from './runbook-control.js';

export const RUNBOOK_KEYS_ENV = 'PEAKET_RUNBOOK_COMMANDER_KEYS';

function publicKeyOf(id: string, b64: unknown): KeyObject {
  if (typeof b64 !== 'string' || b64 === '') throw new Error(`${RUNBOOK_KEYS_ENV}의 ${id}: publicKey가 없다`);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error(`${RUNBOOK_KEYS_ENV}의 ${id}: 공개키를 읽지 못했다`);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error(`${RUNBOOK_KEYS_ENV}의 ${id}: P-256 공개키가 아니다`);
  return key;
}

/** 공개키 목록을 읽는다. 같은 키 ID·같은 운영자·같은 공개키가 두 번이면 시작하지 않는다 */
export function runbookOperatorKeysFromEnv(raw: string): Map<string, RunbookOperatorKey> {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error(`${RUNBOOK_KEYS_ENV}가 JSON이 아니다`);
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${RUNBOOK_KEYS_ENV}는 비어 있지 않은 배열이다`);
  const out = new Map<string, RunbookOperatorKey>();
  const operators = new Set<string>();
  const fingerprints = new Set<string>();
  for (const e of list as { id?: unknown; operatorId?: unknown; role?: unknown; publicKey?: unknown }[]) {
    if (typeof e?.id !== 'string' || e.id === '' || typeof e.role !== 'string' || e.role === '') throw new Error(`${RUNBOOK_KEYS_ENV}의 항목에 id·role이 없다`);
    if (e.role !== 'commander' && e.role !== 'operator') throw new Error(`${RUNBOOK_KEYS_ENV}의 ${e.id}: role은 commander나 operator다`);
    if (out.has(e.id)) throw new Error(`${RUNBOOK_KEYS_ENV}에 같은 id가 있다: ${e.id}`);
    const operatorId = typeof e.operatorId === 'string' && e.operatorId !== '' ? e.operatorId : e.id;
    if (operators.has(operatorId)) throw new Error(`${RUNBOOK_KEYS_ENV}에 같은 운영자가 둘이다: ${operatorId}`);
    const key = publicKeyOf(e.id, e.publicKey);
    const jwk = key.export({ format: 'jwk' });
    const fp = `${jwk.x}.${jwk.y}`;
    if (fingerprints.has(fp)) throw new Error(`${RUNBOOK_KEYS_ENV}에 같은 공개키가 있다: ${e.id}`);
    operators.add(operatorId);
    fingerprints.add(fp);
    out.set(e.id, { keyId: e.id, operatorId, role: e.role as RunbookOperatorRole, key });
  }
  return out;
}

/**
 * 서비스 시작 파일이 쓰는 관문 설정. prod·staging에서 목록이 없으면 시작하지 않는다.
 * local·ci·demo는 목록이 없어도 평소 경로만 받고, 묶음이 오면 bundle-malformed로 거부한다.
 */
export function runbookGateConfigFromProcess(
  env: Readonly<Record<string, string | undefined>>,
  service: RunbookService,
  security?: (e: RunbookSecurityEvent) => void,
): RunbookGateConfig {
  const raw = env[RUNBOOK_KEYS_ENV];
  const production = isProductionLikeEnv({ PEAKET_ENV: env.PEAKET_ENV, ...(env.NODE_ENV ? { NODE_ENV: env.NODE_ENV } : {}) });
  if (!raw) {
    if (production) throw new Error(`${RUNBOOK_KEYS_ENV}가 없다(런북 운영자 공개키 목록)`);
    return { keys: undefined, service, replay: new MemoryRunbookReplayGuard(), ...(security ? { security } : {}) };
  }
  return { keys: runbookOperatorKeysFromEnv(raw), service, replay: new MemoryRunbookReplayGuard(), ...(security ? { security } : {}) };
}
