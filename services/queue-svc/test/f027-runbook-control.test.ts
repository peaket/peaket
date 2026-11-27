// F-02-7(A, OPS-310) queue-svc 제어 포트의 `runbook_bundle` 관문 시험.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T28, ADR-0053 결정 11,
// docs/review/plans/F-02-7.md 6·8·10절. 실제 KMS 없이 시험용 P-256 키로만 서명한다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { saleSuspensionControlBinding } from '../src/control/control-server.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const VALID_MS = 5 * 60_000;
const UUID = (n: number): string => `0193a000-0000-7000-9000-00000000ad${String(n).padStart(2, '0')}`;

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
const commander = keyOf('commander-a', 'commander');
const KEYS = new Map<string, TestKey>([[commander.keyId, commander]]);

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

function bundleOf(commandId: string, issuedAt = NOW) {
  return {
    v: 1,
    commandId,
    kind: 'CONTROL_KIND_SALE_PAUSE',
    scope: EVENT,
    version: issuedAt,
    reason: '판매를 멈춘다',
    issuedAt,
    expiresAt: issuedAt + VALID_MS,
    requests: { 'queue-svc': { paused: true } },
  };
}

const signaturesOf = (b: ReturnType<typeof bundleOf>, keys: readonly TestKey[]) => {
  const bytes = Buffer.from(canonical(b), 'utf8');
  return keys.map((k) => ({ key_id: k.keyId, signature: sign('sha256', bytes, { key: k.privateKey, dsaEncoding: 'der' }) }));
};

const call = (handlers: Record<string, unknown>, request: Record<string, unknown>) =>
  new Promise<{ e: { code?: number; message?: string } | null; v?: Record<string, unknown> }>((resolve) => {
    const fn = handlers.ApplyControl as (c: { request: Record<string, unknown> }, cb: (e: { code?: number; message?: string } | null, v?: Record<string, unknown>) => void) => void;
    fn({ request }, (e, v) => resolve({ e, v }));
  });

function fixture() {
  const events: { reason: string; service: string }[] = [];
  let writes = 0;
  const binding = saleSuspensionControlBinding({
    setSuspension: { run: async () => ({ revision: 1 }) },
    setNotice: {
      run: async (i: { version: number }) => {
        writes += 1;
        return i.version;
      },
    },
    podName: 'queue-svc-1',
    nowMs: () => NOW,
    runbook: {
      keys: KEYS,
      service: 'queue-svc',
      replay: { begin: () => 'reserved', commit: () => undefined, abort: () => undefined },
      security: (e: { reason: string; service: string }) => events.push(e),
      nowMs: () => NOW,
    },
  } as unknown as Parameters<typeof saleSuspensionControlBinding>[0]);
  return { handlers: binding.handlers as Record<string, unknown>, events, writes: () => writes };
}

const requestOf = (b: ReturnType<typeof bundleOf>, signatures: ReturnType<typeof signaturesOf>) => ({
  command_id: b.commandId,
  scope: b.scope,
  kind: b.kind,
  version: b.version,
  desired_state_json: JSON.stringify(b.requests['queue-svc']),
  runbook_bundle: { canonical_bundle: Buffer.from(canonical(b), 'utf8'), signatures },
});

describe('F-02-7 C-T28 ⑫ queue-svc 서명 묶음', () => {
  test('C-T28 ⑫ queue-svc는 commander 한 명의 유효한 판매 정지 묶음을 적용하고, 서명이 틀리면 거부한다', async () => {
    const f = fixture();
    const good = bundleOf(UUID(1));
    const ok = await call(f.handlers, requestOf(good, signaturesOf(good, [commander])));
    expect(ok.e).toBeNull();
    expect(ok.v).toMatchObject({ applied_version: good.version, pod_name: 'queue-svc-1' });
    expect(f.writes()).toBe(1);

    const bad = bundleOf(UUID(2));
    const sigs = signaturesOf(bad, [commander]);
    sigs[0] = { ...sigs[0]!, signature: Buffer.from('broken') };
    const rejected = await call(f.handlers, requestOf(bad, sigs));
    expect(rejected.e?.code).toBe(16);
    expect(f.writes()).toBe(1);
    expect(f.events.at(-1)).toMatchObject({ reason: 'bad-signature', service: 'queue-svc' });
  });
});
