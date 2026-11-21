// 감사 체인 mac 단위 시험(BAT-355 OPS-270, ADR-0341 결정 1~5, control-tower §7 '감사 체인 mac의 첫 구현', C-T49, ASVS 11.2.2·11.4.1).
// mac = HMAC-SHA256(감사 체인 키, "PEAKET-audit-v1" ‖ seq(8바이트 빅엔디언) ‖ 직전 행의 mac(첫 행 0바이트) ‖ record_sha256)을 시험이 따로 계산해 견준다.
// 작업자·빈 행 경보·5분 앵커는 모듈 공개 면(AuditChainWorker·AuditMacLagMonitor·AuditMacAnchorer)을 메모리 짝 가짜(MemoryAuditMacStore·MemoryMacAnchorStore·MemoryOpsAlertStore) 위에서 돌린다.
// KMS는 포트 AuditMacClient 대역으로 넘김 규칙을 보고, SDK 요청의 MacAlgorithm은 KMSClient.send를 감시해 본다(제3자 SDK).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { GenerateMacCommand, KMSClient, VerifyMacCommand } from '@aws-sdk/client-kms';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryOpsAlertStore } from '../src/modules/alerts/index.js';
import {
  AuditChainWorker,
  AuditMacAnchorer,
  AuditMacKeyUnavailable,
  AuditMacLagMonitor,
  AuditSignals,
  KmsAuditMacKey,
  LocalAuditMacKey,
  MemoryAuditChain,
  MemoryAuditMacStore,
  MemoryMacAnchorStore,
  auditHash,
  auditMacInput,
  kmsAuditMacClient,
  type AuditMacClient,
  type AuditMacKey,
} from '../src/modules/audit/index.js';

const T0 = Date.parse('2026-11-22T05:00:00.000Z');
const KEY = randomBytes(32);
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};
/** 정본 식(ADR-0341 결정 1)으로 시험이 따로 계산한 mac 차례 */
function expectedMacs(chain: MemoryAuditChain, key: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (const e of [...chain.entries].sort((a, b) => a.seq - b.seq)) {
    const mac = createHmac('sha256', key)
      .update(Buffer.concat([Buffer.from('PEAKET-audit-v1', 'utf8'), u64(BigInt(e.seq)), prev, Buffer.from(e.hash, 'hex')]))
      .digest();
    out.push(mac);
    prev = mac;
  }
  return out;
}
const seed = async (chain: MemoryAuditChain, n: number, atMs = T0) => {
  for (let i = 0; i < n; i += 1) await chain.append({ recordType: 'COMMAND_CREATED', recordId: '0194b355-0000-7000-8000-00000000000' + String(i % 10), payload: { n: chain.entries.length + 1 }, nowMs: atMs + i });
};

/** 막았다 되살릴 수 있는 감사 체인 키(포트 AuditMacKey 구현) */
class SwitchKey implements AuditMacKey {
  down = false;
  readonly keyId: string;
  constructor(private readonly inner: AuditMacKey) {
    this.keyId = inner.keyId;
  }
  async mac(m: Uint8Array): Promise<Uint8Array> {
    if (this.down) throw new AuditMacKeyUnavailable('ECONNREFUSED');
    return this.inner.mac(m);
  }
  async verify(m: Uint8Array, mac: Uint8Array): Promise<boolean> {
    if (this.down) throw new AuditMacKeyUnavailable('ECONNREFUSED');
    return this.inner.verify(m, mac);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mac 입력 바이트와 작업자·앵커(ASVS 11.2.2)', () => {
  test('[ASVS v5.0.0-11.2.2] mac 입력은 PEAKET-audit-v1(UTF-8 15바이트) ‖ seq(부호 없는 8바이트 빅엔디언) ‖ 직전 mac(첫 행은 0바이트) ‖ 기록 해시 32바이트다', () => {
    const sha = createHash('sha256').update('기록').digest();
    const prev = createHash('sha256').update('직전 mac').digest();
    const first = auditMacInput(1, Buffer.alloc(0), sha);
    expect(first.subarray(0, 15).toString('utf8')).toBe('PEAKET-audit-v1');
    expect(Buffer.from('PEAKET-audit-v1', 'utf8')).toHaveLength(15);
    expect(first).toEqual(Buffer.concat([Buffer.from('PEAKET-audit-v1', 'utf8'), Buffer.from('0000000000000001', 'hex'), sha]));
    expect(first).toHaveLength(15 + 8 + 0 + 32);
    // 2^40 + 3: 8바이트 빅엔디언(글자 seq·4바이트로 자른 seq와 다르다)
    const big = auditMacInput(2n ** 40n + 3n, prev, sha);
    expect(big).toEqual(Buffer.concat([Buffer.from('PEAKET-audit-v1', 'utf8'), Buffer.from('0000010000000003', 'hex'), prev, sha]));
    expect(big).toHaveLength(15 + 8 + 32 + 32);
    expect(() => auditMacInput(0, Buffer.alloc(0), sha)).toThrow(RangeError);
  });

  test('[ASVS v5.0.0-11.2.2] 작업자는 seq 차례로 정본 식의 mac을 바퀴 크기만큼 채우고, 앵커는 mac_seq가 늘었을 때만 {v, seq, mac, keyId, at}를 seq 20자리 객체 하나로 쓰며 쓰기에 실패하면 행 없이 다음 바퀴에 다시 쓴다', async () => {
    const chain = new MemoryAuditChain();
    await seed(chain, 5);
    const store = new MemoryAuditMacStore(chain);
    const key = new LocalAuditMacKey(KEY, 'kms-test-key-1');
    // 바퀴 크기는 기본(100 [가정])과 다르게 2로 둔다
    const worker = new AuditChainWorker({ store, key, batch: 2 });
    expect(await worker.runOnce(T0)).toEqual({ filled: 2 });
    expect(store.macSeq).toBe(2);
    expect(await worker.runOnce(T0)).toEqual({ filled: 2 });
    expect(await worker.runOnce(T0)).toEqual({ filled: 1 });
    expect(await worker.runOnce(T0)).toEqual({ filled: 0 });
    const expected = expectedMacs(chain, KEY);
    expect([...store.macs.entries()].sort(([a], [b]) => a - b)).toEqual(expected.map((m, i) => [i + 1, m]));
    expect(store.macSeq).toBe(5);
    expect(store.lastMac).toEqual(expected[4]);

    const anchors = new MemoryMacAnchorStore();
    const anchorer = new AuditMacAnchorer(store, anchors, key.keyId);
    expect(await anchorer.runOnce(T0 + 5 * 60_000)).toEqual({ anchoredSeq: 5 });
    expect([...anchors.objects.entries()]).toEqual([
      ['audit-chain/anchors/v1/00000000000000000005.json', { v: 1, seq: 5, mac: expected[4]!.toString('hex'), keyId: 'kms-test-key-1', at: new Date(T0 + 5 * 60_000).toISOString() }],
    ]);
    expect([...store.anchors.keys()]).toEqual([5]);
    // mac_seq가 그대로면 쓰지 않는다
    expect(await anchorer.runOnce(T0 + 10 * 60_000)).toEqual({});
    expect(anchors.objects.size).toBe(1);
    // 새 행: 쓰기 실패면 앵커 행이 없고, 다음 바퀴에 같은 이름으로 쓴다
    await seed(chain, 1, T0 + 1_000);
    expect(await worker.runOnce(T0)).toEqual({ filled: 1 });
    anchors.failNext = 1;
    expect(await anchorer.runOnce(T0 + 15 * 60_000)).toEqual({ error: 'Error' });
    expect([...store.anchors.keys()]).toEqual([5]);
    expect(await anchorer.runOnce(T0 + 20 * 60_000)).toEqual({ anchoredSeq: 6 });
    expect([...anchors.objects.keys()]).toEqual(['audit-chain/anchors/v1/00000000000000000005.json', 'audit-chain/anchors/v1/00000000000000000006.json']);
    expect([...store.anchors.keys()]).toEqual([5, 6]);
  });

  test('OPS-270 두 파드가 같은 바퀴를 계산하면 mac_seq 조건부 쓰기가 늦은 쪽 바퀴를 버리고, seq 빈틈이 있으면 멈추고 SEV2 audit-chain-mismatch를 연다', async () => {
    const chain = new MemoryAuditChain();
    await seed(chain, 3);
    const store = new MemoryAuditMacStore(chain);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: AuditMacKey = { keyId: 'slow', mac: async (m) => (await gate, createHmac('sha256', KEY).update(m).digest()), verify: async () => true };
    const a = new AuditChainWorker({ store, key: slow, batch: 10 });
    const b = new AuditChainWorker({ store, key: new LocalAuditMacKey(KEY, 'fast'), batch: 10 });
    const late = a.runOnce(T0);
    expect(await b.runOnce(T0)).toEqual({ filled: 3 });
    release();
    expect(await late).toEqual({ filled: 0, discarded: true });
    expect(store.macSeq).toBe(3);
    expect([...store.macs.values()]).toEqual(expectedMacs(chain, KEY));

    // 빈틈: seq 5 행만 있고 4가 없다
    const gapChain = new MemoryAuditChain();
    await seed(gapChain, 5);
    gapChain.entries.splice(3, 1);
    const gapStore = new MemoryAuditMacStore(gapChain);
    const alerts = new MemoryOpsAlertStore();
    const worker = new AuditChainWorker({ store: gapStore, key: new LocalAuditMacKey(KEY), alerts, batch: 10 });
    expect(await worker.runOnce(T0)).toEqual({ filled: 3, gapSeq: 4 });
    expect(gapStore.macSeq).toBe(3);
    expect(alerts.alerts).toEqual([expect.objectContaining({ eventKey: 'audit-chain', kind: 'audit-chain-mismatch', severity: 'SEV2', detail: { firstBadSeq: 4, reason: 'gap' } })]);
  });
});

describe('해시·mac 알고리즘(ASVS 11.4.1)', () => {
  test('[ASVS v5.0.0-11.4.1] 기록 해시는 SHA-256(직전 해시 16진 ‖ 정규화 기록 JSON)이고, KMS 호출은 GenerateMac·VerifyMac의 MacAlgorithm HMAC_SHA_256이다', async () => {
    const record = { recordType: 'COMMAND_CREATED', recordId: '0194b355-0000-7000-8000-000000000001', payload: { b: 2, a: 1 }, nowMs: T0 };
    const prev = 'ab'.repeat(32);
    const canonical = JSON.stringify({ at: new Date(T0).toISOString(), payload: { a: 1, b: 2 }, recordId: record.recordId, recordType: record.recordType });
    expect(auditHash(prev, record)).toBe(createHash('sha256').update(prev).update(canonical).digest('hex'));

    const sent: Array<GenerateMacCommand | VerifyMacCommand> = [];
    const mac = createHmac('sha256', KEY).update('m').digest();
    vi.spyOn(KMSClient.prototype, 'send').mockImplementation(async (command: unknown) => {
      if (command instanceof GenerateMacCommand) {
        sent.push(command);
        return { Mac: mac, KeyId: command.input.KeyId, MacAlgorithm: command.input.MacAlgorithm };
      }
      if (command instanceof VerifyMacCommand) {
        sent.push(command);
        return { MacValid: true, KeyId: command.input.KeyId, MacAlgorithm: command.input.MacAlgorithm };
      }
      throw new Error('예상 밖 KMS 명령');
    });
    const keyId = 'arn:aws:kms:ap-northeast-2:111122223333:key/mrk-0123456789abcdef0123456789abcdef';
    const client = kmsAuditMacClient({ region: 'ap-northeast-2' });
    expect(Buffer.from(await client.mac(keyId, Buffer.from('m')))).toEqual(mac);
    expect(await client.verify(keyId, Buffer.from('m'), mac)).toBe(true);
    expect(sent.map((c) => [c.constructor.name, c.input.KeyId, c.input.MacAlgorithm])).toEqual([
      ['GenerateMacCommand', keyId, 'HMAC_SHA_256'],
      ['VerifyMacCommand', keyId, 'HMAC_SHA_256'],
    ]);
  });
});

describe('KMS 정지와 복제 키(C-T49)', () => {
  /** 포트 AuditMacClient 대역. 오류를 차례로 내고 부른 키 ID를 적는다 */
  class FakeMacClient implements AuditMacClient {
    readonly keyIds: string[] = [];
    readonly errors: unknown[] = [];
    async mac(keyId: string, message: Uint8Array): Promise<Uint8Array> {
      this.keyIds.push(keyId);
      const e = this.errors.shift();
      if (e) throw e;
      return createHmac('sha256', KEY).update(message).digest();
    }
    async verify(keyId: string, message: Uint8Array, mac: Uint8Array): Promise<boolean> {
      return Buffer.from(await this.mac(keyId, message)).equals(Buffer.from(mac));
    }
  }
  const SEOUL_KEY = 'arn:aws:kms:ap-northeast-2:111122223333:key/mrk-00112233445566778899aabbccddeeff';
  const TOKYO_KEY = 'arn:aws:kms:ap-northeast-1:111122223333:key/mrk-00112233445566778899aabbccddeeff';
  const sdkError = (name: string, httpStatusCode?: number, code?: string) => Object.assign(new Error(name), { name, ...(code ? { code } : {}), ...(httpStatusCode !== undefined ? { $metadata: { httpStatusCode } } : {}) });

  test('C-T49 서울 KMS가 응답하지 않으면(연결 실패·시간 초과·5xx·한도) 도쿄 복제 키로 한 번 더 하고 넘김 지표가 오르며, 거절(권한 없음·키 꺼짐)은 넘기지 않는다', async () => {
    const unavailable = [sdkError('Error', undefined, 'ECONNREFUSED'), sdkError('TimeoutError'), sdkError('InternalFailure', 500), sdkError('KMSInternalException', 500), sdkError('ThrottlingException', 400)];
    for (const e of unavailable) {
      const seoul = new FakeMacClient();
      const tokyo = new FakeMacClient();
      const signals = new AuditSignals();
      seoul.errors.push(e);
      const key = new KmsAuditMacKey(seoul, SEOUL_KEY, { client: tokyo, region: 'ap-northeast-1' }, (op) => signals.failover(op));
      const msg = Buffer.from('입력');
      expect(Buffer.from(await key.mac(msg)), (e as Error).name).toEqual(createHmac('sha256', KEY).update(msg).digest());
      expect(seoul.keyIds).toEqual([SEOUL_KEY]);
      expect(tokyo.keyIds).toEqual([TOKYO_KEY]);
      expect((await signals.kmsFailoverTotal.get()).values).toEqual([expect.objectContaining({ labels: { op: 'GenerateMac' }, value: 1 })]);
    }
    for (const e of [sdkError('AccessDeniedException', 400), sdkError('DisabledException', 400), sdkError('NotFoundException', 400)]) {
      const seoul = new FakeMacClient();
      const tokyo = new FakeMacClient();
      seoul.errors.push(e);
      const key = new KmsAuditMacKey(seoul, SEOUL_KEY, { client: tokyo, region: 'ap-northeast-1' });
      await expect(key.mac(Buffer.from('입력')), (e as Error).name).rejects.toBeInstanceOf(AuditMacKeyUnavailable);
      expect(tokyo.keyIds).toEqual([]);
    }
    // 두 리전 모두 응답하지 않으면 쓸 수 없다(검증은 ERROR, 작업자는 그 바퀴를 멈춘다)
    const seoul = new FakeMacClient();
    const tokyo = new FakeMacClient();
    seoul.errors.push(sdkError('Error', undefined, 'ECONNREFUSED'));
    tokyo.errors.push(sdkError('Error', undefined, 'ECONNREFUSED'));
    await expect(new KmsAuditMacKey(seoul, SEOUL_KEY, { client: tokyo, region: 'ap-northeast-1' }).verify(Buffer.from('입력'), Buffer.alloc(32))).rejects.toBeInstanceOf(AuditMacKeyUnavailable);
  });

  test('C-T49 mac이 빈 가장 오래된 행이 60,000ms면 경보가 없고 60,001ms면 SEV2 audit-mac-lag이 열리며, KMS를 되살리면 seq 차례로 따라잡고 경보가 풀린다', async () => {
    const chain = new MemoryAuditChain();
    await seed(chain, 4);
    const store = new MemoryAuditMacStore(chain);
    const alerts = new MemoryOpsAlertStore();
    const signals = new AuditSignals();
    const key = new SwitchKey(new LocalAuditMacKey(KEY, 'kms-test-key-2'));
    key.down = true;
    const worker = new AuditChainWorker({ store, key, alerts, batch: 3 });
    const monitor = new AuditMacLagMonitor(store, alerts, signals);
    // 막힌 동안: 채우지 않는다(빈 행이 남는다)
    expect(await worker.runOnce(T0 + 1_000)).toEqual({ filled: 0, error: 'AuditMacKeyUnavailable' });
    expect(store.macs.size).toBe(0);
    expect(await monitor.runOnce(T0 + 60_000)).toEqual({ lagMs: 60_000, alerted: false });
    expect(alerts.alerts).toEqual([]);
    expect((await signals.macLagSeconds.get()).values[0]!.value).toBe(60);
    expect(await monitor.runOnce(T0 + 60_001)).toEqual({ lagMs: 60_001, alerted: true });
    expect(alerts.alerts).toEqual([expect.objectContaining({ eventKey: 'audit-chain', kind: 'audit-mac-lag', severity: 'SEV2', detail: { oldestSeq: 1, lagMs: 60_001 } })]);
    expect(alerts.alerts[0]!.resolvedAtMs).toBeUndefined();
    // 되살림: 바퀴마다 seq 차례로 따라잡는다
    key.down = false;
    expect(await worker.runOnce(T0 + 70_000)).toEqual({ filled: 3 });
    expect(await monitor.runOnce(T0 + 70_000)).toMatchObject({ alerted: true });
    expect(await worker.runOnce(T0 + 71_000)).toEqual({ filled: 1 });
    expect([...store.macs.values()]).toEqual(expectedMacs(chain, KEY));
    expect(await monitor.runOnce(T0 + 72_000)).toEqual({ lagMs: 0, alerted: false });
    expect(alerts.alerts).toEqual([expect.objectContaining({ kind: 'audit-mac-lag', resolvedAtMs: T0 + 72_000 })]);
    expect((await signals.macLagSeconds.get()).values[0]!.value).toBe(0);
  });
});
