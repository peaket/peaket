// F-02-7(A, OPS-310) queue-svc 제어 포트의 `runbook_bundle` 관문 시험.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T28, ADR-0053 결정 11,
// docs/review/plans/F-02-7.md 6·8·10절. 실제 KMS 없이 시험용 P-256 키와 충실한 재생 가짜만 쓴다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { saleSuspensionControlBinding } from '../src/control/control-server.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const VALID_MS = 5 * 60_000;
const REPLAY_KEEP_MS = 5 * 60_000;
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
const operator = keyOf('operator-c', 'operator');
const KEYS = new Map<string, TestKey>([commander, operator].map((k) => [k.keyId, k]));

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

const call = (handlers: Record<string, unknown>, request: Record<string, unknown>) =>
  new Promise<{ e: { code?: number; message?: string } | null; v?: Record<string, unknown> }>((resolve) => {
    const fn = handlers.ApplyControl as (c: { request: Record<string, unknown> }, cb: (e: { code?: number; message?: string } | null, v?: Record<string, unknown>) => void) => void;
    fn({ request }, (e, v) => resolve({ e, v }));
  });

function fixture(o: { replay?: ReturnType<typeof replayGuard>; run?: (i: { version: number }) => Promise<number> } = {}) {
  const events: { reason: string; service: string }[] = [];
  let writes = 0;
  const replay = o.replay ?? replayGuard();
  const binding = saleSuspensionControlBinding({
    setSuspension: { run: async () => ({ revision: 1 }) },
    setNotice: {
      run:
        o.run ??
        (async (i: { version: number }) => {
          writes += 1;
          return i.version;
        }),
    },
    podName: 'queue-svc-1',
    nowMs: () => NOW,
    runbook: {
      keys: KEYS,
      service: 'queue-svc',
      replay,
      security: (e: { reason: string; service: string }) => events.push(e),
      nowMs: () => NOW,
    },
  } as unknown as Parameters<typeof saleSuspensionControlBinding>[0]);
  return { handlers: binding.handlers as Record<string, unknown>, events, replay, writes: () => writes };
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
  test('C-T28 ⑫ queue-svc는 판매 정지 정책·재생·동시 요청·적용 전 실패를 가른다', async () => {
    const f = fixture();
    const good = bundleOf(UUID(1));
    const ok = await call(f.handlers, requestOf(good, signaturesOf(good, [commander])));
    expect(ok.e).toBeNull();
    expect(ok.v).toMatchObject({ applied_version: good.version, pod_name: 'queue-svc-1' });
    expect(f.writes()).toBe(1);

    // 재생·충돌
    expect((await call(f.handlers, requestOf(good, signaturesOf(good, [commander])))).e?.code).toBe(6);
    expect(f.events.at(-1)?.reason).toBe('replayed');
    const changed = { ...good, reason: '다른 사유' };
    expect((await call(f.handlers, requestOf(changed, signaturesOf(changed, [commander])))).e?.code).toBe(6);
    expect(f.events.at(-1)?.reason).toBe('conflict');
    expect(f.writes()).toBe(1);

    // operator 한 명은 판매 정지에 쓸 수 없다
    const op = bundleOf(UUID(2));
    expect((await call(f.handlers, requestOf(op, signaturesOf(op, [operator])))).e?.code).toBe(16);
    // 서명이 틀리면 거부하고 보안 이벤트
    const bad = bundleOf(UUID(3));
    const badSigs = signaturesOf(bad, [commander]);
    badSigs[0] = { ...badSigs[0]!, signature: Buffer.from('broken') };
    expect((await call(f.handlers, requestOf(bad, badSigs))).e?.code).toBe(16);
    expect(f.events.at(-1)?.reason).toBe('bad-signature');
    expect(f.writes()).toBe(1);

    // 동시 두 요청: 하나는 예약, 다른 하나는 UNAVAILABLE(14)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fixture({
      run: async (i: { version: number }) => {
        await gate;
        return i.version;
      },
    });
    const concurrent = bundleOf(UUID(4));
    const first = call(slow.handlers, requestOf(concurrent, signaturesOf(concurrent, [commander])));
    await new Promise((r) => setImmediate(r));
    expect((await call(slow.handlers, requestOf(concurrent, signaturesOf(concurrent, [commander])))).e?.code).toBe(14);
    release();
    expect((await first).e).toBeNull();

    // 적용 전 실패는 abort로 풀어 같은 commandId를 다시 보낼 수 있다
    const aborts: string[] = [];
    const replay = replayGuard();
    const originalAbort = replay.abort;
    replay.abort = (id: string) => {
      aborts.push(id);
      originalAbort(id);
    };
    let fail = true;
    const retryFixture = fixture({
      replay,
      run: async (i: { version: number }) => {
        if (fail) {
          fail = false;
          throw new Error('저장소 오류');
        }
        return i.version;
      },
    });
    const retry = bundleOf(UUID(5));
    expect((await call(retryFixture.handlers, requestOf(retry, signaturesOf(retry, [commander])))).e?.code).toBe(14);
    expect(aborts).toEqual([retry.commandId]);
    expect((await call(retryFixture.handlers, requestOf(retry, signaturesOf(retry, [commander])))).e).toBeNull();
  });
});
