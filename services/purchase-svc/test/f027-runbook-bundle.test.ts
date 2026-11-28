// F-02-7(A, OPS-310) 받는 쪽 서명 묶음 시험: purchase-svc 제어 포트의 `runbook_bundle` 관문.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T28, ADR-0053 결정 11·ADR-0095,
// docs/security/asvs/control-tower.md 4.1.5·16.3.3·16.5.2, docs/review/plans/F-02-7.md 6·8·10절.
// 시험은 메모리 저장소·시험용 P-256 키·충실한 재생 가짜만 쓴다(실제 KMS·Docker 없음).
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applyControl, type ControlDeps, type ControlRequest } from '../src/control/control-server.js';
import { MemorySaleControlCopies, MemorySaleControlStore, SetSalePause, SetSaleSuspension } from '../src/modules/sale-control/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const VALID_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const REPLAY_KEEP_MS = 5 * 60_000;
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
  reason?: string;
}): Bundle {
  const issuedAt = o.issuedAt ?? NOW;
  return {
    v: 1,
    commandId: o.commandId,
    kind: o.kind,
    scope: o.scope ?? EVENT,
    version: issuedAt,
    reason: o.reason ?? '결제사 장애로 판매를 멈춘다',
    issuedAt,
    expiresAt: o.expiresAt ?? issuedAt + VALID_MS,
    requests: { [o.service ?? 'purchase-svc']: o.desired },
  };
}

interface Signature {
  key_id: string;
  signature: Buffer;
}

function signaturesOver(bytes: Buffer, keys: readonly TestKey[]): Signature[] {
  return keys.map((k) => ({ key_id: k.keyId, signature: sign('sha256', bytes, { key: k.privateKey, dsaEncoding: 'der' }) }));
}

function signBundle(b: Bundle, keys: readonly TestKey[]): Signature[] {
  return signaturesOver(Buffer.from(canonical(b), 'utf8'), keys);
}

function requestOf(b: Bundle, signatures: readonly Signature[], over: Partial<ControlRequest> = {}): ControlRequest {
  return {
    commandId: b.commandId,
    scope: b.scope,
    kind: b.kind,
    version: b.version,
    desiredStateJson: JSON.stringify(b.requests['purchase-svc'] ?? { suspended: true }),
    runbook_bundle: { canonical_bundle: Buffer.from(canonical(b), 'utf8'), signatures },
    ...over,
  } as ControlRequest;
}

/** 정규화하지 않은 바이트를 그대로 싣는 요청(서명도 그 바이트에 한다) */
function requestWithBytes(b: Bundle, bytes: Buffer, keys: readonly TestKey[]): ControlRequest {
  return {
    commandId: b.commandId,
    scope: b.scope,
    kind: b.kind,
    version: b.version,
    desiredStateJson: JSON.stringify(b.requests['purchase-svc'] ?? { suspended: true }),
    runbook_bundle: { canonical_bundle: bytes, signatures: signaturesOver(bytes, keys) },
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

/** 받는 쪽이 부르는 재생 관문의 충실한 가짜(적용 전 예약·성공 뒤 확정·실패 뒤 풀기·expiresAt+5분 기억) */
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

function harness(o: { replay?: ReturnType<typeof replayGuard> } = {}) {
  const store = new MemorySaleControlStore();
  const copies = new MemorySaleControlCopies();
  const events: Event[] = [];
  let writes = 0;
  const suspension = new SetSaleSuspension(store, copies);
  const pause = new SetSalePause(store, copies);
  const replay = o.replay ?? replayGuard();
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
      replay,
      security: (e: Event) => events.push(e),
      nowMs: () => NOW,
    },
  } as unknown as ControlDeps;
  return { deps, events, replay, writes: () => writes };
}

const suspensionBundle = (commandId = UUID(1), reason?: string) =>
  bundleOf({ commandId, kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true }, ...(reason ? { reason } : {}) });
const salePauseBundle = (commandId = UUID(2), reason?: string) =>
  bundleOf({ commandId, kind: 'CONTROL_KIND_SALE_PAUSE', desired: { paused: true }, ...(reason ? { reason } : {}) });
const saleResumeBundle = (commandId = UUID(3)) => bundleOf({ commandId, kind: 'CONTROL_KIND_SALE_PAUSE', desired: { paused: false } });

describe('F-02-7 C-T28 받는 쪽 서명 묶음(purchase-svc)', () => {
  test('C-T28 ① 서명 수가 정책과 다르면 거부되고 보안 이벤트가 남는다', async () => {
    const h = harness();
    const one = suspensionBundle();
    await expect(applyControl(requestOf(one, signBundle(one, [operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    const pauseTwo = salePauseBundle();
    await expect(applyControl(requestOf(pauseTwo, signBundle(pauseTwo, [commanderA, operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    const resumeOne = saleResumeBundle();
    await expect(applyControl(requestOf(resumeOne, signBundle(resumeOne, [commanderA])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events.map((e) => e.reason)).toEqual(['signature-count', 'signature-count', 'signature-count']);
    expect(h.events.map((e) => e.commandId)).toEqual([one.commandId, pauseTwo.commandId, resumeOne.commandId]);
  });

  test('C-T28 ② 같은 운영자가 두 번 서명한 묶음은 거부된다', async () => {
    const h = harness();
    const b = suspensionBundle();
    await expect(applyControl(requestOf(b, signBundle(b, [operatorC, operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events[0]?.reason).toBe('same-operator');
    expect(h.events[0]?.keyIds).toEqual(['operator-c']);
  });

  test('C-T28 ③ 5분 창의 세 갈래와 경계값을 본다', async () => {
    const h = harness();
    const rejected = async (b: Bundle, expected: string) => {
      await expect(applyControl(requestOf(b, signBundle(b, [operatorC, operatorD])), h.deps)).rejects.toMatchObject({ code: 16 });
      expect(h.events.at(-1)?.reason).toBe(expected);
    };
    await rejected(bundleOf({ commandId: UUID(4), kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true }, issuedAt: NOW - VALID_MS - 1, expiresAt: NOW - 1 }), 'expired');
    await rejected(bundleOf({ commandId: UUID(5), kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true }, issuedAt: NOW + CLOCK_SKEW_MS + 1, expiresAt: NOW + CLOCK_SKEW_MS + 1 + VALID_MS }), 'not-yet-valid');
    await rejected(bundleOf({ commandId: UUID(6), kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true }, issuedAt: NOW, expiresAt: NOW + VALID_MS + 1 }), 'window');

    // 경계값: now == expiresAt, 정확히 5분, issuedAt == now+30초는 받는다
    const atExpiry = bundleOf({ commandId: UUID(7), kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true }, issuedAt: NOW - VALID_MS, expiresAt: NOW });
    await expect(applyControl(requestOf(atExpiry, signBundle(atExpiry, [operatorC, operatorD])), h.deps)).resolves.toMatchObject({ appliedVersion: atExpiry.version });
    const exact = bundleOf({ commandId: UUID(8), kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true } });
    await expect(applyControl(requestOf(exact, signBundle(exact, [operatorC, operatorD])), h.deps)).resolves.toMatchObject({ appliedVersion: exact.version });
    const future = bundleOf({ commandId: UUID(9), kind: 'CONTROL_KIND_SALE_SUSPENSION', desired: { suspended: true }, issuedAt: NOW + CLOCK_SKEW_MS, expiresAt: NOW + CLOCK_SKEW_MS + VALID_MS });
    await expect(applyControl(requestOf(future, signBundle(future, [operatorC, operatorD])), h.deps)).resolves.toMatchObject({ appliedVersion: future.version });
  });

  test('C-T28 ④ 이미 적용한 commandId는 재생·충돌로 거부되고, 실패·동시 요청·기억 만료를 가른다', async () => {
    const h = harness();
    const b = suspensionBundle(UUID(10));
    const sigs = signBundle(b, [operatorC, operatorD]);
    await expect(applyControl(requestOf(b, sigs), h.deps)).resolves.toMatchObject({ appliedVersion: b.version });
    await expect(applyControl(requestOf(b, sigs), h.deps)).rejects.toMatchObject({ code: 6 });
    expect(h.events.at(-1)?.reason).toBe('replayed');

    const changed = { ...b, reason: '다른 사유' };
    await expect(applyControl(requestOf(changed, signBundle(changed, [operatorC, operatorD])), h.deps)).rejects.toMatchObject({ code: 6 });
    expect(h.events.at(-1)?.reason).toBe('conflict');

    // 적용 전 실패는 약속을 풀어 같은 commandId로 다시 보낼 수 있다(가드의 abort 호출을 본다)
    const aborts: string[] = [];
    const replay = replayGuard();
    const originalAbort = replay.abort;
    replay.abort = (id: string) => {
      aborts.push(id);
      originalAbort(id);
    };
    const h2 = harness({ replay });
    let fail = true;
    const deps = {
      ...(h2.deps as unknown as Record<string, unknown>),
      setSuspension: {
        run: async (i: Parameters<SetSaleSuspension['run']>[0]) => {
          if (fail) {
            fail = false;
            throw new Error('저장소 오류');
          }
          return new SetSaleSuspension(new MemorySaleControlStore(), new MemorySaleControlCopies()).run(i);
        },
      },
    } as unknown as ControlDeps;
    const retry = suspensionBundle(UUID(11));
    await expect(applyControl(requestOf(retry, signBundle(retry, [operatorC, operatorD])), deps)).rejects.toMatchObject({ code: 14 });
    expect(aborts).toEqual([retry.commandId]);
    await expect(applyControl(requestOf(retry, signBundle(retry, [operatorC, operatorD])), deps)).resolves.toBeDefined();

    // 동시 두 요청: 하나는 예약, 다른 하나는 UNAVAILABLE(14)이고 쓰기는 한 번이다
    const h3 = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      ...(h3.deps as unknown as Record<string, unknown>),
      setSuspension: {
        run: async (i: Parameters<SetSaleSuspension['run']>[0]) => {
          await gate;
          return new SetSaleSuspension(new MemorySaleControlStore(), new MemorySaleControlCopies()).run(i);
        },
      },
    } as unknown as ControlDeps;
    const concurrent = suspensionBundle(UUID(12));
    const first = applyControl(requestOf(concurrent, signBundle(concurrent, [operatorC, operatorD])), slow);
    await new Promise((r) => setImmediate(r));
    await expect(applyControl(requestOf(concurrent, signBundle(concurrent, [operatorC, operatorD])), slow)).rejects.toMatchObject({ code: 14 });
    release();
    await expect(first).resolves.toBeDefined();

    // 기억은 expiresAt+5분이 지나면 지운다(가드 계약)
    const g = replayGuard();
    expect(g.begin('memory', 'd', NOW + VALID_MS, NOW)).toBe('reserved');
    g.commit('memory');
    expect(g.begin('memory', 'd', NOW + VALID_MS, NOW + VALID_MS + REPLAY_KEEP_MS + 1)).toBe('reserved');

    expect(h.writes()).toBe(1);
  });

  test('C-T28 ⑤ operator 한 명이 서명한 명령 3 정지 묶음은 거부된다', async () => {
    const h = harness();
    const b = salePauseBundle();
    await expect(applyControl(requestOf(b, signBundle(b, [operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events[0]?.reason).toBe('not-authorized-role');
  });

  test('C-T28 ⑥ 판매 재개는 서로 다른 commander 두 명만 받고, 판매 정지는 두 명을 받지 않는다', async () => {
    const h = harness();
    const resumeOne = saleResumeBundle(UUID(13));
    await expect(applyControl(requestOf(resumeOne, signBundle(resumeOne, [commanderA])), h.deps)).rejects.toMatchObject({ code: 16 });
    const resumeMixed = saleResumeBundle(UUID(14));
    await expect(applyControl(requestOf(resumeMixed, signBundle(resumeMixed, [commanderA, operatorC])), h.deps)).rejects.toMatchObject({ code: 16 });
    const pauseTwo = salePauseBundle(UUID(15));
    await expect(applyControl(requestOf(pauseTwo, signBundle(pauseTwo, [commanderA, commanderB])), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events.map((e) => e.reason)).toEqual(['signature-count', 'not-authorized-role', 'signature-count']);

    const resumeTwo = saleResumeBundle(UUID(16));
    await expect(applyControl(requestOf(resumeTwo, signBundle(resumeTwo, [commanderA, commanderB])), h.deps)).resolves.toMatchObject({ appliedVersion: resumeTwo.version });
    expect(h.writes()).toBe(1);
  });

  test('C-T28 ⑧ 정규화하지 않은 바이트와 모양이 틀린 묶음은 거부된다', async () => {
    const h = harness();
    const b = suspensionBundle(UUID(17));
    const pretty = Buffer.from(JSON.stringify(b, null, 2), 'utf8');
    await expect(applyControl(requestWithBytes(b, pretty, [operatorC, operatorD]), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.events.at(-1)?.reason).toBe('not-canonical');

    const malformed = (change: (x: Bundle) => Record<string, unknown>): ControlRequest => {
      const base = suspensionBundle(UUID(18));
      const x = change(structuredClone(base));
      const bytes = Buffer.from(JSON.stringify(x), 'utf8');
      const desired = (x.requests as Record<string, Record<string, unknown>> | undefined)?.['purchase-svc'] ?? { suspended: true };
      return {
        commandId: x.commandId,
        scope: x.scope,
        kind: x.kind,
        version: x.version,
        desiredStateJson: JSON.stringify(desired),
        runbook_bundle: { canonical_bundle: bytes, signatures: signaturesOver(bytes, [operatorC, operatorD]) },
      } as ControlRequest;
    };
    const cases = [
      malformed((x) => ({ ...x, extra: 1 })),
      malformed((x) => ({ ...x, requests: { ...x.requests, 'other-svc': { suspended: true } } })),
      malformed((x) => ({ ...x, requests: {} })),
      malformed((x) => ({ ...x, version: x.issuedAt + 1 })),
      malformed((x) => ({ ...x, version: '1' })),
      malformed((x) => ({ ...x, reason: '' })),
      malformed((x) => ({ ...x, reason: '가'.repeat(201) })),
      malformed((x) => ({ ...x, reason: '줄\n바꿈' })),
    ];
    for (const req of cases) {
      await expect(applyControl(req, h.deps)).rejects.toMatchObject({ code: 16 });
      expect(h.events.at(-1)?.reason).toBe('bundle-malformed');
    }
    expect(h.writes()).toBe(0);
  });

  test('C-T28 ⑩ 요청과 묶음이 다르면 거부되고, 정규화한 값이 같으면 받는다', async () => {
    const h = harness();
    const b = suspensionBundle(UUID(19));
    const sigs = signBundle(b, [operatorC, operatorD]);
    const mismatches = [
      { kind: 'CONTROL_KIND_SALE_PAUSE' },
      { scope: '0193a000-0000-7000-9000-0000000000e2' },
      { version: b.version + 1 },
      { desiredStateJson: '{"suspended":false}' },
    ];
    for (const over of mismatches) {
      const req = { ...requestOf(b, sigs, over), commandId: UUID(20 + mismatches.indexOf(over)) } as ControlRequest;
      await expect(applyControl(req, h.deps)).rejects.toMatchObject({ code: 16 });
    }
    expect(h.events).toHaveLength(4);
    expect(h.events.every((e) => e.reason === 'mismatch' && e.service === 'purchase-svc')).toBe(true);
    expect(h.events.map((e) => e.commandId)).toEqual([UUID(20), UUID(21), UUID(22), UUID(23)]);

    // 공백이 든 같은 값은 받는다
    const spaced = suspensionBundle(UUID(24));
    await expect(applyControl(requestOf(spaced, signBundle(spaced, [operatorC, operatorD]), { desiredStateJson: ' { "suspended" : true } ' }), h.deps)).resolves.toBeDefined();
    // 모르는 칸이 더해진 값은 거부한다
    const extra = suspensionBundle(UUID(25));
    await expect(applyControl(requestOf(extra, signBundle(extra, [operatorC, operatorD]), { desiredStateJson: '{"suspended":true,"extra":1}' }), h.deps)).rejects.toMatchObject({ code: 16 });
    expect(h.events.at(-1)?.reason).toBe('mismatch');
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

  test('[ASVS v5.0.0-16.5.2] 설정·키 목록이 없으면 묶음을 적용하지 않고, prod 시작은 키 없이 뜨지 않는다', async () => {
    const h = harness();
    const b = suspensionBundle(UUID(12));
    const sigs = signBundle(b, [operatorC, operatorD]);
    const withoutRunbook = { ...(h.deps as unknown as Record<string, unknown>) } as Record<string, unknown>;
    delete withoutRunbook.runbook;
    await expect(applyControl(requestOf(b, sigs), withoutRunbook as unknown as ControlDeps)).rejects.toMatchObject({ code: 16 });

    const noKeys = { ...h.deps, runbook: { ...(h.deps as unknown as { runbook: object }).runbook, keys: undefined } } as unknown as ControlDeps;
    await expect(applyControl(requestOf(b, sigs), noKeys)).rejects.toMatchObject({ code: 16 });
    const emptyKeys = { ...h.deps, runbook: { ...(h.deps as unknown as { runbook: object }).runbook, keys: new Map() } } as unknown as ControlDeps;
    await expect(applyControl(requestOf(b, sigs), emptyKeys)).rejects.toMatchObject({ code: 16 });
    expect(h.writes()).toBe(0);
    expect(h.events.at(-1)?.reason).toBe('unknown-key');
  });
});
