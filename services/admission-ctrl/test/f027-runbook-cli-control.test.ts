// F-02-7(A, OPS-310) 런북 CLI의 제어 명령 갈래 시험: draft → sign → run, 감사 sink, KMS 실패.
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양'·§14 C-T7·C-T13·C-T28,
// docs/review/plans/F-02-7.md 6·8·10절. 실제 KMS·S3 없이 시험용 P-256 키와 메모리 sink만 쓴다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { commanderKeysFromProcess, type RunbookDeps, runRunbookCli } from '../src/modules/rb35/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const ACTOR = '0193a000-0000-7000-8000-0000ffff0001';
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
const operatorD = keyOf('operator-d', 'operator');
const KEYS = new Map<string, TestKey>([commanderA, commanderB, operatorC, operatorD].map((k) => [k.keyId, k]));

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

interface AuditIntent {
  type: 'intent';
  commandId: string;
  services: string[];
  canonicalBundle: string;
  signatures: { keyId: string; signature: string }[];
  issuedAt: number;
  expiresAt: number;
  writtenAtMs: number;
}
interface AuditResult {
  type: 'result';
  commandId: string;
  outcome: string;
  applied: { service: string; address: string; podName: string; appliedVersion: number; appliedAtMs: number }[];
  failed: { service: string; address: string; reason: string }[];
  postReviewRequired: boolean;
  finishedAtMs: number;
}
type Audit = AuditIntent | AuditResult;

function harness(
  o: {
    failIntent?: boolean;
    failResult?: boolean;
    failKms?: boolean;
    existing?: AuditResult | null;
    sendError?: (address: string) => { code?: number } | undefined;
  } = {},
) {
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
    keys: new Map([...KEYS.values()].map((k) => [k.keyId, { id: k.keyId, operatorId: k.operatorId, role: k.role, key: k.publicKey }])),
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
        const err = o.sendError?.(address);
        if (err) throw Object.assign(new Error('send failed'), err);
        return { appliedVersion: request.version, podName: `${address}-pod`, appliedAtMs: NOW };
      },
    },
    audit: {
      writeIntent: async (i: Omit<AuditIntent, 'type'>) => {
        calls.push('intent');
        if (o.failIntent) throw new Error('S3 unavailable');
        audits.push({ type: 'intent', ...i });
      },
      writeResult: async (r: Omit<AuditResult, 'type'>) => {
        calls.push('result');
        if (o.failResult) throw new Error('S3 unavailable');
        const result = { type: 'result' as const, ...r };
        audits.push(result);
        existing = result;
      },
      readResult: async (commandId: string) => {
        calls.push('readResult');
        return existing && existing.commandId === commandId ? existing : null;
      },
    },
  } as unknown as RunbookDeps;
  return { deps, files, lines, sent, calls, audits, kmsCalls };
}

async function draft(h: ReturnType<typeof harness>, preset: string, commandId = UUID(1), extra: string[] = []): Promise<number> {
  return runRunbookCli(['draft', preset, '--event', EVENT, '--reason', '결제사 장애로 판매를 멈춘다', '--command-id', commandId, '--out', 'bundle.json', ...extra], h.deps);
}

const read = (h: ReturnType<typeof harness>): SignedFile => JSON.parse(h.files.get('bundle.json')!) as SignedFile;
const serviceOf = (address: string): string => address.split(':')[0]!;
const signAs = (h: ReturnType<typeof harness>, id: string) => runRunbookCli(['sign', '--in', 'bundle.json', '--signer', id], h.deps);

describe('F-02-7 런북 CLI 제어 명령', () => {
  test('C-T13 ops-svc가 없어도 세 받는 쪽에 같은 묶음을 보내고 감사 intent→result를 남긴다', async () => {
    const h = harness();
    expect(await draft(h, 'sale-pause')).toBe(0);
    const f = read(h);
    expect(f.signatures).toEqual([]);
    expect(f.bundle).toMatchObject({ kind: 'CONTROL_KIND_SALE_PAUSE', scope: EVENT, reason: '결제사 장애로 판매를 멈춘다' });
    expect(f.bundle.version).toBe(f.bundle.issuedAt);
    expect(f.bundle.expiresAt - f.bundle.issuedAt).toBe(5 * 60_000);
    expect(f.bundle.requests).toEqual({
      'purchase-svc': { paused: true },
      'admission-ctrl': { paused: true },
      'queue-svc': { paused: true },
    });

    expect(await signAs(h, 'commander-a')).toBe(0);
    expect(read(h).signatures).toEqual([{ keyId: 'commander-a', signature: expect.any(String) }]);

    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
    expect(h.sent).toHaveLength(3);
    expect(h.sent.map((s) => s.address).sort()).toEqual(['admission-ctrl:50061', 'purchase-svc:50061', 'queue-svc:50061']);
    for (const s of h.sent) {
      expect(s.request.commandId).toBe(UUID(1));
      expect(s.request.version).toBe(f.bundle.version);
      expect(s.request.kind).toBe('CONTROL_KIND_SALE_PAUSE');
      expect(JSON.parse(s.request.desiredStateJson)).toEqual(f.bundle.requests[serviceOf(s.address)]);
      expect(JSON.parse(s.request.canonicalBundle.toString('utf8'))).toEqual(f.bundle);
    }

    const intent = h.audits.find((a): a is AuditIntent => a.type === 'intent')!;
    expect(intent.commandId).toBe(UUID(1));
    expect(intent.services.sort()).toEqual(['admission-ctrl', 'purchase-svc', 'queue-svc']);
    expect(JSON.parse(Buffer.from(intent.canonicalBundle, 'base64').toString('utf8'))).toEqual(f.bundle);
    expect(intent.signatures).toHaveLength(1);
    expect(intent.signatures[0]?.keyId).toBe('commander-a');
    expect(intent.issuedAt).toBe(f.bundle.issuedAt);
    expect(intent.expiresAt).toBe(f.bundle.expiresAt);
    expect(intent.writtenAtMs).toBe(NOW);

    const result = h.audits.find((a): a is AuditResult => a.type === 'result')!;
    expect(result).toMatchObject({ commandId: UUID(1), outcome: 'APPLIED', postReviewRequired: true, failed: [] });
    expect(result.applied.map((a) => a.service).sort()).toEqual(['admission-ctrl', 'purchase-svc', 'queue-svc']);
    for (const a of result.applied) {
      expect(a.address).toBe(`${a.service}:50061`);
      expect(a.podName).toBe(`${a.address}-pod`);
      expect(a.appliedVersion).toBe(f.bundle.version);
      expect(a.appliedAtMs).toBe(NOW);
    }
    expect(h.calls[0]).toBe('readResult');
    expect(h.calls[1]).toBe('intent');
    expect(h.calls.at(-1)).toBe('result');
  });

  test('C-T13 pg-switch는 payment-svc와 admission-ctrl에 서로 다른 바라는 상태를 보낸다', async () => {
    const h = harness();
    expect(await draft(h, 'pg-switch', UUID(2), ['--param', 'toPg=PORTONE', '--param', 'pgTps=50'])).toBe(0);
    const f = read(h);
    expect(f.bundle.kind).toBe('CONTROL_KIND_PG_SWITCH');
    expect(f.bundle.requests).toEqual({
      'payment-svc': { switched: true, toPg: 'PORTONE' },
      'admission-ctrl': { switched: true, pgKey: 'PORTONE', pgTps: 50 },
    });
    expect(await signAs(h, 'operator-c')).toBe(0);
    expect(await signAs(h, 'operator-d')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
    expect(h.sent.map((s) => s.address).sort()).toEqual(['admission-ctrl:50061', 'payment-svc:50061']);
    for (const s of h.sent) expect(JSON.parse(s.request.desiredStateJson)).toEqual(f.bundle.requests[serviceOf(s.address)]);
  });

  test('C-T13 나머지 프리셋도 주소·ack·감사 결과까지 간다', async () => {
    const h = harness();
    const cases: { preset: string; id: string; args: string[]; services: string[] }[] = [
      { preset: 'admission-pause', id: UUID(3), args: ['--event', EVENT], services: ['admission-ctrl'] },
      { preset: 'admission-resume', id: UUID(4), args: ['--event', EVENT], services: ['admission-ctrl'] },
      { preset: 'automation-stop', id: UUID(5), args: ['--scope', 'platform'], services: ['admission-ctrl'] },
      { preset: 'automation-resume', id: UUID(6), args: ['--scope', 'platform'], services: ['admission-ctrl'] },
      { preset: 'pg-switch-off', id: UUID(7), args: ['--event', EVENT], services: ['admission-ctrl', 'payment-svc'] },
      { preset: 'entry-pause-release', id: UUID(8), args: ['--scope', 'platform', '--param', 'pg=TOSS', '--param', `actor=${ACTOR}`], services: ['payment-svc'] },
    ];
    for (const c of cases) {
      expect(await runRunbookCli(['draft', c.preset, ...c.args, '--reason', '비상 조치', '--command-id', c.id, '--out', 'bundle.json'], h.deps)).toBe(0);
      expect(await signAs(h, 'operator-c')).toBe(0);
      expect(await signAs(h, 'operator-d')).toBe(0);
      expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
      const result = h.audits.filter((a): a is AuditResult => a.type === 'result').at(-1)!;
      expect(result.outcome).toBe('APPLIED');
      expect(result.applied.map((a) => a.service).sort()).toEqual(c.services);
      expect(result.postReviewRequired).toBe(false);
    }
    expect(h.sent.map((s) => s.address).sort()).toEqual([
      'admission-ctrl:50061',
      'admission-ctrl:50061',
      'admission-ctrl:50061',
      'admission-ctrl:50061',
      'admission-ctrl:50061',
      'payment-svc:50061',
      'payment-svc:50061',
    ]);
  });

  test('C-T28 ⑭ 판매 재개는 commander 두 명만, 판매 정지는 commander 한 명만 보낸다', async () => {
    const h = harness();
    // 재개 1명은 거부
    expect(await draft(h, 'sale-resume', UUID(9))).toBe(0);
    expect(await signAs(h, 'commander-a')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(3);
    expect(h.sent).toHaveLength(0);
    expect(h.lines.join('\n')).toContain('signature-count');

    // 재개 2명은 수용하고, 세 서비스가 모두 {paused:false}여야 한다
    expect(await draft(h, 'sale-resume', UUID(10))).toBe(0);
    expect(read(h).bundle.requests).toEqual({
      'purchase-svc': { paused: false },
      'admission-ctrl': { paused: false },
      'queue-svc': { paused: false },
    });
    expect(await signAs(h, 'commander-a')).toBe(0);
    expect(await signAs(h, 'commander-b')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
    expect(h.sent).toHaveLength(3);
    expect((h.audits.filter((a): a is AuditResult => a.type === 'result').at(-1)!).postReviewRequired).toBe(false);

    // 정지 2명은 거부
    expect(await draft(h, 'sale-pause', UUID(11))).toBe(0);
    expect(read(h).bundle.requests).toEqual({
      'purchase-svc': { paused: true },
      'admission-ctrl': { paused: true },
      'queue-svc': { paused: true },
    });
    expect(await signAs(h, 'commander-a')).toBe(0);
    expect(await signAs(h, 'commander-b')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(3);
    expect(h.sent).toHaveLength(3);
    expect(h.lines.join('\n')).toContain('signature-count');

    // 한 서비스만 재개/정지로 갈린 묶음은 모양이 틀려 보내지 않는다
    expect(await draft(h, 'sale-resume', UUID(13))).toBe(0);
    const mixed = read(h);
    mixed.bundle.requests['queue-svc'] = { paused: true };
    h.files.set('bundle.json', JSON.stringify(mixed));
    expect(await signAs(h, 'commander-a')).toBe(0);
    expect(await signAs(h, 'commander-b')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(3);
    expect(h.sent).toHaveLength(3);
    expect(h.lines.join('\n')).toContain('mismatch');

    // 정지 1명은 수용하고 사후 검토 할 일이 남는다
    expect(await draft(h, 'sale-pause', UUID(12))).toBe(0);
    expect(await signAs(h, 'commander-a')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
    expect(h.sent).toHaveLength(6);
    expect((h.audits.filter((a): a is AuditResult => a.type === 'result').at(-1)!).postReviewRequired).toBe(true);
  });

  test('C-T28 ⑮ 같은 commandId의 결과가 이미 있으면 다시 보내지 않고 그 결과를 보고한다', async () => {
    const h = harness({
      existing: { type: 'result', commandId: UUID(1), outcome: 'APPLIED', applied: [], failed: [], postReviewRequired: true, finishedAtMs: NOW },
    });
    expect(await draft(h, 'sale-pause')).toBe(0);
    expect(await signAs(h, 'commander-a')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(0);
    expect(h.calls).toContain('readResult');
    expect(h.calls).not.toContain('intent');
    expect(h.sent).toHaveLength(0);
    expect(h.lines.join('\n')).toContain('이미 적용됐다');
  });

  test('[ASVS v5.0.0-4.1.5] run은 보내기 전에 키 목록·역할·시간·창을 다시 확인한다', async () => {
    const noKeys = harness();
    expect(await draft(noKeys, 'sale-pause')).toBe(0);
    expect(await signAs(noKeys, 'commander-a')).toBe(0);
    (noKeys.deps as unknown as { keys: null }).keys = null;
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], noKeys.deps)).toBe(3);
    expect(noKeys.sent).toHaveLength(0);

    const h = harness();
    const assertRejected = async (id: string) => {
      expect(await runRunbookCli(['run', '--in', 'bundle.json'], h.deps)).toBe(3);
      expect(h.sent).toHaveLength(0);
      expect(h.calls).not.toContain('intent');
      expect(h.lines.join('\n')).toContain(id);
    };

    // 역할 위반
    expect(await draft(h, 'sale-resume', UUID(13))).toBe(0);
    expect(await signAs(h, 'commander-a')).toBe(0);
    await assertRejected('signature-count');

    // 만료
    expect(await draft(h, 'sale-pause', UUID(14))).toBe(0);
    const expired = read(h);
    expired.bundle.issuedAt = NOW - 400_000;
    expired.bundle.expiresAt = NOW - 100_000;
    expired.bundle.version = expired.bundle.issuedAt;
    h.files.set('bundle.json', JSON.stringify(expired));
    expect(await signAs(h, 'commander-a')).toBe(0);
    await assertRejected('expired');

    // 미래 issuedAt
    expect(await draft(h, 'sale-pause', UUID(15))).toBe(0);
    const future = read(h);
    future.bundle.issuedAt = NOW + 31_000;
    future.bundle.expiresAt = future.bundle.issuedAt + 300_000;
    future.bundle.version = future.bundle.issuedAt;
    h.files.set('bundle.json', JSON.stringify(future));
    expect(await signAs(h, 'commander-a')).toBe(0);
    await assertRejected('not-yet-valid');

    // 5분 창 위반
    expect(await draft(h, 'sale-pause', UUID(16))).toBe(0);
    const wide = read(h);
    wide.bundle.expiresAt = wide.bundle.issuedAt + 300_001;
    h.files.set('bundle.json', JSON.stringify(wide));
    expect(await signAs(h, 'commander-a')).toBe(0);
    await assertRejected('window');

    // 서명한 뒤 사유를 고친 묶음은 run 전에 bad-signature로 끝난다
    expect(await draft(h, 'sale-pause', UUID(17))).toBe(0);
    expect(await signAs(h, 'commander-a')).toBe(0);
    const tampered = read(h);
    tampered.bundle.reason = '고친 사유';
    h.files.set('bundle.json', JSON.stringify(tampered));
    await assertRejected('bad-signature');
  });

  test('[ASVS v5.0.0-16.5.2] 감사 선행·결과 쓰기·부분 실패를 가른다', async () => {
    const noIntent = harness({ failIntent: true });
    expect(await draft(noIntent, 'sale-pause')).toBe(0);
    expect(await signAs(noIntent, 'commander-a')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], noIntent.deps)).toBe(EXTERNAL_FAILURE);
    expect(noIntent.calls).toContain('intent');
    expect(noIntent.calls).not.toContain('send:purchase-svc:50061');
    expect(noIntent.sent).toHaveLength(0);

    const noResult = harness({ failResult: true });
    expect(await draft(noResult, 'sale-pause')).toBe(0);
    expect(await signAs(noResult, 'commander-a')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], noResult.deps)).toBe(EXTERNAL_FAILURE);
    expect(noResult.sent).toHaveLength(3);
    expect(noResult.lines.join('\n')).toContain(UUID(1));
    expect(noResult.lines.join('\n')).toContain('적용됐을 수 있다');

    const partial = harness({ sendError: (address) => (address.startsWith('queue-svc') ? {} : undefined) });
    expect(await draft(partial, 'sale-pause')).toBe(0);
    expect(await signAs(partial, 'commander-a')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], partial.deps)).toBe(4);
    const partialResult = partial.audits.find((a): a is AuditResult => a.type === 'result')!;
    expect(partialResult.outcome).toBe('PARTIAL');
    expect(partialResult.applied).toHaveLength(2);
    expect(partialResult.failed).toHaveLength(1);
    expect(partialResult.failed[0]).toMatchObject({ service: 'queue-svc', address: 'queue-svc:50061' });

    // 결과 대기 TIMEOUT이 아니라 보내기 시한(DEADLINE_EXCEEDED)은 PARTIAL·send-deadline이다
    const sendDeadline = harness({ sendError: (address) => (address.startsWith('queue-svc') ? { code: 4 } : undefined) });
    expect(await draft(sendDeadline, 'sale-pause', UUID(18))).toBe(0);
    expect(await signAs(sendDeadline, 'commander-a')).toBe(0);
    expect(await runRunbookCli(['run', '--in', 'bundle.json'], sendDeadline.deps)).toBe(4);
    const sendDeadlineResult = sendDeadline.audits.find((a): a is AuditResult => a.type === 'result')!;
    expect(sendDeadlineResult.outcome).toBe('PARTIAL');
    expect(sendDeadlineResult.failed[0]).toMatchObject({ service: 'queue-svc', reason: expect.stringContaining('send-deadline') });
  });

  test('[ASVS v5.0.0-16.5.2] KMS 서명이 실패하면 파일을 바꾸지 않고, prod는 키 없이 뜨지 않는다', async () => {
    const h = harness({ failKms: true });
    expect(await draft(h, 'sale-pause')).toBe(0);
    const before = h.files.get('bundle.json');
    expect(await signAs(h, 'commander-a')).toBe(EXTERNAL_FAILURE);
    expect(h.kmsCalls).toEqual(['commander-a']);
    expect(h.files.get('bundle.json')).toBe(before);
    expect(read(h).signatures).toEqual([]);

    expect(() => commanderKeysFromProcess({ PEAKET_ENV: 'prod' })).toThrow();
    expect(commanderKeysFromProcess({ PEAKET_ENV: 'local' })).toBeNull();
  });
});
