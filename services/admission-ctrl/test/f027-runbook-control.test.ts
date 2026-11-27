// F-02-7(A, OPS-310) admission-ctrl 제어 포트의 `runbook_bundle` 관문 시험.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T28, ADR-0053 결정 11,
// docs/review/plans/F-02-7.md 6·8·10절. 실제 KMS 없이 시험용 P-256 키로만 서명한다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applyAdmissionControl, type AdmissionControlDeps } from '../src/control/control-server.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const VALID_MS = 5 * 60_000;
const UUID = (n: number): string => `0193a000-0000-7000-9000-00000000ac${String(n).padStart(2, '0')}`;

interface TestKey {
  keyId: string;
  operatorId: string;
  role: 'commander' | 'operator';
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}
const keyOf = (id: string, role: TestKey['role']): TestKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { keyId: id, operatorId: id, role, publicKey, privateKey };
};
const alice = keyOf('operator-alice', 'operator');
const bob = keyOf('operator-bob', 'operator');
const KEYS = new Map<string, TestKey>([alice, bob].map((k) => [k.keyId, k]));

function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError('unsupported');
}

function bundleOf(commandId: string, desired: Record<string, unknown>, issuedAt = NOW) {
  return {
    v: 1,
    commandId,
    kind: 'CONTROL_KIND_ADMISSION_PAUSE',
    scope: EVENT,
    version: issuedAt,
    reason: '입장을 잠시 멈춘다',
    issuedAt,
    expiresAt: issuedAt + VALID_MS,
    requests: { 'admission-ctrl': desired },
  };
}

const signaturesOf = (b: ReturnType<typeof bundleOf>, keys: readonly TestKey[]) => {
  const bytes = Buffer.from(canonical(b), 'utf8');
  return keys.map((k) => ({ key_id: k.keyId, signature: sign('sha256', bytes, { key: k.privateKey, dsaEncoding: 'der' }) }));
};

function harness() {
  const events: { reason: string; service: string; keyIds: readonly string[] }[] = [];
  let writes = 0;
  const deps = {
    apply: {
      run: async (i: { version: number }) => {
        writes += 1;
        return { status: 'APPLIED', appliedVersion: i.version, changed: true };
      },
    },
    podName: 'admission-ctrl-1',
    nowMs: () => NOW,
    runbook: {
      keys: KEYS,
      service: 'admission-ctrl',
      replay: { begin: () => 'reserved', commit: () => undefined, abort: () => undefined },
      security: (e: { reason: string; service: string; keyIds: readonly string[] }) => events.push(e),
      nowMs: () => NOW,
    },
  } as unknown as AdmissionControlDeps;
  return { deps, events, writes: () => writes };
}

const requestOf = (b: ReturnType<typeof bundleOf>, signatures: ReturnType<typeof signaturesOf>) => ({
  command_id: b.commandId,
  scope: b.scope,
  kind: b.kind,
  version: b.version,
  desired_state_json: JSON.stringify(b.requests['admission-ctrl']),
  runbook_bundle: { canonical_bundle: Buffer.from(canonical(b), 'utf8'), signatures },
});

describe('F-02-7 C-T28 ⑪ admission-ctrl 서명 묶음', () => {
  test('C-T28 ⑪ admission-ctrl은 서로 다른 운영자 두 명의 유효한 묶음을 적용하고, 서명이 틀리면 거부한다', async () => {
    const h = harness();
    const good = bundleOf(UUID(1), { paused: true, expiresAtMs: NOW + 600_000 });
    const ack = await applyAdmissionControl(requestOf(good, signaturesOf(good, [alice, bob])), h.deps);
    expect(ack).toMatchObject({ appliedVersion: good.version, podName: 'admission-ctrl-1' });
    expect(h.writes()).toBe(1);

    const bad = bundleOf(UUID(2), { paused: true, expiresAtMs: NOW + 600_000 });
    const sigs = signaturesOf(bad, [alice, bob]);
    sigs[1] = { ...sigs[1]!, signature: Buffer.from('broken') };
    await expect(applyAdmissionControl(requestOf(bad, sigs), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(1);
    expect(h.events.at(-1)).toMatchObject({ reason: 'bad-signature', service: 'admission-ctrl' });
  });
});
