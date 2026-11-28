// F-02-7(A, OPS-310) payment-svc 제어 포트의 `runbook_bundle` 관문 시험.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T28, ADR-0053 결정 11·ADR-0366,
// docs/review/plans/F-02-7.md 6·8·10절. 실제 KMS 없이 시험용 P-256 키와 충실한 재생 가짜만 쓴다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applyPaymentControl, type PaymentControlDeps } from '../src/control/control-server.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const ACTOR = '0193a000-0000-7000-8000-0000ffff0001';
const VALID_MS = 5 * 60_000;
const REPLAY_KEEP_MS = 5 * 60_000;
const UUID = (n: number): string => `0193a000-0000-7000-9000-00000000ae${String(n).padStart(2, '0')}`;

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

type Bundle = {
  v: 1;
  commandId: string;
  kind: string;
  scope: string;
  version: number;
  reason: string;
  issuedAt: number;
  expiresAt: number;
  requests: Record<string, Record<string, unknown>>;
};

function pgBundle(commandId: string, issuedAt = NOW): Bundle {
  return {
    v: 1,
    commandId,
    kind: 'CONTROL_KIND_PG_SWITCH',
    scope: EVENT,
    version: issuedAt,
    reason: '결제사 장애로 대체 결제사로 전환한다',
    issuedAt,
    expiresAt: issuedAt + VALID_MS,
    requests: { 'payment-svc': { toPg: 'PORTONE', switched: true } },
  };
}

function releaseBundle(commandId: string, issuedAt = NOW): Bundle {
  return {
    v: 1,
    commandId,
    kind: 'CONTROL_KIND_ENTRY_PAUSE_RELEASE',
    scope: 'PLATFORM',
    version: issuedAt,
    reason: '결제사 장애 정지를 해제한다',
    issuedAt,
    expiresAt: issuedAt + VALID_MS,
    requests: { 'payment-svc': { pg: 'TOSS', actor: ACTOR } },
  };
}

const signaturesOf = (b: Bundle, keys: readonly TestKey[]) => {
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
  const events: { reason: string; service: string }[] = [];
  let writes = 0;
  const replay = o.replay ?? replayGuard();
  const deps = {
    pgSwitch: {
      run:
        o.run ??
        (async (i: { version: number }) => {
          writes += 1;
          return { appliedVersion: i.version, written: true };
        }),
    },
    release: {
      run: async (i: { version: number }) => {
        writes += 1;
        return { appliedVersion: i.version, replayed: false, outcome: 'APPLIED' };
      },
    },
    podName: 'payment-svc-1',
    allowSimulator: true,
    nowMs: () => NOW,
    runbook: {
      keys: KEYS,
      service: 'payment-svc',
      replay,
      security: (e: { reason: string; service: string }) => events.push(e),
      nowMs: () => NOW,
    },
  } as unknown as PaymentControlDeps;
  return { deps, events, replay, writes: () => writes };
}

const requestOf = (b: Bundle, signatures: ReturnType<typeof signaturesOf>) => ({
  command_id: b.commandId,
  scope: b.scope,
  kind: b.kind,
  version: b.version,
  desired_state_json: JSON.stringify(b.requests['payment-svc']),
  runbook_bundle: { canonical_bundle: Buffer.from(canonical(b), 'utf8'), signatures },
});

describe('F-02-7 C-T28 ⑬ payment-svc 서명 묶음', () => {
  test('C-T28 ⑬ payment-svc는 PG 전환·해제 정책·정규화·재생·동시 요청·적용 전 실패를 가른다', async () => {
    const h = harness();
    // PG 전환: 키 순서가 다른 같은 값도 받는다
    const pg = pgBundle(UUID(1));
    const pgReq = requestOf(pg, signaturesOf(pg, [alice, bob]));
    pgReq.desired_state_json = '{"switched":true,"toPg":"PORTONE"}';
    expect((await applyPaymentControl(pgReq, h.deps)).appliedVersion).toBe(pg.version);
    expect(h.writes()).toBe(1);

    // 재생·충돌
    expect(await applyPaymentControl(pgReq, h.deps).catch((e: { code?: number }) => e.code)).toBe(6);
    expect(h.events.at(-1)?.reason).toBe('replayed');
    const pgChanged = { ...pg, reason: '다른 사유' };
    expect(await applyPaymentControl(requestOf(pgChanged, signaturesOf(pgChanged, [alice, bob])), h.deps).catch((e: { code?: number }) => e.code)).toBe(6);
    expect(h.events.at(-1)?.reason).toBe('conflict');

    // 서명이 틀리면 거부
    const bad = pgBundle(UUID(2));
    const badSigs = signaturesOf(bad, [alice, bob]);
    badSigs[0] = { ...badSigs[0]!, signature: Buffer.from('broken') };
    expect(await applyPaymentControl(requestOf(bad, badSigs), h.deps).catch((e: { code?: number }) => e.code)).toBe(16);
    expect(h.events.at(-1)?.reason).toBe('bad-signature');

    // 해제는 운영자 두 명, 한 명은 거부
    const release = releaseBundle(UUID(3));
    expect((await applyPaymentControl(requestOf(release, signaturesOf(release, [alice, bob])), h.deps)).appliedVersion).toBe(release.version);
    const releaseOne = releaseBundle(UUID(4));
    expect(await applyPaymentControl(requestOf(releaseOne, signaturesOf(releaseOne, [alice])), h.deps).catch((e: { code?: number }) => e.code)).toBe(16);

    // 동시 두 요청: 하나는 예약, 다른 하나는 UNAVAILABLE(14)
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const slow = harness({
      run: async (i: { version: number }) => {
        await gate;
        return { appliedVersion: i.version, written: true };
      },
    });
    const concurrent = pgBundle(UUID(5));
    const first = applyPaymentControl(requestOf(concurrent, signaturesOf(concurrent, [alice, bob])), slow.deps);
    await new Promise((r) => setImmediate(r));
    expect(await applyPaymentControl(requestOf(concurrent, signaturesOf(concurrent, [alice, bob])), slow.deps).catch((e: { code?: number }) => e.code)).toBe(14);
    releaseGate();
    expect((await first).appliedVersion).toBe(concurrent.version);

    // 적용 전 실패는 abort로 풀어 같은 commandId를 다시 보낼 수 있다
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
        return { appliedVersion: i.version, written: true };
      },
    });
    const retry = pgBundle(UUID(6));
    expect(await applyPaymentControl(requestOf(retry, signaturesOf(retry, [alice, bob])), retryHarness.deps).catch((e: { code?: number }) => e.code)).toBe(14);
    expect(aborts).toEqual([retry.commandId]);
    expect((await applyPaymentControl(requestOf(retry, signaturesOf(retry, [alice, bob])), retryHarness.deps)).appliedVersion).toBe(retry.version);
  });
});
