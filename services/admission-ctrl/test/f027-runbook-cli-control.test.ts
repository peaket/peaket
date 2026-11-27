// F-02-7(A, OPS-310) 런북 CLI의 제어 명령 갈래 시험: draft → sign → run, 감사 sink, KMS 실패.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T7·C-T13·C-T28,
// docs/review/plans/F-02-7.md 6·8·10절. 실제 KMS·S3 없이 시험용 P-256 키와 메모리 sink만 쓴다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { type RunbookDeps, runRunbookCli } from '../src/modules/rb35/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const EXTERNAL_FAILURE = 6;
const UUID = (n: number): string => `0193a000-0000-7000-9000-00000000af${String(n).padStart(2, '0')}`;

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
const commanderA = keyOf('commander-a', 'commander');
const commanderB = keyOf('commander-b', 'commander');
const operatorC = keyOf('operator-c', 'operator');
const KEYS = new Map<string, TestKey>([commanderA, commanderB, operatorC].map((k) => [k.keyId, k]));

interface SignedFile {
  bundle: {
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
  signatures: { keyId: string; signature: string }[];
}

interface Sent {
  address: string;
  request: {
    commandId: string;
    scope: string;
    kind: string;
    version: number;
    desiredStateJson: string;
    canonicalBundle: Buffer;
    signatures: { keyId: string; signature: Buffer }[];
  };
}

interface Audit {
  type: 'intent' | 'result';
  commandId: string;
  outcome?: string;
  postReviewRequired?: boolean;
  applied?: { service: string; address: string; appliedVersion: number }[];
}

function harness(o: { failIntent?: boolean; failKms?: boolean; existing?: Audit | null } = {}) {
  const files = new Map<string, string>();
  const lines: string[] = [];
  const sent: Sent[] = [];
  const calls: string[] = [];
  const audits: Audit[] = [];
  const kmsCalls: string[] = [];
  let existing = o.existing ?? null;
  const deps = {
    store: {
      scheduleOf: async () => null,
      state: async () => ({ stop: null, commit: null, round: null, published: false }),
      deposit: async () => true,
      pending: async () => [],
      apply: async () => 'applied' as const,
      reject: async () => undefined,
      result: async () => null,
    },
    clock: { now: () => NOW, monotonicMs: () => 0 },
    keys: new Map(
      [...KEYS.values()].map((k) => [k.keyId, { id: k.keyId, operatorId: k.operatorId, role: k.role, key: k.publicKey }]),
    ),
    readFile: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`없는 파일: ${p}`);
      return v;
    },
    writeFile: (p: string, s: string) => void files.set(p, s),
    print: (line: string) => void lines.push(line),
    kmsSign: async (keyId: string, message: Buffer) => {
      kmsCalls.push(keyId);
      if (o.failKms) throw new Error('KMS unavailable');
      const k = KEYS.get(keyId);
      if (!k) throw new Error(`모르는 키: ${keyId}`);
      return sign('sha256', message, { key: k.privateKey, dsaEncoding: 'der' });
    },
    newCommandId: () => UUID(1),
    defaultSigningKey: 'commander-a',
    controlAddresses: {
      'purchase-svc': ['purchase-svc:50061'],
      'admission-ctrl': ['admission-ctrl:50061'],
      'queue-svc': ['queue-svc:50061'],
      'payment-svc': ['payment-svc:50061'],
    },
    control: {
      send: async (address: string, request: Sent['request']) => {
        calls.push(`send:${address}`);
        sent.push({ address, request });
        return { appliedVersion: request.version, podName: `${address}-pod`, appliedAtMs: NOW };
      },
    },
    audit: {
      writeIntent: async (i: { commandId: string }) => {
        calls.push('intent');
        if (o.failIntent) throw new Error('S3 unavailable');
        audits.push({ type: 'intent', commandId: i.commandId });
      },
      writeResult: async (r: { commandId: string; outcome: string; postReviewRequired: boolean; applied: Audit['applied'] }) => {
        calls.push('result');
        audits.push({ type: 'result', commandId: r.commandId, outcome: r.outcome, postReviewRequired: r.postReviewRequired, applied: r.applied });
        existing = { type: 'result', commandId: r.commandId, outcome: r.outcome, postReviewRequired: r.postReviewRequired, applied: r.applied };
      },
      readResult: async (commandId: string) => {
        calls.push('readResult');
        return existing && existing.commandId === commandId ? existing : null;
      },
    },
  } as unknown as RunbookDeps;
  return { deps, files, lines, sent, calls, audits, kmsCalls, exists: () => files.has('bundle.json') };
}

async function draft(h: ReturnType<typeof harness>, preset: string, extra: string[] = []): Promise<number> {
  return runRunbookCli(['draft', preset, '--event', EVENT, '--reason', '결제사 장애로 판매를 멈춘다', '--command-id', UUID(1), '--out', 'bundle.json', ...extra], h.deps);
}

const read = (h: ReturnType<typeof harness>): SignedFile => JSON.parse(h.files.get('bundle.json')!) as SignedFile;

describe('F-02-7 런북 CLI 제어 명령', () => {
  test('C-T13 ops-svc가 없어도 런북 CLI가 세 받는 쪽에 같은 명령 ID·판으로 보내고 감사 sink에 intent→result를 남긴다', async () => {
    const h = harness();
    expect(await draft(h, 'sale-pause')).toBe(0);
    const f = read(h);
    expect(f.signatures).toEqual([]);
    expect(f.bundle).toMatchObject({ kind: 'CONTROL_KIND_SALE_PAUSE', scope: EVENT, reason: '결제사 장애로 판매를 멈춘다' });
    expect(f.bundle.version).toBe(f.bundle.issuedAt);
    expect(f.bundle.expiresAt - f.bundle.issuedAt).toBe(5 * 60_000);
    expect(Object.keys(f.bundle.requests).sort()).toEqual(['admission-ctrl', 'purchase-svc', 'queue-svc']);
    expect(f.bundle.requests['purchase-svc']).toEqual({ paused: true });

    expect(await runRunbookCli(['sign', '--in', 'bundle.json', '--signer', 'commander-a'], h.deps)).toBe(0);
    expect(read(h).signatures).toEqual([{ keyId: 'commander-a', signature: expect.any(String) }]);

    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
    expect(h.sent.map((s) => s.address).sort()).toEqual(['admission-ctrl:50061', 'purchase-svc:50061', 'queue-svc:50061']);
    expect(new Set(h.sent.map((s) => s.request.commandId))).toEqual(new Set([UUID(1)]));
    expect(new Set(h.sent.map((s) => s.request.version))).toEqual(new Set([f.bundle.version]));
    expect(h.sent.every((s) => s.request.kind === 'CONTROL_KIND_SALE_PAUSE' && JSON.parse(s.request.canonicalBundle.toString('utf8')))).toEqual(f.bundle);
    expect(h.calls[0]).toBe('readResult');
    expect(h.calls[1]).toBe('intent');
    expect(h.calls.at(-1)).toBe('result');
    expect(h.audits.at(-1)).toMatchObject({ type: 'result', commandId: UUID(1), outcome: 'APPLIED', postReviewRequired: true });
    expect(h.audits.at(-1)?.applied).toHaveLength(3);
  });

  test('C-T13 pg-switch는 payment-svc와 admission-ctrl에 서로 다른 바라는 상태를 보낸다', async () => {
    const h = harness();
    expect(await draft(h, 'pg-switch', ['--param', 'toPg=PORTONE', '--param', 'pgTps=50'])).toBe(0);
    const f = read(h);
    expect(f.bundle.kind).toBe('CONTROL_KIND_PG_SWITCH');
    expect(f.bundle.requests['payment-svc']).toEqual({ switched: true, toPg: 'PORTONE' });
    expect(f.bundle.requests['admission-ctrl']).toEqual({ switched: true, pgKey: 'PORTONE', pgTps: 50 });
    expect(f.bundle.requests['purchase-svc']).toBeUndefined();
  });

  test('C-T13 나머지 프리셋도 정한 kind·scope·requests를 만든다', async () => {
    const run = (preset: string, args: string[]) => runRunbookCli(['draft', preset, ...args, '--reason', '비상 조치', '--command-id', UUID(2), '--out', 'bundle.json'], h.deps);
    const h = harness();
    expect(await run('admission-pause', ['--event', EVENT])).toBe(0);
    expect(read(h).bundle).toMatchObject({ kind: 'CONTROL_KIND_ADMISSION_PAUSE', scope: EVENT });
    expect(read(h).bundle.requests).toEqual({ 'admission-ctrl': { paused: true, expiresAtMs: NOW + 600_000 } });

    expect(await run('admission-resume', ['--event', EVENT])).toBe(0);
    expect(read(h).bundle.requests).toEqual({ 'admission-ctrl': { paused: false, expiresAtMs: null } });

    expect(await run('automation-stop', ['--scope', 'platform'])).toBe(0);
    expect(read(h).bundle).toMatchObject({ kind: 'CONTROL_KIND_AUTOMATION_STOP', scope: 'PLATFORM' });
    expect(read(h).bundle.requests).toEqual({ 'admission-ctrl': { stopped: true } });

    expect(await run('automation-resume', ['--scope', 'platform'])).toBe(0);
    expect(read(h).bundle.requests).toEqual({ 'admission-ctrl': { stopped: false } });

    expect(await run('pg-switch-off', ['--event', EVENT])).toBe(0);
    expect(read(h).bundle.requests).toEqual({ 'payment-svc': { switched: false, toPg: null }, 'admission-ctrl': { switched: false, pgKey: null, pgTps: null } });

    expect(await run('entry-pause-release', ['--scope', 'platform', '--param', 'pg=TOSS', '--param', 'actor=0193a000-0000-7000-8000-0000ffff0001'])).toBe(0);
    expect(read(h).bundle).toMatchObject({ kind: 'CONTROL_KIND_ENTRY_PAUSE_RELEASE', scope: 'PLATFORM' });
    expect(read(h).bundle.requests).toEqual({ 'payment-svc': { pg: 'TOSS', actor: '0193a000-0000-7000-8000-0000ffff0001' } });
  });

  test('C-T28 ⑭ 판매 재개는 서로 다른 commander 두 명이 서명해야 보내고, commander+operator면 보내지 않는다', async () => {
    const h = harness();
    expect(await draft(h, 'sale-resume')).toBe(0);
    expect(await runRunbookCli(['sign', '--in', 'bundle.json', '--signer', 'commander-a'], h.deps)).toBe(0);
    expect(await runRunbookCli(['sign', '--in', 'bundle.json', '--signer', 'operator-c'], h.deps)).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(3);
    expect(h.sent).toHaveLength(0);
    expect(h.lines.join('\n')).toContain('not-authorized-role');

    expect(await runRunbookCli(['sign', '--in', 'bundle.json', '--signer', 'commander-b'], h.deps)).toBe(0);
    expect(read(h).signatures).toHaveLength(3);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
    expect(h.sent).toHaveLength(3);
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'APPLIED', postReviewRequired: false });
  });

  test('C-T28 ⑮ 같은 commandId의 결과가 이미 있으면 다시 보내지 않고 그 결과를 보고한다', async () => {
    const h = harness({ existing: { type: 'result', commandId: UUID(1), outcome: 'APPLIED', postReviewRequired: true, applied: [] } });
    expect(await draft(h, 'sale-pause')).toBe(0);
    expect(await runRunbookCli(['sign', '--in', 'bundle.json', '--signer', 'commander-a'], h.deps)).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
    expect(h.calls).toContain('readResult');
    expect(h.calls).not.toContain('intent');
    expect(h.sent).toHaveLength(0);
    expect(h.lines.join('\n')).toContain('이미 적용됐다');
  });

  test('[ASVS v5.0.0-4.1.5] run은 보내기 전에 서명을 다시 확인하고, 묶음을 고치면 보내지 않는다', async () => {
    const h = harness();
    expect(await draft(h, 'sale-pause')).toBe(0);
    expect(await runRunbookCli(['sign', '--in', 'bundle.json', '--signer', 'commander-a'], h.deps)).toBe(0);
    const f = read(h);
    f.bundle.reason = '고친 사유';
    h.files.set('bundle.json', JSON.stringify(f));
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(3);
    expect(h.sent).toHaveLength(0);
    expect(h.lines.join('\n')).toContain('bad-signature');
  });

  test('[ASVS v5.0.0-16.5.2] 감사 sink에 묶음을 쓰지 못하면 명령을 보내지 않는다', async () => {
    const h = harness({ failIntent: true });
    expect(await draft(h, 'sale-pause')).toBe(0);
    expect(await runRunbookCli(['sign', '--in', 'bundle.json', '--signer', 'commander-a'], h.deps)).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(EXTERNAL_FAILURE);
    expect(h.calls).toContain('intent');
    expect(h.calls).not.toContain('send:purchase-svc:50061');
    expect(h.sent).toHaveLength(0);
  });

  test('[ASVS v5.0.0-16.5.2] KMS 서명이 실패하면 묶음 파일을 바꾸지 않고 실패한다', async () => {
    const h = harness({ failKms: true });
    expect(await draft(h, 'sale-pause')).toBe(0);
    const before = h.files.get('bundle.json');
    expect(await runRunbookCli(['sign', '--in', 'bundle.json', '--signer', 'commander-a'], h.deps)).toBe(EXTERNAL_FAILURE);
    expect(h.kmsCalls).toEqual(['commander-a']);
    expect(h.files.get('bundle.json')).toBe(before);
    expect(read(h).signatures).toEqual([]);
  });
});
