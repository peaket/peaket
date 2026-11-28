// F-02-7(A, OPS-310) admission-ctrl 제어 포트의 `runbook_bundle` 관문 시험.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T28, ADR-0053 결정 11,
// docs/review/plans/F-02-7.md 6·8·10절. 실제 KMS 없이 시험용 P-256 키와 충실한 재생 가짜만 쓴다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applyAdmissionControl, type AdmissionControlDeps } from '../src/control/control-server.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const VALID_MS = 5 * 60_000;
const REPLAY_KEEP_MS = 5 * 60_000;
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
const commander = keyOf('commander-a', 'commander');
const alice = keyOf('operator-alice', 'operator');
const bob = keyOf('operator-bob', 'operator');
const KEYS = new Map<string, TestKey>([commander, alice, bob].map((k) => [k.keyId, k]));

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

function bundleOf(commandId: string, kind: string, desired: Record<string, unknown>, issuedAt = NOW) {
  return {
    v: 1,
    commandId,
    kind,
    scope: kind === 'CONTROL_KIND_AUTOMATION_STOP' ? 'PLATFORM' : EVENT,
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

function replayGuard() {
  const state = new Map<string, { digest: string; state: 'in-flight' | 'applied'; keepUntilMs: number }>();
  return {
    begin(commandId: string, digest: string, expiresAtMs: number, nowMs: number): 'reserved' | 'replayed' | 'conflict' | 'in-flight' {
      const seen = state.get(commandId);
      if (seen && nowMs > seen.keepUntilMs) state.delete(commandId);
      const s = state.get(commandId);
      if (!s) {
        state.set(commandId, { digest, state: 'in-flight', keepUntilMs: expiresAtMs + REPLAY_KEEP_MS });
        return 'reserved';
      }
      if (s.digest !== digest) return 'conflict';
      return s.state === 'applied' ? 'replayed' : 'in-flight';
    },
    commit(commandId: string): void {
      const s = state.get(commandId);
      if (s) s.state = 'applied';
    },
    abort(commandId: string): void {
      state.delete(commandId);
    },
  };
}

function harness(o: { replay?: ReturnType<typeof replayGuard>; run?: (i: { version: number }) => Promise<unknown> } = {}) {
  const events: { reason: string; service: string; keyIds: readonly string[] }[] = [];
  let writes = 0;
  const replay = o.replay ?? replayGuard();
  const deps = {
    apply: {
      run:
        o.run ??
        (async (i: { version: number }) => {
          writes += 1;
          return { status: 'APPLIED', appliedVersion: i.version, changed: true };
        }),
    },
    podName: 'admission-ctrl-1',
    nowMs: () => NOW,
    runbook: {
      keys: KEYS,
      service: 'admission-ctrl',
      replay,
      security: (e: { reason: string; service: string; keyIds: readonly string[] }) => events.push(e),
      nowMs: () => NOW,
    },
  } as unknown as AdmissionControlDeps;
  return { deps, events, replay, writes: () => writes };
}

const requestOf = (b: ReturnType<typeof bundleOf>, signatures: ReturnType<typeof signaturesOf>, over: Record<string, unknown> = {}) => ({
  command_id: b.commandId,
  scope: b.scope,
  kind: b.kind,
  version: b.version,
  desired_state_json: JSON.stringify(b.requests['admission-ctrl']),
  runbook_bundle: { canonical_bundle: Buffer.from(canonical(b), 'utf8'), signatures },
  ...over,
});

describe('F-02-7 C-T28 ⑪ admission-ctrl 서명 묶음', () => {
  test('C-T28 ⑪ admission-ctrl은 종류별 정책·재생·동시 요청·적용 전 실패를 가른다', async () => {
    const h = harness();
    // 1) 운영자 두 명의 입장 일시정지
    const pause = bundleOf(UUID(1), 'CONTROL_KIND_ADMISSION_PAUSE', { paused: true, expiresAtMs: NOW + 600_000 });
    await expect(applyAdmissionControl(requestOf(pause, signaturesOf(pause, [alice, bob])), h.deps)).resolves.toMatchObject({ appliedVersion: pause.version });
    // 2) 같은 commandId 재생은 ALREADY_EXISTS
    await expect(applyAdmissionControl(requestOf(pause, signaturesOf(pause, [alice, bob])), h.deps)).rejects.toMatchObject({ code: 6 });
    expect(h.events.at(-1)?.reason).toBe('replayed');
    // 3) 같은 commandId 다른 묶음은 충돌
    const conflict = { ...pause, reason: '다른 사유' };
    await expect(applyAdmissionControl(requestOf(conflict, signaturesOf(conflict, [alice, bob])), h.deps)).rejects.toMatchObject({ code: 6 });
    expect(h.events.at(-1)?.reason).toBe('conflict');

    // 4) 판매 정지는 commander 한 명, 두 명이면 거부
    const sale = bundleOf(UUID(2), 'CONTROL_KIND_SALE_PAUSE', { paused: true });
    await expect(applyAdmissionControl(requestOf(sale, signaturesOf(sale, [commander])), h.deps)).resolves.toMatchObject({ appliedVersion: sale.version });
    const saleTwo = bundleOf(UUID(3), 'CONTROL_KIND_SALE_PAUSE', { paused: true });
    await expect(applyAdmissionControl(requestOf(saleTwo, signaturesOf(saleTwo, [commander, alice])), h.deps)).rejects.toMatchObject({ code: 16 });
    const saleOperator = bundleOf(UUID(4), 'CONTROL_KIND_SALE_PAUSE', { paused: true });
    await expect(applyAdmissionControl(requestOf(saleOperator, signaturesOf(saleOperator, [alice])), h.deps)).rejects.toMatchObject({ code: 16 });

    // 5) 자동 제어 정지는 운영자 두 명
    const stop = bundleOf(UUID(5), 'CONTROL_KIND_AUTOMATION_STOP', { stopped: true });
    await expect(applyAdmissionControl(requestOf(stop, signaturesOf(stop, [alice, bob])), h.deps)).resolves.toMatchObject({ appliedVersion: stop.version });
    const stopOne = bundleOf(UUID(6), 'CONTROL_KIND_AUTOMATION_STOP', { stopped: true });
    await expect(applyAdmissionControl(requestOf(stopOne, signaturesOf(stopOne, [alice])), h.deps)).rejects.toMatchObject({ code: 16 });

    // 6) 서명이 틀리면 거부하고 보안 이벤트를 남긴다
    const bad = bundleOf(UUID(7), 'CONTROL_KIND_ADMISSION_PAUSE', { paused: true, expiresAtMs: NOW + 600_000 });
    const badSigs = signaturesOf(bad, [alice, bob]);
    badSigs[1] = { ...badSigs[1]!, signature: Buffer.from('broken') };
    await expect(applyAdmissionControl(requestOf(bad, badSigs), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.events.at(-1)).toMatchObject({ reason: 'bad-signature', service: 'admission-ctrl' });

    // 7) 동시 두 요청은 하나만 예약하고 다른 하나는 UNAVAILABLE(14)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = harness({
      run: async (i: { version: number }) => {
        await gate;
        return { status: 'APPLIED', appliedVersion: i.version, changed: true };
      },
    });
    const concurrent = bundleOf(UUID(8), 'CONTROL_KIND_ADMISSION_PAUSE', { paused: true, expiresAtMs: NOW + 600_000 });
    const first = applyAdmissionControl(requestOf(concurrent, signaturesOf(concurrent, [alice, bob])), slow.deps);
    await new Promise((r) => setImmediate(r));
    await expect(applyAdmissionControl(requestOf(concurrent, signaturesOf(concurrent, [alice, bob])), slow.deps)).rejects.toMatchObject({ code: 14 });
    release();
    await expect(first).resolves.toBeDefined();

    // 8) 적용 전 실패는 abort로 풀어 같은 commandId를 다시 보낼 수 있다
    const aborts: string[] = [];
    const replay = replayGuard();
    const originalAbort = replay.abort;
    replay.abort = (id: string) => {
      aborts.push(id);
      originalAbort(id);
    };
    let fail = true;
    const retryHarness = harness({
      replay,
      run: async (i: { version: number }) => {
        if (fail) {
          fail = false;
          throw new Error('저장소 오류');
        }
        return { status: 'APPLIED', appliedVersion: i.version, changed: true };
      },
    });
    const retry = bundleOf(UUID(9), 'CONTROL_KIND_ADMISSION_PAUSE', { paused: true, expiresAtMs: NOW + 600_000 });
    await expect(applyAdmissionControl(requestOf(retry, signaturesOf(retry, [alice, bob])), retryHarness.deps)).rejects.toMatchObject({ code: 14 });
    expect(aborts).toEqual([retry.commandId]);
    await expect(applyAdmissionControl(requestOf(retry, signaturesOf(retry, [alice, bob])), retryHarness.deps)).resolves.toBeDefined();
  });
});
