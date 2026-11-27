// F-02-7(A, OPS-310) 받는 쪽 서명 묶음 시험: purchase-svc 제어 포트의 `runbook_bundle` 관문.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T28, ADR-0053 결정 11·ADR-0095,
// docs/security/asvs/control-tower.md 4.1.5·16.3.3·16.5.2, docs/review/plans/F-02-7.md 6·8·10절.
// 시험은 메모리 저장소와 시험용 P-256 키만 쓴다(실제 KMS·Docker 없음). 틀린 구현은 새 묶음 관문을 빼고 돌려 잡는다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applyControl, type ControlDeps, type ControlRequest } from '../src/control/control-server.js';
import { MemorySaleControlCopies, MemorySaleControlStore, SetSalePause, SetSaleSuspension } from '../src/modules/sale-control/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const VALID_MS = 5 * 60_000;
const UUID = (n: number): string => `0193a000-0000-7000-9000-00000000ab${String(n).padStart(2, '0')}`;

type Role = 'commander' | 'operator';
interface TestKey {
  keyId: string;
  operatorId: string;
  role: Role;
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function keyOf(id: string, role: Role): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { keyId: id, operatorId: id, role, publicKey, privateKey };
}

const commanderA = keyOf('commander-a', 'commander');
const commanderB = keyOf('commander-b', 'commander');
const operatorC = keyOf('operator-c', 'operator');
const operatorD = keyOf('operator-d', 'operator');
const KEYS = new Map<string, TestKey>([commanderA, commanderB, operatorC, operatorD].map((k) => [k.keyId, k]));

/** 시험용 RFC 8785 정규화(묶음 값은 문자열·정수·참거짓·객체·배열뿐이다) */
function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError('안전한 정수만');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError('묶음에 쓸 수 없는 값');
}

interface Bundle {
  v: 1;
  commandId: string;
  kind: string;
  scope: string;
  version: number;
  reason: string;
  issuedAt: number;
  expiresAt: number;
  requests: Record<string, Record<string, unknown>>;
}

function bundleOf(o: {
  commandId: string;
  kind: string;
  desired: Record<string, unknown>;
  service?: string;
  scope?: string;
  issuedAt?: number;
  expiresAt?: number;
}): Bundle {
  const issuedAt = o.issuedAt ?? NOW;
  return {
    v: 1,
    commandId: o.commandId,
    kind: o.kind,
    scope: o.scope ?? EVENT,
    version: issuedAt,
    reason: '결제사 장애로 판매를 멈춘다',
    issuedAt,
    expiresAt: o.expiresAt ?? issuedAt + VALID_MS,
    requests: { [o.service ?? 'purchase-svc']: o.desired },
  };
}

interface Signature {
  key_id: string;
  signature: Buffer;
}

function signBundle(b: Bundle, keys: readonly TestKey[]): Signature[] {
  const bytes = Buffer.from(canonical(b), 'utf8');
  return keys.map((k) => ({ key_id: k.keyId, signature: sign('sha256', bytes, { key: k.privateKey, dsaEncoding: 'der' }) }));
}

function requestOf(b: Bundle, signatures: readonly Signature[], over: Partial<ControlRequest> = {}): ControlRequest {
  return {
    commandId: b.commandId,
    scope: b.scope,
    kind: b.kind,
    version: b.version,
    desiredStateJson: JSON.stringify(b.requests['purchase-svc']!),
    runbook_bundle: { canonical_bundle: Buffer.from(canonical(b), 'utf8'), signatures },
    ...over,
  } as ControlRequest;
}

interface Event {
  kind: string;
  reason: string;
  service: string;
  podName: string;
  commandId?: string;
  kindName?: string;
  scope?: string;
  keyIds: readonly string[];
  atMs: number;
}

/** 받는 쪽이 부르는 재생 관문의 시험용 구현(적용 전 예약·성공 뒤 확정·실패 뒤 풀기) */
function replayGuard() {
  const state = new Map<string, { digest: string; state: 'in-flight' | 'applied' }>();
  return {
    begin(commandId: string, digest: string): 'reserved' | 'replayed' | 'conflict' | 'in-flight' {
      const seen = state.get(commandId);
      if (!seen) {
        state.set(commandId, { digest, state: 'in-flight' });
        return 'reserved';
      }
      if (seen.digest !== digest) return 'conflict';
      return seen.state === 'applied' ? 'replayed' : 'in-flight';
    },
    commit(commandId: string): void {
      const seen = state.get(commandId);
      if (seen) seen.state = 'applied';
    },
    abort(commandId: string): void {
      state.delete(commandId);
    },
  };
}

function harness() {
  const store = new MemorySaleControlStore();
  const copies = new MemorySaleControlCopies();
  const events: Event[] = [];
  let writes = 0;
  const suspension = new SetSaleSuspension(store, copies);
  const pause = new SetSalePause(store, copies);
  const deps = {
    setSuspension: {
      run: async (i: Parameters<SetSaleSuspension['run']>[0]) => {
        writes += 1;
        return suspension.run(i);
      },
    },
    setPause: {
      run: async (i: Parameters<SetSalePause['run']>[0]) => {
        writes += 1;
        return pause.run(i);
      },
    },
    podName: 'purchase-svc-1',
    nowMs: () => NOW,
    runbook: {
      keys: KEYS,
      service: 'purchase-svc',
      replay: replayGuard(),
      security: (e: Event) => events.push(e),
      nowMs: () => NOW,
    },
  } as unknown as ControlDeps;
  return { deps, events, writes: () => writes };
}

const suspensionBundle = (commandId = UUID(1)) => bundleOf({ commandId, kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true } });
const salePauseBundle = (commandId = UUID(2)) => bundleOf({ commandId, kind: 'CONTROL_KIND_SALE_PAUSE', desired: { paused: true } });
const saleResumeBundle = (commandId = UUID(3)) => bundleOf({ commandId, kind: 'CONTROL_KIND_SALE_PAUSE', desired: { paused: false } });

describe('F-02-7 C-T28 받는 쪽 서명 묶음(purchase-svc)', () => {
  test('C-T28 ① 서명이 하나뿐인 판매 중지 묶음은 거부되고 보안 이벤트가 남는다', async () => {
    const h = harness();
    const b = suspensionBundle();
    await expect(applyControl(requestOf(b, signBundle(b, [operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: 'runbook-bundle-rejected', reason: 'signature-count', service: 'purchase-svc', podName: 'purchase-svc-1', commandId: b.commandId });
  });

  test('C-T28 ② 같은 운영자가 두 번 서명한 묶음은 거부된다', async () => {
    const h = harness();
    const b = suspensionBundle();
    await expect(applyControl(requestOf(b, signBundle(b, [operatorC, operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events[0]?.reason).toBe('same-operator');
    expect(h.events[0]?.keyIds).toEqual(['operator-c']);
  });

  test('C-T28 ③ 5분이 지난 묶음은 거부된다', async () => {
    const h = harness();
    const b = bundleOf({ commandId: UUID(4), kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true }, issuedAt: NOW - VALID_MS - 1, expiresAt: NOW - 1 });
    await expect(applyControl(requestOf(b, signBundle(b, [operatorC, operatorD])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events[0]?.reason).toBe('expired');
  });

  test('C-T28 ④ 이미 적용한 commandId의 묶음을 다시 보내면 거부되고 보안 이벤트가 남는다', async () => {
    const h = harness();
    const b = suspensionBundle(UUID(5));
    const sigs = signBundle(b, [operatorC, operatorD]);
    await expect(applyControl(requestOf(b, sigs), h.deps)).resolves.toMatchObject({ appliedVersion: b.version });
    expect(h.writes()).toBe(1);
    await expect(applyControl(requestOf(b, sigs), h.deps)).rejects.toMatchObject({ code: 6 });
    expect(h.writes()).toBe(1);
    expect(h.events.at(-1)?.reason).toBe('replayed');
  });

  test('C-T28 ⑤ operator 한 명이 서명한 명령 3 정지 묶음은 거부된다', async () => {
    const h = harness();
    const b = salePauseBundle();
    await expect(applyControl(requestOf(b, signBundle(b, [operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events[0]?.reason).toBe('not-authorized-role');
  });

  test('C-T28 ⑥ commander 한 명과 operator가 서명한 판매 재개 묶음은 거부된다', async () => {
    const h = harness();
    const b = saleResumeBundle();
    await expect(applyControl(requestOf(b, signBundle(b, [commanderA, operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events[0]?.reason).toBe('not-authorized-role');
  });

  test('C-T28 ⑧ 정규화하지 않은 바이트에 서명한 묶음은 거부된다', async () => {
    const h = harness();
    const b = suspensionBundle(UUID(6));
    const pretty = Buffer.from(JSON.stringify(b, null, 2), 'utf8');
    const signatures = [operatorC, operatorD].map((k) => ({ key_id: k.keyId, signature: sign('sha256', pretty, { key: k.privateKey, dsaEncoding: 'der' }) }));
    await expect(applyControl(requestOf(b, signatures), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events[0]?.reason).toBe('not-canonical');
  });

  test('C-T28 ⑩ 요청의 kind·scope·version·desired_state_json이 묶음과 다르면 거부된다', async () => {
    const h = harness();
    const b = suspensionBundle(UUID(7));
    const sigs = signBundle(b, [operatorC, operatorD]);
    for (const over of [{ kind: 'CONTROL_KIND_SALE_PAUSE' }, { scope: '0193a000-0000-7000-9000-0000000000e2' }, { version: b.version + 1 }, { desiredStateJson: '{"suspended":false}' }]) {
      await expect(applyControl(requestOf(b, sigs, over), h.deps)).rejects.toMatchObject({ code: 16 });
    }
    expect(h.writes()).toBe(0);
    expect(h.events.every((e) => e.reason === 'mismatch')).toBe(true);
  });

  test('C-T28 ⑨ commander 한 명이 서명한 명령 3 정지 묶음은 적용된다', async () => {
    const h = harness();
    const b = salePauseBundle(UUID(8));
    const ack = await applyControl(requestOf(b, signBundle(b, [commanderA])), h.deps);
    expect(ack).toMatchObject({ appliedVersion: b.version, podName: 'purchase-svc-1' });
    expect(h.writes()).toBe(1);
    expect(h.events).toHaveLength(0);
  });

  test('[ASVS v5.0.0-4.1.5] 유효한 KMS 서명 묶음만 적용되고 서명 없는 평소 경로는 그대로 동작한다', async () => {
    const h = harness();
    const normal = await applyControl({ commandId: UUID(9), scope: EVENT, kind: 'CONTROL_KIND_SALE_SUSPENSION', version: 10, desiredStateJson: '{"suspended":true}' }, h.deps);
    expect(normal.appliedVersion).toBe(10);
    const b = suspensionBundle(UUID(10));
    const sigs = signBundle(b, [operatorC, operatorD]);
    sigs[0] = { ...sigs[0]!, signature: Buffer.from('not-a-der') };
    await expect(applyControl(requestOf(b, sigs), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.events.at(-1)?.reason).toBe('bad-signature');
  });

  test('[ASVS v5.0.0-16.3.3] 거부된 묶음은 서명 바이트·사유 글 없이 사유·키 ID·서비스만 보안 이벤트로 남는다', async () => {
    const h = harness();
    const b = salePauseBundle(UUID(11));
    const sigs = signBundle(b, [operatorC]);
    await expect(applyControl(requestOf(b, sigs), h.deps)).rejects.toMatchObject({ code: 16 });
    const e = h.events[0]!;
    expect(Object.keys(e).sort()).toEqual(['atMs', 'commandId', 'kind', 'kindName', 'keyIds', 'podName', 'reason', 'scope', 'service']);
    expect(JSON.stringify(e)).not.toContain(sigs[0]!.signature.toString('base64'));
    expect(JSON.stringify(e)).not.toContain(b.reason);
  });

  test('[ASVS v5.0.0-16.5.2] 공개키 목록이 없으면 묶음을 적용하지 않고 보안 이벤트만 남긴다', async () => {
    const h = harness();
    const b = suspensionBundle(UUID(12));
    const sigs = signBundle(b, [operatorC, operatorD]);
    const deps = { ...h.deps, runbook: { ...(h.deps as unknown as { runbook: object }).runbook, keys: new Map() } } as unknown as ControlDeps;
    await expect(applyControl(requestOf(b, sigs), deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events.at(-1)?.reason).toBe('unknown-key');
  });
});
